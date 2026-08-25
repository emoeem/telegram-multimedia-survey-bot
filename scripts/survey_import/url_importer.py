"""End-to-end URL -> standard survey.json importer."""

from __future__ import annotations

import json
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from .document import (
    DEFAULT_MAX_BYTES,
    DEFAULT_TIMEOUT,
    convert_to_pdf,
    download_document,
    ensure_pdf_file,
    fetch_url,
    save_survey_json,
)
from .errors import SurveyImportError
from .microsoft import (
    DEFAULT_USER_AGENT,
    fetch_forms_definition,
    forms_definition_to_survey,
    is_forms_url,
)
from .pdf import parse_pdf_to_survey
from .schema import ensure_valid_survey_json

DEFAULT_OUTPUT_DIR = Path("output")


@dataclass
class ImportResult:
    survey_file: dict[str, Any]
    output_path: Path
    source_kind: str
    title: str
    question_count: int
    warnings: list[str] = field(default_factory=list)
    work_dir: Path | None = None


def _validate_url(url: str) -> None:
    if not isinstance(url, str) or not url.strip():
        raise SurveyImportError("INVALID_URL", "URL 不能为空。")
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SurveyImportError(
            "INVALID_URL",
            f"无效的 URL：{url.strip()}（仅支持 http/https）。",
        )


def _safe_filename_part(text: str, fallback: str = "questionnaire") -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", text.strip()).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return cleaned[:80] or fallback


def _default_output_path(
    output_dir: Path,
    survey_file: dict[str, Any] | None,
) -> Path:
    title = ""
    if survey_file:
        title = str(survey_file.get("survey", {}).get("title") or "")
    return output_dir / f"{_safe_filename_part(title)}.json"


def _import_forms(
    url: str,
    *,
    output_dir: Path,
    output_path: Path | None,
    timeout: float,
    user_agent: str,
    progress: Callable[[str], None] | None,
) -> ImportResult:
    if progress:
        progress("Resolving Microsoft Forms URL...")
    page = fetch_url(
        url,
        timeout=timeout,
        user_agent=user_agent,
    )
    if page.status_code != 200:
        raise SurveyImportError(
            "DOWNLOAD_FAILED",
            f"Microsoft Forms 页面请求失败（HTTP {page.status_code}）。",
            details={"status": page.status_code},
        )
    html_text = page.body.decode("utf-8", "replace")
    if progress:
        progress("Fetching form definition...")
    definition = fetch_forms_definition(
        html_text,
        fetch_url=fetch_url,
        timeout=timeout,
        user_agent=user_agent,
    )
    if progress:
        progress("Parsing questionnaire...")
    survey_file = forms_definition_to_survey(definition)
    if progress:
        progress("Validating survey JSON...")
    ensure_valid_survey_json(survey_file)

    target = output_path or _default_output_path(output_dir, survey_file)
    save_survey_json(survey_file, target)
    questions = survey_file["survey"]["questions"]
    warnings = list(survey_file["survey"].get("metadata", {}).get("warnings", []))
    return ImportResult(
        survey_file=survey_file,
        output_path=target,
        source_kind="microsoft_forms",
        title=str(survey_file["survey"]["title"]),
        question_count=len(questions),
        warnings=warnings,
    )


