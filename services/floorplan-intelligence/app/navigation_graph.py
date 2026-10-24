"""Navigation Graph Draft from a structural wall mask (centreline extraction).

Pipeline (docs/NAVIGATION_ANALYSIS_DESIGN.md, section 4):
wall mask -> clearance dilation -> interior footprint (exterior flood-fill) ->
Zhang-Suen thinning -> skeleton graph (endpoints / junctions / chains) ->
spur pruning -> polyline simplification -> node NMS -> bounded graph in percent.

Only numpy + OpenCV are used; ``cv2.ximgproc`` and scikit-image are not required.
Everything is deterministic: identical input yields identical nodes, edges and ids.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

CONFIDENCE = 0.85


@dataclass(frozen=True)
class NavigationConfig:
    working_long_edge: int = int(os.getenv("NAV_WORKING_LONG_EDGE", "1024"))
    clearance_ratio: float = float(os.getenv("NAV_CLEARANCE_RATIO", "0.007"))
    min_component_area_ratio: float = float(os.getenv("NAV_MIN_COMPONENT_AREA_RATIO", "0.001"))
    node_merge_px: float = float(os.getenv("NAV_NODE_MERGE_PX", "12"))
    min_edge_px: float = float(os.getenv("NAV_MIN_EDGE_PX", "16"))
    max_nodes: int = int(os.getenv("NAV_MAX_NODES", "150"))
    max_edges: int = int(os.getenv("NAV_MAX_EDGES", "300"))
    simplify_ratio: float = 0.006
    min_wall_ratio: float = float(os.getenv("NAV_MIN_WALL_RATIO", "0.002"))
    max_wall_ratio: float = float(os.getenv("NAV_MAX_WALL_RATIO", "0.45"))


@dataclass
class NavigationMasks:
    wall: np.ndarray
    blocked: np.ndarray
    interior: np.ndarray
    scale: float
    warnings: list[str] = field(default_factory=list)


# ── masks ─────────────────────────────────────────────────────────────────────

def _ellipse(radius: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    return cv2.dilate(mask.astype(np.uint8), _ellipse(radius)) > 0 if radius > 0 else mask.copy()


def _border_labels(labels: np.ndarray) -> set[int]:
    edge = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    return {int(value) for value in np.unique(edge) if value > 0}


def build_navigation_masks(wall_mask_native: np.ndarray, config: NavigationConfig | None = None) -> NavigationMasks:
    """Wall mask (bool, native size) -> working-resolution wall/blocked/interior masks."""
    config = config or NavigationConfig()
    native_height, native_width = wall_mask_native.shape
    scale = min(1.0, config.working_long_edge / max(native_height, native_width))
    if scale < 1.0:
        size = (max(1, round(native_width * scale)), max(1, round(native_height * scale)))
        # INTER_AREA + "any coverage" keeps thin walls instead of letting them vanish
        wall = cv2.resize(wall_mask_native.astype(np.uint8) * 255, size, interpolation=cv2.INTER_AREA) > 0
    else:
        wall = wall_mask_native.copy()
    height, width = wall.shape
    min_dim = min(height, width)
    warnings: list[str] = []

    # Quality gate: a wall mask that is (almost) empty or (almost) solid is not a usable line drawing
    # (e.g. a dark UI mock-up or a photo), and any centreline derived from it would be fiction.
    wall_ratio = float(wall.mean())
    if not config.min_wall_ratio <= wall_ratio <= config.max_wall_ratio:
        warnings.append(
            f"NAVIGATION_WALL_MASK_UNRELIABLE: tường chiếm {wall_ratio:.1%} diện tích ảnh (cần "
            f"{config.min_wall_ratio:.1%}-{config.max_wall_ratio:.1%}); ảnh không giống sơ đồ nét đen trên nền sáng nên không tạo graph."
        )
        empty = np.zeros_like(wall)
        return NavigationMasks(wall, empty, empty, scale, warnings)

    clearance = max(3, round(min_dim * config.clearance_ratio))
    blocked = _dilate(wall, clearance)
    empty = np.zeros_like(wall)
    total = float(height * width)

    # Exterior flood-fill. Close doorway-sized gaps only temporarily and only when
    # the raw drawing lets the exterior leak into the building.
    footprint_free = empty
    for seal_radius in (0, max(1, round(min_dim * 0.004)), max(2, round(min_dim * 0.03))):
        sealed = _dilate(wall, seal_radius)
        free = (~sealed).astype(np.uint8)
        count, labels = cv2.connectedComponents(free, connectivity=4)
        if count <= 1:
            break
        outside = np.isin(labels, list(_border_labels(labels)))
        inside = (labels > 0) & ~outside
        inside_area, outside_area = float(inside.sum()), float((labels > 0).sum() - inside.sum())
        if inside_area >= 0.02 * total and inside_area >= 0.1 * (inside_area + outside_area):
            footprint_free = inside
            if seal_radius:
                warnings.append("NAVIGATION_FOOTPRINT_UNCERTAIN: tường ngoài có khe hở, đã tạm bịt khe để xác định phạm vi toà nhà.")
            break
    if not footprint_free.any():
        warnings.append("NAVIGATION_FOOTPRINT_UNCERTAIN: không xác định được phạm vi bên trong toà nhà; không tạo graph.")
        return NavigationMasks(wall, blocked, empty, scale, warnings)

    # Footprint = everything not exterior; sealed doorway pixels stay inside, walkable where not blocked.
    footprint = _dilate(footprint_free, max(1, round(min_dim * 0.004)))
    interior = footprint & ~blocked
    interior = extract_walkable_components(interior, config)
    if not interior.any():
        warnings.append("NO_WALKABLE_AREA: không có vùng đi lại đủ rộng cách tường.")
    return NavigationMasks(wall, blocked, interior, scale, warnings)


def extract_walkable_components(mask: np.ndarray, config: NavigationConfig) -> np.ndarray:
    """Keep connected walkable regions whose area is a meaningful share of the image."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    minimum = config.min_component_area_ratio * mask.size
    keep = [index for index in range(1, count) if stats[index, cv2.CC_STAT_AREA] >= minimum]
    return np.isin(labels, keep) if keep else np.zeros_like(mask)


