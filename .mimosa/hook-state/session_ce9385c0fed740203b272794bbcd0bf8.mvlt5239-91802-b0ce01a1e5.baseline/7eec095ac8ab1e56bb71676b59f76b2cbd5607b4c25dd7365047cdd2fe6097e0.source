#!/usr/bin/env python3
"""Backfill survey covers from Microsoft Forms URLs.

Matching is by normalized form title against the production D1 ``surveys``
table. For every match the cover image (background/header/logo) is downloaded,
cached into MEDIA_KV and linked via ``surveys.cover_media_id``. Questions and
responses are never touched.

Usage:
    uv run python scripts/backfill_covers.py urls.txt [--dry-run]

The URL file contains one Microsoft Forms URL per line.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from survey_import.document import fetch_url  # noqa: E402
from survey_import.microsoft import (  # noqa: E402
    DEFAULT_USER_AGENT,
    extract_office_form_server_info,
    fetch_forms_definition,
)
import pymupdf as fitz  # noqa: E402

def normalize_title(text: str) -> str:
    return re.sub(r"[\s_.:：\-—,，。、()（）[\]【】]+", "", text).strip().lower()


def fetch_form_info(url: str) -> dict[str, Any]:
    page = fetch_url(url, user_agent=DEFAULT_USER_AGENT)
    if page.status_code != 200:
        raise RuntimeError(f"页面请求失败 HTTP {page.status_code}")
    html_text = page.body.decode("utf-8", "replace")
    definition = fetch_forms_definition(
        html_text,
        fetch_url=fetch_url,
        timeout=30.0,
        user_agent=DEFAULT_USER_AGENT,
    )
    cover = None
    for part_name in ("background", "header", "logo"):
        part = definition.get(part_name) or {}
        resource_url = part.get("resourceUrl")
        if isinstance(resource_url, str) and resource_url.startswith("http"):
            cover = {
                "url": resource_url,
                "mime_type": part.get("contentType"),
                "width": part.get("width"),
                "height": part.get("height"),
                "file_name": part.get("originalFileName"),
            }
            break
    return {
        "title": str(definition.get("title") or "").strip() or url,
        "cover": cover,
    }


def compress_cover(data: bytes, mime_type: str | None) -> tuple[bytes, str]:
    """Re-encode cover bytes to a JPEG small enough for one D1 statement.

    D1 rejects statements above roughly 100KB (SQLITE_TOOBIG), so the base64
    data URL must stay well under that; we keep it below ~80KB.
    """

    # (max width, jpeg quality) tried in order until the payload is small.
    profiles = [(1200, 78), (900, 72), (700, 68), (520, 62)]
    best: tuple[bytes, str] | None = None
    try:
        doc = fitz.open(stream=data, filetype=None)
    except Exception:
        return data, mime_type or "application/octet-stream"
    width = doc[0].rect.width or 0
    for max_width, quality in profiles:
        scale = min(1.0, max_width / width) if width else 1.0
        try:
            pix = doc[0].get_pixmap(
                matrix=fitz.Matrix(scale, scale),
                colorspace=fitz.csRGB,
                alpha=False,
            )
            jpeg = pix.tobytes("jpeg", jpg_quality=quality)
        except Exception:
            continue
        if best is None or len(jpeg) < len(best[0]):
            best = (jpeg, "image/jpeg")
        if len(base64.b64encode(jpeg)) <= 80_000:
            doc.close()
            return jpeg, "image/jpeg"
    doc.close()
    if best is not None and len(best[0]) < len(data):
        return best
    return data, mime_type or "application/octet-stream"


def run_wrangler(args: list[str]) -> Any:
    result = subprocess.run(
        ["npx", "wrangler", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"wrangler 失败: {' '.join(args[:3])}\n{result.stderr[-800:]}"
        )
    return result


def load_surveys() -> list[dict[str, Any]]:
    result = run_wrangler(
        [
            "d1",
            "execute",
            "DB",
            "--remote",
            "--json",
            "--command",
            (
                "SELECT s.id, s.title, s.cover_media_id, "
                "m.storage_kind AS cover_kind, m.url AS cover_url "
                "FROM surveys s "
                "LEFT JOIN media_assets m ON m.id = s.cover_media_id"
            ),
        ]
    )
    data = json.loads(result.stdout)
    return list(data[0].get("results") or [])


def apply_cover(survey_id: int, cover: dict[str, Any], work_dir: Path) -> None:
    image = fetch_url(cover["url"], user_agent=DEFAULT_USER_AGENT)
    if image.status_code != 200:
        raise RuntimeError(f"封面下载失败 HTTP {image.status_code}")
    body, mime_type = compress_cover(image.body, cover.get("mime_type"))

    file_name = cover.get("file_name") or "cover"
    width = cover.get("width") or "NULL"
    height = cover.get("height") or "NULL"
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # Covers are stored as data URLs directly in D1. This avoids depending on
    # the KV namespace used by the runtime Worker binding, which the CLI
    # cannot write to reliably; buildMediaResponse decodes data URLs inline.
    data_url = (
        f"data:{mime_type};base64,"
        + base64.b64encode(body).decode("ascii")
    )
    escaped_name = file_name.replace("'", "''")
    sql = (
        "INSERT INTO media_assets ("
        " asset_scope, media_type, storage_kind, url, mime_type,"
        " file_name, file_size, width, height, created_at, updated_at"
        ") VALUES ("
        f"'survey','photo','url','{data_url}','{mime_type}',"
        f"'{escaped_name}',{len(body)},{width},{height},"
        f"'{timestamp}','{timestamp}'"
        ");"
        f"UPDATE surveys SET cover_media_id = "
        f"(SELECT id FROM media_assets WHERE url = '{data_url}'),"
        f" updated_at = '{timestamp}' WHERE id = {survey_id};"
    )
    sql_path = work_dir / f"cover-{survey_id}.sql"
    sql_path.write_text(sql, encoding="utf-8")
    run_wrangler(["d1", "execute", "DB", "--remote", "--file", str(sql_path)])


def remove_stale_cover(survey: dict[str, Any]) -> None:
    """Delete a cover asset row that is not a usable data URL."""

    cover_id = survey.get("cover_media_id")
    cover_url = survey.get("cover_url")
    if cover_id is None or (isinstance(cover_url, str) and cover_url.startswith("data:")):
        return
    run_wrangler(
        [
            "d1",
            "execute",
            "DB",
            "--remote",
            "--command",
            (
                "DELETE FROM media_assets WHERE id = "
                f"{cover_id} AND NOT EXISTS (SELECT 1 FROM question_media "
                f"WHERE media_asset_id = {cover_id}) AND NOT EXISTS "
                f"(SELECT 1 FROM option_media WHERE media_asset_id = {cover_id})"
            ),
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("urls_file", help="每行一个 Microsoft Forms URL 的文本文件")
    parser.add_argument("--dry-run", action="store_true", help="只输出匹配结果，不写库")
    parser.add_argument(
        "--force",
        action="store_true",
        help="已有封面的问卷也重新更新（用于修复旧的数据 URL 存储）",
    )
    args = parser.parse_args()

    urls = [
        line.strip()
        for line in Path(args.urls_file).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not urls:
        print("URL 列表为空", file=sys.stderr)
        return 2

    surveys = load_surveys()
    by_title: dict[str, list[dict[str, Any]]] = {}
    for survey in surveys:
        by_title.setdefault(normalize_title(str(survey["title"] or "")), []).append(
            survey
        )

    print(f"数据库问卷：{len(surveys)} 份；待处理链接：{len(urls)} 个\n")
    matched = 0
    skipped = 0
    unmatched: list[str] = []
    with tempfile.TemporaryDirectory(prefix="cover-backfill-") as temp_dir:
        work_dir = Path(temp_dir)
        for url in urls:
            try:
                info = fetch_form_info(url)
            except Exception as error:
                print(f"✗ {url}\n    获取失败：{error}")
                unmatched.append(url)
                continue
            key = normalize_title(info["title"])
            candidates = by_title.get(key, [])
            if not candidates:
                print(f"✗ {info['title']}\n    未匹配到库中问卷（{url}）")
                unmatched.append(url)
                continue
            survey = candidates[0]
            if (
                isinstance(survey.get("cover_url"), str)
                and survey["cover_url"].startswith("data:")
                and not args.force
            ):
                print(f"· {info['title']} → 问卷 #{survey['id']}（已有封面，跳过）")
                skipped += 1
                continue
            if not info["cover"]:
                print(f"· {info['title']} → 问卷 #{survey['id']}（该表单无封面图，跳过）")
                skipped += 1
                continue
            if args.dry_run:
                print(f"✓ {info['title']} → 问卷 #{survey['id']}（封面：{info['cover']['url'][:70]}…）")
            else:
                try:
                    remove_stale_cover(survey)
                    apply_cover(survey["id"], info["cover"], work_dir)
                    print(f"✓ {info['title']} → 问卷 #{survey['id']} 封面已更新（data URL）")
                except Exception as error:
                    print(f"✗ {info['title']} → 问卷 #{survey['id']} 更新失败：{error}")
                    unmatched.append(url)
                    continue
            matched += 1

    print(
        f"\n完成：匹配 {matched}，跳过 {skipped}，未匹配/失败 {len(unmatched)}"
        + ("（dry-run，未写库）" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
