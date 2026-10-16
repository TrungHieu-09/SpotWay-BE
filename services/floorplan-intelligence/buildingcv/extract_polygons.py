"""Turn a 4-class segmentation mask into per-class polygons for 3D rendering.

The mask is dense per-pixel labels; the viewer wants vector geometry. We
extract contours per structural class (wall / door / window) and emit a
small JSON describing each polygon as an outer ring plus optional holes.
The viewer extrudes these into 3D walls and slabs.

Pipeline per class:
    1. Binary mask = (pred == class_id).
    2. Morphological closing (3x3) — bridges 1-px gaps so a wall the model
       drew with a hairline break still becomes one polygon, not two.
    3. cv2.findContours(RETR_CCOMP) — outer contours and one level of holes.
       That's all we need: a wall ring with a doorway cut out is exactly
       one outer + one hole.
    4. cv2.approxPolyDP(epsilon = APPROX_EPSILON_PX) — kills the pixel-
       staircase. Without this every horizontal wall edge is ~50 collinear
       points; with it, two.
    5. Drop polygons whose outer-ring area is below MIN_POLYGON_AREA_PX —
       speckle from model noise that would render as floating debris.
"""

from __future__ import annotations

import argparse
import json
from io import BytesIO
from pathlib import Path
from typing import TypedDict

import cv2
import numpy as np
import torch
import yaml
from PIL import Image, ImageDraw

from .checkpoint import load_inference_checkpoint
from .data import IMAGENET_MEAN, IMAGENET_STD, _read_svg_dims  # type: ignore[attr-defined]
from .labels import CLASS_COLORS, CLASS_NAMES, CLASS_TO_ID, FLOOR_ID
from .model import build_model
from .svg_render import render_input_png

# Classes we extract geometry for. `floor` is implicit — it's the negative
# space, the viewer renders it as a single ground plane and doesn't need
# polygon detail.
EXTRACT_CLASSES: tuple[str, ...] = ("wall", "door", "window")

# Closing kernel size in pixels. 3x3 is enough to seal hairline breaks
# without smoothing away real ~5px door openings.
CLOSING_KERNEL_PX: int = 3

# Douglas-Peucker tolerance in pixels. ~1.5 collapses pixel staircases on
# axis-aligned walls without distorting diagonal walls. Set lower if walls
# look polygonal in the viewer; higher if there are too many vertices.
APPROX_EPSILON_PX: float = 1.5

# Polygons smaller than this are model speckle, not real structure. At
# 512x512 a real door is ~80 px², a window ~150 px², so 30 is a safe floor.
MIN_POLYGON_AREA_PX: float = 40.0


class Polygon(TypedDict):
    outer: list[list[float]]
    holes: list[list[list[float]]]


class ExtractionResult(TypedDict):
    canvas_size: list[int]            # [W, H]
    content_rect: list[int]           # [left, top, inner_w, inner_h] for letterboxed renders
    polygons: dict[str, list[Polygon]]


