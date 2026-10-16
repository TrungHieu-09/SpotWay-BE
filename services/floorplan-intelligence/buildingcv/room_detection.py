"""Detect enclosed room candidates from a structural segmentation mask."""

from __future__ import annotations

import math
from typing import Literal, TypedDict

import cv2
import numpy as np

from .labels import CLASS_TO_ID

CLOSING_KERNEL_PX = 7
IOU_DUPLICATE_THRESHOLD = 0.70


class Point(TypedDict):
    x: float
    y: float


class Geometry(TypedDict):
    type: str
    points: list[Point]
    center: Point


class ExistingSpace(TypedDict):
    id: str
    geometry: dict[str, list[Point]]


class DetectedRoom(TypedDict):
    client_id: str
    suggested_label: str
    suggested_type: Literal["ROOM"]
    confidence: float
    geometry: Geometry
    area_px2: float
    area_sq_m: None
    boundary_status: Literal["closed"]


def _canvas_to_source(
    point: tuple[float, float],
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> Point:
    left, top, inner_width, inner_height = content_rect
    source_width, source_height = source_image_size
    return {
        "x": round((point[0] - left) * source_width / inner_width, 3),
        "y": round((point[1] - top) * source_height / inner_height, 3),
    }


def _source_to_canvas(
    point: Point,
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> tuple[float, float]:
    left, top, inner_width, inner_height = content_rect
    source_width, source_height = source_image_size
    return (
        left + point["x"] * inner_width / source_width,
        top + point["y"] * inner_height / source_height,
    )


def _polygon_area(points: list[Point]) -> float:
    if len(points) < 3:
        return 0.0
    area = 0.0
    for index, point in enumerate(points):
        following = points[(index + 1) % len(points)]
        area += point["x"] * following["y"] - following["x"] * point["y"]
    return abs(area) / 2.0


def _enclosed_components(barrier: np.ndarray) -> list[np.ndarray]:
    """Extract individual room components inside the building, sealing doorway gaps."""
    height, width = barrier.shape

    # 1. Morphological closing to seal open doorway openings and archways (up to ~65px)
    close_size = max(5, min(65, min(height, width) // 3))
    if close_size % 2 == 0:
        close_size += 1
    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
    sealed = cv2.morphologyEx(barrier, cv2.MORPH_CLOSE, close_kernel)

    # 2. Flood fill from the 4 outer image borders to identify TRUE exterior background
    inv_sealed = ((sealed == 0).astype(np.uint8)) * 255
    exterior_mask = np.zeros((height + 2, width + 2), dtype=np.uint8)

    for seed in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]:
        cv2.floodFill(inv_sealed, exterior_mask, seed, 128)

    is_exterior = (inv_sealed == 128)

    # 3. Interior floor space is open space inside building footprint that is NOT exterior background
    room_space = (barrier == 0) & (~is_exterior) & (sealed == 0)

    labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(room_space.astype(np.uint8), connectivity=8)
    components: list[np.ndarray] = []

    for label in range(1, labels_count):
        x, y, comp_w, comp_h, comp_area = stats[label]
        touches_border = (x == 0 or y == 0 or x + comp_w == width or y + comp_h == height)
        if not touches_border and comp_area >= 100:
            components.append((labels == label).astype(np.uint8))

    return components


def _polygon_iou_masks(poly1: np.ndarray, poly2: np.ndarray, shape: tuple[int, int]) -> float:
    """Calculate IoU between two polygon point arrays."""
    if len(poly1) < 3 or len(poly2) < 3:
        return 0.0
    m1 = np.zeros(shape, dtype=np.uint8)
    m2 = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(m1, [poly1.astype(np.int32)], 1)
    cv2.fillPoly(m2, [poly2.astype(np.int32)], 1)
    union = np.logical_or(m1, m2).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(m1, m2).sum() / union)


def _create_building_footprint_mask(polygons: dict[str, list[dict]], shape: tuple[int, int]) -> np.ndarray | None:
    """Create a binary mask representing the convex hull of all building structure elements."""
    all_pts: list[list[int]] = []
    for category in ["wall", "door", "window"]:
        for item in polygons.get(category, []):
            for pt in item.get("outer", []):
                all_pts.append([int(round(pt[0])), int(round(pt[1]))])

    if len(all_pts) < 3:
        return None

    hull = cv2.convexHull(np.array(all_pts, dtype=np.int32))
    footprint = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(footprint, [hull], 1)
    return footprint


def _extract_rooms_from_space_mask(
    space_mask: np.ndarray,
    shape: tuple[int, int],
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
    footprint_mask: np.ndarray | None = None,
) -> list[dict]:
    """Find room contours from a binary space_mask and convert to canvas/source points."""
    labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(space_mask, connectivity=8)
    height, width = shape
    results = []

    for label in range(1, labels_count):
        x, y, comp_w, comp_h, comp_area = stats[label]
        touches_border = (x == 0 or y == 0 or x + comp_w == width or y + comp_h == height)
        if touches_border or comp_area < 100:
            continue

        comp_binary = (labels == label).astype(np.uint8)
        contours, _ = cv2.findContours(comp_binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        if cv2.contourArea(contour) <= 50:
            continue

        approximation = cv2.approxPolyDP(contour, epsilon=1.5, closed=True)
        if len(approximation) < 3:
            continue

        candidate_canvas = approximation.reshape(-1, 2)

        # Verify candidate is inside the building footprint
        if footprint_mask is not None:
            cand_mask = np.zeros(shape, dtype=np.uint8)
            cv2.fillPoly(cand_mask, [candidate_canvas.astype(np.int32)], 1)
            cand_total = cand_mask.sum()
            if cand_total > 0:
                inside_ratio = (cand_mask & footprint_mask).sum() / float(cand_total)
                if inside_ratio < 0.70:
                    continue

        source_points = [
            _canvas_to_source((float(px), float(py)), content_rect, source_image_size)
            for px, py in candidate_canvas
        ]

        # Distance transform to find exact visual center (Pole of Inaccessibility - deepest point inside room)
        dist_transform = cv2.distanceTransform(comp_binary, cv2.DIST_L2, 5)
        _, max_val, _, max_loc = cv2.minMaxLoc(dist_transform)
        if max_val > 0:
            center_x, center_y = float(max_loc[0]), float(max_loc[1])
        else:
            moments = cv2.moments(contour)
            if moments["m00"] == 0:
                continue
            center_x, center_y = moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]

        center = _canvas_to_source(
            (center_x, center_y),
            content_rect,
            source_image_size,
        )

        results.append(
            {
                "canvas_points": candidate_canvas,
                "source_points": source_points,
                "center": center,
                "area_px2": _polygon_area(source_points),
            }
        )

    return results


def _polygon_iou(
    candidate: np.ndarray,
    existing_points: list[Point],
    shape: tuple[int, int],
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> float:
    existing_canvas = np.array(
        [_source_to_canvas(point, content_rect, source_image_size) for point in existing_points],
        dtype=np.int32,
    )
    if len(existing_canvas) < 3:
        return 0.0
    candidate_mask = np.zeros(shape, dtype=np.uint8)
    existing_mask = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(candidate_mask, [candidate.astype(np.int32)], 1)
    cv2.fillPoly(existing_mask, [existing_canvas], 1)
    union = np.logical_or(candidate_mask, existing_mask).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(candidate_mask, existing_mask).sum() / union)


def detect_new_rooms(
    mask: np.ndarray,
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
    existing_spaces: list[ExistingSpace],
) -> tuple[list[DetectedRoom], list[dict[str, float | str]], list[str]]:
    """Return enclosed free-space polygons in source-image coordinates.

    Candidate polygons matching an existing space are skipped with their IoU.
    """
    barrier = np.isin(mask, [CLASS_TO_ID["wall"], CLASS_TO_ID["door"], CLASS_TO_ID["window"]]).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSING_KERNEL_PX, CLOSING_KERNEL_PX))
    barrier = cv2.morphologyEx(barrier, cv2.MORPH_CLOSE, kernel)
    dilate_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    barrier = cv2.dilate(barrier, dilate_kernel, iterations=1)

    rooms: list[DetectedRoom] = []
    skipped: list[dict[str, float | str]] = []

    for component in _enclosed_components(barrier):
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        if cv2.contourArea(contour) <= 50:
            continue
        approximation = cv2.approxPolyDP(contour, epsilon=1.5, closed=True)
        if len(approximation) < 3:
            continue
        candidate_canvas = approximation.reshape(-1, 2)
        duplicate = False
        for existing_space in existing_spaces:
            existing_points = existing_space.get("geometry", {}).get("points", [])
            overlap_iou = _polygon_iou(
                candidate_canvas,
                existing_points,
                mask.shape,
                content_rect,
                source_image_size,
            )
            if overlap_iou >= IOU_DUPLICATE_THRESHOLD:
                skipped.append(
                    {
                        "existing_space_id": existing_space["id"],
                        "overlap_iou": round(overlap_iou, 4),
                    }
                )
                duplicate = True
                break
        if duplicate:
            continue
        points = [
            _canvas_to_source((float(x), float(y)), content_rect, source_image_size)
            for x, y in approximation.reshape(-1, 2)
        ]
        moments = cv2.moments(contour)
        if moments["m00"] == 0:
            continue
        center = _canvas_to_source(
            (moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]),
            content_rect,
            source_image_size,
        )
        room_number = len(rooms) + 1
        rooms.append(
            {
                "client_id": f"detected-room-{room_number:03d}",
                "suggested_label": f"Auto Room {room_number:02d}",
                "suggested_type": "ROOM",
                "confidence": 1.0,
                "geometry": {"type": "POLYGON", "points": points, "center": center},
                "area_px2": _polygon_area(points),
                "area_sq_m": None,
                "boundary_status": "closed",
            }
        )

    return rooms, skipped, []