# ── thinning ──────────────────────────────────────────────────────────────────

def skeletonize_walkable(mask: np.ndarray, max_iterations: int = 2000) -> np.ndarray:
    """Zhang-Suen thinning restricted to boundary candidates (fast on large regions)."""
    padded = np.pad(mask.astype(np.uint8), 1)
    width = padded.shape[1]
    flat = padded.reshape(-1)
    # P2..P9 clockwise starting north (Zhang-Suen ordering)
    offsets = np.array([-width, -width + 1, 1, width + 1, width, width - 1, -1, -width - 1])

    background_neighbour = np.zeros_like(padded, dtype=bool)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        background_neighbour |= np.roll(padded, (dy, dx), axis=(0, 1)) == 0
    candidates = np.flatnonzero((padded == 1) & background_neighbour)

    for _ in range(max_iterations):
        removed_any = False
        for step in (0, 1):
            if candidates.size == 0:
                break
            around = flat[candidates[:, None] + offsets[None, :]].astype(np.int16)
            neighbours = around.sum(axis=1)
            transitions = ((around == 0) & (np.roll(around, -1, axis=1) == 1)).sum(axis=1)
            p2, p4, p6, p8 = around[:, 0], around[:, 2], around[:, 4], around[:, 6]
            if step == 0:
                extra = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                extra = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            removable = (neighbours >= 2) & (neighbours <= 6) & (transitions == 1) & extra
            if not removable.any():
                continue
            removed = candidates[removable]
            flat[removed] = 0
            removed_any = True
            exposed = (removed[:, None] + offsets[None, :]).reshape(-1)
            exposed = exposed[flat[exposed] == 1]
            candidates = np.unique(np.concatenate([candidates[~removable], exposed]))
        if not removed_any:
            break
    return padded[1:-1, 1:-1] > 0


# ── skeleton graph ────────────────────────────────────────────────────────────

_NEIGHBOURS = ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))
Pixel = tuple[int, int]  # (x, y)


def _neighbour_pixels(pixel: Pixel, pixels: set[Pixel]) -> list[Pixel]:
    x, y = pixel
    return [(x + dx, y + dy) for dy, dx in _NEIGHBOURS if (x + dx, y + dy) in pixels]


