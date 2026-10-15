#!/usr/bin/env python3
"""Import the 晚安，苏晚棠 galgame survey (58 nodes, branching) into remote D1.

Flow: KV upload (media) → survey/pages/questions/options insert (draft) →
condition patch (slug rules → numeric condition_json + skip_to_question_id) →
publish + version snapshot. Reuses the wenai importer's parameterized helpers.

Usage:
    python3 scripts/galgame/import_galgame_survey.py            # dry-run
    python3 scripts/galgame/import_galgame_survey.py --apply    # KV + D1 + publish
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wenai"))
from import_wenai_survey import (  # noqa: E402
    chunk,
    chunk_escaped_by_bytes,
    esc,
    execute_sql,
    iso,
    query_d1,
    upload_media,
)

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIR / "galgame-survey.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
KV_PREFIX = "media:survey-galgame"
PUBLIC_BASE = "https://emoe.eu.cc"


def collect_media_refs(data: dict) -> list[str]:
    survey = data["survey"]
    slugs: list[str] = []

    def push(ref) -> None:
        if isinstance(ref, str) and ref.startswith("kv://") and ref not in slugs:
            slugs.append(ref)

    theme = survey.get("settings", {}).get("theme", {})
    push(theme.get("background", {}).get("image"))
    audio = theme.get("audio", {})
    push(audio.get("url"))
    for value in (audio.get("byPage") or {}).values():
        push(value)
    for value in (audio.get("byQuestion") or {}).values():
        push(value)
    for value in (audio.get("sfx") or {}).values():
        push(value)
    for value in ((theme.get("sprite") or {}).get("expressions") or {}).values():
        push(value)
    push((survey.get("cover") or {}).get("url"))
    for question in survey["questions"]:
        for media in question.get("media") or []:
            push(media.get("url"))
        for option in question.get("options") or []:
            for media in option.get("media") or []:
                push(media.get("url"))
    return [slug.removeprefix("kv://") for slug in slugs]


def patch_theme(data: dict, media_ids: dict[str, int]) -> str:
    """settings_json 直存 theme 对象（读取端形状），kv:// 全部替换为真实媒体 id。"""
    theme = json.loads(json.dumps(data["survey"]["settings"]["theme"]))

    def resolve(ref: str) -> str:
        return f"/api/survey/media/{media_ids[ref.removeprefix('kv://')]}"

    theme["background"]["image"] = resolve(theme["background"]["image"])
    if theme.get("audio", {}).get("url"):
        theme["audio"]["url"] = resolve(theme["audio"]["url"])
    by_page = theme.get("audio", {}).get("byPage") or {}
    for key, value in list(by_page.items()):
        by_page[key] = resolve(value)
    by_question = theme.get("audio", {}).get("byQuestion") or {}
    for key, value in list(by_question.items()):
        by_question[key] = resolve(value)
    sfx = theme.get("audio", {}).get("sfx") or {}
    for key, value in list(sfx.items()):
        sfx[key] = resolve(value)
    expressions = (theme.get("sprite") or {}).get("expressions") or {}
    for key, value in list(expressions.items()):
        expressions[key] = resolve(value)
    return json.dumps(theme, ensure_ascii=False)


def build_survey_sql(data: dict, media_ids: dict[str, int], owner_id: int, ts: str) -> str:
    survey = data["survey"]
    title = str(survey["title"])
    sid = f"(SELECT id FROM surveys WHERE title = {esc(title)} AND created_at = {esc(ts)} LIMIT 1)"
    statements: list[str] = []

    if query_d1(f"SELECT id FROM surveys WHERE title = {esc(title)} AND deleted_at IS NULL LIMIT 1"):
        raise RuntimeError(f"已存在同名问卷《{title}》，如需重导请先在后台删除。")

    settings_json = patch_theme(data, media_ids)
    statements.append(
        "INSERT INTO surveys ("
        " owner_id, title, description, anonymous, allow_multiple_responses,"
        " max_responses_per_user, version, access_code, report_template_id,"
        " settings_json, created_at, updated_at"
        ") VALUES ("
        f"{owner_id},{esc(title)},{esc(survey.get('description'))},0,0,1,1,NULL,NULL,"
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
            " NULL,"
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
        f"UPDATE surveys SET cover_media_id = {media_ids['cover.jpg']}, updated_at = {esc(ts)} "
        f"WHERE title = {esc(title)} AND created_at = {esc(ts)};"
    )
    return "\n".join(statements)


