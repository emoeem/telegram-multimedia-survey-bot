#!/usr/bin/env python3
"""Import the 文爱偏好问卷 (wenai survey) into remote D1 and publish it.

Mirrors the web admin's saveImportedSurvey flow (surveys → pages → questions →
options → media links → publish → version snapshot), plus:

  - theme/BGM: surveys.settings_json = {"theme": {...}} with background.image
    and audio.url pointing at /api/survey/media/<id>
  - media bytes live in MEDIA_KV under `media:survey-wenai:<slug>`, referenced
    by media_assets rows with storage_kind='temporary' and expires_at=NULL —
    the exact shape of the admin BGM upload endpoint, which the media serve
    route whitelists and the cleanup job never touches.

Usage:
    python3 scripts/wenai/import_wenai_survey.py --dry-run   # SQL preview
    python3 scripts/wenai/import_wenai_survey.py --apply     # KV + D1 + publish
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
CONTENT_PATH = SCRIPT_DIR / "wenai-survey.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
# ---- 目标环境（默认生产）------------------------------------------------
# 样例脚本原样运行 = 写生产。灌 staging 时传：
#   --config wrangler.staging.toml --kv-namespace <staging MEDIA_KV id> \
#   --public-base https://telegram-multimedia-survey-bot-staging.<account>.workers.dev
# wrangler 凭据（OAuth 账号）决定你连的是哪个 Cloudflare 账号——脚本不切换
# 账号，切账号须先 `wrangler login`（staging 在独立账号，见 docs/web-admin-phase-1.md）。
WRANGLER_ARGS: list[str] = []
MEDIA_KV_ID = "1761c29892764597992c189096bc62c2"  # wrangler.toml binding MEDIA_KV
KV_PREFIX = "media:survey-wenai"
PUBLIC_BASE = "https://emoe.eu.cc"

STAGING_PUBLIC_BASE = "https://telegram-multimedia-survey-bot-staging.3353745917.workers.dev"


def configure_target(
    config: str | None = None,
    kv_namespace: str | None = None,
    public_base: str | None = None,
) -> None:
    """设置脚本后续所有 wrangler 调用的目标环境（必须在任何查询前调用）。"""
    global WRANGLER_ARGS, MEDIA_KV_ID, PUBLIC_BASE
    if config:
        WRANGLER_ARGS = ["-c", config]
    if kv_namespace:
        MEDIA_KV_ID = kv_namespace
    if public_base:
        PUBLIC_BASE = public_base


def add_environment_args(parser: argparse.ArgumentParser) -> None:
    """三个 importer（wenai/galgame/hotspot）共用的目标环境参数。"""
    group = parser.add_argument_group("目标环境（默认生产）")
    group.add_argument("--config", help="wrangler 配置文件（staging 用 wrangler.staging.toml）")
    group.add_argument("--kv-namespace", help=f"MEDIA_KV namespace id（默认生产 {MEDIA_KV_ID[:8]}…）")
    group.add_argument("--public-base", help=f"打印链接用的站点 origin（staging 默认 {STAGING_PUBLIC_BASE}）")


def apply_environment_args(args: argparse.Namespace) -> None:
    configure_target(
        config=args.config,
        kv_namespace=args.kv_namespace,
        public_base=args.public_base or (STAGING_PUBLIC_BASE if args.config else None),
    )
    if WRANGLER_ARGS:
        print(f"🎯 目标环境：config={args.config} KV={MEDIA_KV_ID[:8]}… base={PUBLIC_BASE}")
    else:
        print("🎯 目标环境：生产（默认）——确认这是你想要的，或加 --config wrangler.staging.toml")

MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
}
MEDIA_TYPE_BY_EXT = {
    ".jpg": "photo",
    ".jpeg": "photo",
    ".png": "photo",
    ".webp": "photo",
    ".mp3": "audio",
}


def run(args: list[str], capture: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["npx", "wrangler", *WRANGLER_ARGS, *args], cwd=ROOT, capture_output=capture, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"wrangler 失败: {' '.join(args[:3])}\n{result.stderr[-1500:]}")
    return result


def query_d1(sql: str) -> list[dict]:
    result = run(["d1", "execute", "DB", "--remote", "--json", "--command", sql], capture=True)
    return list((json.loads(result.stdout)[0] or {}).get("results") or [])


def esc(value) -> str:
    if value is None:
        return "NULL"
    text = str(value)
    return "'" + text.replace("'", "''") + "'"


def iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def chunk(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def chunk_escaped_by_bytes(text: str, limit: int = 80_000) -> list[str]:
    pieces: list[str] = []
    current, current_size = "", 0
    for char in text:
        size = len(char.replace("'", "''").encode("utf-8"))
        if current and current_size + size > limit:
            pieces.append(current)
            current, current_size = char, size
        else:
            current += char
            current_size += size
    if current:
        pieces.append(current)
    return pieces


# ---------------------------------------------------------------- media refs

def collect_media_refs(data: dict) -> list[str]:
    """All kv:// slugs in declaration order: theme background/audio, cover,
    question media, option media."""
    survey = data["survey"]
    slugs: list[str] = []

    def push(ref) -> None:
        if isinstance(ref, str) and ref.startswith("kv://") and ref not in slugs:
            slugs.append(ref)

    theme = survey.get("settings", {}).get("theme", {})
    push(theme.get("background", {}).get("image"))
    push(theme.get("audio", {}).get("url"))
    cover = survey.get("cover") or {}
    push(cover.get("url"))
    for question in survey["questions"]:
        for media in question.get("media") or []:
            push(media.get("url"))
        for option in question.get("options") or []:
            for media in option.get("media") or []:
                push(media.get("url"))
    return [slug.removeprefix("kv://") for slug in slugs]


def upload_media(slugs: list[str], apply: bool, assets_dir: Path = ASSETS_DIR, kv_prefix: str = KV_PREFIX) -> dict[str, int]:
    """Upload each asset to MEDIA_KV and register a media_assets row.
    Returns slug → media asset id."""
    ts = iso()
    wanted = {}
    for slug in slugs:
        path = assets_dir / slug
        if not path.is_file():
            raise FileNotFoundError(f"缺少素材文件: {path}")
        wanted[slug] = {
            "storageKey": f"{kv_prefix}:{slug}",
            "mime": MIME_BY_EXT[path.suffix.lower()],
            "mediaType": MEDIA_TYPE_BY_EXT[path.suffix.lower()],
            "size": path.stat().st_size,
        }

    existing_ids = {
        row["storage_key"]: int(row["id"])
        for row in query_d1(
            f"SELECT id, storage_key FROM media_assets WHERE storage_key LIKE '{kv_prefix}:%'"
        )
    }

    for slug, meta in wanted.items():
        if apply:
            # Unconditional put (idempotent, self-healing): a D1 row can exist
            # while the KV value was lost, and wrangler kv defaults to local
            # storage — --remote is what the deployed worker actually reads.
            run(
                ["kv", "key", "put", meta["storageKey"], "--path", str(assets_dir / slug),
                 "--namespace-id", MEDIA_KV_ID, "--remote"],
                capture=True,
            )
            print(f"↑ {slug} → KV(remote) {meta['storageKey']} ({meta['size'] // 1024}KB)")
        elif meta["storageKey"] not in existing_ids:
            print(f"· [dry-run] {slug} 将上传到 KV {meta['storageKey']}")

    missing = [m for m in wanted.values() if m["storageKey"] not in existing_ids]
    if missing and apply:
        run_wrangler_insert_media(missing, ts)
        existing_ids = {
            row["storage_key"]: int(row["id"])
            for row in query_d1(
                f"SELECT id, storage_key FROM media_assets WHERE storage_key LIKE '{kv_prefix}:%'"
            )
        }
    for meta in wanted.values():
        if meta["storageKey"] not in existing_ids:
            if not apply:
                # dry-run：还没有真实 id，用占位 id 让 SQL 预览仍可生成。
                existing_ids[meta["storageKey"]] = -(len(existing_ids) + 1)
            else:
                raise RuntimeError(f"media_assets 缺少 {meta['storageKey']}")
    return {slug: existing_ids[meta["storageKey"]] for slug, meta in wanted.items()}


def run_wrangler_insert_media(items: list[dict], ts: str) -> None:
    """Insert media_assets rows: survey scope, temporary kind, no expiry —
    exactly what POST /api/admin/media/audio produces for BGM."""
    statements = []
    for group in chunk(items, 8):
        statements.append(
            "INSERT INTO media_assets ("
            " asset_scope, media_type, storage_kind, storage_key, mime_type,"
            " file_name, file_size, expires_at, created_at, updated_at"
            ") SELECT 'survey', json_extract(item.value,'$.mediaType'), 'temporary',"
            " json_extract(item.value,'$.storageKey'), json_extract(item.value,'$.mime'),"
            " json_extract(item.value,'$.storageKey'), CAST(json_extract(item.value,'$.size') AS INTEGER),"
            f" NULL,{esc(ts)},{esc(ts)} "
            f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item;"
        )
    execute_sql("\n".join(statements), "media_assets")


def execute_sql(sql: str, label: str, apply: bool = True) -> None:
    for index, statement in enumerate(sql.split(";\n")):
        size = len(statement.encode("utf-8"))
        if size > 100_000:
            raise RuntimeError(f"{label} 第 {index} 条语句 {size} 字节，超过 D1 100KB 限制")
    if not apply:
        print(f"[dry-run] {label}: {len(sql.splitlines())} 行 SQL 未执行")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as handle:
        handle.write(sql)
        path = handle.name
    try:
        run(["d1", "execute", "DB", "--remote", "--file", path])
    finally:
        Path(path).unlink(missing_ok=True)


# ------------------------------------------------------------------ survey sql

def build_survey_sql(data: dict, media_ids: dict[str, int], owner_id: int, ts: str,
                     cover_slug: str = "cover.jpg", bgm_slug: str = "bgm.mp3") -> str:
    survey = data["survey"]
    title = str(survey["title"])
    description = survey.get("description")

    if query_d1(f"SELECT id FROM surveys WHERE title = {esc(title)} AND deleted_at IS NULL LIMIT 1"):
        raise RuntimeError(f"已存在同名问卷《{title}》，如需重导请先在后台删除。")

    sid = f"(SELECT id FROM surveys WHERE title = {esc(title)} AND created_at = {esc(ts)} LIMIT 1)"
    statements: list[str] = []

    theme = json.loads(json.dumps(survey["settings"]["theme"]))  # deep copy
    theme["background"]["image"] = f"/api/survey/media/{media_ids[cover_slug]}"
    theme["audio"]["url"] = f"/api/survey/media/{media_ids[bgm_slug]}"
    # 读取端（survey definition / catalog / admin read）把 settings_json 整体
    # 传给 normalizeSurveyTheme，即主题对象必须直接作为 settings_json 存储；
    # saveImportedSurvey / admin editor 写入的 {"theme": ...} 包裹形状读取端
    # 并不识别（见 tests/unit/survey-theme-settings.test.ts）。
    settings_json = json.dumps(theme, ensure_ascii=False)

    statements.append(
        "INSERT INTO surveys ("
        " owner_id, title, description, anonymous, allow_multiple_responses,"
        " max_responses_per_user, version, access_code, report_template_id,"
        " settings_json, created_at, updated_at"
        ") VALUES ("
        f"{owner_id},{esc(title)},{esc(description)},0,0,1,1,NULL,NULL,"
        f"{esc(settings_json)},{esc(ts)},{esc(ts)});"
    )

    pages = survey.get("pages") or []
    page_order_by_id = {str(page.get("id")): index for index, page in enumerate(pages)}
    for index, page in enumerate(pages):
        statements.append(
            "INSERT INTO survey_pages (survey_id, title, description, \"order\", created_at, updated_at) "
            f"VALUES ({sid},{esc(page.get('title'))},{esc(page.get('description'))},{index},{esc(ts)},{esc(ts)});"
        )

    questions = survey["questions"]
    question_items = [
        {
            "type": q.get("type"),
            "title": q.get("title"),
            "description": q.get("description"),
            "required": 1 if q.get("required") else 0,
            "order": q.get("order"),
            "pageOrder": page_order_by_id.get(str(q.get("page_id"))),
            "settingsJson": json.dumps(q["settings"], ensure_ascii=False) if q.get("settings") else None,
        }
        for q in questions
    ]
    for group in chunk(question_items, 4):
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

    option_items = [
        {
            "label": option.get("label"),
            "value": option.get("value") or "",
            "questionOrder": q.get("order"),
            "optionOrder": option.get("order"),
        }
        for q in questions
        for option in (q.get("options") or [])
    ]
    for group in chunk(option_items, 12):
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

    question_media_items = [
        {"questionOrder": q.get("order"), "mediaId": media_ids[url.removeprefix("kv://")], "sortOrder": sort}
        for q in questions
        for sort, media in enumerate(q.get("media") or [])
        if (url := media.get("url"))
    ]
    option_media_items = [
        {
            "questionOrder": q.get("order"),
            "optionOrder": option.get("order"),
            "mediaId": media_ids[url.removeprefix("kv://")],
            "sortOrder": sort,
        }
        for q in questions
        for option in (q.get("options") or [])
        for sort, media in enumerate(option.get("media") or [])
        if (url := media.get("url"))
    ]
    link_columns = {"question_media": "question_id", "option_media": "question_option_id"}
    for name, items, extra_join in (
        ("question_media", question_media_items, ""),
        (
            "option_media",
            option_media_items,
            " JOIN question_options o ON o.question_id = q.id "
            "AND o.\"order\" = CAST(json_extract(item.value,'$.optionOrder') AS INTEGER) ",
        ),
    ):
        if not items:
            continue
        for group in chunk(items, 15):
            statements.append(
                f"INSERT INTO {name} ({link_columns[name]}, media_asset_id, sort_order, created_at) "
                "SELECT "
                + ("q.id" if name == "question_media" else "o.id")
                + ", CAST(json_extract(item.value,'$.mediaId') AS INTEGER),"
                " CAST(json_extract(item.value,'$.sortOrder') AS INTEGER),"
                f"{esc(ts)} "
                f"FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
                f"JOIN survey_questions q ON q.survey_id = {sid} "
                "AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER)"
                + extra_join
                + ";"
            )

    statements.append(
        f"UPDATE surveys SET cover_media_id = {media_ids['cover.jpg']},"
        " status = 'published', version = version + 1,"
        f" published_at = {esc(ts)}, updated_at = {esc(ts)} "
        f"WHERE title = {esc(title)} AND created_at = {esc(ts)};"
    )

    # Version snapshot: same content JSON but with live media URLs baked in.
    snapshot_source = json.loads(json.dumps(data))
    snapshot_source["survey"]["settings"]["theme"]["background"]["image"] = theme["background"]["image"]
    snapshot_source["survey"]["settings"]["theme"]["audio"]["url"] = theme["audio"]["url"]
    snapshot = {
        "schema": snapshot_source,
        "questionOrderIds": [q.get("id") for q in questions],
    }
    snapshot_chunks = chunk_escaped_by_bytes(json.dumps(snapshot, ensure_ascii=False))
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({sid}, (SELECT version FROM surveys WHERE title = {esc(title)} AND created_at = {esc(ts)}),"
        f" {esc(snapshot_chunks[0])},{owner_id},{esc(ts)});"
    )
    for extra in snapshot_chunks[1:]:
        statements.append(
            "UPDATE survey_versions SET snapshot_json = snapshot_json || "
            f"{esc(extra)} WHERE survey_id = {sid} AND version = "
            f"(SELECT version FROM surveys WHERE title = {esc(title)} AND created_at = {esc(ts)});"
        )
    return "\n".join(statements)


# ----------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="执行 KV 上传与 D1 导入（默认 dry-run）")
    parser.add_argument("--owner-id", type=int, help="覆盖问卷归属的 user id（默认取库中最常见 owner）")
    parser.add_argument("--keep-sql", action="store_true", help="保留生成的 SQL 文件供检查")
    add_environment_args(parser)
    args = parser.parse_args()
    apply_environment_args(args)

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    slugs = collect_media_refs(data)
    print(f"问卷《{data['survey']['title']}》：{len(data['survey']['questions'])} 题，{len(slugs)} 个媒体文件")

    media_ids = upload_media(slugs, apply=args.apply)
    print("媒体 ID 映射：", {slug: media_ids[slug] for slug in slugs})

    if args.owner_id:
        owner_id = args.owner_id
    else:
        owners = query_d1("SELECT owner_id FROM surveys GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 1")
        owner_id = int(owners[0]["owner_id"]) if owners else 1
    sql = build_survey_sql(data, media_ids, owner_id, iso())

    if args.keep_sql:
        out = SCRIPT_DIR / "wenai-import.sql"
        out.write_text(sql, encoding="utf-8")
        print(f"SQL 已写入 {out}")
    execute_sql(sql, "survey 导入", apply=args.apply)

    if args.apply:
        rows = query_d1(f"SELECT id FROM surveys WHERE title = {esc(str(data['survey']['title']))} LIMIT 1")
        if rows:
            survey_id = int(rows[0]["id"])
            print(f"\n✅ 已导入并发布：{PUBLIC_BASE}/s/{survey_id}")
        else:
            print("\n⚠️ 导入命令已执行，但未查到新问卷，请到后台确认。")
    else:
        print("\n[dry-run] 未做任何改动。确认无误后加 --apply 执行。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"✗ {error}", file=sys.stderr)
        sys.exit(1)
