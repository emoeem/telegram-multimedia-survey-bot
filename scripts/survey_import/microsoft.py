"""Microsoft URL handling: classification, Forms extraction, download URLs.

Two very different Microsoft URL families are supported:

* Microsoft Forms (``forms.office.com`` / ``forms.cloud.microsoft`` /
  ``forms.microsoft.com``). Public forms expose their definition through a
  page-level ``window.OfficeFormServerInfo`` blob that includes an OData
  ``prefetchFormUrl``. We fetch that API and convert the definition into the
  same survey.json structure the PDF pipeline emits.

* OneDrive / SharePoint / Office Online documents (``1drv.ms``,
  ``onedrive.live.com``, ``*.sharepoint.com``, ``officeapps.live.com``).
  Appending ``download=1`` returns the original file bytes; the caller then
  converts Office formats to PDF and reuses the existing PDF parser.
"""

from __future__ import annotations

import html as html_lib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .errors import SurveyImportError

FORMS_HOSTS = {
    "forms.office.com",
    "forms.cloud.microsoft",
    "forms.microsoft.com",
    "forms.osi.office.net",
}

FORMS_HOST_SUFFIXES = (
    ".forms.office.com",
    ".forms.cloud.microsoft",
    ".forms.microsoft.com",
    ".forms.osi.office.net",
)

ONEDRIVE_HOSTS = {
    "1drv.ms",
    "onedrive.live.com",
    "officeapps.live.com",
    "office.live.com",
}

SHAREPOINT_HOST_SUFFIXES = (
    ".sharepoint.com",
    ".sharepoint-df.com",
    ".sharepoint.cn",
    ".sharepoint.com.cn",
)

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
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


def is_forms_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in FORMS_HOSTS or host.endswith(FORMS_HOST_SUFFIXES)


def is_onedrive_or_sharepoint_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if host in ONEDRIVE_HOSTS:
        return True
    return host.endswith(SHAREPOINT_HOST_SUFFIXES)


def is_microsoft_url(url: str) -> bool:
    return is_forms_url(url) or is_onedrive_or_sharepoint_url(url)


@dataclass
class ResolvedDownload:
    url: str
    """Final URL to fetch; already carries the download=1 hint when relevant."""

    source_kind: str
    """forms | onedrive | sharepoint | office_online | direct"""


def resolve_download_url(url: str) -> ResolvedDownload:
    """Turn a Microsoft sharing link into a directly downloadable URL.

    ``1drv.ms`` short links are resolved by the HTTP layer (it follows
    redirects); we still mark them as onedrive so ``download=1`` is applied to
    whatever host they land on.
    """

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()

    if is_forms_url(url):
        return ResolvedDownload(url=url, source_kind="forms")

    if host in ONEDRIVE_HOSTS or host.endswith(SHAREPOINT_HOST_SUFFIXES):
        # officeapps.live.com/op/view.aspx?src=<original> hosts the original
        # document URL in the src query parameter.
        if host == "officeapps.live.com" and parsed.path.startswith("/op/"):
            src = parse_qs(parsed.query).get("src", [None])[0]
            if src:
                return ResolvedDownload(
                    url=resolve_download_url(src).url,
                    source_kind="office_online",
                )
        return ResolvedDownload(
            url=_with_download_param(url),
            source_kind="onedrive" if "live.com" in host else "sharepoint",
        )

    return ResolvedDownload(url=url, source_kind="direct")


def _with_download_param(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if "download" in query:
        return url
    query["download"] = ["1"]
    return urlunparse(
        parsed._replace(query=urlencode(query, doseq=True))
    )


def _extract_balanced_json_object(text: str, start: int) -> str | None:
    """Extract the JSON object literal starting at ``start`` (at '{')."""

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def extract_office_form_server_info(html_text: str) -> dict[str, Any]:
    """Pull ``window.OfficeFormServerInfo = {...};`` out of the page HTML."""

    marker = "window.OfficeFormServerInfo"
    start = html_text.find(marker)
    if start < 0:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "无法在 Microsoft Forms 页面中找到问卷信息（页面结构可能已变更，"
            "或该链接不是可公开访问的 Forms 问卷）。",
        )
    brace = html_text.find("{", start)
    if brace < 0:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "Microsoft Forms 页面中的问卷信息格式异常，无法解析。",
        )
    raw = _extract_balanced_json_object(html_text, brace)
    if raw is None:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "Microsoft Forms 页面中的问卷信息不完整，无法解析。",
        )
    try:
        return json.loads(html_lib.unescape(raw))
    except json.JSONDecodeError as error:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            f"Microsoft Forms 页面中的问卷信息不是有效 JSON：{error}",
        ) from error