def _erase_text_from_blueprint(img_rgb: np.ndarray) -> np.ndarray:
    """Remove text annotations from a blueprint image before ML segmentation.

    Architectural drawings contain room labels, titles and dimension text that
    the model (trained on clean, text-free CubiCasa SVGs) misclassifies as
    walls or doors.  We detect and paint these text regions white so only
    structural ink reaches the model.

    Strategy — stroke-width analysis via distance transform:
      * Real walls / door frames have thick strokes (≥ 4 px at 512-px canvas).
      * Text glyphs have thin strokes (1-3 px).
    For every connected dark component we compute the max value of the
    L2 distance transform on the binary ink mask.  That value equals the
    component's local stroke radius.  Components with a thin radius that are
    also small enough and that do not span the canvas are classified as text
    and erased (painted white).

    Thresholds are expressed as fractions of the shorter image dimension so the
    filter is resolution-independent (512 px uploads and 2000 px uploads both
    work without tuning).

    Performance note
    ----------------
    The previous implementation had an O(N × H × W) inner loop where N is the
    number of connected components.  On a 1200×900 image with 160 components
    that was ~175 M comparisons and ~600 ms on CPU.  The vectorised version
    replaces that with two O(H × W) passes:

      1.  ``np.maximum.at(max_dist, label_map.ravel(), dist.ravel())``
          computes the per-label maximum distance in a single scatter-reduce.
      2.  ``is_text[label_map]`` builds the text mask via fancy indexing in
          one pass over the label map.

    The per-component Python loop that remains is now only O(N) arithmetic —
    no array comparisons — so it's negligible.  Measured speedup: ~100×.

    Large-image downsampling
    ------------------------
    Text removal works well at any resolution; running it on a 2000-px image
    instead of a 1024-px crop wastes CPU without improving accuracy.  We
    downsample the working copy to ``MAX_ERASE_DIM`` on the shorter edge,
    build the mask there, then upsample (nearest-neighbour) back to the
    original resolution before painting.
    """
    H_orig, W_orig = img_rgb.shape[:2]

    # --- Optional downsampling for large uploads --------------------------------
    MAX_ERASE_DIM = 1024       # shorter-edge cap for the text-removal canvas
    min_dim_orig  = min(H_orig, W_orig)
    if min_dim_orig > MAX_ERASE_DIM:
        sf       = MAX_ERASE_DIM / min_dim_orig
        W_small  = max(1, int(round(W_orig * sf)))
        H_small  = max(1, int(round(H_orig * sf)))
        working  = cv2.resize(img_rgb, (W_small, H_small), interpolation=cv2.INTER_AREA)
        downsampled = True
    else:
        working     = img_rgb
        downsampled = False
    # ---------------------------------------------------------------------------

    gray = cv2.cvtColor(working, cv2.COLOR_RGB2GRAY)

    # Ink pixels are dark on a white/light background (typical blueprint)
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    # L2 distance transform: each ink pixel gets its distance to the nearest
    # background pixel — i.e. the local stroke radius at that point.
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)

    # Label every connected ink component.
    num_labels, label_map, stats, _ = cv2.connectedComponentsWithStats(
        binary, connectivity=8
    )

    H, W = binary.shape
    min_dim = min(H, W)

    # --- Scale-relative thresholds -------------------------------------------
    # At 512 px: STROKE_RADIUS≈3 px, MAX_AREA≈4 000 px², MAX_SPAN≈45 % of edge
    STROKE_RADIUS_PX = max(2.5, min_dim * 0.006)   # thin-stroke ceiling
    MAX_AREA_PX      = min_dim * min_dim * 0.015    # too large → keep (wall)
    NOISE_AREA_PX    = 8                            # absolute noise/dust floor
    MAX_SPAN_RATIO   = 0.45                         # component spans ≤45 % of
                                                    # the shorter dim → not a wall
    # -------------------------------------------------------------------------

    # --- VECTORISED pass 1: per-label max stroke radius ----------------------
    # np.maximum.at is O(H×W) total; the old "label_map == i" loop was O(N×H×W).
    max_dist = np.zeros(num_labels, dtype=np.float32)
    np.maximum.at(max_dist, label_map.ravel(), dist.ravel())
    # -------------------------------------------------------------------------

    # --- O(N) classification loop — only arithmetic, no array comparisons ----
    areas   = stats[:, cv2.CC_STAT_AREA]
    widths  = stats[:, cv2.CC_STAT_WIDTH]
    heights = stats[:, cv2.CC_STAT_HEIGHT]

    is_text = np.zeros(num_labels, dtype=bool)
    for i in range(1, num_labels):
        area = int(areas[i])
        if area < NOISE_AREA_PX:
            is_text[i] = True
            continue
        span_ratio = max(int(widths[i]), int(heights[i])) / max(min_dim, 1)
        if span_ratio >= MAX_SPAN_RATIO:
            continue                # structural wall that spans the canvas
        if area > MAX_AREA_PX:
            continue                # solid filled region — not text
        if max_dist[i] < STROKE_RADIUS_PX:
            is_text[i] = True       # thin stroke → text glyph
    # -------------------------------------------------------------------------

    # --- VECTORISED pass 2: build the text mask in one indexed lookup --------
    text_mask = is_text[label_map].astype(np.uint8) * 255
    # -------------------------------------------------------------------------

    # Dilate 5-px ellipse to cover anti-aliased fringes around erased glyphs.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    text_mask = cv2.dilate(text_mask, k, iterations=1)

    if downsampled:
        # Upsample the mask back to the original resolution.
        text_mask = cv2.resize(text_mask, (W_orig, H_orig),
                               interpolation=cv2.INTER_NEAREST)

    result = img_rgb.copy()
    result[text_mask > 0] = 255
    return result


