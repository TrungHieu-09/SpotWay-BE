"""SpotWay floor-plan intelligence service: tiled high-resolution wall drafts."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

import cv2
import httpx
import numpy as np
import torch
import torch.nn as nn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl

MODEL_PATH = os.getenv("FLOORPLAN_MODEL_PATH", "models/stitch-unet.pth")
PATCH_SIZE = 256
PATCH_STRIDE = int(os.getenv("FLOORPLAN_TILE_STRIDE", "128"))
WALL_THRESHOLD = float(os.getenv("FLOORPLAN_WALL_THRESHOLD", "0.5"))
DARK_INK_THRESHOLD = int(os.getenv("FLOORPLAN_DARK_INK_THRESHOLD", "110"))
NEUTRAL_INK_CHROMA_MAX = int(os.getenv("FLOORPLAN_NEUTRAL_INK_CHROMA_MAX", "40"))
model: nn.Module | None = None


class DoubleConv(nn.Module):
    def __init__(self, input_channels: int, output_channels: int):
        super().__init__()
        # Keep `conv` compatible with the public checkpoint's state-dict.
        self.conv = nn.Sequential(
            nn.Conv2d(input_channels, output_channels, 3, padding=1), nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True),
            nn.Conv2d(output_channels, output_channels, 3, padding=1), nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True),
        )

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.conv(value)


class TiledWallUNet(nn.Module):
    """Binary UNet compatible with the approved MIT STITCH checkpoint."""
    def __init__(self):
        super().__init__()
        self.d1, self.p1 = DoubleConv(3, 64), nn.MaxPool2d(2)
        self.d2, self.p2 = DoubleConv(64, 128), nn.MaxPool2d(2)
        self.d3, self.p3 = DoubleConv(128, 256), nn.MaxPool2d(2)
        self.b = DoubleConv(256, 512)
        self.u3, self.c3 = nn.ConvTranspose2d(512, 256, 2, stride=2), DoubleConv(512, 256)
        self.u2, self.c2 = nn.ConvTranspose2d(256, 128, 2, stride=2), DoubleConv(256, 128)
        self.u1, self.c1 = nn.ConvTranspose2d(128, 64, 2, stride=2), DoubleConv(128, 64)
        self.out = nn.Conv2d(64, 1, 1)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        d1 = self.d1(value)
        d2 = self.d2(self.p1(d1))
        d3 = self.d3(self.p2(d2))
        value = self.c3(torch.cat([self.u3(self.b(self.p3(d3))), d3], dim=1))
        value = self.c2(torch.cat([self.u2(value), d2], dim=1))
        return self.out(self.c1(torch.cat([self.u1(value), d1], dim=1)))


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    if os.path.isfile(MODEL_PATH):
        candidate = TiledWallUNet()
        try:
            weights = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
        except TypeError:
            weights = torch.load(MODEL_PATH, map_location="cpu")
        candidate.load_state_dict(weights, strict=True)
        candidate.eval()
        model = candidate
    yield


app = FastAPI(title="SpotWay Floor-plan Intelligence", version="2.0.0", lifespan=lifespan)


class AnalyzeRequest(BaseModel):
    imageUrl: HttpUrl
    floorId: str


class NavigationAnalyzeRequest(AnalyzeRequest):
    """Raw-image navigation suggestions for manager review; never persisted here."""


def navigation_draft(image_bgr: np.ndarray) -> dict[str, Any]:
    """Suggest a sparse walkable graph and possible stair zones.

    Suggestions are deliberately conservative and carry no authority: a
    manager must confirm, move, delete or reclassify every proposed node
    before it can become a live navigation graph.
    """
    structural = structural_floorplan(image_bgr)
    wall_mask = cv2.cvtColor(structural, cv2.COLOR_BGR2GRAY) < 128
    height, width = wall_mask.shape
    walkable = (~wall_mask).astype(np.uint8) * 255
    safe_radius = max(3, round(min(height, width) * .006))
    safe = cv2.erode(walkable, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (safe_radius * 2 + 1, safe_radius * 2 + 1)))

    def is_safe(x: int, y: int) -> bool:
        return 0 <= x < width and 0 <= y < height and safe[y, x] > 0

    nodes: list[dict[str, Any]] = []
    # A coarse, free-space sampling avoids presenting a dense and unsafe graph.
    for gy in range(1, 8):
        for gx in range(1, 10):
            x, y = round(width * gx / 10), round(height * gy / 8)
            if is_safe(x, y):
                nodes.append({"id": f"n-{len(nodes) + 1}", "x": round(x / width * 100, 2), "y": round(y / height * 100, 2), "type": "NORMAL", "accessible": True, "confidence": .42, "requiresConfirmation": True})

    # Only join nearby candidates when the full segment stays in safe free space.
    def clear_segment(first: dict[str, Any], second: dict[str, Any]) -> bool:
        x1, y1 = round(first["x"] / 100 * width), round(first["y"] / 100 * height)
        x2, y2 = round(second["x"] / 100 * width), round(second["y"] / 100 * height)
        samples = max(2, round(np.hypot(x2 - x1, y2 - y1) / max(3, safe_radius)))
        return all(is_safe(round(x1 + (x2 - x1) * t / samples), round(y1 + (y2 - y1) * t / samples)) for t in range(samples + 1))

    edges: list[dict[str, Any]] = []
    for index, node in enumerate(nodes):
        nearest = sorted((other for other in nodes[index + 1:]), key=lambda other: (other["x"] - node["x"]) ** 2 + (other["y"] - node["y"]) ** 2)[:3]
        for other in nearest:
            distance = float(np.hypot(other["x"] - node["x"], other["y"] - node["y"]))
            if distance <= 18 and clear_segment(node, other):
                edges.append({"id": f"e-{len(edges) + 1}", "fromNodeId": node["id"], "toNodeId": other["id"], "accessible": True, "confidence": .35, "requiresConfirmation": True})

    return {"nodes": nodes, "edges": edges, "warnings": ["Đây là gợi ý đường đi từ ảnh. Manager phải xác nhận và chỉnh sửa trước khi áp dụng.", "Cầu thang, thang cuốn và thang máy cần được Manager đánh dấu/xác nhận trên bản vẽ thực tế."], "image": {"width": width, "height": height}}


def tile_positions(length: int) -> list[int]:
    end = max(0, length - PATCH_SIZE)
    values = list(range(0, end + 1, PATCH_STRIDE)) or [0]
    return values if values[-1] == end else [*values, end]


def structural_floorplan(image_bgr: np.ndarray) -> np.ndarray:
    """Return a black-and-white structural mask suitable for 3D extraction.

    Only dark, near-neutral ink survives. This deliberately removes blue/red
    doors, coloured markup, text and thin dashed/dimension strokes before any
    model or the external FloorPlanTo3D API sees the image.
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    bgr = image_bgr.astype(np.int16)
    chroma = bgr.max(axis=2) - bgr.min(axis=2)

    # Blue is dark in grayscale, so grayscale-only thresholding is unsafe.
    # Requiring neutral ink removes all coloured drawing conventions, including
    # blue door swings and blue dashed annotations.
    dark_neutral_ink = (gray <= DARK_INK_THRESHOLD) & (chroma <= NEUTRAL_INK_CHROMA_MAX)
    ink = dark_neutral_ink.astype(np.uint8) * 255

    # Walls are materially thicker than text, hatching, stair treads and
    # dimension dashes. Keep only the thick centre of each stroke, then expand
    # it back to a stable mask. The scale adapts to imported image resolution.
    minimum_half_width = max(2, round(min(image_bgr.shape[:2]) * 0.0025))
    thickness = cv2.distanceTransform(ink, cv2.DIST_L2, 5)
    wall_centres = (thickness >= minimum_half_width).astype(np.uint8) * 255
    diameter = minimum_half_width * 2 - 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (diameter, diameter))
    mask = cv2.dilate(wall_centres, kernel)

    # PNG is intentionally strict: black structural geometry on white only.
    cleaned = np.full_like(gray, 255)
    cleaned[mask > 0] = 0
    return cv2.cvtColor(cleaned, cv2.COLOR_GRAY2BGR)


