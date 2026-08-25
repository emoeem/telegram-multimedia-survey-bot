"""Python-side validation mirroring the web admin's survey schema checks.

The authoritative rules live in ``src/survey/validator.ts``
(``validateUnifiedSurvey``). This module mirrors them so the CLI can reject
invalid output before the user tries to upload it. It does not redesign the
survey schema; it only checks the structure the existing importer requires.
"""

from __future__ import annotations

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