def _approx(contour: np.ndarray) -> list[list[float]]:
    """Simplify a cv2 contour and return [[x, y], ...] floats."""
    simplified = cv2.approxPolyDP(contour, APPROX_EPSILON_PX, closed=True)
    return simplified.reshape(-1, 2).astype(float).tolist()


def _polygons_for_class(mask: np.ndarray, class_id: int) -> list[Polygon]:
    """Extract simplified polygons (outer + holes) for one class from a label mask."""
    binary = (mask == class_id).astype(np.uint8)
    if binary.sum() == 0:
        return []

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSING_KERNEL_PX, CLOSING_KERNEL_PX))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # RETR_CCOMP returns a two-level hierarchy: top-level outer contours
    # and their immediate holes. hierarchy[i] = [next, prev, child, parent].
    contours, hierarchy = cv2.findContours(closed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]  # shape (N, 4)

    # Group child holes under their parent outer contour.
    holes_by_parent: dict[int, list[int]] = {}
    for i, (_, _, _, parent) in enumerate(hierarchy):
        if parent != -1:
            holes_by_parent.setdefault(parent, []).append(i)

    polygons: list[Polygon] = []
    for i, (_, _, _, parent) in enumerate(hierarchy):
        if parent != -1:
            continue  # this is a hole, processed via its parent
        if cv2.contourArea(contours[i]) < MIN_POLYGON_AREA_PX:
            continue
        outer = _approx(contours[i])
        if len(outer) < 3:
            continue
        holes: list[list[list[float]]] = []
        for j in holes_by_parent.get(i, []):
            if cv2.contourArea(contours[j]) < MIN_POLYGON_AREA_PX:
                continue
            ring = _approx(contours[j])
            if len(ring) >= 3:
                holes.append(ring)
        polygons.append({"outer": outer, "holes": holes})
    return polygons


import math