def _crossing_number(pixel: Pixel, pixels: set[Pixel]) -> tuple[int, int]:
    x, y = pixel
    ring = [1 if (x + dx, y + dy) in pixels else 0 for dy, dx in _NEIGHBOURS]
    transitions = sum(1 for index in range(8) if ring[index] == 0 and ring[(index + 1) % 8] == 1)
    return sum(ring), transitions


@dataclass
class SkeletonGraph:
    positions: dict[int, tuple[float, float]]
    kinds: dict[int, str]  # "endpoint" | "junction"
    chains: list[tuple[int, int, list[tuple[float, float]]]]  # (node a, node b, polyline from a to b)


def trace_skeleton_graph(skeleton: np.ndarray) -> SkeletonGraph:
    """Endpoints (1 neighbour), junctions (>=3 branches, clustered) and the chains between them."""
    ys, xs = np.nonzero(skeleton)
    pixels: set[Pixel] = set(zip(xs.tolist(), ys.tolist()))
    special: dict[Pixel, str] = {}
    for pixel in sorted(pixels, key=lambda item: (item[1], item[0])):
        count, transitions = _crossing_number(pixel, pixels)
        if count == 1:
            special[pixel] = "endpoint"
        elif transitions >= 3 or (transitions == 2 and count >= 3):
            special[pixel] = "junction"

    node_of: dict[Pixel, int] = {}
    positions: dict[int, tuple[float, float]] = {}
    kinds: dict[int, str] = {}

    def new_node(members: list[Pixel], kind: str) -> None:
        index = len(positions)
        cx = sum(p[0] for p in members) / len(members)
        cy = sum(p[1] for p in members) / len(members)
        anchor = min(members, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
        positions[index], kinds[index] = (float(anchor[0]), float(anchor[1])), kind
        for member in members:
            node_of[member] = index

    junction_pixels = {p for p, kind in special.items() if kind == "junction"}
    seen: set[Pixel] = set()
    for start in sorted(junction_pixels, key=lambda item: (item[1], item[0])):
        if start in seen:
            continue
        cluster, stack = [], [start]
        seen.add(start)
        while stack:
            current = stack.pop()
            cluster.append(current)
            for other in _neighbour_pixels(current, junction_pixels):
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        new_node(cluster, "junction")
    for pixel in sorted((p for p, kind in special.items() if kind == "endpoint"), key=lambda item: (item[1], item[0])):
        new_node([pixel], "endpoint")

    chains: list[tuple[int, int, list[tuple[float, float]]]] = []
    consumed: set[Pixel] = set()
    direct: set[tuple[int, int]] = set()

    def trace(start: Pixel) -> None:
        for first in _neighbour_pixels(start, pixels):
            origin = node_of[start]
            if node_of.get(first) == origin:
                continue
            if first in node_of:
                key = (min(origin, node_of[first]), max(origin, node_of[first]))
                if key not in direct:
                    direct.add(key)
                    chains.append((origin, node_of[first], [positions[origin], positions[node_of[first]]]))
                continue
            if first in consumed:
                continue
            path, previous, current = [first], start, first
            consumed.add(first)
            end: int | None = None
            while end is None:
                options = [p for p in _neighbour_pixels(current, pixels) if p != previous and p not in path[-3:]]
                reached = [p for p in options if p in node_of and not (node_of[p] == origin and len(path) < 3)]
                if reached:
                    end = node_of[reached[0]]
                    break
                free = [p for p in options if p not in consumed and p not in node_of]
                if not free:
                    break
                free.sort(key=lambda p: (abs(p[0] - current[0]) + abs(p[1] - current[1]), p[1], p[0]))
                previous, current = current, free[0]
                path.append(current)
                consumed.add(current)
                for extra in free[1:]:
                    consumed.add(extra)
            if end is None:
                # dead end without an endpoint pixel (rare staircase artefact): terminate with a node
                new_node([current], "endpoint")
                end = node_of[current]
            chains.append((origin, end, [positions[origin], *[(float(p[0]), float(p[1])) for p in path], positions[end]]))

    for pixel in sorted(node_of, key=lambda item: (item[1], item[0])):
        trace(pixel)
    # Pure loops contain no endpoint/junction: seed them from their first unvisited pixel.
    for pixel in sorted(pixels, key=lambda item: (item[1], item[0])):
        if pixel not in node_of and pixel not in consumed:
            new_node([pixel], "endpoint")
            trace(pixel)
    return SkeletonGraph(positions, kinds, chains)


def _chain_length(polyline: list[tuple[float, float]]) -> float:
    return sum(math.dist(polyline[i], polyline[i + 1]) for i in range(len(polyline) - 1))


def prune_spurs(graph: SkeletonGraph, min_edge_px: float) -> SkeletonGraph:
    """Drop short leaf branches (skeleton noise) and bypass junctions left with two branches."""
    chains = list(graph.chains)
    changed = True
    while changed:
        changed = False
        degree: dict[int, int] = {}
        for a, b, _ in chains:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1
        for chain in chains:
            a, b, polyline = chain
            leaf = degree[a] == 1 or degree[b] == 1
            attached = degree[a] >= 3 or degree[b] >= 3
            if a != b and leaf and attached and _chain_length(polyline) < min_edge_px:
                chains.remove(chain)
                changed = True
                break
    # merge through junction nodes that now only connect two chains
    merged = True
    while merged:
        merged = False
        incident: dict[int, list[int]] = {}
        for index, (a, b, _) in enumerate(chains):
            incident.setdefault(a, []).append(index)
            incident.setdefault(b, []).append(index)
        for node, indexes in sorted(incident.items()):
            if graph.kinds.get(node) != "junction" or len(indexes) != 2 or indexes[0] == indexes[1]:
                continue
            first, second = chains[indexes[0]], chains[indexes[1]]
            if first[0] == first[1] or second[0] == second[1]:
                continue
            left = first[2] if first[1] == node else first[2][::-1]
            left_end = first[0] if first[1] == node else first[1]
            right = second[2] if second[0] == node else second[2][::-1]
            right_end = second[1] if second[0] == node else second[0]
            chains = [c for i, c in enumerate(chains) if i not in indexes]
            chains.append((left_end, right_end, [*left, *right[1:]]))
            merged = True
            break
    used = {n for a, b, _ in chains for n in (a, b)}
    return SkeletonGraph(
        {n: p for n, p in graph.positions.items() if n in used},
        {n: k for n, k in graph.kinds.items() if n in used},
        chains,
    )


# ── geometry helpers ──────────────────────────────────────────────────────────

def _line_clear(blocked: np.ndarray, a: tuple[float, float], b: tuple[float, float]) -> bool:
    length = max(1, math.ceil(math.dist(a, b)))
    xs = np.rint(np.linspace(a[0], b[0], length + 1)).astype(int)
    ys = np.rint(np.linspace(a[1], b[1], length + 1)).astype(int)
    height, width = blocked.shape
    if (xs < 0).any() or (ys < 0).any() or (xs >= width).any() or (ys >= height).any():
        return False
    return not blocked[ys, xs].any()


def _simplify(polyline: list[tuple[float, float]], blocked: np.ndarray, epsilon: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, refined until every resulting segment stays out of the blocked mask."""
    if len(polyline) <= 2:
        return polyline
    points = np.array(polyline, dtype=np.float32).reshape(-1, 1, 2)
    current = epsilon
    for _ in range(6):
        approx = [(float(p[0][0]), float(p[0][1])) for p in cv2.approxPolyDP(points, current, False)]
        if all(_line_clear(blocked, approx[i], approx[i + 1]) for i in range(len(approx) - 1)):
            return approx
        current /= 2
    step = max(1, len(polyline) // max(2, round(_chain_length(polyline) / 6)))
    return polyline[::step] if polyline[::step][-1] == polyline[-1] else [*polyline[::step], polyline[-1]]


@dataclass
class _Draft:
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]


def _assemble(graph: SkeletonGraph, blocked: np.ndarray, epsilon: float, merge_px: float, min_edge_px: float) -> _Draft:
    """Chains -> simplified corner nodes -> NMS merge -> undirected edge set."""
    priority = {"junction": 3, "corner": 2, "endpoint": 1}
    coords: list[tuple[float, float]] = []
    kind_of: list[str] = []
    index_of: dict[tuple[int, int], int] = {}

    def node_at(point: tuple[float, float], kind: str) -> int:
        key = (round(point[0]), round(point[1]))
        if key not in index_of:
            index_of[key] = len(coords)
            coords.append((float(key[0]), float(key[1])))
            kind_of.append(kind)
        elif priority[kind] > priority[kind_of[index_of[key]]]:
            kind_of[index_of[key]] = kind
        return index_of[key]

    segments: list[tuple[int, int]] = []
    for a, b, polyline in graph.chains:
        simplified = _simplify(polyline, blocked, epsilon)
        ids = [
            node_at(point, graph.kinds[a] if i == 0 else graph.kinds[b] if i == len(simplified) - 1 else "corner")
            for i, point in enumerate(simplified)
        ]
        segments.extend((ids[i], ids[i + 1]) for i in range(len(ids) - 1))

    # NMS: strongest nodes win, neighbours within merge_px (and in line of sight) collapse onto them
    order = sorted(range(len(coords)), key=lambda i: (-priority[kind_of[i]], coords[i][1], coords[i][0]))
    owner: dict[int, int] = {}
    kept: list[int] = []
    for index in order:
        target = next((k for k in kept if math.dist(coords[k], coords[index]) < merge_px and _line_clear(blocked, coords[k], coords[index])), None)
        if target is None:
            kept.append(index)
            owner[index] = index
        else:
            owner[index] = target

    pairs: dict[tuple[int, int], float] = {}
    for a, b in segments:
        ra, rb = owner[a], owner[b]
        if ra == rb:
            continue
        key = (min(ra, rb), max(ra, rb))
        if key in pairs or not _line_clear(blocked, coords[ra], coords[rb]):
            continue
        pairs[key] = math.dist(coords[ra], coords[rb])

    # drop leaf edges that are only noise, repeatedly
    while True:
        degree: dict[int, int] = {}
        for a, b in pairs:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1
        short = [key for key, length in pairs.items() if length < min_edge_px and (degree[key[0]] == 1 or degree[key[1]] == 1) and (degree[key[0]] >= 3 or degree[key[1]] >= 3)]
        if not short:
            break
        del pairs[short[0]]

    used = sorted({n for pair in pairs for n in pair}, key=lambda i: (coords[i][1], coords[i][0]))
    degree = {n: 0 for n in used}
    for a, b in pairs:
        degree[a] += 1
        degree[b] += 1
    nodes = [
        {"_ref": n, "px": coords[n], "type": "JUNCTION" if degree[n] >= 3 else "NORMAL",
         "source": "SKELETON_JUNCTION" if degree[n] >= 3 else "SKELETON_CORNER" if kind_of[n] == "corner" else "SKELETON_ENDPOINT"}
        for n in used
    ]
    edges = [{"a": a, "b": b, "length": length} for (a, b), length in sorted(pairs.items(), key=lambda item: (coords[item[0][0]][1], coords[item[0][0]][0], coords[item[0][1]][1], coords[item[0][1]][0]))]
    return _Draft(nodes, edges)


def _connected_components(draft: _Draft) -> int:
    parent = {node["_ref"]: node["_ref"] for node in draft.nodes}

    def find(item: int) -> int:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    for edge in draft.edges:
        parent[find(edge["a"])] = find(edge["b"])
    return len({find(item) for item in parent})


def _truncate(draft: _Draft, max_nodes: int, max_edges: int) -> _Draft:
    """Last resort: BFS from the best-connected node so the kept subgraph stays connected."""
    adjacency: dict[int, list[int]] = {}
    for edge in draft.edges:
        adjacency.setdefault(edge["a"], []).append(edge["b"])
        adjacency.setdefault(edge["b"], []).append(edge["a"])
    start = max(adjacency, key=lambda n: (len(adjacency[n]), -n))
    kept, queue = [start], [start]
    while queue and len(kept) < max_nodes:
        for neighbour in sorted(adjacency[queue.pop(0)]):
            if neighbour not in kept and len(kept) < max_nodes:
                kept.append(neighbour)
                queue.append(neighbour)
    allowed = set(kept)
    edges = [e for e in draft.edges if e["a"] in allowed and e["b"] in allowed][:max_edges]
    return _Draft([n for n in draft.nodes if n["_ref"] in allowed], edges)


def build_draft_graph(skeleton: np.ndarray, blocked: np.ndarray, config: NavigationConfig) -> tuple[_Draft, list[str]]:
    warnings: list[str] = []
    graph = prune_spurs(trace_skeleton_graph(skeleton), config.min_edge_px)
    min_dim = min(blocked.shape)
    draft = _Draft([], [])
    for factor in (1.0, 1.5, 2.2, 3.2, 4.5):
        draft = _assemble(graph, blocked, max(2.0, min_dim * config.simplify_ratio) * factor, config.node_merge_px * factor, config.min_edge_px * factor)
        if len(draft.nodes) <= config.max_nodes and len(draft.edges) <= config.max_edges:
            break
    if len(draft.nodes) > config.max_nodes or len(draft.edges) > config.max_edges:
        warnings.append("NODE_LIMIT_REACHED: graph vượt giới hạn nên đã rút gọn; hãy kiểm tra các nhánh bị thiếu.")
        draft = _truncate(draft, config.max_nodes, config.max_edges)
    if draft.nodes and _connected_components(draft) > 1:
        warnings.append("DISCONNECTED_WALKABLE_AREAS: có nhiều vùng đi lại không nối với nhau; hãy nối thủ công nếu cần.")
    return draft, warnings


# ── public entry ──────────────────────────────────────────────────────────────

def normalise_draft_coordinates(draft: _Draft, width: int, height: int, scale: float) -> dict[str, Any]:
    """Working pixels -> percent (0..100) of the native image, plus ids/confidence fields."""
    # Percent is resolution independent: divide by the *working* size the pixels came from.
    work_width, work_height = max(1, round(width * scale)), max(1, round(height * scale))
    index_of = {node["_ref"]: i for i, node in enumerate(draft.nodes)}
    nodes = [
        {
            "id": f"draft-node-{i}",
            "x": round(node["px"][0] / work_width * 100, 2),
            "y": round(node["px"][1] / work_height * 100, 2),
            "name": None,
            "type": node["type"],
            "accessible": True,
            "confidence": CONFIDENCE,
            "requiresConfirmation": True,
            "source": node["source"],
        }
        for i, node in enumerate(draft.nodes)
    ]
    edges = [
        {
            "id": f"draft-edge-{j}",
            "fromNodeId": f"draft-node-{index_of[edge['a']]}",
            "toNodeId": f"draft-node-{index_of[edge['b']]}",
            "weight": round(edge["length"] / scale, 2),
            "accessible": True,
            "confidence": CONFIDENCE,
            "requiresConfirmation": True,
            "source": "SKELETON_CHAIN",
        }
        for j, edge in enumerate(draft.edges)
    ]
    return {"nodes": nodes, "edges": edges}


def generate_navigation_draft(wall_mask_native: np.ndarray, config: NavigationConfig | None = None) -> dict[str, Any]:
    """Wall mask (bool, native size, True = wall) -> AI response v1 body."""
    config = config or NavigationConfig()
    height, width = wall_mask_native.shape
    masks = build_navigation_masks(wall_mask_native, config)
    warnings = list(masks.warnings)
    body: dict[str, Any] = {"nodes": [], "edges": []}
    diagnostics: dict[str, Any] = {"algorithm": "medial-axis-v1", "workingWidth": masks.wall.shape[1], "workingHeight": masks.wall.shape[0]}
    if masks.interior.any():
        skeleton = skeletonize_walkable(masks.interior)
        diagnostics["skeletonPixels"] = int(skeleton.sum())
        draft, graph_warnings = build_draft_graph(skeleton, masks.blocked, config)
        warnings += graph_warnings
        if draft.nodes:
            body = normalise_draft_coordinates(draft, width, height, masks.scale)
        else:
            warnings.append("NO_WALKABLE_AREA: vùng đi lại quá hẹp hoặc rời rạc để tạo đường tâm.")
    body["warnings"] = warnings
    body["schemaVersion"] = 1
    body["coordinateSpace"] = "PERCENT_0_100"
    body["image"] = {"width": int(width), "height": int(height)}
    body["diagnostics"] = diagnostics
    return body
