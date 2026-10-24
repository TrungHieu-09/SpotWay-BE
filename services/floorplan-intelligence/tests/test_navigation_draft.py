"""Run: .venv\\Scripts\\python.exe -m unittest discover -s tests -v  (from services/floorplan-intelligence)."""
from __future__ import annotations

import math
import sys
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.navigation_graph import (  # noqa: E402
    NavigationConfig,
    build_navigation_masks,
    generate_navigation_draft,
    skeletonize_walkable,
)

W, H, T = 900, 600, 10  # image size, wall thickness


def building(*walls: tuple[int, int, int, int]) -> np.ndarray:
    """Outer shell with a white margin plus extra wall rectangles (x1, y1, x2, y2); True = wall."""
    mask = np.zeros((H, W), bool)
    for x1, y1, x2, y2 in [(60, 60, W - 60, 60 + T), (60, H - 60 - T, W - 60, H - 60), (60, 60, 60 + T, H - 60), (W - 60 - T, 60, W - 60, H - 60), *walls]:
        mask[y1:y2, x1:x2] = True
    return mask


def l_corridor() -> np.ndarray:
    """Corridor 60px wide shaped like an L, rest of the building filled with solid rooms."""
    mask = building()
    mask[70:H - 70, 70:W - 70] = True  # solid
    mask[70:130, 70:W - 70] = False  # horizontal corridor along the top
    mask[70:H - 70, 70:130] = False  # vertical corridor along the left
    return mask


def t_junction() -> np.ndarray:
    mask = building()
    mask[70:H - 70, 70:W - 70] = True
    mask[270:330, 70:W - 70] = False  # horizontal bar
    mask[70:H - 70, 420:480] = False  # vertical stem crossing it -> a "+" ; cut the upper part to form a T
    mask[70:270, 420:480] = True
    return mask


def gen(walls: np.ndarray, **overrides) -> dict:
    """Synthetic fixtures fill rooms solid (high wall ratio), so lift the quality gate for them only."""
    return generate_navigation_draft(walls, NavigationConfig(max_wall_ratio=0.95, **overrides))


def pixel(node: dict, width: int = W, height: int = H) -> tuple[float, float]:
    return node["x"] / 100 * width, node["y"] / 100 * height


def edge_samples(draft: dict, width: int = W, height: int = H):
    nodes = {n["id"]: pixel(n, width, height) for n in draft["nodes"]}
    for e in draft["edges"]:
        a, b = nodes[e["fromNodeId"]], nodes[e["toNodeId"]]
        for t in np.linspace(0, 1, max(2, int(math.dist(a, b)))):
            yield a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t


def degrees(draft: dict) -> dict[str, int]:
    count = {n["id"]: 0 for n in draft["nodes"]}
    for e in draft["edges"]:
        count[e["fromNodeId"]] += 1
        count[e["toNodeId"]] += 1
    return count


