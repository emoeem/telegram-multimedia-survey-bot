#!/usr/bin/env python3
"""《雨夜书房 · 雨停之前》场景包 → 指定问卷（默认生产 9136）的落库脚本。

与 scripts/galgame/apply_scenes.py 同构：校验先行、默认 dry-run、--apply 才写、
写前备份。目标是对**已存在的问卷**做原地更新（参照
scripts/galgame/update_galgame_survey.py 的原地模式与
docs/guides/HOTSPOT_SCENES.md §5），做四件事：

  1. 校验：asset-plan.json 的资产 ↔ art/<id>.png 一一存在（宽高以磁盘真实
     像素为准，与 mediaMeta 不符即停）；配置里的 kv://study-room/<id> 占位 ↔
     资产清单 ↔ mediaMeta 三方对齐。
  2. 解析占位：--media-map（{"study-room/<id>": media_id} 的 JSON）把配置与
     question.media 里全部 kv:// 占位换成 /api/survey/media/<id>。依据
     docs/guides/HOTSPOT_SCENES.md §2：URL 白名单只认 data:image/、https://、
     / 相对路径；kv:// 仅导入校验期放行，**落库前必须替换**。
  3. 落库（--apply，wrangler d1 --remote）：
       UPDATE survey_questions.settings_json（scene 题）
       → 重建该题 question_media（先删后挂，声明顺序即 sort_order）
       → media_assets 回填 alt/width/height
       → surveys.version+1 + updated_at（定义缓存键含 version+updated_at，
         旧定义缓存自动失效，无需 bump SURVEY_DEFINITION_CACHE_VERSION）
       → survey_versions 快照（供后台版本历史/回滚）
  4. verify()：独立 SQL 复核——settings_json 与定义逐字段一致、
     question_media 挂载完整、媒体元数据齐备（不复用构建期中间对象）。

本脚本**不翻转发布状态**：目标是生产已发布的 9136 时原地生效；若走「后台复制
草稿 → 改草稿」路径，草稿改完后在管理端发布即可。

前置条件（按顺序）：
  a. art/ 下 9 张插画已生成并通过第 1 步校验（2026-11-13 快照：0/9 全缺，
     见 study-room/README.md「缺口」节，先补插画再跑）；
  b. 素材已入库并拿到 media id：手工维护 --media-map，或 --use-wenai 复用
     scripts/hotspot/import_hotspot_survey.py 的 KV 上传管线自动上传建映射；
  c. wrangler 已登录目标账号（脚本不切账号，切账号须先 `wrangler login`）；
     连 staging 传 --config wrangler.staging.toml --kv-namespace <staging
     MEDIA_KV id> --public-base <staging origin>；
  d. 生产 9136 已发布，管理端只读（loadWritableSurvey 要求草稿且 0 答卷）；
     D1 直写不受此限，但请先对草稿副本演练一遍 --apply 再动 9136。

Usage:
    python3 study-room/apply_scenes.py                                        # 校验 + 报告
    python3 study-room/apply_scenes.py --media-map study-room/media-map.json  # + SQL 预览
    python3 study-room/apply_scenes.py --resolve --media-map study-room/media-map.json
    python3 study-room/apply_scenes.py --apply  --media-map study-room/media-map.json --survey-id 9136

环境变量（CLI 未给时回退）：SURVEY_ID / WRANGLER_CONFIG / MEDIA_KV_NAMESPACE / PUBLIC_BASE
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent  # study-room/
ROOT = SCRIPT_DIR.parent  # 仓库根
PLAN_PATH = SCRIPT_DIR / "asset-plan.json"
CONTENT_PATH = SCRIPT_DIR / "scenes" / "hotspot-survey.json"
RESOLVED_PATH = SCRIPT_DIR / "scenes" / "hotspot-survey.resolved.json"  # 管理端 JSON 导入用
BACKUP_PATH = SCRIPT_DIR / "scenes" / "hotspot-survey.pre-apply.json"  # --apply 前的本地备份
ASSETS_DIR = SCRIPT_DIR / "art"  # art/<id>.png，与 asset-plan.json 的 path 约定一致
DEFAULT_MEDIA_MAP_PATH = SCRIPT_DIR / "media-map.json"
DEFAULT_SURVEY_ID = 9136
KV_PREFIX = "media:survey-studyroom"  # KV storage_key 前缀，与生产 858… 那批（media:survey-hotspot）不混用

sys.path.insert(0, str(ROOT / "scripts" / "wenai"))
import import_wenai_survey as wenai  # noqa: E402  共享的 wrangler d1/kv 通道与目标环境参数


# ---------------------------------------------------------------------------
# 定义读取与占位收集
# ---------------------------------------------------------------------------

def scene_question(data: dict) -> dict:
    """本包只有一道 scene 题（q-scene）；找不到就说明定义被动过了，直接停。"""
    for question in data["survey"]["questions"]:
        if question.get("type") == "scene":
            return question
    raise RuntimeError("定义里没有 scene 题")


def collect_media_refs(data: dict) -> list[str]:
    """全部 kv://study-room/<id> 占位（去重、保声明序）。

    question.media 已列出全部底图与内层图，但仍遍历 scene 配置兜底——
    校验器与被校验对象不能共用一把漏尺（galgame 交付报告 C-3 的教训，
    见 docs/guides/HOTSPOT_SCENES.md §5）。"""
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
    """深拷贝替换：每个 kv://study-room/<id> 占位换成 /api/survey/media/<id>。"""
    if isinstance(value, str) and value.startswith("kv://"):
        return f"/api/survey/media/{media_ids[value.removeprefix('kv://')]}"
    if isinstance(value, list):
        return [resolve_refs(item, media_ids) for item in value]
    if isinstance(value, dict):
        return {key: resolve_refs(item, media_ids) for key, item in value.items()}
    return value


