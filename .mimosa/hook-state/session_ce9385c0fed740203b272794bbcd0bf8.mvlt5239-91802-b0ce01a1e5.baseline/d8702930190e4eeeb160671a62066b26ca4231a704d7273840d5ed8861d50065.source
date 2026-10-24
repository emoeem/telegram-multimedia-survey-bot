"""HTTP download, document-type detection, and Office -> PDF conversion."""

from __future__ import annotations

import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .errors import SurveyImportError
from .microsoft import (
    DEFAULT_USER_AGENT,
    is_microsoft_url,
    resolve_download_url,
)

DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # 50 MB, same as the web import limit.
DEFAULT_TIMEOUT = 30.0

# Extensions LibreOffice can convert to PDF. ``None`` means "convert any".
OFFICE_EXTENSIONS = {
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".odt",
    ".ods",
    ".odp",
    ".rtf",
    ".txt",
    ".csv",
}

PDF_EXTENSIONS = {".pdf"}
JSON_EXTENSIONS = {".json"}


@dataclass
class HttpResponse:
    status_code: int
    headers: dict[str, str]
    body: bytes
    final_url: str


def _error_from_urlerror(error: urllib.error.URLError, context: str) -> SurveyImportError:
    reason = getattr(error, "reason", None)
    detail = str(reason or error)
    if isinstance(error, urllib.error.HTTPError):
        status = error.code
        if status == 404:
            return SurveyImportError(
                "HTTP_404",
                f"{context}返回 404，链接可能已失效。",
                details={"status": status},
            )
        if status == 401:
            return SurveyImportError(
                "DOCUMENT_REQUIRES_AUTH",
                "This Microsoft document requires authentication.",
                details={"status": status},
            )
        if status == 403:
            return SurveyImportError(
                "HTTP_403",
                f"{context}返回 403（拒绝访问），链接可能没有公开共享。",
                details={"status": status},
            )
        return SurveyImportError(
            "DOWNLOAD_FAILED",
            f"{context}请求失败（HTTP {status}）。",
            details={"status": status},
        )
    if isinstance(reason, TimeoutError) or "timed out" in detail.lower():
        return SurveyImportError(
            "NETWORK_ERROR",
            f"{context}请求超时，请检查网络或稍后重试。",
        )
    return SurveyImportError(
        "NETWORK_ERROR",
        f"{context}网络请求失败：{detail}",
    )