def _bridge_nearby_endpoints(barrier: np.ndarray, polygons: dict[str, list[dict]], max_dist: float = 45.0) -> None:
    """Connect wall/door/window vertices that are close to each other with barrier lines."""
    all_vertices: list[np.ndarray] = []

    for category in ["wall", "door", "window"]:
        for item in polygons.get(category, []):
            outer = item.get("outer", [])
            if len(outer) >= 2:
                for pt in outer:
                    all_vertices.append(np.array(pt, dtype=np.float32))

    if len(all_vertices) < 2:
        return

    pts = np.array(all_vertices)
    num_pts = len(pts)
    for i in range(num_pts):
        for j in range(i + 1, num_pts):
            d = float(np.linalg.norm(pts[i] - pts[j]))
            if 0 < d <= max_dist:
                p1 = (int(round(pts[i][0])), int(round(pts[i][1])))
                p2 = (int(round(pts[j][0])), int(round(pts[j][1])))
                cv2.line(barrier, p1, p2, 1, thickness=8)


def _polygon_iomin(poly1: np.ndarray, poly2: np.ndarray, shape: tuple[int, int]) -> tuple[float, float]:
    """Calculate IoU and IoMIN (Intersection over Min Area) between two polygon point arrays."""
    if len(poly1) < 3 or len(poly2) < 3:
        return 0.0, 0.0
    m1 = np.zeros(shape, dtype=np.uint8)
    m2 = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(m1, [poly1.astype(np.int32)], 1)
    cv2.fillPoly(m2, [poly2.astype(np.int32)], 1)

    area1 = float(m1.sum())
    area2 = float(m2.sum())
    if area1 == 0 or area2 == 0:
        return 0.0, 0.0

    intersection = float(np.logical_and(m1, m2).sum())
    union = float(np.logical_or(m1, m2).sum())

    iou = intersection / union if union > 0 else 0.0
    iomin = intersection / min(area1, area2)
    return iou, iomin


