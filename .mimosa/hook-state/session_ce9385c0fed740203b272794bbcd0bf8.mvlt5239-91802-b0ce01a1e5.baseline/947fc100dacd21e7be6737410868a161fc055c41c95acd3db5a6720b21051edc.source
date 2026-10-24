#!/usr/bin/env python3
"""Import Microsoft Forms URLs as new published surveys in production D1.

The local importer produces the standard survey.json for each URL; this script
persists those surveys directly into D1 (pages/questions/options/media/cover),
marks them published, and writes the version-1 snapshot — mirroring the web
admin's saveImportedSurvey + publishSurvey flow without needing admin auth.

Usage:
    uv run python scripts/import_surveys_batch.py urls.txt [--dry-run]
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from backfill_covers import compress_cover  # noqa: E402
from survey_import.document import fetch_url  # noqa: E402
from survey_import.microsoft import DEFAULT_USER_AGENT  # noqa: E402
from survey_import.url_importer import import_survey_from_url  # noqa: E402


def run_wrangler(args: list[str]) -> subprocess.CompletedProcess[str]:
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


def query_d1(sql: str) -> list[dict[str, Any]]:
    result = run_wrangler(
        ["d1", "execute", "DB", "--remote", "--json", "--command", sql]
    )
    return list((json.loads(result.stdout)[0] or {}).get("results") or [])


def esc(value: Any) -> str:
    if value is None:
        return "NULL"
    text = str(value)
    return "'" + text.replace("'", "''") + "'"


def iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def chunk(items: list[Any], size: int) -> list[list[Any]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def chunk_escaped_by_bytes(
    text: str,
    limit: int = 80_000,
) -> list[str]:
    """Split ``text`` so each piece's escaped UTF-8 size stays under limit."""

    pieces: list[str] = []
    current = ""
    current_escaped_size = 0
    for char in text:
        escaped_char = char.replace("'", "''")
        char_size = utf8_len(escaped_char)
        if current and current_escaped_size + char_size > limit:
            pieces.append(current)
            current = char
            current_escaped_size = char_size
        else:
            current += char
            current_escaped_size += char_size
    if current:
        pieces.append(current)
    return pieces


def cover_data_url(url: str) -> tuple[str, str, int]:
    image = fetch_url(url, user_agent=DEFAULT_USER_AGENT)
    if image.status_code != 200:
        raise RuntimeError(f"封面下载失败 HTTP {image.status_code}")
    body, mime = compress_cover(image.body, None)
    return f"data:{mime};base64," + base64.b64encode(body).decode("ascii"), mime, len(body)