def fetch_url(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_BYTES,
    user_agent: str = DEFAULT_USER_AGENT,
) -> HttpResponse:
    """GET ``url`` (following redirects) with a size cap and clear errors."""

    request_headers = {
        "User-Agent": user_agent,
        "Accept": "*/*",
        **dict(headers or {}),
    }
    request = urllib.request.Request(url, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise SurveyImportError(
                        "DOWNLOAD_FAILED",
                        f"下载内容超过 {max_bytes // (1024 * 1024)}MB 上限，已中止。",
                        details={"max_bytes": max_bytes},
                    )
                chunks.append(chunk)
            return HttpResponse(
                status_code=response.status,
                headers={key.lower(): value for key, value in response.headers.items()},
                body=b"".join(chunks),
                final_url=response.geturl(),
            )
    except SurveyImportError:
        raise
    except urllib.error.HTTPError as error:
        raise _error_from_urlerror(error, "下载") from error
    except urllib.error.URLError as error:
        raise _error_from_urlerror(error, "下载") from error
    except TimeoutError as error:
        raise SurveyImportError(
            "NETWORK_ERROR",
            "下载请求超时，请检查网络或稍后重试。",
        ) from error
    except OSError as error:
        raise SurveyImportError(
            "NETWORK_ERROR",
            f"下载失败：{error}",
        ) from error


def _extension_from_content_type(content_type: str) -> str | None:
    mime_to_ext = {
        "application/pdf": ".pdf",
        "application/json": ".json",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "application/msword": ".doc",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.ms-powerpoint": ".ppt",
        "application/vnd.oasis.opendocument.text": ".odt",
        "application/vnd.oasis.opendocument.spreadsheet": ".ods",
        "application/vnd.oasis.opendocument.presentation": ".odp",
        "application/rtf": ".rtf",
        "text/plain": ".txt",
        "text/csv": ".csv",
    }
    return mime_to_ext.get(content_type.split(";")[0].strip().lower())


def _filename_from_url(url: str) -> str:
    path = urlparse(url).path
    name = path.rsplit("/", 1)[-1]
    return name or "download"


def _extension_from_url(url: str) -> str | None:
    name = _filename_from_url(url)
    return Path(name).suffix.lower() if "." in name else None


def _is_pdf_bytes(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _is_json_bytes(data: bytes) -> bool:
    stripped = data.lstrip()
    return stripped[:1] in (b"{", b"[")


def resolve_redirect_target(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    user_agent: str = DEFAULT_USER_AGENT,
) -> str:
    """Return the final URL after following redirects (without the body)."""

    request = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent, "Accept": "*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(1024)
            return response.geturl()
    except urllib.error.HTTPError as error:
        raise _error_from_urlerror(error, "解析链接") from error
    except urllib.error.URLError as error:
        raise _error_from_urlerror(error, "解析链接") from error


def download_document(
    url: str,
    work_dir: Path,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_BYTES,
    user_agent: str = DEFAULT_USER_AGENT,
) -> tuple[Path, str, str]:
    """Download ``url`` to ``work_dir``; return (path, content_type, kind).

    ``kind`` is one of: forms | pdf | json | office | other.
    """

    resolved = resolve_download_url(url)
    if resolved.source_kind == "forms":
        raise SurveyImportError(
            "FORMS_URL",
            "该链接是 Microsoft Forms 问卷，请使用 Forms 导入路径。",
        )

    # 1drv.ms short links redirect to a real OneDrive/SharePoint item URL;
    # resolve the redirect first so download=1 lands on the item URL itself.
    if (
        resolved.source_kind == "onedrive"
        and (urlparse(url).hostname or "").lower() == "1drv.ms"
    ):
        final = resolve_redirect_target(
            resolved.url,
            timeout=timeout,
            user_agent=user_agent,
        )
        if final and final != resolved.url:
            resolved = resolve_download_url(final)

    response = fetch_url(
        resolved.url,
        timeout=timeout,
        max_bytes=max_bytes,
        user_agent=user_agent,
    )
    if response.status_code != 200:
        raise SurveyImportError(
            "DOWNLOAD_FAILED",
            f"下载失败（HTTP {response.status_code}）。",
            details={"status": response.status_code},
        )

    final_url = response.final_url
    content_type = response.headers.get("content-type", "")
    ext = (
        _extension_from_url(final_url)
        or _extension_from_content_type(content_type)
    )
    if ext is None:
        if _is_pdf_bytes(response.body):
            ext = ".pdf"
        elif _is_json_bytes(response.body):
            ext = ".json"
        else:
            ext = ".bin"

    name = _filename_from_url(final_url) or "download"
    stem = Path(name).stem or "download"
    target = work_dir / f"{stem}{ext}"
    target.write_bytes(response.body)

    if ext == ".pdf":
        kind = "pdf"
    elif ext == ".json":
        kind = "json"
    elif ext in OFFICE_EXTENSIONS:
        kind = "office"
    elif content_type.lower().startswith("text/html") and is_microsoft_url(final_url):
        raise SurveyImportError(
            "DOCUMENT_REQUIRES_AUTH",
            "This Microsoft document requires authentication "
            "or is not publicly shared.",
        )
    else:
        kind = "other"

    return target, content_type, kind


def convert_to_pdf(
    source: Path,
    work_dir: Path,
    *,
    timeout: float = 180.0,
) -> Path:
    """Convert an Office/text document to PDF with headless LibreOffice."""

    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise SurveyImportError(
            "PDF_CONVERSION_FAILED",
            "需要 LibreOffice 才能把 Office 文档转换为 PDF。"
            "请安装 LibreOffice 后重试（本机已检测到 /usr/bin/soffice 时可直接使用）。",
        )

    out_dir = work_dir / "converted"
    out_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = work_dir / "lo-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    profile_uri = profile_dir.resolve().as_uri()

    command = [
        soffice,
        "--headless",
        "--norestore",
        f"-env:UserInstallation={profile_uri}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(out_dir),
        str(source),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise SurveyImportError(
            "PDF_CONVERSION_FAILED",
            "文档转 PDF 超时，请确认文档没有损坏或过大。",
        ) from error
    except OSError as error:
        raise SurveyImportError(
            "PDF_CONVERSION_FAILED",
            f"无法启动 LibreOffice：{error}",
        ) from error

    pdf_path = out_dir / f"{source.stem}.pdf"
    if result.returncode != 0 or not pdf_path.is_file():
        detail = (result.stderr or result.stdout or "").strip()
        raise SurveyImportError(
            "PDF_CONVERSION_FAILED",
            "LibreOffice 转换 PDF 失败，文件格式可能不受支持。",
            details={"stderr": detail[:500]},
        )
    return pdf_path


def ensure_pdf_file(path: Path) -> None:
    if not path.is_file() or path.read_bytes()[:5] != b"%PDF-":
        raise SurveyImportError(
            "UNSUPPORTED_FORMAT",
            "转换结果不是有效的 PDF 文件。",
        )


def save_survey_json(survey_file: dict, output_path: Path) -> None:
    import json

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(survey_file, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