def _deduplicate_candidate_rooms(candidates: list[dict], shape: tuple[int, int]) -> list[dict]:
    """Deduplicate room candidates using canvas center distance, containment, and IoMIN."""
    unique_rooms: list[dict] = []

    for cand in candidates:
        cand_poly = np.array(cand["canvas_points"], dtype=np.int32)
        if len(cand_poly) < 3:
            continue

        c_x = float(cand_poly[:, 0].mean())
        c_y = float(cand_poly[:, 1].mean())

        is_duplicate = False

        for existing in unique_rooms:
            ex_poly = np.array(existing["canvas_points"], dtype=np.int32)
            if len(ex_poly) < 3:
                continue

            ex_cx = float(ex_poly[:, 0].mean())
            ex_cy = float(ex_poly[:, 1].mean())

            # 1. Center Proximity Check in Canvas Coordinates (distance < 50px)
            center_dist = math.hypot(c_x - ex_cx, c_y - ex_cy)
            if center_dist < 50.0:
                is_duplicate = True
                break

            # 2. Point-in-Polygon Check (in matching Canvas Coordinates)
            in_existing = cv2.pointPolygonTest(ex_poly, (c_x, c_y), measureDist=False) >= 0
            in_cand = cv2.pointPolygonTest(cand_poly, (ex_cx, ex_cy), measureDist=False) >= 0

            iou, iomin = _polygon_iomin(cand_poly, ex_poly, shape)

            if (in_existing or in_cand or iou >= 0.35 or iomin >= 0.45):
                is_duplicate = True
                break

        if not is_duplicate:
            unique_rooms.append(cand)

    return unique_rooms