def build_sql(survey_file: dict[str, Any], owner_id: int) -> str:
    survey = survey_file["survey"]
    ts = iso()
    title = str(survey["title"])
    description = survey.get("description")
    pages = survey.get("pages") or []
    questions = survey.get("questions") or []

    page_order_by_id = {
        str(page.get("id")): index for index, page in enumerate(pages)
    }

    sid = f"(SELECT id FROM surveys WHERE title = {esc(title)} AND created_at = {esc(ts)} LIMIT 1)"
    statements: list[str] = []

    statements.append(
        "INSERT INTO surveys ("
        " owner_id, title, description, anonymous, allow_multiple_responses,"
        " max_responses_per_user, version, access_code, report_template_id,"
        " settings_json, created_at, updated_at"
        ") VALUES ("
        f"{owner_id},{esc(title)},{esc(description)},0,0,1,1,NULL,NULL,NULL,"
        f"{esc(ts)},{esc(ts)});"
    )

    for index, page in enumerate(pages):
        statements.append(
            "INSERT INTO survey_pages (survey_id, title, description, \"order\", created_at, updated_at) "
            f"VALUES ({sid},{esc(page.get('title'))},{esc(page.get('description'))},{index},{esc(ts)},{esc(ts)});"
        )

    question_items = []
    for question in questions:
        page_id = question.get("page_id")
        question_items.append(
            {
                "type": question.get("type"),
                "title": question.get("title"),
                "description": question.get("description"),
                "required": 1 if question.get("required") else 0,
                "order": question.get("order"),
                "pageOrder": (
                    page_order_by_id.get(str(page_id)) if page_id else None
                ),
                "settingsJson": (
                    json.dumps(question.get("settings"), ensure_ascii=False)
                    if question.get("settings")
                    else None
                ),
            }
        )
    for group in chunk(question_items, 5):
        statements.append(
            "INSERT INTO survey_questions ("
            " survey_id, type, title, description, required, \"order\", page_id,"
            " settings_json, created_at, updated_at"
            ") SELECT "
            f"{sid},"
            " json_extract(item.value,'$.type'),"
            " json_extract(item.value,'$.title'),"
            " json_extract(item.value,'$.description'),"
            " CAST(json_extract(item.value,'$.required') AS INTEGER),"
            " CAST(json_extract(item.value,'$.order') AS INTEGER),"
            " page.id,"
            " json_extract(item.value,'$.settingsJson'),"
            f"{esc(ts)},{esc(ts)} "
            f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
            f"LEFT JOIN survey_pages page ON page.survey_id = {sid} "
            "AND page.\"order\" = CAST(json_extract(item.value,'$.pageOrder') AS INTEGER);"
        )

    option_items = []
    for question_order, question in enumerate(questions, start=1):
        for option_order, option in enumerate(question.get("options") or [], start=1):
            option_items.append(
                {
                    "label": option.get("label"),
                    "value": option.get("text") or option.get("value") or "",
                    "questionOrder": question.get("order", question_order),
                    "optionOrder": option_order,
                }
            )
    for group in chunk(option_items, 15):
        statements.append(
            "INSERT INTO question_options (question_id, label, value, \"order\", created_at, updated_at) "
            "SELECT q.id, json_extract(item.value,'$.label'),"
            " json_extract(item.value,'$.value'),"
            " CAST(json_extract(item.value,'$.optionOrder') AS INTEGER),"
            f"{esc(ts)},{esc(ts)} "
            f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
            f"JOIN survey_questions q ON q.survey_id = {sid} "
            "AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER);"
        )

    media_items: list[dict[str, Any]] = []
    media_by_url: dict[str, dict[str, Any]] = {}

    def register_media(media: dict[str, Any]) -> str | None:
        url = media.get("url")
        if not isinstance(url, str) or not url:
            return None
        if url.startswith("data:"):
            return None
        if url not in media_by_url:
            media_by_url[url] = {
                "mediaType": media.get("type", "photo"),
                "url": url,
                "mimeType": media.get("mime_type"),
                "fileName": media.get("file_name"),
                "fileSize": media.get("size"),
                "width": media.get("width"),
                "height": media.get("height"),
            }
        return url

    question_media_items: list[dict[str, Any]] = []
    option_media_items: list[dict[str, Any]] = []
    for question in questions:
        q_order = question.get("order")
        for sort_order, media in enumerate(question.get("media") or []):
            key = register_media(media)
            if key:
                question_media_items.append(
                    {
                        "questionOrder": q_order,
                        "url": key,
                        "sortOrder": sort_order,
                    }
                )
        for option_order, option in enumerate(question.get("options") or [], start=1):
            for sort_order, media in enumerate(option.get("media") or []):
                key = register_media(media)
                if key:
                    option_media_items.append(
                        {
                            "questionOrder": q_order,
                            "optionOrder": option_order,
                            "url": key,
                            "sortOrder": sort_order,
                        }
                    )

    if media_by_url:
        for group in chunk(list(media_by_url.values()), 8):
            statements.append(
                "INSERT INTO media_assets ("
                " asset_scope, media_type, url, storage_kind, mime_type,"
                " file_name, file_size, width, height, created_at, updated_at"
                ") SELECT "
                "'survey', json_extract(item.value,'$.mediaType'),"
                " json_extract(item.value,'$.url'), 'url',"
                " json_extract(item.value,'$.mimeType'),"
                " json_extract(item.value,'$.fileName'),"
                " CAST(json_extract(item.value,'$.fileSize') AS INTEGER),"
                " CAST(json_extract(item.value,'$.width') AS INTEGER),"
                " CAST(json_extract(item.value,'$.height') AS INTEGER),"
                f"{esc(ts)},{esc(ts)} "
                f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item;"
            )

    for group in chunk(question_media_items, 20):
        statements.append(
            "INSERT INTO question_media (question_id, media_asset_id, sort_order, created_at) "
            "SELECT q.id, m.id,"
            " CAST(json_extract(item.value,'$.sortOrder') AS INTEGER),"
            f"{esc(ts)} "
            f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
            f"JOIN survey_questions q ON q.survey_id = {sid} "
            "AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER) "
            f"JOIN media_assets m ON m.storage_kind = 'url' AND m.url = "
            "json_extract(item.value,'$.url') AND m.created_at = "
            f"{esc(ts)};"
        )
    for group in chunk(option_media_items, 20):
        statements.append(
            "INSERT INTO option_media (question_option_id, media_asset_id, sort_order, created_at) "
            "SELECT o.id, m.id,"
            " CAST(json_extract(item.value,'$.sortOrder') AS INTEGER),"
            f"{esc(ts)} "
            f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
            "JOIN survey_questions q ON q.survey_id = "
            f"{sid} AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER) "
            "JOIN question_options o ON o.question_id = q.id "
            "AND o.\"order\" = CAST(json_extract(item.value,'$.optionOrder') AS INTEGER) "
            f"JOIN media_assets m ON m.storage_kind = 'url' AND m.url = "
            "json_extract(item.value,'$.url') AND m.created_at = "
            f"{esc(ts)};"
        )

    cover = survey.get("cover")
    if isinstance(cover, dict) and isinstance(cover.get("url"), str) and cover["url"].startswith("http"):
        data_url, mime, size = cover_data_url(cover["url"])
        width = cover.get("width") or "NULL"
        height = cover.get("height") or "NULL"
        statements.append(
            "INSERT INTO media_assets ("
            " asset_scope, media_type, url, storage_kind, mime_type,"
            " file_name, file_size, width, height, created_at, updated_at"
            f") VALUES ('survey','photo',{esc(data_url)},'url',{esc(mime)},"
            f"'cover',{size},{width},{height},{esc(ts)},{esc(ts)});"
        )
        statements.append(
            f"UPDATE surveys SET cover_media_id = (SELECT id FROM media_assets "
            f"WHERE url = {esc(data_url)} AND created_at = {esc(ts)}) "
            f"WHERE title = {esc(title)} AND created_at = {esc(ts)};"
        )

    statements.append(
        "UPDATE surveys SET status = 'published', version = version + 1,"
        f" updated_at = {esc(ts)}, published_at = {esc(ts)} "
        f"WHERE title = {esc(title)} AND created_at = {esc(ts)};"
    )

    snapshot = {
        "schema": survey_file,
        "questionOrderIds": [q.get("id") for q in questions],
    }
    snapshot_json = json.dumps(snapshot, ensure_ascii=False)
    snapshot_chunks = chunk_escaped_by_bytes(snapshot_json)
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({sid}, (SELECT version FROM surveys WHERE title = {esc(title)} "
        f"AND created_at = {esc(ts)}), {esc(snapshot_chunks[0])},{owner_id},{esc(ts)});"
    )
    for extra_chunk in snapshot_chunks[1:]:
        statements.append(
            "UPDATE survey_versions SET snapshot_json = snapshot_json || "
            f"{esc(extra_chunk)} WHERE survey_id = {sid} AND version = "
            f"(SELECT version FROM surveys WHERE title = {esc(title)} "
            f"AND created_at = {esc(ts)});"
        )

    sql = "\n".join(statements)
    for index, statement in enumerate(statements):
        size = utf8_len(statement)
        if size > 100_000:
            raise RuntimeError(
                f"第 {index} 条语句 {size} 字节，超过 D1 100KB 限制，"
                "请进一步缩小分块"
            )
    return sql


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("urls_file", help="每行一个 Microsoft Forms URL 的文本文件")
    parser.add_argument("--dry-run", action="store_true", help="只生成 SQL，不执行")
    args = parser.parse_args()

    urls = [
        line.strip()
        for line in Path(args.urls_file).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not urls:
        print("URL 列表为空", file=sys.stderr)
        return 2

    existing_titles = {
        str(row["title"]).strip().lower()
        for row in query_d1("SELECT title FROM surveys")
    }
    owners = query_d1(
        "SELECT owner_id FROM surveys GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 1"
    )
    owner_id = int(owners[0]["owner_id"]) if owners else 1

    with tempfile.TemporaryDirectory(prefix="survey-import-batch-") as temp_dir:
        work_dir = Path(temp_dir)
        for url in urls:
            try:
                result = import_survey_from_url(url, output_dir=work_dir)
                survey_file = result.survey_file
                title = str(survey_file["survey"]["title"])
            except Exception as error:
                print(f"✗ {url}\n    生成问卷失败：{error}")
                continue
            if title.strip().lower() in existing_titles:
                print(f"· {title}（已存在，跳过）")
                continue
            sql = build_sql(survey_file, owner_id)
            sql_path = work_dir / f"{title[:40]}.sql"
            sql_path.write_text(sql, encoding="utf-8")
            print(f"✓ {title}（{len(survey_file['survey']['questions'])} 题）SQL 已生成")
            if args.dry_run:
                continue
            try:
                run_wrangler(
                    ["d1", "execute", "DB", "--remote", "--file", str(sql_path)]
                )
                print(f"  → 已导入并发布")
                existing_titles.add(title.strip().lower())
            except Exception as error:
                print(f"  ✗ 导入失败：{error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
