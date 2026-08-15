#!/usr/bin/env python3
"""Microsoft Forms PDF -> DocumentModel -> Semantic Layout Parser.

The parser intentionally separates extraction, semantic layout parsing,
question/option/media association, and unified-survey serialization. It keeps
spatial relationships and reports uncertainty instead of silently discarding
ambiguous content.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import math
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import pymupdf as fitz


OPTION_LETTER_RE = re.compile(
    r"^\s*([A-Za-z])\s*[.、．)]\s*(.*)$",
    re.IGNORECASE,
)
BARE_OPTION_LETTER_RE = re.compile(r"^\s*([A-Za-z])\s*$", re.IGNORECASE)
QUESTION_NUMBER_RE = re.compile(
    r"^\s*(?:\*+\s*)?(\d{1,4})\s*(?P<sep>[.、．)]?)\s*(?P<rest>.*)$",
)
NUMERIC_OPTION_RE = re.compile(
    r"^\s*(\d{1,2})\s*[.、．)]\s*(.*)$",
)
BARE_NUMERIC_OPTION_RE = re.compile(r"^\s*(\d{1,2})\s*$")
YES_NO_RE = re.compile(
    r"^\s*(是|否|Yes|No|可以|不可以|有|没有)\s*[.。．、)]?$",
    re.IGNORECASE,
)
PAGE_NUMBER_RE = re.compile(
    r"^(?:第\s*\d+\s*[页⻚](?:\s*共\s*\d+\s*[页⻚])?|Page\s*\d+|\d+\s*/\s*\d+)$",
    re.IGNORECASE,
)

EXT_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
}

MULTIPLE_MARKERS = (
    "多选",
    "可多选",
    "请选择所有",
    "选择所有符合",
    "可以选择多个",
    "三个",
    "multiple",
    "multiple answers",
    "select all that apply",
    "check all that apply",
)
RATING_MARKERS = (
    "rating",
    "score",
    "评分",
    "打分",
    "满意度",
    "给分",
)
YES_NO_VALUES = {
    "是",
    "否",
    "yes",
    "no",
    "可以",
    "不可以",
    "有",
    "没有",
}
OPEN_IMAGE_MARKERS = ("图片", "照片", "截图", "图像", "image", "photo", "picture")
OPEN_VIDEO_MARKERS = ("视频", "录像", "video")
OPEN_AUDIO_MARKERS = ("音频", "录音", "语音", "audio", "voice")
OPEN_FILE_MARKERS = ("文件", "附件", "上传", "document", "file", "upload")
OPEN_DATE_MARKERS = ("日期", "date", "年月日")
OPEN_TIME_MARKERS = ("时间", "time")
OPEN_NUMBER_MARKERS = (
    "年龄",
    "身高",
    "体重",
    "数字",
    "number",
    "age",
    "height",
    "weight",
)
OPEN_LONG_TEXT_MARKERS = (
    "意见",
    "建议",
    "说明",
    "详细",
    "描述",
    "备注",
    "介绍",
    "经历",
    "看法",
    "感受",
    "请描述",
    "请说明",
    "long text",
    "essay",
)


def _first(iterable: Iterable[Any]) -> Any:
    return next(iter(iterable), None)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_key(text: str) -> str:
    return re.sub(r"[\s_.:：\-—,，。、()（）[\]【】]+", "", text).strip().lower()


def is_blank(text: str) -> bool:
    return not normalize(text)


def bbox_union(bboxes: Iterable[list[float] | None]) -> list[float] | None:
    boxes = [b for b in bboxes if b is not None]
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def bbox_area(b: list[float] | None) -> float:
    if not b:
        return 0.0
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def bbox_intersection(a: list[float], b: list[float]) -> float:
    x = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    y = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return x * y


def bbox_iou(a: list[float], b: list[float]) -> float:
    inter = bbox_intersection(a, b)
    union = bbox_area(a) + bbox_area(b) - inter
    return inter / union if union else 0.0


def bbox_overlap_ratio(a: list[float], b: list[float]) -> float:
    inter = bbox_intersection(a, b)
    smaller = min(bbox_area(a), bbox_area(b))
    return inter / smaller if smaller else 0.0


def bbox_center(b: list[float] | None) -> tuple[float, float] | None:
    if not b:
        return None
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def center_distance(a: list[float], b: list[float]) -> float:
    ca = bbox_center(a)
    cb = bbox_center(b)
    if not ca or not cb:
        return float("inf")
    return math.hypot(ca[0] - cb[0], ca[1] - cb[1])


def _span_to_dict(span: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": span.get("text", ""),
        "bbox": span.get("bbox"),
        "font": span.get("font"),
        "font_size": span.get("size"),
        "color": span.get("color"),
    }


def _line_to_dict(line: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": line["id"],
        "type": "text_line",
        "text": line["text"],
        "bbox": line["bbox"],
        "page_number": line["page_number"],
        "spans": line.get("spans", []),
        "font_size": line.get("font_size"),
        "role": line.get("role"),
    }


def extract_document_model(pdf_path: str, output_dir: Path) -> dict[str, Any]:
    """Extract the raw DocumentModel, including lines/spans/bboxes and images."""

    assets_dir = output_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    pages: list[dict[str, Any]] = []
    all_lines: list[dict[str, Any]] = []
    image_resources: dict[int, dict[str, Any]] = {}
    image_instances: list[dict[str, Any]] = []
    seen_instance_keys: set[tuple[int, int, tuple[int, ...]]] = set()

    with fitz.open(pdf_path) as doc:
        for page_index, page in enumerate(doc, start=1):
            raw_text = page.get_text()
            page_dict = page.get_text("dict", sort=True)
            blocks: list[dict[str, Any]] = []

            for block_index, block in enumerate(page_dict.get("blocks", [])):
                if block.get("type", 0) != 0:
                    continue

                for line_index, line in enumerate(block.get("lines", [])):
                    line_text = "".join(
                        span.get("text", "") for span in line.get("spans", [])
                    )
                    if is_blank(line_text):
                        continue

                    spans = [_span_to_dict(span) for span in line.get("spans", [])]
                    font_size = max(
                        (
                            span.get("font_size")
                            for span in spans
                            if span.get("font_size") is not None
                        ),
                        default=None,
                    )
                    line_id = f"p{page_index}_b{block_index}_l{line_index}"
                    line_obj = {
                        "id": line_id,
                        "type": "text_line",
                        "text": normalize(line_text),
                        "bbox": line.get("bbox"),
                        "page_number": page_index,
                        "spans": spans,
                        "font_size": font_size,
                    }
                    blocks.append(line_obj)
                    all_lines.append(line_obj)

            for image_index, image in enumerate(page.get_images(full=True)):
                xref = image[0]
                resource_id = f"img_res_{xref}"

                if xref not in image_resources:
                    resource: dict[str, Any] = {
                        "id": resource_id,
                        "xref": xref,
                        "source": None,
                        "mime": None,
                        "width": image[2],
                        "height": image[3],
                    }
                    try:
                        extracted = doc.extract_image(xref)
                        ext = extracted.get("ext", "bin")
                        asset_name = f"{resource_id}.{ext}"
                        asset_path = assets_dir / asset_name
                        asset_path.write_bytes(extracted.get("image", b""))
                        resource["source"] = f"assets/{asset_name}"
                        resource["mime"] = EXT_MIME.get(
                            ext,
                            "application/octet-stream",
                        )
                    except Exception:
                        resource["source"] = None
                    image_resources[xref] = resource

                rects = page.get_image_rects(xref) or [None]
                for rect_index, rect in enumerate(rects):
                    bbox = (
                        [rect.x0, rect.y0, rect.x1, rect.y1] if rect is not None else None
                    )
                    if bbox is not None:
                        key = (
                            xref,
                            page_index,
                            tuple(round(value, 1) for value in bbox),
                        )
                        if key in seen_instance_keys:
                            continue
                        seen_instance_keys.add(key)
                    image_instances.append(
                        {
                            "id": f"img_p{page_index}_x{xref}_{image_index}_{rect_index}",
                            "resource_id": resource_id,
                            "page": page_index,
                            "bbox": bbox,
                        }
                    )

            pages.append(
                {
                    "page_number": page_index,
                    "pdf_page": page_index,
                    "forms_page_id": None,
                    "width": page.rect.width,
                    "height": page.rect.height,
                    "blocks": blocks,
                    "raw_text": raw_text,
                }
            )

        metadata = doc.metadata or {}

    return {
        "metadata": metadata,
        "page_count": len(pages),
        "pages": pages,
        "all_lines": all_lines,
        "image_resources": list(image_resources.values()),
        "image_instances": image_instances,
    }


def is_page_number_line(text: str) -> bool:
    return bool(PAGE_NUMBER_RE.match(normalize(text)))


def looks_like_date(text: str) -> bool:
    return bool(
        re.search(r"\d{4}年\d{1,2}月\d{1,2}日", text)
        or re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", text)
        or re.search(r"\d{1,2}月\d{1,2}日", text)
        or re.search(r"\d{1,2}[-/]\d{1,2}", text)
    ) or any(token in normalize_key(text) for token in ("年月日", "日期", "date"))


def looks_like_url(text: str) -> bool:
    t = normalize(text)
    return "http://" in t.lower() or "https://" in t.lower() or "@" in t


def _preamble_noise(text: str) -> bool:
    t = normalize_key(text)
    if not t:
        return True
    if looks_like_url(text):
        return True
    if any(token in t for token in ("microsoftforms", "microsoft forms", "forms")):
        return True
    if is_page_number_line(text):
        return True
    if t in {"必答题", "必答", "选答题", "非必答题"}:
        return True
    return False


def detect_page_furniture(
    document: dict[str, Any],
    forms_title: str | None = None,
) -> dict[str, Any]:
    """Detect repeated page headers/footers without global string filtering."""

    pages = document["pages"]
    lines_by_page = defaultdict(list)
    for line in document["all_lines"]:
        lines_by_page[line["page_number"]].append(line)

    top_counts: Counter[str] = Counter()
    bottom_counts: Counter[str] = Counter()
    top_lines_by_key: dict[str, list[str]] = defaultdict(list)
    bottom_lines_by_key: dict[str, list[str]] = defaultdict(list)

    for page in pages:
        page_number = page["page_number"]
        height = page["height"]
        page_lines = lines_by_page.get(page_number, [])
        top_threshold = height * 0.12
        bottom_threshold = height * 0.88

        for line in page_lines:
            bbox = line.get("bbox")
            if not bbox:
                continue
            key = normalize_key(line["text"])
            if not key:
                continue
            if bbox[1] < top_threshold:
                top_counts[key] += 1
                top_lines_by_key[key].append(line["id"])
            elif bbox[3] > bottom_threshold:
                bottom_counts[key] += 1
                bottom_lines_by_key[key].append(line["id"])

    header_keys = {key for key, count in top_counts.items() if count >= 2}
    footer_keys = {key for key, count in bottom_counts.items() if count >= 2}
    header_ids = sorted(
        {line_id for key in header_keys for line_id in top_lines_by_key[key]}
    )
    footer_ids = sorted(
        {line_id for key in footer_keys for line_id in bottom_lines_by_key[key]}
    )

    # The first page occurrence of the survey title is a title, not a header.
    if forms_title:
        title_keys = {normalize_key(part) for part in forms_title.splitlines()}
        header_ids = [
            line_id
            for line_id in header_ids
            if not (
                line_id.startswith("p1_")
                and normalize_key(
                    _first(
                        line["text"]
                        for line in document["all_lines"]
                        if line["id"] == line_id
                    )
                    or ""
                )
                in title_keys
            )
        ]

    # On the last page, Microsoft Forms footer/logo text is not question content.
    if pages:
        last_page = max(page["page_number"] for page in pages)
        last_page_lines = lines_by_page.get(last_page, [])
        question_number_y = max(
            (
                line["bbox"][1]
                for line in last_page_lines
                if line.get("bbox")
                and re.fullmatch(r"\s*\d{1,3}\s*", line["text"])
            ),
            default=None,
        )
        if question_number_y is not None:
            for line in last_page_lines:
                if line.get("bbox") and line["bbox"][1] > question_number_y + 20:
                    if not is_page_number_line(line["text"]):
                        footer_ids.append(line["id"])
                        line["role"] = "footer"

    for line in document["all_lines"]:
        if line["id"] in header_ids:
            line["role"] = "header"
        elif line["id"] in footer_ids:
            line["role"] = "footer"
        elif is_page_number_line(line["text"]):
            line["role"] = "footer"

    for page in pages:
        page_lines = lines_by_page.get(page["page_number"], [])
        page["header_line_ids"] = [
            line["id"] for line in page_lines if line.get("role") == "header"
        ]
        page["footer_line_ids"] = [
            line["id"]
            for line in page_lines
            if line.get("role") == "footer" or is_page_number_line(line["text"])
        ]

    return {
        "header_line_ids": header_ids,
        "footer_line_ids": footer_ids,
        "header_texts": sorted(header_keys),
        "footer_texts": sorted(footer_keys),
        "header_lines_removed": len(header_ids),
        "footer_lines_removed": len(
            {line_id for line_id in footer_ids}
            | {
                line["id"]
                for line in document["all_lines"]
                if is_page_number_line(line["text"])
            }
        ),
    }


def detect_forms_title(
    document: dict[str, Any],
) -> str | None:
    pages = document["pages"]
    lines = sorted(
        document["all_lines"],
        key=lambda line: (
            line["page_number"],
            line["bbox"][1],
            line["bbox"][0],
        ),
    )
    candidates: list[dict[str, Any]] = []

    for line in lines:
        if line["page_number"] > min(2, len(pages)):
            continue
        bbox = line.get("bbox")
        if not bbox:
            continue
        page = _first(p for p in pages if p["page_number"] == line["page_number"])
        if not page:
            continue
        if bbox[1] > page["height"] * 0.42:
            continue
        if _preamble_noise(line["text"]):
            continue
        if QUESTION_NUMBER_RE.match(line["text"]):
            continue
        if OPTION_LETTER_RE.match(line["text"]):
            continue
        if YES_NO_RE.match(line["text"]):
            continue
        if looks_like_date(line["text"]):
            continue

        repeat_bonus = 0.0
        page_bonus = 1.0 if line["page_number"] == 1 else 0.35
        font_size = line.get("font_size") or 12.0
        length_bonus = min(max(len(normalize(line["text"])) - 4, 0) / 16.0, 1.5)
        score = float(font_size) + page_bonus + repeat_bonus + length_bonus
        candidates.append({**line, "_score": score})

    if not candidates:
        return None

    candidates.sort(key=lambda item: item["_score"], reverse=True)
    best = candidates[0]
    title_lines = [best]
    page_lines = [
        line
        for line in lines
        if line["page_number"] == best["page_number"]
    ]
    page_lines.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))

    best_y = best["bbox"][1]
    for line in page_lines:
        if line["id"] == best["id"]:
            continue
        if line["bbox"][0] > best["bbox"][2] + 8:
            continue
        gap = line["bbox"][1] - best_y
        if gap < -4 or gap > max(14.0, (best.get("font_size") or 12.0) * 1.1):
            continue
        if QUESTION_NUMBER_RE.match(line["text"]) or OPTION_LETTER_RE.match(
            line["text"]
        ):
            break
        if _preamble_noise(line["text"]) or looks_like_date(line["text"]):
            continue
        title_lines.append(line)
        best_y = max(best_y, line["bbox"][3])

    title_text = "\n".join(normalize(line["text"]) for line in title_lines).strip()
    return title_text or None


def parse_question_number(
    text: str,
) -> tuple[int, str] | None:
    match = QUESTION_NUMBER_RE.match(text)
    if not match:
        return None

    number = int(match.group(1))
    sep = match.group("sep")
    rest = normalize(match.group("rest"))
    full = normalize(text)

    if not sep and not rest:
        return None
    if number > 500:
        return None
    if 1900 <= number <= 2100:
        return None
    if looks_like_date(full) or looks_like_date(rest):
        return None
    if re.search(r"^\d+\s*(?:%|元|岁|人|个|次|分|秒|题|页)", rest):
        return None
    if rest and any(
        token in normalize_key(rest)
        for token in ("第", "共", "页", "问题", "题目")
    ):
        return None
    if rest in YES_NO_VALUES and sep:
        return None
    return number, rest


def parse_option_letter(text: str, in_question: bool) -> tuple[str, str] | None:
    match = OPTION_LETTER_RE.match(text)
    if match:
        return match.group(1).upper(), normalize(match.group(2))
    if in_question:
        match = BARE_OPTION_LETTER_RE.match(text)
        if match:
            return match.group(1).upper(), ""
    return None


def parse_yes_no_option(text: str, in_question: bool) -> tuple[str, str] | None:
    if not in_question:
        return None
    match = YES_NO_RE.match(text)
    if not match:
        return None
    label = normalize(match.group(1))
    return label, label


def has_rating_context(title: str) -> bool:
    return any(token in normalize_key(title) for token in RATING_MARKERS)


def parse_numeric_option(
    text: str,
    rating_context: bool,
    current_question_number: int | None,
) -> tuple[str, str] | None:
    if not rating_context:
        return None
    match = NUMERIC_OPTION_RE.match(text)
    if match:
        number = int(match.group(1))
        if number <= 11:
            return str(number), normalize(match.group(2))
        return None
    match = BARE_NUMERIC_OPTION_RE.match(text)
    if match:
        number = int(match.group(1))
        if number <= 11 and number != current_question_number:
            return str(number), ""
    return None


def has_multiple_marker(text: str) -> bool:
    return any(token in normalize_key(text) for token in MULTIPLE_MARKERS)


@dataclass
class QuestionStartCandidate:
    number: int
    confidence: float
    reason: str
    rest: str = ""


class QuestionStartDetector:
    """Use line context rather than a bare numeric regex."""

    def detect(
        self,
        line: dict[str, Any],
        prev_line: dict[str, Any] | None,
        next_line: dict[str, Any] | None,
        current: QuestionDraft | None,
        page: dict[str, Any] | None,
    ) -> QuestionStartCandidate | None:
        text = normalize(line.get("text", ""))
        if not text:
            return None
        if is_page_number_line(text) or looks_like_date(text) or looks_like_url(text):
            return None

        match = QUESTION_NUMBER_RE.match(text)
        if not match:
            return None

        number = int(match.group(1))
        sep = match.group("sep")
        rest = normalize(match.group("rest"))
        raw = line.get("text", "")

        if not 1 <= number <= 500:
            return None
        if 1900 <= number <= 2100:
            return None

        # A number glued directly to the following text is usually body text,
        # e.g. the stray "5他让你辞职..." title in the real fixture.
        if not sep and rest:
            rest_start = match.start("rest")
            if rest_start > 0 and raw[rest_start - 1].isdigit():
                return None

        # Dates and page-like numeric tokens are not question starts.
        if looks_like_date(rest) or re.search(r"^\d+\s*(?:%|元|岁|人|个|次|分|秒|题|页)", rest):
            return None
        if rest in YES_NO_VALUES and sep:
            return None

        # Explicit numbered prefix: "1.", "1、", "1)", "1．"
        if sep:
            return QuestionStartCandidate(
                number=number,
                confidence=0.9,
                reason="explicit_numbered_prefix",
                rest=rest,
            )

        # Bare number followed by a body line is a strong candidate in this PDF.
        if not rest:
            next_text = normalize(next_line.get("text", "")) if next_line else ""
            if next_line is None or not next_text:
                return None
            if is_page_number_line(next_text) or looks_like_date(next_text):
                return None
            if OPTION_LETTER_RE.match(next_text) or YES_NO_RE.match(next_text):
                return None
            if self._looks_like_body_continuation(line, next_line):
                return QuestionStartCandidate(
                    number=number,
                    confidence=0.82,
                    reason="bare_number_followed_by_title",
                    rest="",
                )
            return None

        # Number followed by a title on the same line, with a separator-like space.
        if current is None or not current.title:
            return QuestionStartCandidate(
                number=number,
                confidence=0.62,
                reason="number_with_inline_title",
                rest=rest,
            )
        return None

    @staticmethod
    def _looks_like_body_continuation(
        number_line: dict[str, Any],
        next_line: dict[str, Any],
    ) -> bool:
        nb = number_line.get("bbox")
        tb = next_line.get("bbox")
        if not nb or not tb:
            return True
        gap = tb[1] - nb[3]
        if gap < 0 or gap > 28:
            return False
        # Question numbers are short and start near the same left edge as the title.
        return abs(nb[0] - tb[0]) <= 12


class UnlabeledChoiceDetector:
    """Detect choice blocks that do not carry A/B/C/D labels."""

    def detect(
        self,
        lines: list[dict[str, Any]],
        question: QuestionDraft,
        page: dict[str, Any] | None,
    ) -> tuple[bool, float, str]:
        if len(lines) < 2:
            if (
                len(lines) == 1
                and normalize_key(lines[0]["text"]) in {"其他", "其它", "other"}
            ):
                return False, 0.0, "singleton_other_is_open_text"
            return False, 0.0, "not_enough_unlabeled_blocks"

        bboxes = [line.get("bbox") for line in lines if line.get("bbox")]
        if len(bboxes) != len(lines):
            return False, 0.0, "missing_bbox"

        lefts = [b[0] for b in bboxes]
        gaps = [bboxes[i + 1][1] - bboxes[i][3] for i in range(len(bboxes) - 1)]
        if min(gaps) < 2 or max(gaps) > 28:
            return False, 0.0, "irregular_vertical_gaps"

        left_spread = max(lefts) - min(lefts)
        gap_spread = max(gaps) - min(gaps)
        heights = [b[3] - b[1] for b in bboxes]
        height_spread = max(heights) - min(heights)

        if left_spread <= 10 and gap_spread <= 8 and height_spread <= 12:
            return True, 0.92, "uniform_unlabeled_choice_blocks"
        if left_spread <= 18 and gap_spread <= 14:
            return True, 0.58, "weak_unlabeled_choice_layout"
        return False, 0.0, "ambiguous_unlabeled_layout"


class OptionBoundaryDetector:
    """Classify an option-area line as a new option or a continuation."""

    CONTINUATION_GAP = 7.0
    NEW_OPTION_GAP = 18.0

    def classify(
        self,
        line: dict[str, Any],
        question: QuestionDraft,
    ) -> tuple[str, Any]:
        text = line["text"]
        yes_no = parse_yes_no_option(text, True)
        if yes_no:
            return "yes_no_option", yes_no

        letter = parse_option_letter(text, True)
        if letter:
            return "letter_option", letter

        if has_rating_context(question.title):
            numeric_option = parse_numeric_option(text, True, question.source_number)
            if numeric_option:
                return "numeric_option", numeric_option

        if not question.options:
            return "unlabeled", text

        last = question.options[-1]
        last_bottom = last.bbox[3] if last.bbox else None
        line_top = line.get("bbox", [0, 0, 0, 0])[1]
        gap = (line_top - last_bottom) if last_bottom is not None else float("inf")

        if gap <= self.CONTINUATION_GAP:
            return "continuation", text

        # A clear new block after labeled A/B/C options can be a missing label
        # (real Q56 D), but it must not be an ordinary body paragraph.
        if (
            question.options
            and len(question.options) >= 2
            and any(option.label_source == "extracted" for option in question.options)
            and gap <= self.NEW_OPTION_GAP
            and self._looks_like_option_block(line, question)
        ):
            return "generated_label_option", text

        return "continuation", text

    @staticmethod
    def _looks_like_option_block(
        line: dict[str, Any],
        question: QuestionDraft,
    ) -> bool:
        bbox = line.get("bbox")
        if not bbox:
            return False
        first_option = question.options[0]
        first_bbox = first_option.bbox
        if not first_bbox:
            return True
        left_delta = abs(bbox[0] - first_bbox[0])
        return left_delta <= 12


@dataclass
class MediaAttachment:
    id: str
    resource_id: str | None
    source: str | None
    mime: str | None
    width: int | None
    height: int | None
    page: int | None
    bbox: list[float] | None
    confidence: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "photo",
            "source": "url" if self.source else "url",
            "url": self.source,
            "resource_id": self.resource_id,
            "mime_type": self.mime,
            "width": self.width,
            "height": self.height,
            "page": self.page,
            "bbox": self.bbox,
            "confidence": self.confidence,
            "reason": self.reason,
        }


@dataclass
class OptionDraft:
    id: str
    label: str
    text: str
    text_lines: list[dict[str, Any]]
    page_start: int | None
    page_end: int | None
    bbox: list[float] | None
    media: list[MediaAttachment] = field(default_factory=list)
    confidence: float = 0.9
    label_source: str = "extracted"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "text": self.text,
            "value": self.text,
            "order": 0,
            "text_lines": [_line_to_dict(line) for line in self.text_lines],
            "page_start": self.page_start,
            "page_end": self.page_end,
            "bbox": self.bbox,
            "media": [media.to_dict() for media in self.media],
            "confidence": self.confidence,
            "label_source": self.label_source,
        }


@dataclass
class QuestionDraft:
    id: str
    source_number: int | None
    title: str
    title_lines: list[dict[str, Any]]
    source_page_start: int | None
    source_page_end: int | None
    bbox: list[float] | None
    title_bbox: list[float] | None
    options: list[OptionDraft] = field(default_factory=list)
    media: list[MediaAttachment] = field(default_factory=list)
    required: bool | None = None
    required_confidence: float = 0.5
    type: str = "text"
    type_confidence: float = 0.0
    type_reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    title_closed: bool = False
    question_region: dict[str, Any] | None = None
    pending_unlabeled: list[dict[str, Any]] = field(default_factory=list)


def _clean_required_title_text(text: str) -> str:
    return re.sub(r"^\s*\*+\s*", "", text).strip()


def _required_signal(text: str) -> tuple[bool, float] | None:
    t = normalize_key(text)
    if text.rstrip().endswith("*"):
        return True, 0.95
    if any(token in t for token in ("必答题", "必填", "required", "must answer", "必答")):
        return True, 0.95
    if any(token in t for token in ("选答题", "非必答题", "optional", "可不填")):
        return False, 0.9
    if text.strip().startswith("*") or " * " in text:
        return True, 0.72
    return None


def apply_required_signal(question: QuestionDraft, text: str) -> None:
    signal = _required_signal(text)
    if not signal:
        return
    value, confidence = signal
    if confidence >= question.required_confidence:
        question.required = value
        question.required_confidence = confidence


def _question_counter(questions: list[QuestionDraft]) -> int:
    return len(questions) + 1


def _new_question(
    questions: list[QuestionDraft],
    number: int,
    rest: str,
    line: dict[str, Any],
) -> QuestionDraft:
    question = QuestionDraft(
        id=f"q_{_question_counter(questions)}",
        source_number=number,
        title=_clean_required_title_text(rest),
        title_lines=[line],
        source_page_start=line["page_number"],
        source_page_end=line["page_number"],
        bbox=line.get("bbox"),
        title_bbox=line.get("bbox"),
    )
    apply_required_signal(question, line["text"])
    if rest:
        question.title_closed = True
    return question


def _append_title(question: QuestionDraft, line: dict[str, Any]) -> None:
    text = normalize(line["text"])
    signal = _required_signal(text)
    if signal:
        apply_required_signal(question, text)
    if signal and text.strip().startswith("*") and len(text.strip()) <= 8:
        question.title_closed = True
        return
    if text in {"必答题", "必答", "选答题", "非必答题"}:
        question.title_closed = True
        return
    if question.title:
        question.title = f"{question.title}\n{text}"
    else:
        question.title = text
    question.title_lines.append(line)
    question.title_bbox = bbox_union([question.title_bbox, line.get("bbox")])
    question.source_page_end = max(
        question.source_page_end or 0,
        line["page_number"],
    )
    if text.rstrip().endswith("*"):
        question.title_closed = True


def _append_option_continuation(option: OptionDraft, line: dict[str, Any]) -> None:
    text = normalize(line["text"])
    option.text = f"{option.text}\n{text}".strip()
    option.text_lines.append(line)
    option.page_end = max(option.page_end or 0, line["page_number"])
    option.bbox = bbox_union([option.bbox, line.get("bbox")])


def classify_question_type(question: QuestionDraft) -> None:
    normalized = normalize_key(question.title)
    reasons: list[str] = []

    if question.options:
        option_values = [
            normalize_key(option.text or option.label) for option in question.options
        ]
        yes_no_hits = [value for value in option_values if value in YES_NO_VALUES]
        if (
            len(question.options) >= 2
            and len(yes_no_hits) == len(question.options)
            and len(set(yes_no_hits)) >= 2
        ):
            question.type = "yes_no"
            question.type_confidence = 0.96
            question.type_reasons = ["all_options_are_yes_no_values"]
            return

        if has_multiple_marker(question.title) or any(
            has_multiple_marker(option.text) for option in question.options
        ):
            question.type = "multiple"
            question.type_confidence = 0.92
            question.type_reasons = ["explicit_multiple_choice_marker"]
            return

        if has_rating_context(question.title) and all(
            re.fullmatch(r"\d+(?:\.\d+)?", normalize(option.label))
            or re.fullmatch(r"\d+(?:\.\d+)?", normalize(option.text))
            for option in question.options
        ):
            question.type = "rating"
            question.type_confidence = 0.94
            question.type_reasons = ["rating_context_with_numeric_options"]
            return

        question.type = "single"
        question.type_confidence = 0.86
        question.type_reasons = ["choice_options_without_specific_marker"]
        return

    reasons.append("no_options")
    if len(normalize(question.title)) >= 80:
        question.type = "long_text"
        question.type_confidence = 0.72
        question.type_reasons = reasons + ["long_open_question_title"]
        return
    if any(token in normalized for token in OPEN_IMAGE_MARKERS):
        question.type = "image"
        question.type_confidence = 0.72
    elif any(token in normalized for token in OPEN_VIDEO_MARKERS):
        question.type = "video"
        question.type_confidence = 0.7
    elif any(token in normalized for token in OPEN_AUDIO_MARKERS):
        question.type = "audio"
        question.type_confidence = 0.7
    elif any(token in normalized for token in OPEN_FILE_MARKERS):
        question.type = "file"
        question.type_confidence = 0.72
    elif any(token in normalized for token in OPEN_DATE_MARKERS):
        question.type = "date"
        question.type_confidence = 0.7
    elif any(token in normalized for token in OPEN_TIME_MARKERS):
        question.type = "time"
        question.type_confidence = 0.7
    elif any(token in normalized for token in OPEN_NUMBER_MARKERS):
        question.type = "number"
        question.type_confidence = 0.68
    elif any(token in normalized for token in OPEN_LONG_TEXT_MARKERS):
        question.type = "long_text"
        question.type_confidence = 0.66
    else:
        question.type = "text"
        question.type_confidence = 0.52
        reasons.append("open_question_no_explicit_type")

    question.type_reasons = reasons


def _finalize_pending_unlabeled(question: QuestionDraft) -> None:
    if not question.pending_unlabeled:
        return

    # Merge continuation lines while preserving option-start cadence. A new
    # unlabeled option is determined by distance from the previous option's
    # first line, not by the previous wrapped line's bottom edge.
    merged_lines: list[dict[str, Any]] = []
    groups: list[list[dict[str, Any]]] = []
    for line in question.pending_unlabeled:
        if not groups:
            groups.append([line])
            continue
        first_line = groups[-1][0]
        prev_line = groups[-1][-1]
        if (
            first_line.get("bbox")
            and prev_line.get("bbox")
            and line.get("bbox")
            and line["bbox"][1] - first_line["bbox"][1] < 11
        ):
            groups[-1].append(line)
        else:
            groups.append([line])

    for group in groups:
        if len(group) == 1:
            merged_lines.append(dict(group[0]))
            continue
        first = group[0]
        merged_line = dict(first)
        merged_line["text"] = "\n".join(normalize(line["text"]) for line in group)
        merged_line["bbox"] = bbox_union([line.get("bbox") for line in group])
        merged_lines.append(merged_line)

    if (
        len(merged_lines) == 1
        and normalize_key(merged_lines[0]["text"]) in {"其他", "其它", "other"}
    ):
        question.warnings.append("singleton_other_treated_as_open_text")
        return

    detector = UnlabeledChoiceDetector()
    page = _page_for(
        {
            "pages": [],
            "all_lines": [],
            "image_resources": [],
            "image_instances": [],
        },
        question.source_page_start,
    )
    ok, confidence, reason = detector.detect(
        merged_lines,
        question,
        page,
    )
    if not ok:
        question.warnings.append(
            f"unresolved_unlabeled_text_after_title: {reason}"
        )
        return

    for index, line in enumerate(merged_lines, start=1):
        option = OptionDraft(
            id=f"{question.id}_o{len(question.options) + 1}",
            label=str(index),
            text=normalize(line["text"]),
            text_lines=[line],
            page_start=line["page_number"],
            page_end=line["page_number"],
            bbox=line.get("bbox"),
            confidence=confidence,
            label_source="generated",
        )
        question.options.append(option)
        question.source_page_end = max(
            question.source_page_end or 0,
            line["page_number"],
        )
    question.warnings.append("unlabeled_options_detected")


def _finalize_question(question: QuestionDraft) -> None:
    _finalize_pending_unlabeled(question)
    if not question.title:
        question.warnings.append("empty_question_title")
    if not question.options:
        question.warnings.append("open_question_no_explicit_options")
    classify_question_type(question)


def _line_kind(
    line: dict[str, Any],
    current: QuestionDraft | None,
) -> tuple[str, Any]:
    text = line["text"]

    question_number = parse_question_number(text)
    if question_number:
        if current and has_rating_context(current.title):
            numeric_option = parse_numeric_option(
                text,
                True,
                current.source_number,
            )
            if numeric_option and (
                not question_number[1] or len(question_number[1]) <= 3
            ):
                return "numeric_option", numeric_option
        return "question_number", question_number

    yes_no = parse_yes_no_option(text, current is not None)
    if yes_no:
        return "yes_no_option", yes_no

    letter = parse_option_letter(text, current is not None)
    if letter:
        return "letter_option", letter

    if current and has_rating_context(current.title):
        numeric_option = parse_numeric_option(
            text,
            True,
            current.source_number,
        )
        if numeric_option:
            return "numeric_option", numeric_option

    return "text", text


def parse_semantic_layout(
    document: dict[str, Any],
    furniture: dict[str, Any] | None = None,
) -> dict[str, Any]:
    furniture = furniture or detect_page_furniture(document)
    excluded_ids = set(furniture["header_line_ids"]) | set(
        furniture["footer_line_ids"]
    )
    lines = sorted(
        document["all_lines"],
        key=lambda line: (
            line["page_number"],
            line["bbox"][1],
            line["bbox"][0],
        ),
    )
    pages = {page["page_number"]: page for page in document.get("pages", [])}
    start_detector = QuestionStartDetector()
    boundary_detector = OptionBoundaryDetector()

    questions: list[QuestionDraft] = []
    seen_numbers: list[int] = []
    current: QuestionDraft | None = None

    def flush_question() -> None:
        nonlocal current
        if current is None:
            return
        _finalize_question(current)
        questions.append(current)
        current = None

    def add_option(
        question: QuestionDraft,
        label: str,
        text: str,
        line: dict[str, Any],
        confidence: float,
        label_source: str = "extracted",
    ) -> None:
        option = OptionDraft(
            id=f"{question.id}_o{len(question.options) + 1}",
            label=label,
            text=text,
            text_lines=[line],
            page_start=line["page_number"],
            page_end=line["page_number"],
            bbox=line.get("bbox"),
            confidence=confidence,
            label_source=label_source,
        )
        question.options.append(option)
        question.source_page_end = max(
            question.source_page_end or 0,
            line["page_number"],
        )

    for index, line in enumerate(lines):
        if line["id"] in excluded_ids:
            continue
        if is_page_number_line(line["text"]):
            continue
        if not line["text"]:
            continue

        prev_line = lines[index - 1] if index > 0 else None
        next_line = lines[index + 1] if index + 1 < len(lines) else None
        page = pages.get(line["page_number"])

        if current and has_rating_context(current.title):
            rating_option = parse_numeric_option(
                line["text"],
                True,
                current.source_number,
            )
            if rating_option and (
                not rating_option[1] or len(rating_option[1]) <= 8
            ):
                add_option(
                    current,
                    rating_option[0],
                    rating_option[1],
                    line,
                    0.82,
                    label_source="extracted",
                )
                continue

        candidate = start_detector.detect(
            line,
            prev_line,
            next_line,
            current,
            page,
        )
        if candidate is not None:
            flush_question()
            current = _new_question(questions, candidate.number, candidate.rest, line)
            seen_numbers.append(candidate.number)
            current.warnings.append(f"question_start_reason: {candidate.reason}")
            continue

        if current is None:
            continue

        kind, payload = boundary_detector.classify(line, current)

        if kind in {"letter_option", "yes_no_option", "numeric_option"}:
            label, option_text = payload
            if kind == "yes_no_option":
                label = label.capitalize()
                option_text = label
                confidence = 0.96
            elif kind == "letter_option":
                confidence = 0.9
            else:
                confidence = 0.82
            current.title_closed = True
            add_option(
                current,
                label,
                option_text,
                line,
                confidence,
                label_source="extracted",
            )
            continue

        if kind == "generated_label_option":
            generated_label = chr(ord("A") + len(current.options))
            add_option(
                current,
                generated_label,
                normalize(line["text"]),
                line,
                0.63,
                label_source="generated",
            )
            current.warnings.append("missing_explicit_option_label")
            continue

        if kind == "unlabeled":
            # Title is already closed; buffer a potential unlabeled choice block.
            if current.title_closed:
                current.pending_unlabeled.append(line)
                current.source_page_end = max(
                    current.source_page_end or 0,
                    line["page_number"],
                )
            else:
                _append_title(current, line)
            continue

        # continuation (or ordinary body text after options)
        if current.options:
            _append_option_continuation(current.options[-1], line)
        elif current.title_closed:
            current.pending_unlabeled.append(line)
        else:
            _append_title(current, line)

    flush_question()

    seen_sorted = sorted(seen_numbers)
    missing_numbers: list[int] = []
    if seen_sorted:
        for number in range(1, seen_sorted[-1] + 1):
            if number not in seen_sorted:
                missing_numbers.append(number)

    duplicate_numbers = sorted(
        {
            number
            for number, count in Counter(seen_numbers).items()
            if count > 1
        }
    )

    warnings: list[str] = []
    if missing_numbers:
        warnings.append(f"missing_question_numbers: {missing_numbers}")
    if duplicate_numbers:
        warnings.append(f"duplicate_question_numbers: {duplicate_numbers}")

    return {
        "questions": questions,
        "seen_numbers": seen_sorted,
        "missing_numbers": missing_numbers,
        "duplicate_numbers": duplicate_numbers,
        "warnings": warnings,
    }


def _resource_for(
    document: dict[str, Any],
    resource_id: str | None,
) -> dict[str, Any] | None:
    if not resource_id:
        return None
    return _first(
        resource
        for resource in document.get("image_resources", [])
        if resource.get("id") == resource_id
    )


def _media_from_instance(
    instance: dict[str, Any],
    resource: dict[str, Any] | None,
    confidence: float,
    reason: str,
) -> MediaAttachment:
    return MediaAttachment(
        id=instance.get("id", ""),
        resource_id=instance.get("resource_id"),
        source=(resource or {}).get("source"),
        mime=(resource or {}).get("mime"),
        width=(resource or {}).get("width"),
        height=(resource or {}).get("height"),
        page=instance.get("page"),
        bbox=instance.get("bbox"),
        confidence=confidence,
        reason=reason,
    )


def _page_for(document: dict[str, Any], page_number: int | None) -> dict[str, Any] | None:
    if page_number is None:
        return None
    return _first(
        page
        for page in document.get("pages", [])
        if page.get("page_number") == page_number
    )


def _question_media_floor(
    questions: list[QuestionDraft],
    question: QuestionDraft,
    page: dict[str, Any] | None,
) -> float:
    next_question = _first(
        candidate
        for candidate in questions
        if candidate is not question
        and (candidate.source_page_start or 0) == (question.source_page_start or 0)
        and candidate.title_bbox
    )
    next_top = next_question.title_bbox[1] if next_question else None
    page_height = page.get("height") if page else 800.0
    title_bottom = question.title_bbox[3] if question.title_bbox else page_height / 2
    conservative_bottom = title_bottom + max(180.0, page_height * 0.25)

    if next_top is None:
        return conservative_bottom
    return min(next_top, conservative_bottom)


def _attach_to_question(
    question: QuestionDraft,
    instance: dict[str, Any],
    resource: dict[str, Any] | None,
    floor_y: float | None = None,
) -> bool:
    bbox = instance.get("bbox")
    if not bbox or not question.title_bbox:
        return False

    title_bottom = question.title_bbox[3]
    if question.options:
        option_top = min(
            (option.bbox[1] for option in question.options if option.bbox),
            default=None,
        )
        if option_top is not None and bbox[1] >= title_bottom - 6 and bbox[3] <= option_top + 6:
            question.media.append(
                _media_from_instance(
                    instance,
                    resource,
                    0.95,
                    "image_between_question_title_and_options",
                )
            )
            return True
        return False

    effective_floor = float("inf") if floor_y is None else floor_y
    if bbox[1] >= title_bottom - 6 and bbox[3] <= effective_floor + 6:
        question.media.append(
            _media_from_instance(
                instance,
                resource,
                0.78,
                "image_below_open_question_title",
            )
        )
        return True
    return False


def _attach_to_option_by_overlap(
    question: QuestionDraft,
    instance: dict[str, Any],
    resource: dict[str, Any] | None,
) -> bool:
    bbox = instance.get("bbox")
    if not bbox:
        return False

    best_option: OptionDraft | None = None
    best_score = 0.0
    for option in question.options:
        if not option.bbox:
            continue
        score = max(bbox_iou(bbox, option.bbox), bbox_overlap_ratio(bbox, option.bbox))
        if score > best_score:
            best_score = score
            best_option = option

    if best_option and best_score >= 0.12:
        best_option.media.append(
            _media_from_instance(
                instance,
                resource,
                0.96,
                "image_overlaps_option_bbox",
            )
        )
        return True
    return False


def _attach_to_nearest_option(
    question: QuestionDraft,
    instance: dict[str, Any],
    resource: dict[str, Any] | None,
    page: dict[str, Any] | None,
) -> bool:
    bbox = instance.get("bbox")
    if not bbox or not question.title_bbox:
        return False
    center = bbox_center(bbox)
    if not center or center[1] < question.title_bbox[3] - 5:
        return False

    best_option: OptionDraft | None = None
    best_distance = float("inf")
    for option in question.options:
        if not option.bbox:
            continue
        distance = center_distance(bbox, option.bbox)
        if distance < best_distance:
            best_distance = distance
            best_option = option

    if best_option is None:
        return False

    height = page.get("height") if page else 800.0
    threshold = max(80.0, height * 0.28)
    if best_distance <= threshold:
        best_option.media.append(
            _media_from_instance(
                instance,
                resource,
                0.55,
                "nearest_option_candidate",
            )
        )
        return True
    return False


def associate_media_to_question(
    question: QuestionDraft,
    image_instances: list[dict[str, Any]],
    document: dict[str, Any],
) -> list[MediaAttachment]:
    """Attach media that sits between a question title and its options/next question."""

    attached: list[MediaAttachment] = []
    page = _page_for(document, question.source_page_start)
    floor_y = _question_media_floor([question], question, page)
    for instance in image_instances:
        if not instance.get("bbox"):
            continue
        page_number = instance.get("page")
        if page_number is None or not (
            (question.source_page_start or 0)
            <= page_number
            <= (question.source_page_end or 0)
        ):
            continue
        resource = _resource_for(document, instance.get("resource_id"))
        if _attach_to_question(question, instance, resource, floor_y):
            attached.append(question.media[-1])
    return attached


def associate_media_to_option(
    question: QuestionDraft,
    image_instances: list[dict[str, Any]],
    document: dict[str, Any],
) -> list[MediaAttachment]:
    """Attach media that overlaps or is nearest to an option bbox."""

    attached: list[MediaAttachment] = []
    for instance in image_instances:
        if not instance.get("bbox"):
            continue
        page_number = instance.get("page")
        if page_number is None or not (
            (question.source_page_start or 0)
            <= page_number
            <= (question.source_page_end or 0)
        ):
            continue
        resource = _resource_for(document, instance.get("resource_id"))
        page = _page_for(document, page_number)
        if _attach_to_option_by_overlap(question, instance, resource):
            for option in question.options:
                if option.media and option.media[-1].id == instance.get("id"):
                    attached.append(option.media[-1])
        elif _attach_to_nearest_option(question, instance, resource, page):
            for option in question.options:
                if option.media and option.media[-1].id == instance.get("id"):
                    attached.append(option.media[-1])
    return attached


def _overlaps_furniture(
    bbox: list[float] | None,
    furniture_bboxes: list[list[float]],
) -> bool:
    if not bbox:
        return False
    return any(
        bbox_overlap_ratio(bbox, furniture) > 0.08
        or bbox_iou(bbox, furniture) > 0.04
        for furniture in furniture_bboxes
    )


def _inside_region(bbox: list[float], region: list[float]) -> bool:
    center = bbox_center(bbox)
    if not center:
        return False
    return (
        region[0] <= center[0] <= region[2]
        and region[1] <= center[1] <= region[3]
    )


def _overlaps_any_option(
    question: QuestionDraft,
    bbox: list[float] | None,
    threshold: float = 0.08,
) -> bool:
    if not bbox:
        return False
    return any(
        option.bbox
        and (
            bbox_overlap_ratio(bbox, option.bbox) >= threshold
            or bbox_iou(bbox, option.bbox) >= threshold
        )
        for option in question.options
    )


def _attach_overlap_to_option(
    question: QuestionDraft,
    instance: dict[str, Any],
    resource: dict[str, Any] | None,
) -> None:
    bbox = instance.get("bbox")
    if not bbox:
        return
    best: OptionDraft | None = None
    best_score = 0.0
    for option in question.options:
        if not option.bbox:
            continue
        score = max(bbox_iou(bbox, option.bbox), bbox_overlap_ratio(bbox, option.bbox))
        if score > best_score:
            best_score = score
            best = option
    if best is not None:
        best.media.append(
            _media_from_instance(
                instance,
                resource,
                0.96,
                "image_overlaps_option_bbox",
            )
        )


def associate_media(
    questions: list[QuestionDraft],
    document: dict[str, Any],
) -> list[MediaAttachment]:
    instances = document.get("image_instances", [])
    lines_by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for line in document.get("all_lines", []):
        lines_by_page[line["page_number"]].append(line)

    furniture_bboxes_by_page: dict[int, list[list[float]]] = defaultdict(list)
    for line in document.get("all_lines", []):
        if line.get("bbox") and line.get("role") in {"header", "footer"}:
            furniture_bboxes_by_page[line["page_number"]].append(line["bbox"])

    # Build a source-page question region for every question.
    for index, question in enumerate(questions):
        if question.source_page_start is None or question.title_bbox is None:
            continue
        page = _page_for(document, question.source_page_start)
        if not page:
            continue
        next_question = _first(
            candidate
            for candidate in questions[index + 1 :]
            if candidate.source_page_start == question.source_page_start
            and candidate.title_bbox
        )
        next_top = next_question.title_bbox[1] if next_question else None
        region_bottom = (
            next_top - 2
            if next_top is not None
            else question.title_bbox[3] + 45
        )
        question.question_region = {
            "page": question.source_page_start,
            "bbox": [
                0,
                max(0, question.title_bbox[1] - 5),
                page["width"],
                max(question.title_bbox[3] + 5, region_bottom),
            ],
        }

    assigned_ids: set[str] = set()
    unattached: list[MediaAttachment] = []

    for question in questions:
        for instance in instances:
            if instance["id"] in assigned_ids or not instance.get("bbox"):
                continue
            page_number = instance.get("page")
            if page_number is None or not (
                (question.source_page_start or 0)
                <= page_number
                <= (question.source_page_end or 0)
            ):
                continue

            resource = _resource_for(document, instance.get("resource_id"))
            bbox = instance.get("bbox")
            if _overlaps_furniture(
                bbox,
                furniture_bboxes_by_page.get(page_number, []),
            ):
                continue

            # Question media has priority. Only attach to a question if the image
            # is inside that question's source-page region and not inside an option.
            region = question.question_region
            if region and bbox and _inside_region(bbox, region["bbox"]):
                if not _overlaps_any_option(question, bbox):
                    question.media.append(
                        _media_from_instance(
                            instance,
                            resource,
                            0.9,
                            "image_inside_question_region_not_option",
                        )
                    )
                    assigned_ids.add(instance["id"])
                    continue

            # Option media only when there is a clear bbox overlap.
            if _overlaps_any_option(question, bbox, threshold=0.18):
                _attach_overlap_to_option(question, instance, resource)
                assigned_ids.add(instance["id"])
                continue

    for instance in instances:
        if instance["id"] in assigned_ids:
            continue
        resource = _resource_for(document, instance.get("resource_id"))
        unattached.append(
            _media_from_instance(
                instance,
                resource,
                0.0,
                "unattached_media_no_reliable_association",
            )
        )

    for question in questions:
        bboxes: list[list[float] | None] = [question.title_bbox]
        bboxes.extend(option.bbox for option in question.options)
        bboxes.extend(media.bbox for media in question.media)
        bboxes.extend(
            media.bbox for option in question.options for media in option.media
        )
        question.bbox = bbox_union(bboxes)

    return unattached


def map_forms_pages(
    document: dict[str, Any],
    questions: list[QuestionDraft],
    forms_title: str | None,
) -> tuple[dict[int, str | None], list[dict[str, Any]], list[str]]:
    pdf_pages = sorted(document["pages"], key=lambda page: page["page_number"])
    page_map: dict[int, str | None] = {
        page["page_number"]: None for page in pdf_pages
    }
    warnings = ["forms_page_detection_not_available"]

    for page in pdf_pages:
        page["forms_page_id"] = None

    return page_map, [], warnings


def build_survey_questions(
    questions: list[QuestionDraft],
    page_map: dict[int, str | None],
) -> list[dict[str, Any]]:
    survey_questions: list[dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        page_id = (
            page_map.get(question.source_page_start)
            if question.source_page_start is not None
            else None
        )
        survey_questions.append(
            {
                "id": question.id,
                "source_number": question.source_number,
                "source_page_start": question.source_page_start,
                "source_page_end": question.source_page_end,
                "page_id": page_id,
                "type": question.type,
                "title": question.title,
                "required": question.required,
                "required_confidence": question.required_confidence,
                "type_confidence": question.type_confidence,
                "type_reasons": question.type_reasons,
                "order": index,
                "options": [
                    {
                        **option.to_dict(),
                        "order": option_index + 1,
                    }
                    for option_index, option in enumerate(question.options)
                ],
                "media": [media.to_dict() for media in question.media],
                "validation": {},
                "settings": {},
                "bbox": question.bbox,
                "title_bbox": question.title_bbox,
                "warnings": question.warnings,
            }
        )
    return survey_questions


def build_output(
    document: dict[str, Any],
    layout: dict[str, Any],
    furniture: dict[str, Any],
    forms_title: str | None,
    title_override: str | None,
) -> dict[str, Any]:
    questions: list[QuestionDraft] = layout["questions"]
    page_map, forms_pages, page_mapping_warnings = map_forms_pages(
        document,
        questions,
        forms_title,
    )
    unattached = associate_media(questions, document)

    if forms_pages:
        survey_pages = forms_pages
    else:
        survey_pages = [
            {
                "id": f"pdf_page_{page['page_number']}",
                "order": page["page_number"],
                "title": None,
                "description": None,
                "pdf_pages": [page["page_number"]],
                "forms_page_id": None,
            }
            for page in sorted(
                document["pages"],
                key=lambda item: item["page_number"],
            )
        ]

    survey_questions = build_survey_questions(questions, page_map)
    title = forms_title or title_override or "Imported Survey"
    type_counts = Counter(question["type"] for question in survey_questions)
    low_confidence_questions = [
        {
            "id": question["id"],
            "source_number": question["source_number"],
            "type": question["type"],
            "type_confidence": question["type_confidence"],
            "required_confidence": question["required_confidence"],
        }
        for question in survey_questions
        if question["type_confidence"] < 0.7 or question["required_confidence"] < 0.7
    ]

    question_media_count = sum(len(question.media) for question in questions)
    option_media_count = sum(
        len(option.media) for question in questions for option in question.options
    )

    parser_warnings = list(layout.get("warnings", []))
    import_report = {
        "pages": document["page_count"],
        "forms_pages": len(forms_pages),
        "detected_questions": len(survey_questions),
        "detected_options": sum(len(q["options"]) for q in survey_questions),
        "detected_media_resources": len(document.get("image_resources", [])),
        "detected_media_instances": len(document.get("image_instances", [])),
        "question_type_counts": dict(type_counts),
        "low_confidence_questions": low_confidence_questions,
        "unattached_media": [media.to_dict() for media in unattached],
        "question_media_count": question_media_count,
        "option_media_count": option_media_count,
        "header_lines_removed": furniture["header_lines_removed"],
        "footer_lines_removed": furniture["footer_lines_removed"],
        "duplicate_question_numbers": layout["duplicate_numbers"],
        "missing_question_numbers": layout["missing_numbers"],
        "page_mapping_warnings": page_mapping_warnings,
    }

    document_out = {
        **document,
        "forms_title": forms_title,
        "header_lines_removed": furniture["header_lines_removed"],
        "footer_lines_removed": furniture["footer_lines_removed"],
    }

    return {
        "document": document_out,
        "survey": {
            "schema_version": 1,
            "title": title,
            "description": "Imported from Microsoft Forms PDF",
            "pages": survey_pages,
            "questions": survey_questions,
            "settings": {
                "anonymous": False,
                "allow_multiple": False,
                "max_responses": 1,
                "shuffle_questions": False,
                "shuffle_options": False,
                "show_progress": True,
                "allow_back": True,
                "allow_resume": True,
            },
            "metadata": {
                "source": "pdf",
                "warnings": parser_warnings + page_mapping_warnings,
            },
        },
        "import_report": import_report,
    }


def _embed_media_urls(survey_file: dict[str, Any], output_dir: Path) -> int:
    embedded = 0
    output_root = output_dir.resolve()

    def embed(media: dict[str, Any]) -> None:
        nonlocal embedded
        url = media.get("url")
        if not isinstance(url, str) or not url or url.startswith(("data:", "http://", "https://")):
            return

        asset_path = (output_dir / url).resolve()
        try:
            asset_path.relative_to(output_root)
        except ValueError:
            return
        if not asset_path.is_file():
            return

        mime = media.get("mime_type") or "application/octet-stream"
        encoded = base64.b64encode(asset_path.read_bytes()).decode("ascii")
        media["source"] = "url"
        media["url"] = f"data:{mime};base64,{encoded}"
        media["file_name"] = asset_path.name
        embedded += 1

    for question in survey_file["survey"].get("questions", []):
        for media in question.get("media", []):
            embed(media)
        for option in question.get("options", []):
            option_media = option.get("media", [])
            if isinstance(option_media, dict):
                option_media = [option_media]
            for media in option_media:
                embed(media)

    return embedded


def run_pipeline(
    pdf_path: str,
    output_dir: Path,
    title_override: str | None = None,
) -> dict[str, Any]:
    document = extract_document_model(pdf_path, output_dir)
    forms_title = detect_forms_title(document)
    furniture = detect_page_furniture(document, forms_title)
    layout = parse_semantic_layout(document, furniture)
    output = build_output(
        document,
        layout,
        furniture,
        forms_title,
        title_override,
    )

    (output_dir / "document.json").write_text(
        json.dumps(output["document"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    survey_file = copy.deepcopy({
        "schema_version": output["survey"]["schema_version"],
        "survey": {
            key: value
            for key, value in output["survey"].items()
            if key != "schema_version"
        },
    })
    output["import_report"]["embedded_media_count"] = _embed_media_urls(
        survey_file,
        output_dir,
    )
    (output_dir / "survey.json").write_text(
        json.dumps(survey_file, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "import-report.json").write_text(
        json.dumps(output["import_report"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return output


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a Microsoft Forms PDF export to document + unified survey JSON."
    )
    parser.add_argument("input", help="Input PDF file path")
    parser.add_argument("-o", "--output", default="/tmp/pdf-import", help="Output directory")
    parser.add_argument("--title", default=None, help="Override survey title")
    args = parser.parse_args()

    pdf_path = Path(args.input)
    if not pdf_path.exists():
        print(f"File not found: {pdf_path}", file=sys.stderr)
        return 2

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    output = run_pipeline(str(pdf_path), output_dir, args.title)
    report = output["import_report"]

    print(f"Wrote {output_dir}")
    print(f"Pages: {report['pages']}")
    print(f"Questions: {report['detected_questions']}")
    print(f"Options: {report['detected_options']}")
    print(f"Media resources: {report['detected_media_resources']}")
    print(f"Page mapping warnings: {len(report['page_mapping_warnings'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