def ref_id(ref: str) -> str:
    """kv 键（study-room/<id>）→ asset-plan 资产 id（<id>）。

    键名换算是 copy.md §0.3 的约定：kv://study-room/<id> ↔ asset-plan 的 id
    ↔ study-room/art/<id>.png；mediaMeta 用全键、asset-plan 用裸 id，对齐时
    必须先归一到同一侧，否则两边全被误报成孤儿。"""
    return ref.removeprefix("study-room/")


# ---------------------------------------------------------------------------
# 校验（结构 ↔ 磁盘）
# ---------------------------------------------------------------------------

def validate_structure(data: dict, plan: list[dict], refs: list[str]) -> None:
    """三方对齐：配置占位 ↔ asset-plan ↔ mediaMeta。任何错位都在替换前拦下。"""
    plan_by_id = {entry["id"]: entry for entry in plan}
    meta_keys = set((data.get("mediaMeta") or {}).keys())
    ids = [ref_id(ref) for ref in refs]
    errors: list[str] = []

    if len(plan) != len(plan_by_id):
        errors.append("asset-plan.json 存在重复 id")
    unknown = [ref for ref, refid in zip(refs, ids) if refid not in plan_by_id]
    if unknown:
        errors.append(f"配置引用了清单外的占位: {unknown}")
    no_meta = [ref for ref in refs if ref not in meta_keys]
    if no_meta:
        errors.append(f"配置引用了 mediaMeta 缺失的键: {no_meta}")
    orphan = [key for key in plan_by_id if key not in set(ids)]
    if orphan:
        errors.append(f"清单里渲染了却没被配置引用的资产: {orphan}")
    bad_path = [key for key, e in plan_by_id.items() if e.get("path") != f"study-room/art/{key}.png"]
    if bad_path:
        errors.append(f"清单 path 与 art/<id>.png 约定不符: {bad_path}")
    pano = [key for key, e in plan_by_id.items() if e.get("kind") == "panorama"]
    if len(pano) != 1:
        # 底图恰好一张是本包的设计决策（copy.md §0.3「一幅画，四个驻点」）
        errors.append(f"kind=panorama 应恰好 1 张，实际 {len(pano)}: {pano}")
    if errors:
        raise SystemExit("✗ 结构校验未过:\n  " + "\n  ".join(errors))
    print(f"结构对齐：配置 {len(refs)} 个占位 ↔ 清单 {len(plan)} 条 ↔ mediaMeta {len(meta_keys)} 条")