def refine_door_window_polygons(
    polygons: dict[str, list[Polygon]], img_gray: np.ndarray | None = None
) -> dict[str, list[Polygon]]:
    """Refine door vs window classification based on architectural drawing conventions:
    - Windows: Opening in wall containing thin parallel lines (glass & frame), contained inside wall thickness.
    - Doors: Opening in wall containing a door leaf (straight line at 45-90 deg) and a thin circular swing arc.
    """
    if "door" not in polygons and "window" not in polygons:
        return polygons

    doors = polygons.get("door", [])
    windows = polygons.get("window", [])
    all_items = []
    for p in doors:
        all_items.append({"poly": p, "initial": "door"})
    for p in windows:
        all_items.append({"poly": p, "initial": "window"})

    refined_doors: list[Polygon] = []
    refined_windows: list[Polygon] = []

    for item in all_items:
        poly = item["poly"]
        outer = np.array(poly["outer"], dtype=np.float32)
        if len(outer) < 3:
            if item["initial"] == "door":
                refined_doors.append(poly)
            else:
                refined_windows.append(poly)
            continue

        area = float(cv2.contourArea(outer))
        rect = cv2.minAreaRect(outer)
        (cx, cy), (rw, rh), angle = rect
        min_d = min(rw, rh)
        max_d = max(rw, rh)
        aspect_ratio = max_d / max(1e-3, min_d)
        extent = area / max(1e-3, rw * rh)

        is_door = False
        is_window = False

        if img_gray is not None:
            x, y, w, h = cv2.boundingRect(outer)
            if w > 4 and h > 4:
                pad = 8
                y1 = max(0, int(y - pad))
                y2 = min(img_gray.shape[0], int(y + h + pad))
                x1 = max(0, int(x - pad))
                x2 = min(img_gray.shape[1], int(x + w + pad))

                crop = img_gray[y1:y2, x1:x2]
                if crop.size > 0:
                    edges = cv2.Canny(crop, 40, 140)
                    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=12, minLineLength=8, maxLineGap=4)
                    parallel_pairs = 0
                    if lines is not None and len(lines) >= 2:
                        angles = []
                        for l in lines:
                            # cv2.HoughLinesP returns (N, 1, 4) on OpenCV 4.x but
                            # (N, 4) on 5.x — ravel() normalizes both to a flat
                            # 4-element row instead of assuming l[0] is that row.
                            lx1, ly1, lx2, ly2 = np.asarray(l).reshape(-1)[:4]
                            ang = math.atan2(ly2 - ly1, lx2 - lx1) * 180.0 / math.pi
                            angles.append(ang)
                        for idx_a in range(len(angles)):
                            for idx_b in range(idx_a + 1, len(angles)):
                                diff = abs(angles[idx_a] - angles[idx_b]) % 180.0
                                if diff < 12.0 or diff > 168.0:
                                    parallel_pairs += 1

                    circles = cv2.HoughCircles(
                        crop,
                        cv2.HOUGH_GRADIENT,
                        dp=1.2,
                        minDist=8,
                        param1=40,
                        param2=22,
                        minRadius=int(max(1, min(w, h) * 0.3)),
                        maxRadius=int(max(w, h) * 1.5),
                    )
                    has_swing_arc = circles is not None and len(circles[0]) > 0

                    if has_swing_arc or (aspect_ratio < 2.2 and extent < 0.65):
                        is_door = True
                    elif parallel_pairs >= 2 or (aspect_ratio >= 2.6 and extent >= 0.68):
                        is_window = True

        if not is_door and not is_window:
            if aspect_ratio >= 2.8 and extent >= 0.65:
                is_window = True
            elif aspect_ratio < 2.0 or extent < 0.55:
                is_door = True
            else:
                if item["initial"] == "door":
                    is_door = True
                else:
                    is_window = True

        if is_door:
            refined_doors.append(poly)
        else:
            refined_windows.append(poly)

    polygons["door"] = refined_doors
    polygons["window"] = refined_windows
    return polygons


def mask_to_polygons(mask: np.ndarray, img_gray: np.ndarray | None = None) -> dict[str, list[Polygon]]:
    """Run the per-class extraction for every structural class. Pure function on the mask."""
    res = {cls: _polygons_for_class(mask, CLASS_TO_ID[cls]) for cls in EXTRACT_CLASSES}
    return refine_door_window_polygons(res, img_gray)


def _array_to_tensor(
    img_arr: np.ndarray,
    image_size: tuple[int, int],
    letterbox: bool,
    normalize: bool,
    inner_w: int,
    inner_h: int,
) -> tuple[torch.Tensor, tuple[int, int, int, int]]:
    """Turn an (inner_h, inner_w, 3) uint8 RGB array into the model's input
    tensor, applying ImageNet normalization and letterbox padding to image_size.

    Shared by the SVG and image paths so their preprocessing is identical from
    this point on. Returns (tensor, (left, top, inner_w, inner_h)).
    """
    H, W = image_size
    image_t = torch.from_numpy(img_arr).permute(2, 0, 1).contiguous().float().div_(255.0)
    if normalize:
        mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
        image_t = (image_t - mean) / std

    if letterbox and (inner_h, inner_w) != (H, W):
        top = (H - inner_h) // 2
        left = (W - inner_w) // 2
        if normalize:
            canvas = torch.zeros(3, H, W)
        else:
            canvas = torch.tensor(IMAGENET_MEAN).view(3, 1, 1).expand(3, H, W).clone()
        canvas[:, top:top + inner_h, left:left + inner_w] = image_t
        return canvas, (left, top, inner_w, inner_h)

    return image_t, (0, 0, W, H)


