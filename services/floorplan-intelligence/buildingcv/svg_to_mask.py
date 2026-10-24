"""Convert a CubiCasa5K `model.svg` into a per-pixel class mask.

The SVG is XML with nested <g> groups carrying class attributes. Architectural
elements appear as polygons (and occasionally rects) whose class — directly or
inherited from an ancestor group — names them. We walk the tree, collect every
fillable shape with a recognized class, and paint them onto a 2D array in the
order defined by PAINT_ORDER.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .labels import CLASS_TO_ID, FLOOR_ID, PAINT_ORDER, TOKEN_TO_CLASS

SVG_NS = "{http://www.w3.org/2000/svg}"
_POLYGON_TAG = f"{SVG_NS}polygon"
_RECT_TAG = f"{SVG_NS}rect"


def _classify(tokens: frozenset[str]) -> str | None:
    for token, cls in TOKEN_TO_CLASS.items():
        if token in tokens:
            return cls
    return None


def _is_hidden(elem: ET.Element) -> bool:
    """True if the element (or its style) explicitly hides it from rendering.

    cairosvg honors `display:none` and `visibility:hidden` when rasterizing
    the input image. Without this check, svg_to_mask would still paint the
    hidden subtrees onto the mask — which is exactly the bug behind GT masks
    containing multiple floor plans (Floor 2/3 are display:none) while the
    input image shows only Floor 1.
    """
    if elem.get("display") == "none" or elem.get("visibility") == "hidden":
        return True
    style = elem.get("style") or ""
    return "display:none" in style.replace(" ", "") or "visibility:hidden" in style.replace(" ", "")


def _polygon_points(elem: ET.Element) -> list[tuple[float, float]]:
    raw = (elem.get("points") or "").replace(",", " ").split()
    coords = [float(x) for x in raw]
    return list(zip(coords[0::2], coords[1::2]))


def _rect_points(elem: ET.Element) -> list[tuple[float, float]]:
    x = float(elem.get("x", 0))
    y = float(elem.get("y", 0))
    w = float(elem.get("width", 0))
    h = float(elem.get("height", 0))
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def _collect(
    elem: ET.Element,
    inherited: frozenset[str],
    out: dict[str, list[list[tuple[float, float]]]],
) -> None:
    if _is_hidden(elem):
        return

    own = elem.get("class")
    tokens = inherited | (frozenset(own.split()) if own else frozenset())

    points: list[tuple[float, float]] | None = None
    if elem.tag == _POLYGON_TAG:
        points = _polygon_points(elem)
    elif elem.tag == _RECT_TAG:
        points = _rect_points(elem)

    if points is not None and len(points) >= 3:
        cls = _classify(tokens)
        if cls is not None:
            out.setdefault(cls, []).append(points)

    for child in elem:
        _collect(child, tokens, out)


def svg_to_mask(
    svg_path: str | Path,
    size: tuple[int, int] | None = None,
) -> np.ndarray:
    """Rasterize a CubiCasa SVG into a per-pixel class mask.

    Args:
        svg_path: path to a CubiCasa `model.svg`.
        size: (W, H) in pixels for the output. If None, the SVG's native
            viewBox/width/height is used.

    Returns:
        uint8 ndarray of shape (H, W). Each value is a class index in
        [0, NUM_CLASSES). 0 = floor (default fill).
    """
    root = ET.parse(svg_path).getroot()

    viewbox = (root.get("viewBox") or "").split()
    svg_w = float(root.get("width") or (viewbox[2] if len(viewbox) == 4 else 0))
    svg_h = float(root.get("height") or (viewbox[3] if len(viewbox) == 4 else 0))
    if svg_w <= 0 or svg_h <= 0:
        raise ValueError(f"could not determine SVG size for {svg_path}")

    if size is None:
        out_w, out_h = int(round(svg_w)), int(round(svg_h))
        sx = sy = 1.0
    else:
        out_w, out_h = size
        sx = out_w / svg_w
        sy = out_h / svg_h

    polys_by_class: dict[str, list[list[tuple[float, float]]]] = {}
    _collect(root, frozenset(), polys_by_class)

    mask_img = Image.new("L", (out_w, out_h), color=FLOOR_ID)
    draw = ImageDraw.Draw(mask_img)
    for cls in PAINT_ORDER:
        idx = CLASS_TO_ID[cls]
        for pts in polys_by_class.get(cls, []):
            draw.polygon([(x * sx, y * sy) for x, y in pts], fill=idx)

    return np.array(mask_img, dtype=np.uint8)
