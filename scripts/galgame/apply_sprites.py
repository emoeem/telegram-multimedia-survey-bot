#!/usr/bin/env python3
"""把「苏晚棠」立绘写进问卷数据：`survey.settings.theme.sprite`。

数据形状与 `theme.audio` 同构（页级默认 + 节点级覆盖），解析在
`src/survey/theme.ts` 的 `resolveSprite()`，渲染在
`admin/src/survey/SpriteLayer.tsx`。写完后由
`scripts/galgame/update_galgame_survey.py --apply` 上传 KV 并原地更新 D1。

用法：
    python3 scripts/galgame/apply_sprites.py            # 演练（只打印差异）
    python3 scripts/galgame/apply_sprites.py --apply    # 写回 galgame-survey.json
    python3 scripts/galgame/apply_sprites.py --verify   # 只校验现有数据自洽
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIR / "galgame-survey.json"
BACKUP_PATH = SCRIPT_DIR / "galgame-survey.presprite.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
CHARACTER = "苏晚棠"

# 11 张表情由 scripts/galgame/build_sprites.py 从 CC-BY 4.0 的 Codel 套图导出，
# 表情名的中文含义见 sprite-manifest.json 的 label_note。
EXPRESSIONS = [
    "neutral",
    "smile",
    "soft",
    "shy",
    "blush",
    "fluster",
    "sad",
    "cry",
    "annoyed",
    "think",
    "pout",
]

# 页级默认表情（键 = 页码，0 起）。一页只给一个基调，避免来回闪。
BY_PAGE = {
    "0": "neutral",  # 序章 · 雨夜频率：还没见面，平静
    "1": "think",  # 第一章 · 交换秘密的游戏：立规矩、交换筹码
    "2": "soft",  # 距离线 · 隔座的月光：只交换文字，柔软
    "3": "neutral",  # 慢热线 · 台灯与手稿：当面校对，工作状态
    "4": "neutral",  # 深入线 · 语音条：拉锯与试探
    "5": "smile",  # 默契线 · 猫与外卖：日常、笑
    "6": "soft",  # 尾声 · 天亮之前：收束
}

# 节点级覆盖（键 = 题目 order）。只写**偏离页默认**的情绪转折点：
# 立绘换得太勤会变成闪烁，所以这里只标「这一夜真正改变了什么」的那些节点。
BY_QUESTION = {
    "3": "soft",  # 三年十一封信、读信不回信
    "4": "smile",  # 02:14 她先开口
    "6": "sad",  # 她说出被剪声音的那三年
    "10": "think",  # 「为什么在那个时间」
    "12": "smile",  # 「今晚的雨，是哪个声部？」
    "13": "blush",  # 「我想看着你把这条读完」
    "14": "shy",  # 「让我再靠近一点点？」
    "15": "shy",  # 交换呼吸的节奏
    "17": "sad",  # 02:14 不再亮
    "18": "cry",  # 「他在楼下站过两晚」
    "19": "shy",  # 「只回 0417」
    "22": "smile",  # 她抱着手稿站在门口
    "23": "think",  # 校对时的咬笔帽
    "25": "shy",  # 第三十六页之后的沉默
    "26": "shy",  # 「不在合同范围内。可以吗？」
    "27": "fluster",  # 批注落在下颌线与耳后
    "28": "shy",  # 关灯前的最后一步
    "29": "sad",  # 编务会上的窃语
    "31": "smile",  # 「铺垫完成。——校对：晚棠」
    "32": "soft",
    "34": "think",  # 「你想听哪一种声音？」
    "35": "smile",  # 「是心跳太吵吧」
    "36": "shy",  # 「写一句你今晚不敢寄的话」
    "38": "shy",  # 「继续吗？你随时可以说停。」
    "39": "fluster",  # 「关灯。把手放在屏幕上。」
    "40": "soft",  # 对面楼的一格窗子先亮了
    "41": "sad",  # 嗓音不适，代班主播
    "42": "cry",  # 「对不起」
    "43": "soft",  # 新书出版，那句评语
    "44": "soft",
    "48": "shy",  # 「你听的是哪一个我？」
    "49": "blush",  # 替你摘掉肩上那根猫毛
    "50": "shy",  # 「再留一会儿？这顿算稿费。」
    "52": "shy",  # 楼道里的告别
    "53": "sad",  # 下午四点的那通电话
    "54": "sad",  # 分社没有直播间
    "55": "soft",  # 「特别校对：句号」
    "56": "soft",
}


def build_sprite() -> dict:
    return {
        "name": CHARACTER,
        "default": "neutral",
        "expressions": {name: f"kv://sprite-{name}.webp" for name in EXPRESSIONS},
        "byPage": dict(BY_PAGE),
        "byQuestion": dict(BY_QUESTION),
    }


def validate(data: dict, sprite: dict) -> list[str]:
    problems: list[str] = []
    orders = {str(question["order"]) for question in data["survey"]["questions"]}
    pages = {str(index) for index in range(len(data["survey"]["pages"]))}
    names = set(sprite["expressions"])
    for name in names:
        path = ASSETS_DIR / f"sprite-{name}.webp"
        if not path.is_file():
            problems.append(f"缺少素材文件 {path.name}")
    for key, value in sprite["byPage"].items():
        if key not in pages:
            problems.append(f"byPage 的键 {key} 不是有效页码")
        if value not in names:
            problems.append(f"byPage[{key}] = {value} 不是已知表情")
    for key, value in sprite["byQuestion"].items():
        if key not in orders:
            problems.append(f"byQuestion 的键 {key} 不是有效题目 order")
        if value not in names:
            problems.append(f"byQuestion[{key}] = {value} 不是已知表情")
    return problems


def verify() -> int:
    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    sprite = (data["survey"].get("settings", {}).get("theme", {}) or {}).get("sprite")
    if not sprite:
        print("问卷数据里没有 theme.sprite")
        return 1
    problems = validate(data, sprite)
    answered = len(sprite["byQuestion"])
    covered = set(sprite["byPage"]) | set(sprite["byQuestion"])
    print(f"表情 {len(sprite['expressions'])} 个 · 页级 {len(sprite['byPage'])} 条 · 节点级 {answered} 条")
    print(f"覆盖：{len(sprite['byPage'])} 页 + {answered} 个节点（总 58 节点）")
    for problem in problems:
        print("FAIL", problem)
    print("PASS" if not problems else f"{len(problems)} 个问题")
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        return verify()

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    sprite = build_sprite()
    problems = validate(data, sprite)
    if problems:
        for problem in problems:
            print("FAIL", problem)
        return 1

    before = (data["survey"].setdefault("settings", {}).setdefault("theme", {})).get("sprite")
    # 幂等：内容一致就什么都不做（避免无意义地递增 version）。
    if before == sprite:
        print("theme.sprite 已是最新，无需改动")
        return 0

    print(f"角色：{sprite['name']}｜表情 {len(sprite['expressions'])} 个")
    print(f"页级默认：{sprite['byPage']}")
    print(f"节点级覆盖：{len(sprite['byQuestion'])} 条")
    if not args.apply:
        print("（演练）加 --apply 写回 galgame-survey.json")
        return 0

    if not BACKUP_PATH.exists():
        shutil.copy2(CONTENT_PATH, BACKUP_PATH)
        print(f"备份 → {BACKUP_PATH.name}")
    data["survey"]["settings"]["theme"]["sprite"] = sprite
    CONTENT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"写入 {CONTENT_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