def _render_input_tensor(
    svg_path: Path, image_size: tuple[int, int], letterbox: bool, normalize: bool
) -> tuple[torch.Tensor, tuple[int, int, int, int]]:
    """Render an SVG to the model's input tensor. Returns (tensor, (left, top, inner_w, inner_h)).

    Mirrors CubiCasaDataset._load so model inference here matches training-time
    preprocessing exactly. Returned content rect tells the viewer which pixels
    are real plan vs. letterbox padding.
    """
    H, W = image_size
    if letterbox:
        svg_w, svg_h = _read_svg_dims(svg_path)
        scale = min(W / svg_w, H / svg_h)
        inner_w = max(1, int(round(svg_w * scale)))
        inner_h = max(1, int(round(svg_h * scale)))
    else:
        inner_w, inner_h = W, H

    png = render_input_png(svg_path, out_size=(inner_w, inner_h))
    img = np.array(Image.open(BytesIO(png)).convert("RGB"))
    return _array_to_tensor(img, image_size, letterbox, normalize, inner_w, inner_h)


def _image_to_tensor(
    img: Image.Image, image_size: tuple[int, int], letterbox: bool, normalize: bool
) -> tuple[torch.Tensor, tuple[int, int, int, int]]:
    """Render a PIL image (uploaded PNG/JPG) to the model's input tensor.

    Same letterbox + normalize semantics as ``_render_input_tensor``, but the
    source is a raster image rather than an SVG, so we resize with PIL instead
    of re-rasterizing via cairosvg. This lets the server accept plain image
    uploads in addition to CubiCasa ``model.svg`` files.

    A text-removal pass runs *before* resizing so it operates at the full
    uploaded resolution where stroke widths are most distinct.  Thin-stroke
    text glyphs (room labels, titles, dimensions) are painted white; thick-
    stroke structural ink (walls, door frames) is left intact.
    """
    H, W = image_size
    img = img.convert("RGB")
    W0, H0 = img.size  # PIL uses (width, height)

    # --- Text-removal preprocessing (at full upload resolution) ---------------
    arr_original = np.array(img)
    arr_clean = _erase_text_from_blueprint(arr_original)
    img = Image.fromarray(arr_clean)
    # --------------------------------------------------------------------------

    if letterbox:
        scale = min(W / W0, H / H0)
        inner_w = max(1, int(round(W0 * scale)))
        inner_h = max(1, int(round(H0 * scale)))
    else:
        inner_w, inner_h = W, H

    if (inner_w, inner_h) != (W0, H0):
        img = img.resize((inner_w, inner_h), Image.BILINEAR)
    arr = np.array(img)
    return _array_to_tensor(arr, image_size, letterbox, normalize, inner_w, inner_h)