def detect_rooms_from_polygons(
    polygons: dict[str, list[dict]],
    canvas_size: tuple[int, int],
    content_rect: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
    existing_spaces: list[ExistingSpace],
) -> tuple[list[DetectedRoom], list[dict[str, float | str]], list[str]]:
    """Detect enclosed rooms by combining fine-grained room closing and topological space extraction."""
    width, height = canvas_size
    footprint_mask = _create_building_footprint_mask(polygons, (height, width))

    # --- PASS 1: Fine-grained Individual Room Detection (Sealing doorways & archways) ---
    barrier_p1 = np.zeros((height, width), dtype=np.uint8)
    for category in ["wall", "door", "window"]:
        for item in polygons.get(category, []):
            outer = item.get("outer", [])
            if len(outer) >= 3:
                pts = np.array(outer, dtype=np.int32)
                cv2.fillPoly(barrier_p1, [pts], 1)

    close_size = max(5, min(35, min(height, width) // 3))
    if close_size % 2 == 0:
        close_size += 1
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (close_size, close_size))
    sealed_p1 = cv2.morphologyEx(barrier_p1, cv2.MORPH_CLOSE, close_kernel)

    inv_sealed = ((sealed_p1 == 0).astype(np.uint8)) * 255
    exterior_mask = np.zeros((height + 2, width + 2), dtype=np.uint8)
    for seed in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]:
        cv2.floodFill(inv_sealed, exterior_mask, seed, 128)

    is_exterior = (inv_sealed == 128)
    room_space_p1 = (barrier_p1 == 0) & (~is_exterior) & (sealed_p1 == 0)

    p1_candidates = _extract_rooms_from_space_mask(
        room_space_p1.astype(np.uint8),
        (height, width),
        content_rect,
        source_image_size,
        footprint_mask=footprint_mask,
    )

    # --- PASS 2: Topological Enclosure Detection (Endpoint bridging for large open spaces) ---
    barrier_p2 = barrier_p1.copy()
    _bridge_nearby_endpoints(barrier_p2, polygons, max_dist=45.0)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    barrier_p2 = cv2.morphologyEx(barrier_p2, cv2.MORPH_CLOSE, kernel)
    dilate_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    barrier_p2 = cv2.dilate(barrier_p2, dilate_kernel, iterations=1)

    p2_candidates = _extract_rooms_from_space_mask(
        (barrier_p2 == 0).astype(np.uint8),
        (height, width),
        content_rect,
        source_image_size,
        footprint_mask=footprint_mask,
    )

    # --- PASS 3: Smart Union & Multi-Rule Deduplication ---
    raw_combined = list(p1_candidates) + list(p2_candidates)
    all_raw_rooms = _deduplicate_candidate_rooms(raw_combined, (height, width))

    # Deduplicate against stored spaces in database
    rooms: list[DetectedRoom] = []
    skipped: list[dict[str, float | str]] = []

    for item in all_raw_rooms:
        candidate_canvas = np.array(item["canvas_points"], dtype=np.int32)
        duplicate = False
        for existing_space in existing_spaces:
            existing_points = existing_space.get("geometry", {}).get("points", [])
            overlap_iou = _polygon_iou(
                candidate_canvas,
                existing_points,
                (height, width),
                content_rect,
                source_image_size,
            )
            if overlap_iou >= IOU_DUPLICATE_THRESHOLD:
                skipped.append(
                    {
                        "existing_space_id": existing_space["id"],
                        "overlap_iou": round(overlap_iou, 4),
                    }
                )
                duplicate = True
                break
        if duplicate:
            continue

        room_number = len(rooms) + 1
        rooms.append(
            {
                "client_id": f"detected-room-{room_number:03d}",
                "suggested_label": f"Auto Room {room_number:02d}",
                "suggested_type": "ROOM",
                "confidence": 1.0,
                "geometry": {"type": "POLYGON", "points": item["source_points"], "center": item["center"]},
                "area_px2": item["area_px2"],
                "area_sq_m": None,
                "boundary_status": "closed",
            }
        )

    return rooms, skipped, []