def check_assets(plan: list[dict], media_meta: dict) -> list[str]:
    """磁盘核对：asset-plan 每个条目都要有 art/<id>.png，且真实像素与
    mediaMeta 一致（galgame apply_scenes 的原则：以磁盘上的真实文件为准）。
    返回缺失清单；空列表 = 全部就位。"""
    missing: list[str] = []
    mismatch: list[str] = []
    for entry in plan:
        path = ASSETS_DIR / f"{entry['id']}.png"
        if not path.is_file():
            missing.append(entry["id"])
            continue
        with Image.open(path) as im:
            actual = (im.width, im.height)
        # mediaMeta 用全键（study-room/<id>），asset-plan 用裸 id——对齐前先拼全键
        # 再兜底裸键，否则全部被误报成 0×0（ref_id 反向换算的对称操作）。
        meta = media_meta.get(f"study-room/{entry['id']}") or media_meta.get(entry["id"]) or {}
        declared = (int(meta.get("width", 0)), int(meta.get("height", 0)))
        if actual != declared:
            mismatch.append(f"{entry['id']}: 磁盘 {actual[0]}×{actual[1]} ≠ mediaMeta {declared[0]}×{declared[1]}")
    if mismatch:
        raise SystemExit("✗ 插画像素与 mediaMeta 不符（改 mediaMeta 或重生成插画）:\n  " + "\n  ".join(mismatch))
    return missing


# ---------------------------------------------------------------------------
# 落库 SQL（--apply 才执行；dry-run 只打印预览）
# ---------------------------------------------------------------------------

def build_update_sql(data: dict, media_ids: dict[str, int], survey_id: int, ts: str, owner_id: int) -> str:
    scene = scene_question(data)
    settings_json = json.dumps(
        {"scene": resolve_refs(scene["settings"]["scene"], media_ids)}, ensure_ascii=False
    )
    sid = str(survey_id)
    # 子查询定位 scene 题：本包 scene["order"]=0，但按 type+order 双条件定位，
    # 避免问卷后续加题时 order 漂移误伤
    qid = (
        f"(SELECT id FROM survey_questions WHERE survey_id = {sid} "
        f"AND \"order\" = {int(scene['order'])} AND type = 'scene' LIMIT 1)"
    )
    statements: list[str] = []

    # 1. scene 题 settings_json：整体替换为解析过真实媒体 URL 的配置
    statements.append(
        "UPDATE survey_questions SET settings_json = "
        f"{wenai.esc(settings_json)}, updated_at = {wenai.esc(ts)} "
        f"WHERE survey_id = {sid} AND \"order\" = {int(scene['order'])} AND type = 'scene';"
    )

    # 2. question_media 先删后挂：原地更新不能叠挂（重复行会让媒体端点
    #    linkage 与前端按 URL 匹配 alt 都翻倍）；声明顺序即 sort_order
    statements.append(f"DELETE FROM question_media WHERE question_id = {qid};")
    media_items = [
        {"mediaId": media_ids[media["url"].removeprefix("kv://")], "sortOrder": sort}
        for q in data["survey"]["questions"]
        for sort, media in enumerate(q.get("media") or [])
        if (media.get("url") or "").startswith("kv://")
    ]
    for group in wenai.chunk(media_items, 15):
        statements.append(
            "INSERT INTO question_media (question_id, media_asset_id, sort_order, created_at) "
            f"SELECT {qid}, CAST(json_extract(item.value,'$.mediaId') AS INTEGER), "
            f"CAST(json_extract(item.value,'$.sortOrder') AS INTEGER), {wenai.esc(ts)} "
            f"FROM json_each({wenai.esc(json.dumps(group, ensure_ascii=False))}) AS item;"
        )

    # 3. media_assets 回填 alt / 像素尺寸（迁移 0077 的列；导出与前端 alt 都从这里读）
    for slug, meta in (data.get("mediaMeta") or {}).items():
        if slug not in media_ids:
            continue
        statements.append(
            "UPDATE media_assets SET alt_text = "
            f"{wenai.esc(meta.get('alt'))}, width = {int(meta['width'])}, height = {int(meta['height'])}, "
            f"updated_at = {wenai.esc(ts)} WHERE id = {media_ids[slug]};"
        )

    # 4. version+1 + updated_at：定义缓存键含两者，旧缓存自动失效
    statements.append(
        f"UPDATE surveys SET version = version + 1, updated_at = {wenai.esc(ts)} "
        f"WHERE id = {sid} AND deleted_at IS NULL;"
    )

    # 5. survey_versions 快照（形状与 hotspot/galgame importer 一致，供回滚）
    snapshot = {
        "schema": {key: value for key, value in data.items() if key != "mediaMeta"},
        "mediaMap": {slug: mid for slug, mid in sorted(media_ids.items())},
    }
    snapshot_chunks = wenai.chunk_escaped_by_bytes(json.dumps(snapshot, ensure_ascii=False))
    statements.append(
        "INSERT INTO survey_versions (survey_id, version, snapshot_json, created_by, created_at) "
        f"VALUES ({sid}, (SELECT version FROM surveys WHERE id = {sid}), "
        f"{wenai.esc(snapshot_chunks[0])}, {owner_id}, {wenai.esc(ts)});"
    )
    for extra in snapshot_chunks[1:]:
        statements.append(
            f"UPDATE survey_versions SET snapshot_json = snapshot_json || {wenai.esc(extra)} "
            f"WHERE survey_id = {sid} AND version = (SELECT version FROM surveys WHERE id = {sid});"
        )
    return "\n".join(statements)


