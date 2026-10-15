#!/usr/bin/env python3
"""原地更新生产里的《晚安，苏晚棠》问卷（默认 survey id = 118）。

为什么要单独一个脚本：`import_galgame_survey.py` 会**新建**一份问卷（新 id），
那样 `/s/118` 就失效了。这里只做原地 UPDATE：

  1. 把 `assets/` 里的媒体重传到 KV remote（同 storageKey = 内容原地替换，
     media_assets 的 id 不变；新曲目才新增行）
  2. `surveys.settings_json` 换成解析过 `/api/survey/media/<id>` 的 theme
     （含 audio.byPage / audio.byQuestion），并把 version +1、updated_at 置新
     ⇒ 定义缓存键含 version + updated_at，因此这次更新会自动失效旧缓存
  3. 按 `"order"` 逐条 UPDATE `survey_questions` 的 title/description
  4. 追加一条 `survey_versions` 快照（形状与导入器一致，供后台版本历史/回滚）

**不动** condition_json / skip_to_question_id / options / 页面归属：本次只改
叙述文本、BGM 映射与素材内容，分支结构保持不变。脚本结尾会把 DB 现状与 JSON
对照打印出来，方便人工核对。

Usage:
    python3 scripts/galgame/update_galgame_survey.py                 # dry-run
    python3 scripts/galgame/update_galgame_survey.py --apply
    python3 scripts/galgame/update_galgame_survey.py --apply --survey-id 118
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from import_galgame_survey import (  # noqa: E402
    ASSETS_DIR,
    CONTENT_PATH,
    KV_PREFIX,
    chunk,
    chunk_escaped_by_bytes,
    collect_media_refs,
    esc,
    execute_sql,
    iso,
    patch_theme,
    query_d1,
    upload_media,
)


def fetch_survey(survey_id: int) -> dict | None:
    rows = query_d1(
        "SELECT id, owner_id, title, status, version, updated_at, settings_json "
        f"FROM surveys WHERE id = {survey_id} AND deleted_at IS NULL"
    )
    return rows[0] if rows else None


def media_meta_by_slug(data: dict) -> dict[str, dict]:
    """slug（= kv:// 后面的文件名）→ 该素材的 alt 文本与**磁盘上的真实**元数据。

    为什么必须回填：`media_assets.file_size` 是首次插入时记下的值，而 KV 里的内容
    后来被同 storageKey 原地替换过（素材换新），DB 列不会自己更新；width/height 在
    导入时根本没写。这里一律以本地文件为准，让 DB 记录与 KV 实际字节一致。

    注意：遍历的是 `collect_media_refs()` —— **全部被引用的素材**（含没有 alt 的音频），
    不是"带 alt 的图"。早先的实现只收集 alt 非空的 slug，于是 BGM 永远进不了回填语句；
    而 `verify()` 复用了同一个函数，等于拿同一把漏尺量自己，5 条陈旧行一直报 PASS。
    没有 alt 的素材返回 `alt=None`，表示"保留 DB 里已有的 alt_text，不要覆盖"。
    """
    survey = data["survey"]
    alt_by_slug: dict[str, str] = {}
    for question in survey["questions"]:
        for media in question.get("media") or []:
            url = media.get("url") or ""
            alt = (media.get("alt") or "").strip()
            if url.startswith("kv://") and alt:
                alt_by_slug[url.removeprefix("kv://")] = alt
    for extra in (survey.get("cover") or {}, survey["settings"]["theme"].get("background") or {}):
        url = extra.get("image") or extra.get("url") or ""
        alt = (extra.get("alt") or "").strip()
        if url.startswith("kv://") and alt:
            alt_by_slug.setdefault(url.removeprefix("kv://"), alt)

    out: dict[str, dict] = {}
    for slug in collect_media_refs(data):
        path = ASSETS_DIR / slug
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        mime = {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "webp": "image/webp",
            "mp3": "audio/mpeg",
        }.get(suffix.lstrip("."), "application/octet-stream")
        width = height = None
        if mime.startswith("image/"):
            with Image.open(path) as im:
                width, height = im.width, im.height
        out[slug] = {
            "alt": alt_by_slug.get(slug),
            "size": path.stat().st_size,
            "width": width,
            "height": height,
            "mime": mime,
        }
    return out


def build_statements(data: dict, survey: dict, media_ids: dict[str, int], ts: str) -> tuple[str, int]:
    survey_id = int(survey["id"])
    owner_id = int(survey["owner_id"])
    new_version = int(survey["version"]) + 1
    questions = data["survey"]["questions"]
    settings_json = patch_theme(data, media_ids)

    statements = [
        "UPDATE surveys SET"
        f" settings_json = {esc(settings_json)},"
        f" version = {new_version},"
        f" updated_at = {esc(ts)}"
        f" WHERE id = {survey_id} AND deleted_at IS NULL;"
    ]

    for question in questions:
        order = int(question["order"])
        statements.append(
            "UPDATE survey_questions SET"
            f" title = {esc(question['title'])},"
            f" description = {esc(question.get('description'))},"
            f" updated_at = {esc(ts)}"
            f" WHERE survey_id = {survey_id} AND \"order\" = {order};"
        )

    # 配图映射整表重建：先删本问卷全部 question_media，再按 JSON 的顺序插回。
    # （只 UPDATE 题目文本不会生效——渲染读的是 question_media，不是 JSON。）
    statements.append(
        "DELETE FROM question_media WHERE question_id IN "
        f"(SELECT id FROM survey_questions WHERE survey_id = {survey_id});"
    )
    media_items = [
        {
            "questionOrder": int(question["order"]),
            "mediaId": media_ids[(media.get("url") or "").removeprefix("kv://")],
            "sortOrder": sort,
        }
        for question in questions
        for sort, media in enumerate(question.get("media") or [])
        if (media.get("url") or "").startswith("kv://")
    ]
    for group in chunk(media_items, 15):
        statements.append(
            "INSERT INTO question_media (question_id, media_asset_id, sort_order, created_at) "
            "SELECT q.id, CAST(json_extract(item.value,'$.mediaId') AS INTEGER), "
            "CAST(json_extract(item.value,'$.sortOrder') AS INTEGER), "
            f"{esc(ts)} FROM json_each({esc(json.dumps(group, ensure_ascii=False))}) AS item "
            f"JOIN survey_questions q ON q.survey_id = {survey_id} "
            "AND q.\"order\" = CAST(json_extract(item.value,'$.questionOrder') AS INTEGER);"
        )

    # alt 文本 + 真实体积/尺寸写回 media_assets（定义接口再把 alt 随 media 发给前端）。
    # 覆盖全部被引用素材（含音频）；没有 alt 的素材不动 alt_text，只修体积/尺寸/MIME。
    for slug, meta in sorted(media_meta_by_slug(data).items()):
        media_id = media_ids.get(slug)
        if media_id is None:
            continue
        width = "NULL" if meta["width"] is None else str(meta["width"])
        height = "NULL" if meta["height"] is None else str(meta["height"])
        alt_sql = "" if meta["alt"] is None else f" alt_text = {esc(meta['alt'])},"
        statements.append(
            "UPDATE media_assets SET"
            f"{alt_sql}"
            f" file_size = {meta['size']},"
            f" width = {width},"
            f" height = {height},"
            f" mime_type = {esc(meta['mime'])},"
            f" updated_at = {esc(ts)}"
            f" WHERE id = {media_id};"
        )

    snapshot = {
        "schema": data,
        "questionOrderIds": [q.get("id") for q in questions],
    }
    chunks = chunk_escaped_by_bytes(json.dumps(snapshot, ensure_ascii=False))
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({survey_id}, {new_version}, {esc(chunks[0])}, {owner_id}, {esc(ts)});"
    )
    for extra in chunks[1:]:
        statements.append(
            "UPDATE survey_versions SET snapshot_json = snapshot_json || "
            f"{esc(extra)} WHERE survey_id = {survey_id} AND version = {new_version};"
        )
    return "\n".join(statements), new_version


def verify(survey_id: int, data: dict, new_version: int, media_ids: dict[str, int]) -> bool:
    """对照 JSON 与 DB，返回是否完全一致。"""
    questions = data["survey"]["questions"]
    ok = True

    row = fetch_survey(survey_id)
    if not row:
        print("✗ 更新后查不到该问卷")
        return False
    print(f"surveys: version={row['version']} updated_at={row['updated_at']}")
    if int(row["version"]) != new_version:
        print(f"✗ version 期望 {new_version}，实际 {row['version']}")
        ok = False

    stored = json.loads(row["settings_json"])
    audio = stored.get("audio") or {}
    json_audio = data["survey"]["settings"]["theme"]["audio"]
    for field in ("url", "byPage", "byQuestion"):
        want = json_audio.get(field)
        got = audio.get(field)
        if field == "url":
            matched = isinstance(got, str) and got.startswith("/api/survey/media/")
        else:
            matched = isinstance(got, dict) and set(got) == set(want or {}) and all(
                str(v).startswith("/api/survey/media/") for v in got.values()
            )
        print(f"  audio.{field}: {len(got) if isinstance(got, dict) else got} {'✓' if matched else '✗'}")
        ok = ok and matched

    # 界面音效：cue 名必须原样保留，URL 必须是已解析的媒体地址。
    json_sfx = (data["survey"]["settings"]["theme"].get("audio") or {}).get("sfx") or {}
    if json_sfx:
        got_sfx = audio.get("sfx") or {}
        matched = set(got_sfx) == set(json_sfx) and all(
            str(v).startswith("/api/survey/media/") for v in got_sfx.values()
        )
        print(f"  audio.sfx: {len(got_sfx)} 条 cue {'✓' if matched else '✗'}")
        ok = ok and matched

    # 立绘：expressions 必须是已解析的媒体 URL；byPage/byQuestion 是**表情名**，必须原样保留。
    json_sprite = data["survey"]["settings"]["theme"].get("sprite") or {}
    if json_sprite:
        stored_sprite = stored.get("sprite") or {}
        want_expr = json_sprite.get("expressions") or {}
        got_expr = stored_sprite.get("expressions") or {}
        matched = (
            set(got_expr) == set(want_expr)
            and all(str(v).startswith("/api/survey/media/") for v in got_expr.values())
            and (stored_sprite.get("byPage") or {}) == (json_sprite.get("byPage") or {})
            and (stored_sprite.get("byQuestion") or {}) == (json_sprite.get("byQuestion") or {})
            and stored_sprite.get("default") == json_sprite.get("default")
            and stored_sprite.get("name") == json_sprite.get("name")
        )
        print(
            f"  sprite: {len(got_expr)} 个表情 / byPage {len(stored_sprite.get('byPage') or {})} 条"
            f" / byQuestion {len(stored_sprite.get('byQuestion') or {})} 条 {'✓' if matched else '✗'}"
        )
        ok = ok and matched

    db_rows = query_d1(
        "SELECT \"order\" AS ord, title, description FROM survey_questions "
        f"WHERE survey_id = {survey_id} ORDER BY \"order\""
    )
    by_order = {int(r["ord"]): r for r in db_rows}
    if len(db_rows) != len(questions):
        print(f"✗ 题数期望 {len(questions)}，实际 {len(db_rows)}")
        ok = False
    mismatched = 0
    for question in questions:
        order = int(question["order"])
        db = by_order.get(order)
        if not db:
            print(f"✗ order {order} 在 DB 中缺失")
            ok = False
            continue
        if (db["description"] or "") != (question.get("description") or ""):
            mismatched += 1
            if mismatched <= 3:
                print(f"✗ order {order} description 不一致（DB {len(db['description'] or '')} 字 / JSON {len(question.get('description') or '')} 字）")
        if (db["title"] or "") != (question["title"] or ""):
            print(f"✗ order {order} title 不一致")
            ok = False
    if mismatched:
        print(f"✗ 共 {mismatched} 条 description 不一致")
        ok = False
    else:
        total = sum(len(q.get("description") or "") for q in questions)
        print(f"  survey_questions: {len(db_rows)} 行，description 全部一致（合计 {total} 字）")

    # 分支结构必须原样保留：每条带 condition 的题目都要有数字目标。
    cond_rows = query_d1(
        "SELECT \"order\" AS ord, condition_json, skip_to_question_id FROM survey_questions "
        f"WHERE survey_id = {survey_id} AND condition_json IS NOT NULL ORDER BY \"order\""
    )
    expect_cond = len([q for q in questions if q.get("condition")])
    print(f"  condition 行: {len(cond_rows)}（JSON 期望 {expect_cond}）")
    ok = ok and len(cond_rows) == expect_cond
    for r in cond_rows:
        parsed = json.loads(r["condition_json"])
        if parsed.get("kind") != "option_equals" or not parsed.get("rules"):
            print(f"✗ order {r['ord']} condition_json 形状异常: {r['condition_json'][:120]}")
            ok = False

    # 配图映射：逐题核对 question_media 与 JSON 的 media 条数
    want_media = {
        int(q["order"]): len([m for m in (q.get("media") or []) if m.get("url")])
        for q in questions
    }
    want_media = {k: v for k, v in want_media.items() if v}
    media_rows = query_d1(
        "SELECT q.\"order\" AS ord, COUNT(qm.id) AS n FROM survey_questions q "
        "JOIN question_media qm ON qm.question_id = q.id "
        f"WHERE q.survey_id = {survey_id} GROUP BY q.id ORDER BY ord"
    )
    got_media = {int(r["ord"]): int(r["n"]) for r in media_rows}
    if got_media == want_media:
        print(f"  question_media: {sum(got_media.values())} 条映射覆盖 {len(got_media)} 题，与 JSON 一致")
    else:
        print(f"✗ question_media 不一致：DB {got_media} / JSON {want_media}")
        ok = False

    # 素材元数据：alt 非空（若有）、file_size 与磁盘一致、图片有尺寸。
    # 覆盖全部被引用素材——含音频，否则正是这里会漏掉 BGM 的陈旧 file_size。
    want_meta = media_meta_by_slug(data)
    want_ids = {media_ids[s]: m for s, m in want_meta.items() if s in media_ids}
    if want_ids:
        id_list = ",".join(str(i) for i in sorted(want_ids))
        rows = query_d1(
            "SELECT id, alt_text, file_size, width, height FROM media_assets "
            f"WHERE id IN ({id_list})"
        )
        got = {int(r["id"]): r for r in rows}
        bad_alt = [
            i for i, m in want_ids.items()
            if m["alt"] is not None and (got.get(i, {}).get("alt_text") or "") != m["alt"]
        ]
        bad_size = [i for i, m in want_ids.items() if int(got.get(i, {}).get("file_size") or -1) != m["size"]]
        bad_dim = [
            i for i, m in want_ids.items()
            if m["width"] is not None
            and (int(got.get(i, {}).get("width") or 0), int(got.get(i, {}).get("height") or 0))
            != (m["width"], m["height"])
        ]
        for label, bad in (("alt_text", bad_alt), ("file_size", bad_size), ("width/height", bad_dim)):
            if bad:
                print(f"✗ {label} 不一致：{bad[:5]}")
                ok = False
        images = [m for m in want_ids.values() if m["width"] is not None]
        audios = [m for m in want_ids.values() if m["width"] is None]
        if not (bad_alt or bad_size or bad_dim):
            alt_images = [m for m in images if m["alt"] is not None]
            print(
                f"  media_assets: {len(want_ids)} 条素材（{len(images)} 图 + {len(audios)} 音频）"
                "体积全部与磁盘一致，图片尺寸一致"
                f"，{len(alt_images)} 张图 alt 平均 {sum(len(m['alt']) for m in alt_images) // len(alt_images)} 字"
            )

    versions = query_d1(
        f"SELECT version, length(snapshot_json) AS bytes FROM survey_versions WHERE survey_id = {survey_id} ORDER BY version"
    )
    print(f"  survey_versions: {[(int(v['version']), int(v['bytes'])) for v in versions]}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="执行 KV 上传与 D1 更新（默认 dry-run）")
    parser.add_argument("--survey-id", type=int, default=118, help="目标问卷 id（默认 118）")
    args = parser.parse_args()

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    json_title = str(data["survey"]["title"])
    questions = data["survey"]["questions"]
    slugs = collect_media_refs(data)

    survey = fetch_survey(args.survey_id)
    if not survey:
        print(f"✗ 生产里找不到 id={args.survey_id} 且未删除的问卷")
        return 1
    if str(survey["title"]) != json_title:
        print(f"✗ 目标问卷标题不匹配，拒绝更新\n  DB : {survey['title']}\n  JSON: {json_title}")
        return 1
    print(f"目标: id={args.survey_id} 《{survey['title']}》 status={survey['status']} version={survey['version']}")

    media_ids = upload_media(slugs, apply=args.apply, assets_dir=ASSETS_DIR, kv_prefix=KV_PREFIX)
    print(f"媒体: {len(slugs)} 个文件（{len(media_ids)} 个映射）")
    for slug in sorted(media_ids):
        print(f"  {slug:24s} → media #{media_ids[slug]}")

    ts = iso()
    sql, new_version = build_statements(data, survey, media_ids, ts)
    print(f"SQL: {sql.count('UPDATE') + sql.count('INSERT')} 条语句，目标 version={new_version}")

    if not args.apply:
        print("[dry-run] 未改动生产。加 --apply 才会执行。")
        return 0

    execute_sql(sql, f"update galgame survey {args.survey_id}", apply=True)
    print("已执行 D1 更新，开始校验…")
    ok = verify(args.survey_id, data, new_version, media_ids)
    print("校验结果:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
