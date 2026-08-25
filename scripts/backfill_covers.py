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
import json
import re
import subprocess
import sys
import tempfile
import uuid
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

MEDIA_KV_NAMESPACE_ID = "1761c29892764597992c189096bc62c2"


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
            "SELECT id, title, cover_media_id FROM surveys",
        ]
    )
    data = json.loads(result.stdout)
    return list(data[0].get("results") or [])


def apply_cover(survey_id: int, cover: dict[str, Any], work_dir: Path) -> None:
    image = fetch_url(cover["url"], user_agent=DEFAULT_USER_AGENT)
    if image.status_code != 200:
        raise RuntimeError(f"封面下载失败 HTTP {image.status_code}")
    bytes_path = work_dir / f"cover-{survey_id}.bin"
    bytes_path.write_bytes(image.body)

    storage_key = f"media:import:{uuid.uuid4()}"
    run_wrangler(
        [
            "kv",
            "key",
            "put",
            storage_key,
            "--namespace-id",
            MEDIA_KV_NAMESPACE_ID,
            "--path",
            str(bytes_path),
        ]
    )

    mime_type = cover.get("mime_type") or "application/octet-stream"
    file_name = cover.get("file_name") or "cover"
    width = cover.get("width") or "NULL"
    height = cover.get("height") or "NULL"
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sql = (
        "INSERT INTO media_assets ("
        " asset_scope, media_type, storage_kind, storage_key, mime_type,"
        " file_name, file_size, width, height, created_at, updated_at"
        ") VALUES ("
        f"'survey','photo','temporary','{storage_key}','{mime_type}',"
        f"'{file_name}',{len(image.body)},{width},{height},"
        f"'{timestamp}','{timestamp}'"
        ");"
        f"UPDATE surveys SET cover_media_id = "
        f"(SELECT id FROM media_assets WHERE storage_key = '{storage_key}'),"
        f" updated_at = '{timestamp}' WHERE id = {survey_id};"
    )
    run_wrangler(["d1", "execute", "DB", "--remote", "--command", sql])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("urls_file", help="每行一个 Microsoft Forms URL 的文本文件")
    parser.add_argument("--dry-run", action="store_true", help="只输出匹配结果，不写库")
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
            if survey.get("cover_media_id") is not None:
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
                    apply_cover(survey["id"], info["cover"], work_dir)
                    print(f"✓ {info['title']} → 问卷 #{survey['id']} 封面已更新")
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