def wall_probability(image: np.ndarray) -> np.ndarray:
    image = structural_floorplan(image)

    if model is not None:
        source = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        height, width = source.shape[:2]
        pad_y, pad_x = max(1, round(height * .05)), max(1, round(width * .05))
        padded = cv2.copyMakeBorder(source, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_REFLECT_101)
        blended = np.zeros(padded.shape[:2], dtype=np.float32)
        weight_sum = np.zeros_like(blended)
        ys, xs = np.ogrid[-1:1:complex(PATCH_SIZE), -1:1:complex(PATCH_SIZE)]
        weight = np.exp(-(xs**2 + ys**2) * 4).astype(np.float32)
        for y in tile_positions(padded.shape[0]):
            for x in tile_positions(padded.shape[1]):
                tile = padded[y:y + PATCH_SIZE, x:x + PATCH_SIZE]
                if tile.shape[:2] != (PATCH_SIZE, PATCH_SIZE):
                    tile = cv2.copyMakeBorder(tile, 0, PATCH_SIZE - tile.shape[0], 0, PATCH_SIZE - tile.shape[1], cv2.BORDER_REFLECT_101)
                tensor = torch.from_numpy(tile.astype(np.float32).transpose(2, 0, 1) / 255.).unsqueeze(0)
                with torch.inference_mode():
                    prediction = torch.sigmoid(model(tensor)).squeeze().cpu().numpy()
                blended[y:y + PATCH_SIZE, x:x + PATCH_SIZE] += prediction * weight
                weight_sum[y:y + PATCH_SIZE, x:x + PATCH_SIZE] += weight
        probability = blended / np.maximum(weight_sum, 1e-8)
        return probability[pad_y:pad_y + height, pad_x:pad_x + width]

    # Classical CV fallback when U-Net weights are not loaded:
    # Use dark ink only (structural walls + columns)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    is_wall = (gray < 90).astype(np.uint8) * 255
    cleaned = cv2.morphologyEx(is_wall, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)))
    return (cleaned / 255.0).astype(np.float32)