def fetch_forms_definition(
    html_text: str,
    *,
    fetch_url: Any,
    timeout: float,
    user_agent: str,
) -> dict[str, Any]:
    """Fetch the form-definition JSON via the page's prefetch API URL."""

    info = extract_office_form_server_info(html_text)
    api_url = info.get("prefetchFormUrl") or info.get(
        "prefetchFormWithResponsesUrl"
    )
    if not isinstance(api_url, str) or not api_url.startswith(("https://", "http://")):
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "Microsoft Forms 页面未提供问卷定义 API 地址，无法获取问卷内容。",
        )

    headers = {
        "Accept": "application/json",
        "User-Agent": user_agent,
        "X-UserSessionId": str(info.get("serverSessionId") or ""),
        "__RequestVerificationToken": str(info.get("antiForgeryToken") or ""),
    }
    response = fetch_url(api_url, headers=headers, timeout=timeout)
    if response.status_code == 401 or response.status_code == 403:
        raise SurveyImportError(
            "DOCUMENT_REQUIRES_AUTH",
            "This Microsoft form requires authentication "
            "or is not publicly accessible.",
        )
    if response.status_code != 200:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "获取 Microsoft Forms 问卷定义失败"
            f"（HTTP {response.status_code}）。",
        )
    try:
        data = json.loads(response.body.decode("utf-8", "replace"))
    except json.JSONDecodeError as error:
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "Microsoft Forms 问卷定义不是有效 JSON。",
        ) from error
    if not isinstance(data, dict) or not data.get("questions"):
        raise SurveyImportError(
            "FORMS_PARSE_FAILED",
            "Microsoft Forms 问卷定义缺少 questions 字段，"
            "可能不是可公开访问的问卷。",
        )
    return data


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    # FormsProRT* fields contain rich-text markup; strip simple tags.
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def _parse_question_info(question: dict[str, Any]) -> dict[str, Any]:
    raw = question.get("questionInfo")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _choice_question_type(
    question: dict[str, Any],
    question_info: dict[str, Any],
) -> tuple[str, list[str], list[str]]:
    choices: list[str] = []
    for choice in question_info.get("Choices") or []:
        if isinstance(choice, dict):
            description = _clean_text(
                choice.get("Description")
                or choice.get("FormsProDisplayRTText")
            )
            if description:
                choices.append(description)
        elif isinstance(choice, str) and choice.strip():
            choices.append(choice.strip())

    if question_info.get("AllowOtherAnswer"):
        choices.append("其他")

    choice_type = question_info.get("ChoiceType")
    multi = bool(question.get("allowMultipleValues")) or choice_type == 3
    if not multi:
        yes_no_hits = [
            choice
            for choice in choices
            if choice.strip().lower() in YES_NO_VALUES
        ]
        if (
            len(choices) >= 2
            and len(yes_no_hits) == len(choices)
            and len(set(yes_no_hits)) >= 2
        ):
            return "yes_no", choices, ["all_options_are_yes_no_values"]
    return ("multiple" if multi else "single"), choices, []


def _rating_question(
    question_info: dict[str, Any],
) -> tuple[str, list[str], list[str]]:
    length = question_info.get("Length") or 5
    try:
        length = int(length)
    except (TypeError, ValueError):
        length = 5
    length = max(2, min(length, 20))
    return "rating", [str(index) for index in range(1, length + 1)], []


def _question_to_survey(
    question: dict[str, Any],
    *,
    index: int,
    page_id: str,
) -> dict[str, Any]:
    qtype = question.get("type")
    title = _clean_text(
        question.get("formsProRTQuestionTitle")
        or question.get("title")
        or f"Question {index + 1}"
    )
    subtitle = _clean_text(
        question.get("formsProRTSubtitle") or question.get("subtitle")
    )
    question_info = _parse_question_info(question)
    warnings: list[str] = []

    if qtype == "Question.Choice":
        question_type, choices, reasons = _choice_question_type(
            question, question_info
        )
        options = [
            {
                "id": f"{question.get('id') or index}_o{option_index}",
                "label": str(option_index + 1),
                "text": choice,
                "value": choice,
                "order": option_index + 1,
                "media": [],
            }
            for option_index, choice in enumerate(choices)
        ]
        warnings.extend(reasons)
    elif qtype == "Question.Rating":
        question_type, choices, reasons = _rating_question(question_info)
        options = [
            {
                "id": f"{question.get('id') or index}_o{option_index}",
                "label": str(option_index + 1),
                "text": choice,
                "value": choice,
                "order": option_index + 1,
                "media": [],
            }
            for option_index, choice in enumerate(choices)
        ]
        warnings.extend(reasons)
    elif qtype == "Question.TextField":
        question_type = "long_text" if question_info.get("Multiline") else "text"
        options = []
    elif qtype == "Question.DateTime":
        question_info_data = question_info
        has_date = bool(
            question_info_data.get("date") or question_info_data.get("Date")
        )
        has_time = bool(
            question_info_data.get("time") or question_info_data.get("Time")
        )
        if has_date and not has_time:
            question_type = "date"
        elif has_time and not has_date:
            question_type = "time"
        else:
            question_type = "date"
        options = []
    elif qtype == "Question.FileUpload":
        question_type = "file"
        options = []
    else:
        question_type = "text"
        options = []
        warnings.append(
            f"未识别的 Forms 题型 {qtype or 'unknown'}，已按文本题导入"
        )

    media: list[dict[str, Any]] = []
    image = question.get("image") or {}
    resource_url = image.get("resourceUrl")
    if isinstance(resource_url, str) and resource_url.startswith("http"):
        media.append(
            {
                "id": f"{question.get('id') or index}_media_0",
                "type": "photo",
                "source": "url",
                "url": resource_url,
                "mime_type": image.get("contentType"),
                "width": image.get("width"),
                "height": image.get("height"),
                "file_name": image.get("originalFileName"),
                "caption": image.get("altText"),
            }
        )

    validation: dict[str, Any] = {}
    if question_type == "multiple":
        restriction = question_info.get("ChoiceRestrictionType")
        if restriction in ("AtLeast", "AtMost", "Between"):
            minimum = question_info.get("ChoiceMinBoundary")
            maximum = question_info.get("ChoiceMaxBoundary")
            if restriction == "AtLeast" and isinstance(minimum, (int, float)):
                validation["min_selections"] = int(minimum)
            elif restriction == "AtMost" and isinstance(maximum, (int, float)):
                validation["max_selections"] = int(maximum)
            elif restriction == "Between":
                if isinstance(minimum, (int, float)):
                    validation["min_selections"] = int(minimum)
                if isinstance(maximum, (int, float)):
                    validation["max_selections"] = int(maximum)

    survey_question = {
        "id": str(question.get("id") or f"q_{index + 1}"),
        "source_number": index + 1,
        "page_id": page_id,
        "type": question_type,
        "title": title,
        "required": bool(question.get("required")),
        "required_confidence": 0.98,
        "type_confidence": 0.98,
        "type_reasons": [],
        "order": index + 1,
        "options": options,
        "media": media,
        "validation": validation,
        "settings": {},
        "warnings": warnings,
    }
    if subtitle:
        survey_question["description"] = subtitle
    return survey_question


