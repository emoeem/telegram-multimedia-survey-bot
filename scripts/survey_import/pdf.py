"""Thin wrapper around scripts/forms_pdf_to_survey.py — no parser logic here."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .errors import SurveyImportError

_SCRIPT_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

try:
    import forms_pdf_to_survey  # noqa: E402
except ModuleNotFoundError as error:  # pragma: no cover - environment issue
    raise SurveyImportError(
        "PDF_PARSE_FAILED",
        "无法加载 forms_pdf_to_survey.py，请确认脚本文件存在。",
    ) from error


def ensure_pymupdf_available() -> None:
    if forms_pdf_to_survey.fitz is None:
        raise SurveyImportError(
            "PDF_PARSE_FAILED",
            "缺少 PDF 处理组件 PyMuPDF。请运行 uv sync 后重试。",
        )


def parse_pdf_to_survey(
    pdf_path: Path,
    work_dir: Path,
    *,
    title_override: str | None = None,
) -> dict[str, Any]:
    """Run the existing PDF pipeline and return the survey.json it produces.

    Reuses ``forms_pdf_to_survey.run_pipeline`` exactly; the returned dict is
    the same survey.json file the script writes (media data URLs embedded).
    """

    ensure_pymupdf_available()
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        forms_pdf_to_survey.run_pipeline(
            str(pdf_path),
            work_dir,
            title_override,
        )
    except SurveyImportError:
        raise
    except Exception as error:
        raise SurveyImportError(
            "PDF_PARSE_FAILED",
            f"PDF 问卷解析失败：{error}",
        ) from error

    survey_path = work_dir / "survey.json"
    if not survey_path.is_file():
        raise SurveyImportError(
            "PDF_PARSE_FAILED",
            "PDF 转换器未生成 survey.json。",
        )
    try:
        return json.loads(survey_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SurveyImportError(
            "PDF_PARSE_FAILED",
            "PDF 转换器生成的 survey.json 不是有效 JSON。",
        ) from error