def walls_from_probability(probability: np.ndarray, floor_id: str) -> list[dict[str, Any]]:
    binary = (probability >= WALL_THRESHOLD).astype(np.uint8) * 255
    height, width = binary.shape

    # Directional morphological closing to bridge door openings & gaps (Janavee01/floorplan pattern)
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 1))
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 15))
    closed_h = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel_h)
    closed_v = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel_v)
    closed = cv2.bitwise_or(closed_h, closed_v)
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))

    # HoughLinesP with threshold calibrated for room partitions
    threshold = max(20, min(height, width) // 28)
    min_line_len = max(18, min(height, width) // 30)
    max_line_gap = max(12, min(height, width) // 25)

    lines = cv2.HoughLinesP(
        closed, 1, np.pi / 180,
        threshold=threshold,
        minLineLength=min_line_len,
        maxLineGap=max_line_gap
    )

    if lines is None:
        return []

    raw_segments: list[tuple[float, float, float, float]] = []

    for line in lines:
        x1, y1, x2, y2 = map(int, line[0])
        px1 = round(x1 / width * 100, 3)
        py1 = round(y1 / height * 100, 3)
        px2 = round(x2 / width * 100, 3)
        py2 = round(y2 / height * 100, 3)

        # Ignore outer boundary border & dimension lines
        if (px1 <= 2.8 and px2 <= 2.8) or (px1 >= 97.5 and px2 >= 97.5):
            continue
        if (py1 <= 2.8 and py2 <= 2.8) or (py1 >= 93.8 and py2 >= 93.8):
            continue

        dx = abs(px2 - px1)
        dy = abs(py2 - py1)
        if np.hypot(dx, dy) < 4.2:
            continue

        # Rectilinear snapping for almost horizontal/vertical lines (within 3 degrees)
        angle_deg = np.degrees(np.arctan2(dy, dx))
        if angle_deg <= 3.0:
            avg_y = round((py1 + py2) / 2, 2)
            py1 = py2 = avg_y
        elif angle_deg >= 87.0:
            avg_x = round((px1 + px2) / 2, 2)
            px1 = px2 = avg_x

        # Normalize direction
        if px1 > px2 or (px1 == px2 and py1 > py2):
            px1, px2 = px2, px1
            py1, py2 = py2, py1

        raw_segments.append((px1, py1, px2, py2))

    # Collinear deduplication & merging (eliminate double-walls from line thickness)
    merged_segments: list[tuple[float, float, float, float]] = []
    for seg in raw_segments:
        x1, y1, x2, y2 = seg
        is_merged = False
        is_horiz = abs(y2 - y1) < 0.1
        is_vert = abs(x2 - x1) < 0.1

        for i, existing in enumerate(merged_segments):
            ex1, ey1, ex2, ey2 = existing
            ex_horiz = abs(ey2 - ey1) < 0.1
            ex_vert = abs(ex2 - ex1) < 0.1

            # Merge horizontal lines that are close in Y and overlap or touch in X
            if is_horiz and ex_horiz and abs(y1 - ey1) <= 1.2:
                if not (x2 < ex1 - 3.0 or x1 > ex2 + 3.0):
                    new_x1 = min(x1, ex1)
                    new_x2 = max(x2, ex2)
                    new_y = round((y1 + ey1) / 2, 2)
                    merged_segments[i] = (new_x1, new_y, new_x2, new_y)
                    is_merged = True
                    break

            # Merge vertical lines that are close in X and overlap or touch in Y
            elif is_vert and ex_vert and abs(x1 - ex1) <= 1.2:
                if not (y2 < ey1 - 3.0 or y1 > ey2 + 3.0):
                    new_y1 = min(y1, ey1)
                    new_y2 = max(y2, ey2)
                    new_x = round((x1 + ex1) / 2, 2)
                    merged_segments[i] = (new_x, new_y1, new_x, new_y2)
                    is_merged = True
                    break

        if not is_merged:
            merged_segments.append(seg)

    result: list[dict[str, Any]] = []
    for idx, (x1, y1, x2, y2) in enumerate(merged_segments):
        result.append({
            "id": f"wall-{floor_id}-{idx}",
            "x1": round(x1, 2),
            "y1": round(y1, 2),
            "x2": round(x2, 2),
            "y2": round(y2, 2),
            "confidence": 0.85
        })
    return result


def polygons_from_mask(mask: np.ndarray, width: int, height: int) -> dict[str, list[dict[str, Any]]]:
    """CubiCasa5K contour extraction: outer boundary plus internal door/window hole cutouts."""
    binary = (mask * 255).astype(np.uint8) if mask.dtype != np.uint8 else mask
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    contours, hierarchy = cv2.findContours(closed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None or len(contours) == 0:
        return {"wall": [], "door": [], "window": []}

    wall_polys = []
    door_polys = []
    hierarchy = hierarchy[0]
    for i, h in enumerate(hierarchy):
        if h[3] != -1:
            continue  # hole, will be collected by parent
        outer_contour = cv2.approxPolyDP(contours[i], 1.5, True)
        if cv2.contourArea(outer_contour) < 30.0:
            continue

        outer_pts = [[round(float(pt[0][0]) / width * 100, 2), round(float(pt[0][1]) / height * 100, 2)] for pt in outer_contour]
        holes = []
        child_idx = h[2]
        while child_idx != -1:
            child_contour = cv2.approxPolyDP(contours[child_idx], 1.5, True)
            area = cv2.contourArea(child_contour)
            if area >= 12.0:
                hole_pts = [[round(float(pt[0][0]) / width * 100, 2), round(float(pt[0][1]) / height * 100, 2)] for pt in child_contour]
                holes.append(hole_pts)
                if area <= 350.0:
                    door_polys.append({"outer": hole_pts, "holes": []})
            child_idx = hierarchy[child_idx][0]

        wall_polys.append({
            "outer": outer_pts,
            "holes": holes
        })

    return {"wall": wall_polys, "door": door_polys, "window": []}


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok" if model else "model-unavailable", "modelPath": MODEL_PATH, "engine": "CubiCasa5k FloorPlanTo3D Intelligence", "ocr": False}


@app.post("/v1/analyze")
async def analyze(payload: AnalyzeRequest) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            response = await client.get(str(payload.imageUrl))
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(
            422,
            f"Unable to download the floor-plan image ({error}). Check that its storage URL is accessible.",
        ) from error
    image = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(422, "The uploaded asset is not a supported raster floor-plan image")
    structural_image = structural_floorplan(image)
    structural_probability = (
        cv2.cvtColor(structural_image, cv2.COLOR_BGR2GRAY) < 128
    ).astype(np.float32)
    labels: list[dict[str, Any]] = []

    # 1. Forward to external FloorPlanTo3D-API-v2 if running on port 8000
    external_url = os.getenv("FLOORPLANTO3D_API_URL", "http://localhost:8000")
    try:
        encoded, structural_png = cv2.imencode(".png", structural_image)
        if not encoded:
            raise RuntimeError("Could not encode the normalized floor plan")
        async with httpx.AsyncClient(timeout=15) as client:
            # Do not give the 3D extractor the raw upload: its blue symbols,
            # labels and dashed lines otherwise become fake walls/openings.
            files = {"file": ("structure-mask.png", structural_png.tobytes(), "image/png")}
            ext_resp = await client.post(f"{external_url}/extract", files=files)
            if ext_resp.status_code == 200:
                data = ext_resp.json()
                if "polygons" in data:
                    content_rect = data.get("content_rect", [0, 0, image.shape[1], image.shape[0]])
                    scale_w = content_rect[2] if content_rect[2] > 0 else image.shape[1]
                    scale_h = content_rect[3] if content_rect[3] > 0 else image.shape[0]
                    norm_polys: dict[str, Any] = {}
                    for cls_name, poly_list in data["polygons"].items():
                        norm_list = []
                        for poly in poly_list:
                            outer = [[round(float(x) / scale_w * 100, 2), round(float(y) / scale_h * 100, 2)] for x, y in poly.get("outer", [])]
                            holes = []
                            for h in poly.get("holes", []):
                                holes.append([[round(float(x) / scale_w * 100, 2), round(float(y) / scale_h * 100, 2)] for x, y in h])
                            norm_list.append({"outer": outer, "holes": holes})
                        norm_polys[cls_name] = norm_list

                    return {
                        "engine": {"name": "FloorPlanTo3D-API-v2", "model": "CubiCasa5K ResNet-34 UNet", "version": "2.0"},
                        "image": {"width": int(image.shape[1]), "height": int(image.shape[0])},
                        "polygons": norm_polys,
                        "walls": walls_from_probability(structural_probability, payload.floorId),
                        "openings": [],
                        "labels": labels,
                        "needsReview": False
                    }
    except Exception:
        pass

    # 2. Built-in CubiCasa contour polygon extractor fallback
    # The legacy local U-Net is expensive on CPU. Only run it if the primary
    # CubiCasa-trained FloorPlanTo3D API is unavailable or rejects the image.
    probability = wall_probability(image)
    polygons = polygons_from_mask((probability >= WALL_THRESHOLD).astype(np.uint8) * 255, image.shape[1], image.shape[0])

    return {
        "engine": {"name": "spotway-cubicasa-intelligence", "model": "CubiCasa5K Contour Extractor", "version": "2.0"},
        "image": {"width": int(image.shape[1]), "height": int(image.shape[0])},
        "polygons": polygons,
        "walls": walls_from_probability(probability, payload.floorId),
        "openings": [],
        "labels": labels,
        "symbols": [],
        "warnings": [],
        "needsReview": False
    }


@app.post("/v1/navigation-analyze")
async def analyze_navigation(payload: NavigationAnalyzeRequest) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            response = await client.get(str(payload.imageUrl))
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(422, f"Unable to download the floor-plan image ({error}).") from error

    image = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(422, "The uploaded asset is not a supported raster floor-plan image")
    return navigation_draft(image)