class NavigationDraftTests(unittest.TestCase):
    def assert_valid(self, draft: dict, width: int = W, height: int = H) -> None:
        self.assertEqual(draft["schemaVersion"], 1)
        self.assertEqual(draft["coordinateSpace"], "PERCENT_0_100")
        ids = [n["id"] for n in draft["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertLessEqual(len(draft["nodes"]), 150)
        self.assertLessEqual(len(draft["edges"]), 300)
        for n in draft["nodes"]:
            self.assertTrue(0 <= n["x"] <= 100 and 0 <= n["y"] <= 100)
            self.assertTrue(0 <= n["confidence"] <= 1)
            self.assertTrue(n["requiresConfirmation"] and n["accessible"])
            self.assertIn(n["type"], {"NORMAL", "JUNCTION"})
        pairs = set()
        for e in draft["edges"]:
            self.assertIn(e["fromNodeId"], ids)
            self.assertIn(e["toNodeId"], ids)
            self.assertNotEqual(e["fromNodeId"], e["toNodeId"])
            pair = frozenset((e["fromNodeId"], e["toNodeId"]))
            self.assertNotIn(pair, pairs)
            pairs.add(pair)
            self.assertTrue(0 <= e["confidence"] <= 1)

    def assert_clear_of_walls(self, draft: dict, walls: np.ndarray) -> None:
        # every sampled point must keep a margin from the (undilated) walls
        distance = cv2.distanceTransform((~walls).astype(np.uint8), cv2.DIST_L2, 5)
        for x, y in edge_samples(draft):
            self.assertFalse(walls[int(round(y)), int(round(x))], f"edge crosses a wall at {x:.0f},{y:.0f}")
            self.assertGreaterEqual(distance[min(H - 1, int(round(y))), min(W - 1, int(round(x)))], 3)

    def test_l_corridor_has_corner_and_safe_edges(self):
        walls = l_corridor()
        draft = gen(walls)
        self.assert_valid(draft)
        self.assertGreaterEqual(len(draft["nodes"]), 3)
        self.assertGreaterEqual(len(draft["edges"]), 2)
        self.assert_clear_of_walls(draft, walls)
        # a corner node sits near the top-left joint of the L (around x=100,y=100)
        corner = min(draft["nodes"], key=lambda n: math.dist(pixel(n), (100, 100)))
        self.assertLess(math.dist(pixel(corner), (100, 100)), 45)
        self.assertEqual(max(degrees(draft).values()), 2)

    def test_t_junction_has_degree_three_junction(self):
        walls = t_junction()
        draft = gen(walls)
        self.assert_valid(draft)
        junctions = [n for n in draft["nodes"] if n["type"] == "JUNCTION"]
        self.assertEqual(len(junctions), 1)
        self.assertGreaterEqual(degrees(draft)[junctions[0]["id"]], 3)
        self.assertLess(math.dist(pixel(junctions[0]), (450, 300)), 40)
        self.assert_clear_of_walls(draft, walls)

    def test_exterior_white_margin_never_gets_edges(self):
        walls = l_corridor()
        draft = gen(walls)
        for x, y in edge_samples(draft):
            self.assertTrue(70 <= x <= W - 70 and 70 <= y <= H - 70, f"edge outside the building at {x:.0f},{y:.0f}")

    def test_blank_and_noisy_images_return_empty_draft_with_warning(self):
        blank = generate_navigation_draft(np.zeros((H, W), bool))
        self.assertEqual((blank["nodes"], blank["edges"]), ([], []))
        self.assertTrue(blank["warnings"])
        noise = np.random.default_rng(7).random((H, W)) > 0.5
        noisy = generate_navigation_draft(noise)
        self.assert_valid(noisy)
        self.assertLessEqual(len(noisy["nodes"]), 150)

    def test_unreliable_wall_masks_are_rejected(self):
        solid = generate_navigation_draft(np.ones((H, W), bool))  # dark image: everything "wall"
        self.assertEqual((solid["nodes"], solid["edges"]), ([], []))
        self.assertTrue(any(w.startswith("NAVIGATION_WALL_MASK_UNRELIABLE") for w in solid["warnings"]))
        empty = generate_navigation_draft(np.zeros((H, W), bool))
        self.assertTrue(any(w.startswith("NAVIGATION_WALL_MASK_UNRELIABLE") for w in empty["warnings"]))

    def test_deterministic(self):
        walls = t_junction()
        self.assertEqual(gen(walls), gen(walls))

    def test_disconnected_areas_warn_and_never_link_across(self):
        walls = building((W // 2 - 5, 60, W // 2 + 5, H - 60))  # full-height partition, no door
        walls[70:H - 70, 70:W // 2 - 5] = True
        walls[70:H - 70, W // 2 + 5:W - 70] = True
        walls[250:350, 90:W // 2 - 20] = False  # corridor in the left half
        walls[250:350, W // 2 + 20:W - 90] = False  # corridor in the right half
        draft = gen(walls)
        self.assert_valid(draft)
        self.assertTrue(any(w.startswith("DISCONNECTED_WALKABLE_AREAS") for w in draft["warnings"]))
        mid = W / 2
        for e in draft["edges"]:
            nodes = {n["id"]: pixel(n) for n in draft["nodes"]}
            self.assertEqual(nodes[e["fromNodeId"]][0] < mid, nodes[e["toNodeId"]][0] < mid)

    def test_large_building_is_bounded_and_fast(self):
        walls = building()
        for x in range(160, W - 120, 120):  # many parallel partitions with gaps -> dense skeleton
            walls[70:H - 70, x:x + T] = True
            walls[250:330, x:x + T] = False
        start = time.perf_counter()
        draft = gen(walls, max_nodes=40, max_edges=80)
        self.assertLess(time.perf_counter() - start, 15)
        self.assertLessEqual(len(draft["nodes"]), 40)
        self.assertLessEqual(len(draft["edges"]), 80)

    def test_percent_is_resolution_independent(self):
        small = gen(l_corridor())
        big_walls = cv2.resize(l_corridor().astype(np.uint8) * 255, (W * 2, H * 2), interpolation=cv2.INTER_NEAREST) > 0
        big = gen(big_walls)
        self.assertTrue(small["nodes"] and big["nodes"])
        for node in small["nodes"]:
            nearest = min(big["nodes"], key=lambda other: math.dist((node["x"], node["y"]), (other["x"], other["y"])))
            self.assertLess(math.dist((node["x"], node["y"]), (nearest["x"], nearest["y"])), 4)

    def test_zhang_suen_thins_a_bar_to_a_single_pixel_line(self):
        bar = np.zeros((60, 200), bool)
        bar[20:40, 10:190] = True
        skeleton = skeletonize_walkable(bar)
        self.assertGreater(skeleton.sum(), 100)
        self.assertLess(skeleton.sum(), 220)
        self.assertTrue(skeleton[28:32, 100].any())

    def test_masks_clearance_excludes_pixels_next_to_walls(self):
        walls = l_corridor()
        masks = build_navigation_masks(walls, NavigationConfig(max_wall_ratio=0.95))
        self.assertFalse((masks.interior & masks.blocked).any())
        self.assertTrue(masks.interior.any())


if __name__ == "__main__":
    unittest.main()
