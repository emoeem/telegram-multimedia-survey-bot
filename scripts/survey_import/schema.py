"""Python-side validation mirroring the web admin's survey schema checks.

The authoritative rules live in ``src/survey/validator.ts``
(``validateUnifiedSurvey``). This module mirrors them so the CLI can reject
invalid output before the user tries to upload it. It does not redesign the
survey schema; it only checks the structure the existing importer requires.
"""

from __future__ import annotations

import re
from typing import Any

from .errors import SurveyImportError

SURVEY_SCHEMA_VERSION = 1

# Same set as src/survey/question-rules.ts SURVEY_QUESTION_TYPES.
SURVEY_QUESTION_TYPES = {
    "single",
    "multiple",
    "text",
    "long_text",
    "number",
    "yes_no",
    "rating",
    "matrix",
    "date",
    "time",
    "image",
    "video",
    "audio",
    "file",
}

MATRIX_COLUMN_MIN = 2


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def validate_survey_json(survey_file: Any) -> list[str]:
    """Return human-readable issues, or an empty list when the file is valid."""

    issues: list[str] = []

    if not _is_record(survey_file):
        return ["$.survey: Survey file must be an object"]

    if survey_file.get("schema_version") != SURVEY_SCHEMA_VERSION:
        issues.append(
            f"$.schema_version: schema_version must be {SURVEY_SCHEMA_VERSION}"
        )

    survey = survey_file.get("survey")
    if not _is_record(survey):
        issues.append("$.survey: survey is required")
        return issues

    cover = survey.get("cover")
    if cover is not None:
        if not _is_record(cover):
            issues.append("$.survey.cover: cover must be an object or null")
        else:
            cover_url = cover.get("url")
            if not isinstance(cover_url, str) or not re.match(
                r"^(?:data:|https?://)", cover_url
            ):
                issues.append(
                    "$.survey.cover.url: cover 的 URL 必须是 data: 或 http(s) 绝对地址"
                )

    title = survey.get("title")
    if not isinstance(title, str) or not title.strip():
        issues.append("$.survey.title: title is required")

    questions = survey.get("questions")
    if not isinstance(questions, list) or not questions:
        issues.append("$.survey.questions: questions must be a non-empty array")
        return issues

    for index, question in enumerate(questions):
        path = f"$.survey.questions[{index}]"
        if not _is_record(question):
            issues.append(f"{path}: question must be an object")
            continue

        if not question.get("id"):
            issues.append(f"{path}.id: id is required")

        qtype = question.get("type")
        if qtype not in SURVEY_QUESTION_TYPES:
            issues.append(
                f"{path}.type: type must be one of: "
                + ", ".join(sorted(SURVEY_QUESTION_TYPES))
            )

        qtitle = question.get("title")
        if not isinstance(qtitle, str) or not qtitle.strip():
            issues.append(f"{path}.title: title is required")

        required = question.get("required")
        if not isinstance(required, bool) and required is not None:
            issues.append(f"{path}.required: required must be a boolean or null")

        if not isinstance(question.get("options"), list):
            issues.append(f"{path}.options: options must be an array")

        if not isinstance(question.get("media"), list):
            issues.append(f"{path}.media: media must be an array")

        def check_media_url(media: Any, media_path: str) -> None:
            if not _is_record(media):
                return
            url = media.get("url")
            if isinstance(url, str) and url and not re.match(
                r"^(?:data:|https?://)", url
            ):
                issues.append(
                    f"{media_path}.url: 媒体 URL 必须是 data: 或 http(s) "
                    "绝对地址，不支持 assets/... 相对路径（请用新版脚本重新转换）"
                )

        for media_index, media in enumerate(question.get("media") or []):
            check_media_url(media, f"{path}.media[{media_index}]")
        for option_index, option in enumerate(question.get("options") or []):
            if not _is_record(option):
                continue
            for media_index, media in enumerate(option.get("media") or []):
                check_media_url(
                    media,
                    f"{path}.options[{option_index}].media[{media_index}]",
                )

        if qtype == "matrix":
            settings = question.get("settings")
            columns = (
                settings.get("columns")
                if _is_record(settings) and isinstance(settings.get("columns"), list)
                else []
            )
            columns = [
                column
                for column in columns
                if isinstance(column, str)
            ]
            if len(columns) < MATRIX_COLUMN_MIN:
                issues.append(
                    f"{path}.settings.columns: matrix questions require at least "
                    f"{MATRIX_COLUMN_MIN} columns"
                )

    return issues


def ensure_valid_survey_json(survey_file: Any) -> None:
    """Raise SurveyImportError(SCHEMA_VALIDATION_FAILED) when invalid."""

    issues = validate_survey_json(survey_file)
    if issues:
        raise SurveyImportError(
            "SCHEMA_VALIDATION_FAILED",
            "生成的问卷 JSON 未通过项目 Survey Schema 校验：\n" + "\n".join(issues),
            details={"issues": issues},
        )