def build_condition_updates(data: dict, ts: str) -> str:
    """slug 条件 → 数字 condition_json / skip_to_question_id。"""
    survey = data["survey"]
    title = str(survey["title"])
    sid = f"(SELECT id FROM surveys WHERE title = {esc(title)} LIMIT 1)"

    questions = {str(q["id"]): q for q in survey["questions"]}
    rows = query_d1(
        f"SELECT q.id qid, q.\"order\" qorder, o.id oid, o.\"order\" oorder "
        f"FROM survey_questions q LEFT JOIN question_options o ON o.question_id = q.id "
        f"WHERE q.survey_id = {sid}"
    )
    qid_by_order = {int(r["qorder"]): int(r["qid"]) for r in rows}
    oid_by_slot = {(int(r["qorder"]), int(r["oorder"])): int(r["oid"]) for r in rows if r.get("oid")}
    if not qid_by_order:
        # dry-run：库内还没有真实行，用占位 id 让 SQL 预览仍可生成
        for q in survey["questions"]:
            qid_by_order[int(q["order"])] = 90000 + int(q["order"])
            for o in q.get("options") or []:
                oid_by_slot[(int(q["order"]), int(o["order"]))] = 95000 + int(q["order"]) * 10 + int(o["order"])

    statements: list[str] = []
    for question in survey["questions"]:
        condition = question.get("condition")
        if not condition:
            continue
        rules = []
        for rule in condition.get("rules", []):
            q_order = int(questions[str(question["id"])]["order"])
            option = next(
                o for o in questions[str(question["id"])]["options"] if o["id"] == rule["optionId"]
            )
            rules.append(
                {
                    "optionId": oid_by_slot[(q_order, int(option["order"]))],
                    "targetQuestionId": qid_by_order[int(questions[str(rule["targetQuestionId"])]["order"])],
                }
            )
        skip_to = None
        if condition.get("skipToQuestionId"):
            skip_to = qid_by_order[int(questions[str(condition["skipToQuestionId"])]["order"])]
        condition_json = json.dumps(
            {"kind": "option_equals", "rules": rules}, ensure_ascii=False
        )
        skip_sql = "NULL" if skip_to is None else str(skip_to)
        statements.append(
            "UPDATE survey_questions SET condition_json = "
            f"{esc(condition_json)}, skip_to_question_id = {skip_sql}, updated_at = {esc(ts)} "
            f"WHERE id = {qid_by_order[int(question['order'])]};"
        )
    return "\n".join(statements)


def build_publish_sql(data: dict, owner_id: int, ts: str) -> str:
    survey = data["survey"]
    title = str(survey["title"])
    sid = f"(SELECT id FROM surveys WHERE title = {esc(title)} LIMIT 1)"
    statements = [
        "UPDATE surveys SET status = 'published', version = version + 1,"
        f" published_at = {esc(ts)}, updated_at = {esc(ts)} "
        f"WHERE title = {esc(title)} AND created_at IS NOT NULL;"
    ]
    snapshot = {"schema": data, "questionOrderIds": [q.get("id") for q in survey["questions"]]}
    snapshot_chunks = chunk_escaped_by_bytes(json.dumps(snapshot, ensure_ascii=False))
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({sid}, (SELECT version FROM surveys WHERE title = {esc(title)}),"
        f" {esc(snapshot_chunks[0])},{owner_id},{esc(ts)});"
    )
    for extra in snapshot_chunks[1:]:
        statements.append(
            "UPDATE survey_versions SET snapshot_json = snapshot_json || "
            f"{esc(extra)} WHERE survey_id = {sid} AND version = "
            f"(SELECT version FROM surveys WHERE title = {esc(title)});"
        )
    return "\n".join(statements)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="执行 KV 上传与 D1 导入（默认 dry-run）")
    parser.add_argument("--owner-id", type=int, help="覆盖问卷归属的 user id（默认取库中最常见 owner）")
    args = parser.parse_args()

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    slugs = collect_media_refs(data)
    questions = data["survey"]["questions"]
    print(f"问卷《{data['survey']['title']}》：{len(questions)} 题，{len(slugs)} 个媒体文件")

    media_ids = upload_media(slugs, apply=args.apply, assets_dir=ASSETS_DIR, kv_prefix=KV_PREFIX)
    print("媒体 ID 映射：", {s: media_ids[s] for s in slugs[:4]}, f"... 共 {len(slugs)}")

    if args.owner_id:
        owner_id = args.owner_id
    else:
        owners = query_d1("SELECT owner_id FROM surveys GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 1")
        owner_id = int(owners[0]["owner_id"]) if owners else 1
    ts = iso()

    create_sql = build_survey_sql(data, media_ids, owner_id, ts)
    execute_sql(create_sql, "survey 主体", apply=args.apply)

    condition_sql = build_condition_updates(data, ts)
    execute_sql(condition_sql, "条件回填", apply=args.apply)

    publish_sql = build_publish_sql(data, owner_id, iso())
    execute_sql(publish_sql, "发布与快照", apply=args.apply)

    if args.apply:
        rows = query_d1(f"SELECT id FROM surveys WHERE title = {esc(str(data['survey']['title']))} LIMIT 1")
        if rows:
            print(f"\n✅ 已导入并发布：{PUBLIC_BASE}/s/{rows[0]['id']}")
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