def verify(data: dict, media_ids: dict[str, int], survey_id: int) -> bool:
    """独立 SQL 复核（不复用构建期的任何中间对象）。"""
    ok = True

    def check(label: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'✓' if passed else '✗'} {label}{(' — ' + detail) if detail else ''}")
        ok = ok and passed

    rows = wenai.query_d1(
        f"SELECT id, status, version FROM surveys WHERE id = {survey_id} AND deleted_at IS NULL LIMIT 1"
    )
    if not rows:
        print("  ✗ 问卷不存在")
        return False
    check("问卷存在且未删除", True, f"status={rows[0]['status']} version={rows[0]['version']}")

    scene = scene_question(data)
    qrows = wenai.query_d1(
        f"SELECT id, type, settings_json FROM survey_questions "
        f"WHERE survey_id = {survey_id} AND \"order\" = {int(scene['order'])} AND type = 'scene' LIMIT 1"
    )
    if not qrows:
        print("  ✗ scene 题不存在")
        return False
    stored = json.loads(qrows[0]["settings_json"] or "null")
    expected = json.loads(
        json.dumps({"scene": resolve_refs(scene["settings"]["scene"], media_ids)}, ensure_ascii=False)
    )
    check("settings_json 与定义一致", stored == expected, f"{len(qrows[0]['settings_json'] or '')} 字节")

    linked = {
        int(row["media_asset_id"])
        for row in wenai.query_d1(f"SELECT media_asset_id FROM question_media WHERE question_id = {int(qrows[0]['id'])}")
    }
    wanted = set(media_ids.values())
    check("question_media 挂载完整", linked == wanted, f"{len(linked)}/{len(wanted)}")

    bad_meta = wenai.query_d1(
        "SELECT id FROM media_assets WHERE id IN ("
        + ",".join(str(mid) for mid in media_ids.values())
        + ") AND (alt_text IS NULL OR width IS NULL OR height IS NULL OR file_size IS NULL OR file_size <= 0)"
    )
    check("媒体元数据（alt/尺寸/大小）齐备", len(bad_meta) == 0, f"缺失 {len(bad_meta)} 条")

    return ok


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--apply", action="store_true", help="执行 D1 原地更新 + verify（默认 dry-run）")
    parser.add_argument("--resolve", action="store_true", help=f"解析占位并写出 {RESOLVED_PATH.name}（管理端 JSON 导入用）")
    parser.add_argument("--media-map", help=f'kv 键→media id 映射 JSON（如 {{"study-room/panorama": 901, …}}）')
    parser.add_argument("--use-wenai", action="store_true", help="用 wenai 管线把 art/*.png 上传 KV+D1 建映射（素材入库的脚本路径）")
    parser.add_argument("--survey-id", type=int, help=f"目标问卷 id（env SURVEY_ID，默认 {DEFAULT_SURVEY_ID}）")
    wenai.add_environment_args(parser)
    args = parser.parse_args()

    # CLI 优先，环境变量兜底（三个 importer 的目标环境参数同款）
    if args.survey_id is None:
        args.survey_id = int(os.environ.get("SURVEY_ID") or DEFAULT_SURVEY_ID)
    args.config = args.config or os.environ.get("WRANGLER_CONFIG") or None
    args.kv_namespace = args.kv_namespace or os.environ.get("MEDIA_KV_NAMESPACE") or None
    args.public_base = args.public_base or os.environ.get("PUBLIC_BASE") or None
    wenai.apply_environment_args(args)

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    plan: list[dict] = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    media_meta = data.get("mediaMeta") or {}
    refs = collect_media_refs(data)
    scenes = scene_question(data)["settings"]["scene"]["scenes"]
    print(
        f"问卷《{data['survey']['title']}》：{len(data['survey']['questions'])} 题，"
        f"{len(scenes)} 场景，{sum(len(s['hotspots']) for s in scenes.values())} 热点，"
        f"{len(refs)} 个唯一媒体占位"
    )

    # 1+2：结构对齐与磁盘核对——任何一步不过就停，绝不带病替换
    validate_structure(data, plan, refs)
    missing = check_assets(plan, media_meta)
    if missing:
        raise SystemExit(
            f"✗ art/ 缺 {len(missing)}/{len(plan)} 张插画: {missing}\n"
            "  先按 study-room/asset-plan.json 的 prompt 生成后再跑（见 README「缺口」节）。"
        )
    print(f"插画 {len(plan)}/{len(plan)} 就位（磁盘像素与 mediaMeta 一致）")

    # 3：媒体映射——resolve/apply 必需；纯 dry-run 没有映射也允许，只做校验报告
    media_ids: dict[str, int] | None = None
    if args.use_wenai:
        # wenai.upload_media 以 assets_dir/<slug> 找文件；本包占位无扩展名，
        # 实际文件是 art/<id>.png，所以上传前补 .png、回来再去掉
        uploaded = wenai.upload_media(
            [f"{slug}.png" for slug in refs], apply=args.apply, assets_dir=ASSETS_DIR, kv_prefix=KV_PREFIX
        )
        media_ids = {slug: int(uploaded[f"{slug}.png"]) for slug in refs}
        print(f"wenai 上传映射：{media_ids}")
    else:
        map_path = Path(args.media_map) if args.media_map else DEFAULT_MEDIA_MAP_PATH
        if map_path.is_file():
            media_ids = {
                str(key): int(value)
                for key, value in json.loads(map_path.read_text(encoding="utf-8")).items()
            }
            print(f"media map：{map_path}（{len(media_ids)} 键）")

    if media_ids is None:
        print("\n[dry-run] 未提供 --media-map / --use-wenai：仅校验，不解析占位。")
        print("占位清单：", ", ".join(refs))
        print("下一步：素材入库后生成 media-map.json，再加 --resolve 或 --apply。")
        return 0

    unresolved = [slug for slug in refs if slug not in media_ids]
    if unresolved:
        raise SystemExit(f"✗ media map 缺 {len(unresolved)} 个键: {unresolved}")
    extra = sorted(set(media_ids) - set(refs))
    if extra:
        print(f"⚠ media map 有 {len(extra)} 个配置未引用的键（核对是否抄错）: {extra}")

    # 4：--resolve 只做本地变换（离线可用），产出管理端 JSON 导入用的解析稿
    if args.resolve:
        resolved = {**data, "survey": resolve_refs(data["survey"], media_ids)}
        RESOLVED_PATH.write_text(
            json.dumps(resolved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"已写出解析稿 → {RESOLVED_PATH}")

    if not args.apply:
        # 远程读一次目标问卷，让 SQL 预览带着真实上下文（dry-run 不做任何写）
        rows = wenai.query_d1(
            f"SELECT id, title, status, version FROM surveys WHERE id = {args.survey_id} AND deleted_at IS NULL LIMIT 1"
        )
        if not rows:
            raise SystemExit(f"✗ survey {args.survey_id} 不存在（或已删除）")
        print(
            f"目标问卷：id={rows[0]['id']} 《{rows[0]['title']}》 status={rows[0]['status']} version={rows[0]['version']}"
        )
        sql = build_update_sql(data, media_ids, args.survey_id, wenai.iso(), owner_id=0)
        wenai.execute_sql(sql, "原地更新预览", apply=False)
        print("\n[dry-run] 未做任何改动。确认无误后加 --apply 执行。")
        return 0

    # 5：--apply —— 本地备份 → D1 原地更新 → 独立 verify
    if not BACKUP_PATH.exists():
        shutil.copy2(CONTENT_PATH, BACKUP_PATH)
        print(f"已备份 → {BACKUP_PATH}")
    srows = wenai.query_d1(
        f"SELECT owner_id, status FROM surveys WHERE id = {args.survey_id} AND deleted_at IS NULL LIMIT 1"
    )
    if not srows:
        raise SystemExit(f"✗ survey {args.survey_id} 不存在（或已删除）")
    sql = build_update_sql(data, media_ids, args.survey_id, wenai.iso(), owner_id=int(srows[0]["owner_id"]))
    wenai.execute_sql(sql, "原地更新", apply=True)

    print("\n—— verify ——")
    passed = verify(data, media_ids, args.survey_id)
    if passed:
        print(f"\n✅ 已原地更新：{wenai.PUBLIC_BASE}/s/{args.survey_id}")
        return 0
    print("\n⚠️ 更新已执行但校验未全过，请按上面的 ✗ 项排查。")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001  顶层收口：报错统一打一行 ✗，退出码非 0
        print(f"✗ {error}", file=sys.stderr)
        sys.exit(1)