def _resolve_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class PolygonExtractor:
    """Stateful wrapper: load the model once, then extract for many SVGs.

    The server uses this to keep the model warm across requests; the CLI
    uses it for one shot.
    """

    def __init__(self, run_dir: Path, ckpt: str = "best.safetensors", device: str = "auto") -> None:
        cfg_path = run_dir / "config.yaml"
        ckpt_path = run_dir / ckpt
        with cfg_path.open() as f:
            self.cfg = yaml.safe_load(f)

        self.device = _resolve_device(device)
        self.image_size: tuple[int, int] = tuple(self.cfg["data"]["image_size"])  # (H, W)
        self.letterbox: bool = self.cfg["data"].get("letterbox", False)
        self.normalize: bool = self.cfg["data"]["normalize"]

        self.model = build_model(
            encoder_name=self.cfg["model"]["encoder_name"],
            encoder_weights=None,
        ).to(self.device)
        state, self.epoch = load_inference_checkpoint(ckpt_path, self.device)
        self.model.load_state_dict(state)
        self.model.eval()

    @torch.no_grad()
    def predict_mask(self, svg_path: Path) -> tuple[np.ndarray, tuple[int, int, int, int]]:
        """Run the model on one SVG. Returns (mask H×W uint8, content rect)."""
        image_t, rect = _render_input_tensor(svg_path, self.image_size, self.letterbox, self.normalize)
        logits = self.model(image_t.unsqueeze(0).to(self.device))
        mask = logits.argmax(dim=1).squeeze(0).to("cpu", torch.uint8).numpy()
        return mask, rect

    def predict_mask_from_image(self, img: Image.Image) -> tuple[np.ndarray, tuple[int, int, int, int]]:
        """Run the model on a PIL image (PNG/JPG upload). Returns (mask, content rect)."""
        image_t, rect = _image_to_tensor(img, self.image_size, self.letterbox, self.normalize)
        logits = self.model(image_t.unsqueeze(0).to(self.device))
        mask = logits.argmax(dim=1).squeeze(0).to("cpu", torch.uint8).numpy()
        return mask, rect

    def _result_from_mask(
        self, mask: np.ndarray, left: int, top: int, inner_w: int, inner_h: int, img_gray: np.ndarray | None = None
    ) -> ExtractionResult:
        # Zero out letterbox padding so we don't extract polygons from the
        # gray border. The model is well-behaved here in practice (predicts
        # floor) but the closing op can otherwise pull stray pixels outward.
        if (inner_h, inner_w) != mask.shape:
            cleaned = np.full_like(mask, FLOOR_ID)
            cleaned[top:top + inner_h, left:left + inner_w] = mask[top:top + inner_h, left:left + inner_w]
            mask = cleaned

        H, W = mask.shape
        return {
            "canvas_size": [W, H],
            "content_rect": [left, top, inner_w, inner_h],
            "polygons": mask_to_polygons(mask, img_gray),
        }

    def extract(self, svg_path: Path) -> ExtractionResult:
        mask, (left, top, inner_w, inner_h) = self.predict_mask(svg_path)
        return self._result_from_mask(mask, left, top, inner_w, inner_h)

    def extract_from_image(self, img: Image.Image) -> ExtractionResult:
        """Same as extract(), but the input is a PIL image instead of an SVG path."""
        img_gray = np.array(img.convert("L"))
        mask, (left, top, inner_w, inner_h) = self.predict_mask_from_image(img)
        return self._result_from_mask(mask, left, top, inner_w, inner_h, img_gray)


def _denormalize_to_pil(image_t: torch.Tensor, normalize: bool) -> Image.Image:
    """Undo ImageNet normalization (if applied) and convert (3,H,W) → PIL RGB."""
    if normalize:
        mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
        img = (image_t * std + mean).clamp(0, 1)
    else:
        img = image_t.clamp(0, 1)
    arr = (img.permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
    return Image.fromarray(arr)


def _colorize_mask(mask: np.ndarray) -> Image.Image:
    """Map class-index mask to RGB using the per-class color table."""
    rgb = np.zeros((*mask.shape, 3), dtype=np.uint8)
    for idx, name in enumerate(CLASS_NAMES):
        rgb[mask == idx] = CLASS_COLORS[name]
    return Image.fromarray(rgb)


def _draw_polygons(base: Image.Image, polygons: dict[str, list[Polygon]]) -> Image.Image:
    """Render polygons over `base` with semi-transparent fills, bright outlines,
    and vertex dots so simplification artifacts are visible at a glance.
    """
    canvas = base.convert("RGBA")
    fill_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    fdraw = ImageDraw.Draw(fill_layer)

    for cls in EXTRACT_CLASSES:
        r, g, b = CLASS_COLORS[cls]
        fill_rgba = (r, g, b, 90)  # ~35% alpha — visible but doesn't hide the input
        for poly in polygons[cls]:
            outer = [(x, y) for x, y in poly["outer"]]
            if len(outer) >= 3:
                fdraw.polygon(outer, fill=fill_rgba)
            for hole in poly["holes"]:
                # Holes punch back to fully transparent so the original input
                # image shows through where the model said "not this class".
                fdraw.polygon([(x, y) for x, y in hole], fill=(0, 0, 0, 0))

    canvas = Image.alpha_composite(canvas, fill_layer)
    odraw = ImageDraw.Draw(canvas)

    for cls in EXTRACT_CLASSES:
        r, g, b = CLASS_COLORS[cls]
        outline = (r, g, b, 255)
        for poly in polygons[cls]:
            rings = [poly["outer"]] + poly["holes"]
            for ring in rings:
                pts = [(x, y) for x, y in ring]
                if len(pts) >= 2:
                    odraw.line(pts + [pts[0]], fill=outline, width=1)
                # Vertex dots — 2px radius. Small enough not to swamp the image,
                # large enough to see whether approxPolyDP was over- or under-eager.
                for x, y in pts:
                    odraw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=outline)

    return canvas.convert("RGB")


