#!/usr/bin/env python3
"""把 `render_scenes.py` 的分镜插画接进 `galgame-survey.json`。

做三件事，全部以**磁盘上的真实 JPEG** 为准（不信任早先手写的宽高）：

  1. 给每一题的 `media[]` 补上 `alt`（取自 `scene-alt.json`）与真实 `width/height`
  2. 给 5 个"关键选择"节点新增配图（四道门 + 四条线的同意关卡）
  3. 校验：每个 `scene-alt.json` 的条目都真的被引用；每个 media.url 都对应存在的文件

`--apply` 前会先备份成 `galgame-survey.prescenes.json`，幂等（重复跑结果相同）。

Usage:
    python3 scripts/galgame/apply_scenes.py            # dry-run
    python3 scripts/galgame/apply_scenes.py --apply
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIR / "galgame-survey.json"
BACKUP_PATH = SCRIPT_DIR / "galgame-survey.prescenes.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
ALT_PATH = SCRIPT_DIR / "scene-alt.json"

COVER_FILE = "cover.jpg"

# order -> (media slug id, 文件名, 依据)
NEW_MEDIA: dict[int, tuple[str, str, str]] = {
    8: ("m-gate", "gate-four.jpg", "四选一的开场门：四道门框分别透出四条线的主色"),
    14: ("m-d6", "d6-consent.jpg", "距离线同意关卡：半掩的门透出暖光"),
    26: ("m-a6", "a6-consent.jpg", "慢热线同意关卡：台灯调暗、手稿合起"),
    38: ("m-b6", "b6-consent.jpg", "深入线同意关卡：窗帘与放下的耳机"),
    50: ("m-c6", "c6-consent.jpg", "默契线同意关卡：毯子上蜷睡的猫"),
}


def real_size(filename: str) -> tuple[int, int]:
    with Image.open(ASSETS_DIR / filename) as im:
        return im.width, im.height


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="写回 galgame-survey.json")
    args = parser.parse_args()

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    survey = data["survey"]
    alt: dict[str, str] = json.loads(ALT_PATH.read_text(encoding="utf-8"))
    questions = survey["questions"]
    by_order = {int(q["order"]): q for q in questions}

    used: set[str] = set()
    added: list[str] = []

    # 1 + 3：已有配图 → 补 alt 与真实宽高
    for question in questions:
        for media in question.get("media") or []:
            url = media.get("url") or ""
            if not url.startswith("kv://"):
                continue
            filename = url.removeprefix("kv://")
            if filename not in alt:
                raise SystemExit(f"✗ order {question['order']} 引用的 {filename} 没有 alt 文本")
            if not (ASSETS_DIR / filename).is_file():
                raise SystemExit(f"✗ order {question['order']} 引用的 {filename} 文件不存在")
            media["alt"] = alt[filename]
            media["width"], media["height"] = real_size(filename)
            used.add(filename)

    # 2：新增"关键选择"配图
    for order, (slug, filename, why) in sorted(NEW_MEDIA.items()):
        question = by_order.get(order)
        if question is None:
            raise SystemExit(f"✗ 新配图指定的 order {order} 不存在")
        media = question.setdefault("media", [])
        if any((m.get("url") or "").endswith("/" + filename) for m in media):
            used.add(filename)
            continue
        width, height = real_size(filename)
        media.append({
            "id": slug,
            "type": "photo",
            "source": "kv",
            "url": f"kv://{filename}",
            "width": width,
            "height": height,
            "alt": alt[filename],
        })
        used.add(filename)
        added.append(f"order {order} += {filename}（{why}）")

    # 封面：同一个文件也要有 alt 与真实尺寸
    survey["cover"]["alt"] = alt[COVER_FILE]
    survey["cover"]["width"], survey["cover"]["height"] = real_size(COVER_FILE)
    used.add(COVER_FILE)

    unused = sorted(set(alt) - used)
    if unused:
        raise SystemExit(f"✗ 这些插画渲染了却没有被任何节点引用: {unused}")

    print(f"插画引用：{len(used)}/{len(alt)} 张全部被引用")
    for line in added:
        print(f"  新增 {line}")
    print(f"  各题配图数：{[len(q.get('media') or []) for q in questions].count(1)} 题 1 张，"
          f"共 {sum(len(q.get('media') or []) for q in questions)} 条 media")
    print(f"  alt 覆盖：{sum(1 for q in questions for m in (q.get('media') or []) if m.get('alt'))} 条有 alt")

    if not args.apply:
        print("\n（dry-run，未写入。加 --apply 写回）")
        return 0

    if not BACKUP_PATH.exists():
        shutil.copy2(CONTENT_PATH, BACKUP_PATH)
        print(f"已备份 → {BACKUP_PATH.name}")
    CONTENT_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"已写入 {CONTENT_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
