#!/usr/bin/env python3
"""Import the 雨夜书房 hotspot-scene survey (scene question) into remote D1.

Mirrors the galgame importer's flow (KV upload → draft insert → settings/links
patch → publish + version snapshot), with two scene-specific differences:

  - the scene question's settings_json carries the whole hotspot config, with
    kv:// slugs resolved to /api/survey/media/<id> before the UPDATE lands;
  - every image referenced by the config (scene backdrops + detail images) is
    attached to question_media in declaration order — the media endpoint's
    linkage check grants public visibility through question_media once the
    survey is published, and the frontend reads alt text from the same rows.

Usage:
    python3 scripts/hotspot/import_hotspot_survey.py            # dry-run
    python3 scripts/hotspot/import_hotspot_survey.py --apply    # KV + D1 + publish
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wenai"))
import import_wenai_survey as wenai  # noqa: E402

# 到 Cloudflare API 的连接偶发 fetch failed，且 wrangler --json 把错误对象打在
# stdout（wenai 的 run() 只回显 stderr，npm notice 会把真实错误淹没）。这里给
# 底层 wrangler 调用做完整替换：错误取 stdout+stderr，网络类失败有界重试。
# patch 模块属性即可覆盖 upload_media/query_d1/execute_sql 的全部内部调用。
import subprocess  # noqa: E402
import time  # noqa: E402

_SCRIPT_ROOT = wenai.ROOT


def _run_with_retry(args: list[str], capture: bool = False) -> subprocess.CompletedProcess[str]:
    # 运行时读 wenai.WRANGLER_ARGS（--config 注入目标环境）。此函数在模块
    # 顶部替换 wenai.run，wenai 内部所有 wrangler 调用都经这里——丢了
    # WRANGLER_ARGS 会静默打到生产库（实际发生过，见 runbook 风险记录）。
    wrangler_args = ["npx", "wrangler", *wenai.WRANGLER_ARGS, *args]
    last_error = ""
    for attempt in range(4):
        result = subprocess.run(
            wrangler_args,
            cwd=_SCRIPT_ROOT,
            capture_output=capture,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return result
        last_error = (result.stdout + "\n" + result.stderr)[-1500:]
        transient = (
            "fetch failed" in last_error
            or "connection" in last_error.lower()
            or "timed out" in last_error.lower()
        )
        if not transient or attempt == 3:
            break
        wait = 2**attempt
        print(f"  ⏳ wrangler 网络失败（第 {attempt + 1} 次），{wait}s 后重试…")
        time.sleep(wait)
    raise RuntimeError(f"wrangler 失败: {' '.join(args[:3])}\n{last_error}")


wenai.run = _run_with_retry

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIR / "hotspot-survey.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
KV_PREFIX = "media:survey-hotspot"
PUBLIC_BASE = "https://emoe.eu.cc"


def collect_media_refs(data: dict) -> list[str]:
    """All kv:// slugs in declaration order: question media (which already
    lists every scene/detail image) plus anything referenced by the scene
    config itself, in case a config URL is not attached as question media."""
    slugs: list[str] = []

    def push(ref) -> None:
        if isinstance(ref, str) and ref.startswith("kv://") and ref not in slugs:
            slugs.append(ref)

    for question in data["survey"]["questions"]:
        for media in question.get("media") or []:
            push(media.get("url"))
        scene = (question.get("settings") or {}).get("scene") or {}
        for scene_def in (scene.get("scenes") or {}).values():
            push(scene_def.get("image"))
            for hotspot in scene_def.get("hotspots") or []:
                action = hotspot.get("action") or {}
                if action.get("kind") == "image":
                    push(action.get("src"))
    return [slug.removeprefix("kv://") for slug in slugs]


def resolve_refs(value, media_ids: dict[str, int]):
    """Deep-copy the settings object with every kv:// slug swapped for its
    /api/survey/media/<id> URL."""
    if isinstance(value, str) and value.startswith("kv://"):
        return f"/api/survey/media/{media_ids[value.removeprefix('kv://')]}"
    if isinstance(value, list):
        return [resolve_refs(item, media_ids) for item in value]
    if isinstance(value, dict):
        return {key: resolve_refs(item, media_ids) for key, item in value.items()}
    return value


def scene_question(data: dict) -> dict:
    for question in data["survey"]["questions"]:
        if question.get("type") == "scene":
            return question
    raise RuntimeError("定义里没有 scene 题")


def build_survey_sql(data: dict, media_ids: dict[str, int], owner_id: int, ts: str) -> str:
    survey = data["survey"]
    title = str(survey["title"])
    sid = f"(SELECT id FROM surveys WHERE title = {wenai.esc(title)} AND created_at = {wenai.esc(ts)} LIMIT 1)"
    statements: list[str] = []

    if wenai.query_d1(f"SELECT id FROM surveys WHERE title = {wenai.esc(title)} AND deleted_at IS NULL LIMIT 1"):
        raise RuntimeError(f"已存在同名问卷《{title}》，如需重导请先在后台删除（回收站也占标题）。")

    statements.append(
        "INSERT INTO surveys ("
        " owner_id, title, description, anonymous, allow_multiple_responses,"
        " max_responses_per_user, version, access_code, report_template_id,"
        " settings_json, created_at, updated_at"
        ") VALUES ("
        f"{owner_id},{wenai.esc(title)},{wenai.esc(survey.get('description'))},"
        f"{1 if survey.get('anonymous') else 0},0,1,1,NULL,NULL,"
        f"NULL,{wenai.esc(ts)},{wenai.esc(ts)});"
    )

    for index, page in enumerate(survey.get("pages") or []):
        statements.append(
            "INSERT INTO survey_pages (survey_id, title, description, \"order\", created_at, updated_at) "
            f"VALUES ({sid},{wenai.esc(page.get('title'))},{wenai.esc(page.get('description'))},{index},{wenai.esc(ts)},{wenai.esc(ts)});"
        )

    pages = survey.get("pages") or []
    page_order_by_id = {str(page.get("id")): index for index, page in enumerate(pages)}
    for question in survey["questions"]:
        statements.append(
            "INSERT INTO survey_questions ("
            " survey_id, type, title, description, required, \"order\", page_id,"
            " settings_json, created_at, updated_at"
            f") VALUES ({sid},{wenai.esc(question['type'])},{wenai.esc(question.get('title'))},"
            f"{wenai.esc(question.get('description'))},"
            f"{1 if question.get('required') else 0},{int(question['order'])},"
            f"(SELECT id FROM survey_pages WHERE survey_id = {sid} AND \"order\" = "
            f"{page_order_by_id.get(str(question.get('page_id')), 0)}),"
            f"NULL,{wenai.esc(ts)},{wenai.esc(ts)});"
        )

    # 场景配置：kv:// 先换成真实媒体 URL 再整体写入 settings_json。
    scene = scene_question(data)
    settings_json = json.dumps(
        {"scene": resolve_refs(scene["settings"]["scene"], media_ids)}, ensure_ascii=False
    )
    statements.append(
        "UPDATE survey_questions SET settings_json = "
        f"{wenai.esc(settings_json)}, updated_at = {wenai.esc(ts)} "
        f"WHERE survey_id = {sid} AND \"order\" = {int(scene['order'])};"
    )

    # question_media：声明顺序即 sort_order。场景图 + 全部内层图都挂上，
    # 媒体端点对 once-published 问卷的第一路 linkage（question_media）因此放行。
    media_items = [
        {
            "questionOrder": int(q.get("order")),
            "mediaId": media_ids[url.removeprefix("kv://")],
            "sortOrder": sort,
        }
        for q in survey["questions"]
        for sort, media in enumerate(q.get("media") or [])
        if (url := media.get("url"))
    ]
    for group in wenai.chunk(media_items, 15):
        statements.append(
            "INSERT INTO question_media (question_id, media_asset_id, sort_order, created_at) "
            "SELECT q.id, CAST(json_extract(item.value,'$.mediaId') AS INTEGER),"
            " CAST(json_extract(item.value,'$.sortOrder') AS INTEGER),"
            f"{wenai.esc(ts)} "
            f"FROM json_each({wenai.esc(json.dumps(group, ensure_ascii=False))}) AS item "
            f"JOIN survey_questions q ON q.survey_id = {sid} "
            "AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER);"
        )

    # alt_text / 像素尺寸回填（0077 的列；导出与前端 alt 都从这里读）。
    meta_updates = []
    for slug, meta in (data.get("mediaMeta") or {}).items():
        if slug not in media_ids:
            continue
        meta_updates.append(
            "UPDATE media_assets SET alt_text = "
            f"{wenai.esc(meta.get('alt'))}, width = {int(meta['width'])}, height = {int(meta['height'])},"
            f" updated_at = {wenai.esc(ts)} WHERE id = {media_ids[slug]};"
        )
    if meta_updates:
        statements.extend(meta_updates)
    return "\n".join(statements)


def build_publish_sql(data: dict, owner_id: int, ts: str) -> str:
    survey = data["survey"]
    title = str(survey["title"])
    sid = f"(SELECT id FROM surveys WHERE title = {wenai.esc(title)} LIMIT 1)"
    statements = [
        "UPDATE surveys SET status = 'published', version = version + 1,"
        f" published_at = {wenai.esc(ts)}, updated_at = {wenai.esc(ts)} "
        f"WHERE title = {wenai.esc(title)} AND created_at IS NOT NULL;"
    ]
    snapshot = {
        "schema": {k: v for k, v in data.items() if k != "mediaMeta"},
        "questionOrderIds": [q.get("id") for q in survey["questions"]],
    }
    snapshot_chunks = wenai.chunk_escaped_by_bytes(json.dumps(snapshot, ensure_ascii=False))
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({sid}, (SELECT version FROM surveys WHERE title = {wenai.esc(title)}),"
        f" {wenai.esc(snapshot_chunks[0])},{owner_id},{wenai.esc(ts)});"
    )
    for extra in snapshot_chunks[1:]:
        statements.append(
            "UPDATE survey_versions SET snapshot_json = snapshot_json || "
            f"{wenai.esc(extra)} WHERE survey_id = {sid} AND version = "
            f"(SELECT version FROM surveys WHERE title = {wenai.esc(title)});"
        )
    return "\n".join(statements)


def verify(data: dict, media_ids: dict[str, int], title: str) -> bool:
    """独立 SQL 复核（不复用构建期的任何中间对象）。"""
    ok = True

    def check(label: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'✓' if passed else '✗'} {label}{(' — ' + detail) if detail else ''}")
        ok = ok and passed

    rows = wenai.query_d1(f"SELECT id, status, version FROM surveys WHERE title = {wenai.esc(title)} AND deleted_at IS NULL LIMIT 1")
    if not rows:
        print("  ✗ 问卷不存在")
        return False
    survey_id = int(rows[0]["id"])
    check("问卷已发布", rows[0]["status"] == "published", f"id={survey_id} status={rows[0]['status']}")

    scene = scene_question(data)
    qrows = wenai.query_d1(
        f"SELECT id, type, required, settings_json FROM survey_questions "
        f"WHERE survey_id = {survey_id} AND \"order\" = {int(scene['order'])} LIMIT 1"
    )
    if not qrows:
        print("  ✗ scene 题不存在")
        return False
    stored = json.loads(qrows[0]["settings_json"] or "null")
    expected = json.loads(
        json.dumps({"scene": resolve_refs(scene["settings"]["scene"], media_ids)}, ensure_ascii=False)
    )
    check("scene 题类型正确", qrows[0]["type"] == "scene")
    check(
        "settings_json 与定义一致",
        stored == expected,
        f"{len(qrows[0]['settings_json'] or '')} 字节",
    )

    linked = {
        int(row["media_asset_id"])
        for row in wenai.query_d1(
            f"SELECT media_asset_id FROM question_media WHERE question_id = {int(qrows[0]['id'])}"
        )
    }
    wanted = set(media_ids.values())
    check("question_media 挂载完整", linked == wanted, f"{len(linked)}/{len(wanted)}")

    bad_meta = wenai.query_d1(
        "SELECT storage_key FROM media_assets WHERE id IN ("
        + ",".join(str(i) for i in media_ids.values())
        + ") AND (alt_text IS NULL OR width IS NULL OR height IS NULL OR file_size IS NULL OR file_size <= 0)"
    )
    check("媒体元数据（alt/尺寸/大小）齐备", len(bad_meta) == 0, f"缺失 {len(bad_meta)} 条")

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="执行 KV 上传与 D1 导入（默认 dry-run）")
    parser.add_argument("--owner-id", type=int, help="覆盖问卷归属的 user id（默认取库中最常见 owner）")
    wenai.add_environment_args(parser)
    args = parser.parse_args()
    wenai.apply_environment_args(args)

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    slugs = collect_media_refs(data)
    questions = data["survey"]["questions"]
    print(f"问卷《{data['survey']['title']}》：{len(questions)} 题，{len(slugs)} 个媒体文件")

    media_ids = wenai.upload_media(slugs, apply=args.apply, assets_dir=ASSETS_DIR, kv_prefix=KV_PREFIX)
    print("媒体 ID 映射：", {s: media_ids[s] for s in slugs[:4]}, f"... 共 {len(slugs)}")

    if args.owner_id:
        owner_id = args.owner_id
    else:
        owners = wenai.query_d1("SELECT owner_id FROM surveys GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 1")
        owner_id = int(owners[0]["owner_id"]) if owners else 1
    ts = wenai.iso()

    create_sql = build_survey_sql(data, media_ids, owner_id, ts)
    wenai.execute_sql(create_sql, "survey 主体", apply=args.apply)

    publish_sql = build_publish_sql(data, owner_id, wenai.iso())
    wenai.execute_sql(publish_sql, "发布与快照", apply=args.apply)

    if args.apply:
        rows = wenai.query_d1(f"SELECT id FROM surveys WHERE title = {wenai.esc(str(data['survey']['title']))} LIMIT 1")
        print("\n—— verify ——")
        passed = verify(data, media_ids, str(data["survey"]["title"]))
        if rows and passed:
            print(f"\n✅ 已导入并发布：{PUBLIC_BASE}/s/{rows[0]['id']}")
        else:
            print("\n⚠️ 导入已执行但校验未全过，请按上面的 ✗ 项排查。")
            return 1
    else:
        print("\n[dry-run] 未做任何改动。确认无误后加 --apply 执行。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"✗ {error}", file=sys.stderr)
        sys.exit(1)