def _hconcat_with_titles(images: list[Image.Image], titles: list[str]) -> Image.Image:
    """Side-by-side panel with a small label strip on top — keeps dimensions
    aligned even if a panel comes from a different source size."""
    label_h = 24
    h = max(im.height for im in images)
    w = sum(im.width for im in images)
    out = Image.new("RGB", (w, h + label_h), (255, 255, 255))
    draw = ImageDraw.Draw(out)
    x = 0
    for im, title in zip(images, titles):
        out.paste(im, (x, label_h))
        draw.text((x + 6, 4), title, fill=(20, 20, 20))
        x += im.width
    return out


def render_debug_panel(
    image_t: torch.Tensor,
    mask: np.ndarray,
    result: ExtractionResult,
    normalize: bool,
) -> Image.Image:
    """Three panels: input | predicted mask | polygons overlaid on input."""
    input_img = _denormalize_to_pil(image_t, normalize)
    mask_img = _colorize_mask(mask)
    overlay_img = _draw_polygons(input_img, result["polygons"])
    return _hconcat_with_titles(
        [input_img, mask_img, overlay_img],
        ["input", "predicted mask", "polygons"],
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--svg", required=True, type=Path, help="path to a CubiCasa model.svg")
    p.add_argument("--run-dir", required=True, type=Path, help="trained run dir (with best.pt + config.yaml)")
    p.add_argument("--ckpt", default="best.pt")
    p.add_argument("--out", required=True, type=Path, help="output JSON path")
    p.add_argument(
        "--debug-png",
        type=Path,
        default=None,
        help="if set, also write a 3-panel debug PNG (input | mask | polygons)",
    )
    p.add_argument("--device", default="auto")
    args = p.parse_args()

    extractor = PolygonExtractor(args.run_dir, ckpt=args.ckpt, device=args.device)
    print(f"device: {extractor.device}   epoch: {extractor.epoch}")

    if args.debug_png is None:
        result = extractor.extract(args.svg)
    else:
        # Debug path: keep the input tensor + raw mask around so we can render
        # the overlay. Reuses the same predict_mask call as the JSON path.
        image_t, rect = _render_input_tensor(
            args.svg, extractor.image_size, extractor.letterbox, extractor.normalize
        )
        with torch.no_grad():
            logits = extractor.model(image_t.unsqueeze(0).to(extractor.device))
        mask = logits.argmax(dim=1).squeeze(0).to("cpu", torch.uint8).numpy()
        left, top, inner_w, inner_h = rect
        if (inner_h, inner_w) != mask.shape:
            cleaned = np.full_like(mask, FLOOR_ID)
            cleaned[top:top + inner_h, left:left + inner_w] = mask[top:top + inner_h, left:left + inner_w]
            mask = cleaned
        H, W = mask.shape
        result: ExtractionResult = {
            "canvas_size": [W, H],
            "content_rect": list(rect),
            "polygons": mask_to_polygons(mask),
        }
        panel = render_debug_panel(image_t, mask, result, extractor.normalize)
        panel.save(args.debug_png)
        print(f"wrote {args.debug_png}")

    args.out.write_text(json.dumps(result))
    n_per_class = {k: len(v) for k, v in result["polygons"].items()}
    print(f"wrote {args.out}   polygons: {n_per_class}")


if __name__ == "__main__":
    main()