def _build_pages_and_questions(
    data: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build pages from descriptive questions and order questions."""

    questions = data.get("questions") or []
    if not isinstance(questions, list):
        questions = []
    questions = sorted(
        questions,
        key=lambda item: (
            item.get("order") if isinstance(item, dict) else 0
        ) or 0,
    )

    pages: list[dict[str, Any]] = []
    page_by_descriptive: dict[str, str] = {}
    ordered_descriptive: list[dict[str, Any]] = []
    descriptive = data.get("descriptiveQuestions") or []
    if isinstance(descriptive, list) and descriptive:
        ordered_descriptive = sorted(
            descriptive,
            key=lambda item: (
                item.get("order") if isinstance(item, dict) else 0
            ) or 0,
        )
        for page_index, item in enumerate(ordered_descriptive, start=1):
            if not isinstance(item, dict):
                continue
            page_id = f"page_{page_index}"
            page = {
                "id": page_id,
                "order": page_index,
            }
            title = _clean_text(item.get("title"))
            subtitle = _clean_text(item.get("subtitle"))
            if title:
                page["title"] = title
            if subtitle:
                page["description"] = subtitle
            pages.append(page)
            if item.get("id") is not None:
                page_by_descriptive[str(item["id"])] = page_id

    if not pages:
        pages = [{"id": "page_1", "order": 1}]

    current_page = pages[0]["id"]

    survey_questions: list[dict[str, Any]] = []
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            continue
        if (
            question.get("groupId") is not None
            and str(question.get("groupId")) in page_by_descriptive
        ):
            current_page = page_by_descriptive[str(question.get("groupId"))]
        survey_questions.append(
            _question_to_survey(
                question,
                index=index,
                page_id=current_page,
            )
        )

    return pages, survey_questions


def forms_definition_to_survey(data: dict[str, Any]) -> dict[str, Any]:
    """Convert the Forms OData definition into the standard survey.json shape."""

    title = _clean_text(data.get("title")) or "Imported Survey"
    description = _clean_text(data.get("description"))
    if not description:
        description = "Imported from Microsoft Forms"

    pages, questions = _build_pages_and_questions(data)
    warnings: list[str] = []
    for question in questions:
        warnings.extend(question["warnings"])

    survey_object: dict[str, Any] = {
        "title": title,
        "description": description,
        "pages": pages,
        "questions": questions,
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
            "source": "microsoft_forms",
            "warnings": warnings,
        },
    }

    # Microsoft Forms exposes the form cover as background / header / logo
    # images; surface the first one available as the survey cover.
    for part_name in ("background", "header", "logo"):
        part = data.get(part_name) or {}
        resource_url = part.get("resourceUrl")
        if not isinstance(resource_url, str) or not resource_url.startswith("http"):
            continue
        cover: dict[str, Any] = {
            "id": f"cover_{part_name}",
            "type": "photo",
            "source": "url",
            "url": resource_url,
            "mime_type": part.get("contentType"),
            "width": part.get("width"),
            "height": part.get("height"),
            "file_name": part.get("originalFileName"),
            "caption": part.get("altText"),
        }
        survey_object["cover"] = cover
        break

    return {
        "schema_version": 1,
        "survey": survey_object,
    }
