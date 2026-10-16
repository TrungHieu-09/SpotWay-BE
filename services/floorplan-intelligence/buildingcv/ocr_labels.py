"""OCR room-name labels from a floor-plan image and match them to detected room polygons.

Printed floor plans usually have the room's real name stamped inside its own
outline (e.g. "PHÒNG KỸ THUẬT"). `detect_new_rooms`/`detect_rooms_from_polygons`
only know wall geometry, so every room starts out labeled "Auto Room NN". This
module reads the text back out with Tesseract and, for any room whose text
falls inside its polygon, replaces that placeholder with the real name.

Coordinate space: Tesseract runs directly on the same source image whose
pixel dimensions `DetectedRoom["geometry"]` coordinates are already expressed
in (see `_canvas_to_source` in room_detection.py), so no conversion is needed
between an OCR box's center and a room polygon's points.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytesseract
from PIL import Image
from pytesseract import Output

from .room_detection import DetectedRoom

# Tesseract's per-word confidence is 0-100; low scores are mostly noise from
# dimension lines, hatching, or furniture icons rather than real text.
MIN_WORD_CONFIDENCE = 40
MIN_LABEL_CHARS = 2
MAX_LABEL_CHARS = 80


def _group_words_into_lines(ocr_data: dict) -> list[dict]:
    """Group Tesseract's per-word boxes into per-line text blocks.

    A room name is often split across 1-3 words by Tesseract (and sometimes
    across 2 lines, e.g. "PHÒNG" / "KỸ THUẬT"); grouping by (block, paragraph,
    line) reconstructs each printed line as one label instead of scattered
    single words.
    """
    lines: dict[tuple[int, int, int], list[int]] = {}
    n = len(ocr_data["text"])
    for i in range(n):
        text = ocr_data["text"][i].strip()
        raw_conf = ocr_data["conf"][i]
        try:
            conf = float(raw_conf)
        except (TypeError, ValueError):
            conf = -1.0
        if not text or conf < MIN_WORD_CONFIDENCE:
            continue
        key = (ocr_data["block_num"][i], ocr_data["par_num"][i], ocr_data["line_num"][i])
        lines.setdefault(key, []).append(i)

    result = []
    for indices in lines.values():
        text = " ".join(ocr_data["text"][i].strip() for i in indices).strip()
        if len(text) < MIN_LABEL_CHARS:
            continue
        xs = [ocr_data["left"][i] for i in indices] + [
            ocr_data["left"][i] + ocr_data["width"][i] for i in indices
        ]
        ys = [ocr_data["top"][i] for i in indices] + [
            ocr_data["top"][i] + ocr_data["height"][i] for i in indices
        ]
        result.append(
            {
                "text": text,
                "center": (float(min(xs) + max(xs)) / 2.0, float(min(ys) + max(ys)) / 2.0),
                "top": min(ys),
            }
        )
    return result


def ocr_lines(image: Image.Image, lang: str = "vie") -> list[dict]:
    """Run Tesseract on `image`, returning grouped text lines with pixel-space centers."""
    rgb = image.convert("RGB")
    try:
        data = pytesseract.image_to_data(rgb, lang=lang, output_type=Output.DICT)
    except pytesseract.TesseractError:
        # Vietnamese trained data missing/misconfigured — degrade to English
        # rather than failing the whole detect-rooms request over OCR alone.
        data = pytesseract.image_to_data(rgb, lang="eng", output_type=Output.DICT)
    return _group_words_into_lines(data)


def apply_ocr_labels(
    rooms: list[DetectedRoom],
    image: Image.Image,
    lang: str = "vie",
    scale: tuple[float, float] = (1.0, 1.0),
    offset: tuple[float, float] = (0.0, 0.0),
) -> int:
    """Mutate `rooms` in place: replace the generic suggested_label with OCR'd
    text found inside that room's polygon. Rooms with no matching text keep
    their "Auto Room NN" fallback. Returns how many rooms got a real label.

    `image` is deliberately allowed to be a different resolution than the
    room-polygon coordinate space (small in-room labels are often illegible
    at the ~512px canvas size room detection runs at, so callers should
    prefer OCR-ing the highest-resolution original they have). Each OCR
    line's center is mapped into room-polygon space as
    `(x * scale_x + offset_x, y * scale_y + offset_y)` before the
    point-in-polygon test — see call sites in server/main.py for exactly
    what scale/offset each one needs.
    """
    if not rooms:
        return 0

    lines = ocr_lines(image, lang=lang)
    if not lines:
        return 0

    sx, sy = scale
    dx, dy = offset
    matched_count = 0
    for room in rooms:
        points = room.get("geometry", {}).get("points", [])
        if len(points) < 3:
            continue
        polygon = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32)

        hits = []
        for line in lines:
            mapped = (line["center"][0] * sx + dx, line["center"][1] * sy + dy)
            if cv2.pointPolygonTest(polygon, mapped, False) >= 0:
                hits.append(line)
        if not hits:
            continue

        hits.sort(key=lambda h: h["top"])
        label = " ".join(h["text"] for h in hits).strip()
        if label:
            room["suggested_label"] = label[:MAX_LABEL_CHARS]
            matched_count += 1

    return matched_count