def _import_json(
    json_path: Path,
    *,
    output_dir: Path,
    output_path: Path | None,
) -> ImportResult:
    try:
        survey_file = json.loads(json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as error:
        raise SurveyImportError(
            "UNSUPPORTED_FORMAT",
            f"JSON 文件无法读取：{error}",
        ) from error
    ensure_valid_survey_json(survey_file)

    target = output_path or _default_output_path(output_dir, survey_file)
    save_survey_json(survey_file, target)
    questions = survey_file["survey"]["questions"]
    warnings = list(survey_file.get("survey", {}).get("metadata", {}).get("warnings", []))
    return ImportResult(
        survey_file=survey_file,
        output_path=target,
        source_kind="json",
        title=str(survey_file["survey"]["title"]),
        question_count=len(questions),
        warnings=warnings,
    )


def _import_document(
    url: str,
    *,
    output_dir: Path,
    output_path: Path | None,
    timeout: float,
    max_bytes: int,
    user_agent: str,
    title_override: str | None,
    progress: Callable[[str], None] | None,
) -> ImportResult:
    with tempfile.TemporaryDirectory(prefix="survey-import-") as temp_dir:
        work_dir = Path(temp_dir)
        if progress:
            progress("Resolving URL...")
        file_path, content_type, kind = download_document(
            url,
            work_dir,
            timeout=timeout,
            max_bytes=max_bytes,
            user_agent=user_agent,
        )

        if kind == "json":
            if progress:
                progress("Validating survey JSON...")
            return _import_json(
                file_path,
                output_dir=output_dir,
                output_path=output_path,
            )
        if kind == "other":
            raise SurveyImportError(
                "UNSUPPORTED_FORMAT",
                f"不支持的文件格式（Content-Type: {content_type or '未知'}）。"
                "目前支持 PDF、Word/Excel/PowerPoint 文档以及 survey JSON。",
            )

        if kind == "office":
            if progress:
                progress("Converting document to PDF...")
            file_path = convert_to_pdf(file_path, work_dir)

        ensure_pdf_file(file_path)
        if progress:
            progress("Parsing questionnaire...")
        survey_file = parse_pdf_to_survey(
            file_path,
            work_dir / "pipeline",
            title_override=title_override,
        )
        if progress:
            progress("Validating survey JSON...")
        ensure_valid_survey_json(survey_file)

        target = output_path or _default_output_path(output_dir, survey_file)
        save_survey_json(survey_file, target)
        questions = survey_file["survey"]["questions"]
        warnings = list(survey_file.get("survey", {}).get("metadata", {}).get("warnings", []))
        return ImportResult(
            survey_file=survey_file,
            output_path=target,
            source_kind=kind,
            title=str(survey_file["survey"]["title"]),
            question_count=len(questions),
            warnings=warnings,
        )


def import_survey_from_url(
    url: str,
    *,
    output_dir: Path | str = DEFAULT_OUTPUT_DIR,
    output_path: Path | str | None = None,
    title: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_BYTES,
    user_agent: str = DEFAULT_USER_AGENT,
    progress: Callable[[str], None] | None = None,
) -> ImportResult:
    """Import a survey from a URL and write the standard survey.json.

    Supported inputs:
    * Microsoft Forms URLs (public forms)
    * OneDrive / SharePoint / Word Online document sharing links
    * Direct PDF URLs
    * Direct survey JSON URLs
    * Any URL whose response is a PDF or an Office/text document
    """

    _validate_url(url)
    output_dir_path = Path(output_dir)
    output_path_obj = Path(output_path) if output_path else None
    url = url.strip()

    if is_forms_url(url):
        return _import_forms(
            url,
            output_dir=output_dir_path,
            output_path=output_path_obj,
            timeout=timeout,
            user_agent=user_agent,
            progress=progress,
        )
    return _import_document(
        url,
        output_dir=output_dir_path,
        output_path=output_path_obj,
        timeout=timeout,
        max_bytes=max_bytes,
        user_agent=user_agent,
        title_override=title,
        progress=progress,
    )


def run_cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "通过 URL 导入 Microsoft 问卷并输出项目标准 survey.json。"
            "支持 Microsoft Forms、OneDrive/SharePoint 文档与直接 PDF 链接。"
        )
    )
    parser.add_argument("url", help="Microsoft 文档 / Forms / PDF 的 URL")
    parser.add_argument(
        "-o",
        "--output",
        help="输出 JSON 文件路径；默认写到 output/<标题>.json",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="覆盖问卷标题（仅对 PDF/文档导入生效）",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"网络请求超时秒数（默认 {DEFAULT_TIMEOUT:.0f}）",
    )
    args = parser.parse_args(argv)

    step_counter = 0

    def step(message: str) -> None:
        nonlocal step_counter
        step_counter += 1
        print(f"[{step_counter}/5] {message}")

    try:
        result = import_survey_from_url(
            args.url,
            output_path=args.output,
            title=args.title,
            timeout=args.timeout,
            progress=step,
        )
    except SurveyImportError as error:
        print(f"导入失败 [{error.code}]: {error.message}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已取消。", file=sys.stderr)
        return 130

    print("\n✓ Import successful")
    print(f"Title: {result.title}")
    print(f"Questions: {result.question_count}")
    print(f"Output: {result.output_path}")
    if result.warnings:
        preview = "、".join(result.warnings[:5])
        more = "……" if len(result.warnings) > 5 else ""
        print(f"导入警告 ({len(result.warnings)}): {preview}{more}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run_cli())
