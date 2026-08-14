#!/usr/bin/env python3
"""Microsoft Forms PDF -> DocumentModel -> Semantic Layout Parser.

The parser intentionally separates extraction, semantic layout parsing,
question/option/media association, and unified-survey serialization. It keeps
spatial relationships and reports uncertainty instead of silently discarding
ambiguous content.
"""

from __future__ import annotations

import argparse
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
    r"^(?:第\s*\d+\s*页|Page\s*\d+|\d+\s*/\s*\d+)$",
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


def detect_page_furniture(document: dict[str, Any]) -> dict[str, Any]:
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
    furniture: dict[str, Any],
) -> str | None:
    pages = document["pages"]
    lines = document["all_lines"]
    excluded_ids = set(furniture["header_line_ids"]) | set(
        furniture["footer_line_ids"]
    )
    candidates: list[dict[str, Any]] = []
    seen_text_counts = Counter(
        normalize_key(line["text"])
        for line in lines
        if line["id"] not in excluded_ids
    )

    for line in lines:
        if line["id"] in excluded_ids:
            continue
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

        repeat_bonus = seen_text_counts.get(normalize_key(line["text"]), 0) * 0.35
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
        if line["page_number"] == best["page_number"] and line["id"] not in excluded_ids
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


def _clean_required_title_text(text: str) -> str:
    return re.sub(r"^\s*\*+\s*", "", text).strip()


def _required_signal(text: str) -> tuple[bool, float] | None:
    t = normalize_key(text)
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
    return question


def _append_title(question: QuestionDraft, line: dict[str, Any]) -> None:
    text = normalize(line["text"])
    signal = _required_signal(text)
    if signal and text.strip().startswith("*") and len(text.strip()) <= 8:
        apply_required_signal(question, text)
        return
    if text in {"必答题", "必答", "选答题", "非必答题"}:
        apply_required_signal(question, text)
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


def _finalize_question(question: QuestionDraft) -> None:
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

    for line in document["all_lines"]:
        if line["id"] in excluded_ids:
            continue
        if is_page_number_line(line["text"]):
            continue
        if not line["text"]:
            continue

        kind, payload = _line_kind(line, current)

        if kind == "question_number":
            flush_question()
            number, rest = payload
            current = _new_question(questions, number, rest, line)
            seen_numbers.append(number)
            continue

        if current is None:
            continue

        if kind == "letter_option":
            label, option_text = payload
            option = OptionDraft(
                id=f"{current.id}_o{len(current.options) + 1}",
                label=label,
                text=option_text,
                text_lines=[line],
                page_start=line["page_number"],
                page_end=line["page_number"],
                bbox=line.get("bbox"),
                confidence=0.9,
            )
            current.options.append(option)
            current.source_page_end = max(
                current.source_page_end or 0,
                line["page_number"],
            )
            continue

        if kind == "yes_no_option":
            label, option_text = payload
            option = OptionDraft(
                id=f"{current.id}_o{len(current.options) + 1}",
                label=label,
                text=option_text,
                text_lines=[line],
                page_start=line["page_number"],
                page_end=line["page_number"],
                bbox=line.get("bbox"),
                confidence=0.96,
            )
            current.options.append(option)
            current.source_page_end = max(
                current.source_page_end or 0,
                line["page_number"],
            )
            continue

        if kind == "numeric_option":
            label, option_text = payload
            option = OptionDraft(
                id=f"{current.id}_o{len(current.options) + 1}",
                label=label,
                text=option_text,
                text_lines=[line],
                page_start=line["page_number"],
                page_end=line["page_number"],
                bbox=line.get("bbox"),
                confidence=0.82,
            )
            current.options.append(option)
            current.source_page_end = max(
                current.source_page_end or 0,
                line["page_number"],
            )
            continue

        if current.options:
            _append_option_continuation(current.options[-1], line)
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


def associate_media(
    questions: list[QuestionDraft],
    document: dict[str, Any],
) -> list[MediaAttachment]:
    instances = document.get("image_instances", [])
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
            page = _page_for(document, page_number)
            if _attach_to_question(question, instance, resource, _question_media_floor(questions, question, page)):
                assigned_ids.add(instance["id"])
                continue
            if _attach_to_option_by_overlap(question, instance, resource):
                assigned_ids.add(instance["id"])

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
            page = _page_for(document, page_number)
            if _attach_to_nearest_option(question, instance, resource, page):
                assigned_ids.add(instance["id"])

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
    title_page = _first(page for page in pdf_pages if page["page_number"] == 1)
    start_pages = sorted({q.source_page_start for q in questions if q.source_page_start})
    title_page_number = title_page["page_number"] if title_page else None

    page_map: dict[int, str | None] = {}
    forms_pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    next_forms_number = 1

    if forms_title and title_page_number is not None:
        forms_id = f"forms_{next_forms_number}"
        page_map[title_page_number] = forms_id
        forms_pages.append(
            {
                "id": forms_id,
                "order": next_forms_number,
                "title": None,
                "description": None,
                "pdf_pages": [title_page_number],
                "forms_page_id": forms_id,
            }
        )
        next_forms_number += 1

    for pdf_page in pdf_pages:
        page_number = pdf_page["page_number"]
        if page_number in page_map:
            continue
        if page_number in start_pages:
            forms_id = f"forms_{next_forms_number}"
            page_map[page_number] = forms_id
            forms_pages.append(
                {
                    "id": forms_id,
                    "order": next_forms_number,
                    "title": None,
                    "description": None,
                    "pdf_pages": [page_number],
                    "forms_page_id": forms_id,
                }
            )
            next_forms_number += 1
            continue

        previous_start = _first(
            start for start in reversed(start_pages) if start < page_number
        )
        if previous_start is not None and previous_start in page_map:
            page_map[page_number] = page_map[previous_start]
            forms_page = _first(
                page for page in forms_pages if page["id"] == page_map[page_number]
            )
            if forms_page is not None and page_number not in forms_page["pdf_pages"]:
                forms_page["pdf_pages"].append(page_number)
            warnings.append(f"estimated_forms_page_for_pdf_page_{page_number}")
        else:
            page_map[page_number] = None
            warnings.append(f"forms_page_not_detected_for_pdf_page_{page_number}")

    if not forms_pages:
        warnings.append("no_reliable_forms_page_mapping")

    for page in pdf_pages:
        page["forms_page_id"] = page_map.get(page["page_number"])

    return page_map, forms_pages, warnings


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


def run_pipeline(
    pdf_path: str,
    output_dir: Path,
    title_override: str | None = None,
) -> dict[str, Any]:
    document = extract_document_model(pdf_path, output_dir)
    furniture = detect_page_furniture(document)
    forms_title = detect_forms_title(document, furniture)
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
    (output_dir / "survey.json").write_text(
        json.dumps(output["survey"], ensure_ascii=False, indent=2),
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
