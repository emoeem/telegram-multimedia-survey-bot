#!/usr/bin/env python3
"""把界面音效写进问卷数据：`survey.settings.theme.audio.sfx`。

cue 名必须与 `src/survey/theme.ts` 的 `SURVEY_SFX_CUES` 完全一致——本脚本会读那个
文件做交叉核对，避免两边各改各的。素材由 `scripts/galgame/fetch_sfx.py` 从
魔王魂（CC BY 4.0 / 等效自订条款，商用可、著作表记必要）取得。

用法：
    python3 scripts/galgame/apply_sfx.py            # 演练
    python3 scripts/galgame/apply_sfx.py --apply    # 写回 galgame-survey.json
    python3 scripts/galgame/apply_sfx.py --verify
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_PATH = SCRIPT_DIR / "galgame-survey.json"
BACKUP_PATH = SCRIPT_DIR / "galgame-survey.presfx.json"
ASSETS_DIR = SCRIPT_DIR / "assets"
THEME_TS = SCRIPT_DIR.parent.parent / "src" / "survey" / "theme.ts"

# cue → 素材文件（魔王魂曲目与用途依据见 fetch_sfx.py 的 TRACKS 表 / sfx-manifest.json）
SFX = {
    "select": "kv://sfx-select.mp3",  # 点选选项：最短的決定音，只做轻 tick
    "confirm": "kv://sfx-confirm.mp3",  # 确认 / 提交完成：干净的決定音
    "cancel": "kv://sfx-cancel.mp3",  # 返回 / 取消：キャンセル音
    "page": "kv://sfx-page.mp3",  # 同页内下一题：紙をめくる音
    "transition": "kv://sfx-transition.mp3",  # 跨页 / 到结尾：スイッチ音
}


def theme_cue_names() -> list[str]:
    source = THEME_TS.read_text(encoding="utf-8")
    match = re.search(r"SURVEY_SFX_CUES\s*=\s*\[(.*?)\]\s*as const", source, re.S)
    if not match:
        raise SystemExit(f"✗ 在 {THEME_TS} 里找不到 SURVEY_SFX_CUES")
    return re.findall(r'"([a-z]+)"', match.group(1))


def validate() -> list[str]:
    problems: list[str] = []
    declared = theme_cue_names()
    if sorted(declared) != sorted(SFX):
        problems.append(f"cue 名不一致：theme.ts {declared} vs 本脚本 {sorted(SFX)}")
    for cue, url in SFX.items():
        path = ASSETS_DIR / url.removeprefix("kv://")
        if not path.is_file():
            problems.append(f"cue {cue} 缺素材 {path.name}")
        elif path.stat().st_size < 1000:
            problems.append(f"cue {cue} 的 {path.name} 只有 {path.stat().st_size} 字节，疑似损坏")
    return problems


def verify() -> int:
    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    stored = (data["survey"].get("settings", {}).get("theme", {}) or {}).get("audio", {}).get("sfx")
    problems = validate()
    if stored != SFX:
        problems.append(f"问卷数据里的 audio.sfx 与期望不一致：{stored}")
    print(f"cue {len(SFX)} 条：{'、'.join(sorted(SFX))}")
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

    problems = validate()
    if problems:
        for problem in problems:
            print("FAIL", problem)
        return 1

    data = json.loads(CONTENT_PATH.read_text(encoding="utf-8"))
    audio = data["survey"].setdefault("settings", {}).setdefault("theme", {}).setdefault("audio", {})
    if audio.get("sfx") == SFX:
        print("audio.sfx 已是最新，无需改动")
        return 0
    for cue, url in SFX.items():
        print(f"  {cue:11s} → {url}")
    if not args.apply:
        print("（演练）加 --apply 写回 galgame-survey.json")
        return 0
    if not BACKUP_PATH.exists():
        shutil.copy2(CONTENT_PATH, BACKUP_PATH)
        print(f"备份 → {BACKUP_PATH.name}")
    audio["sfx"] = dict(SFX)
    CONTENT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"写入 {CONTENT_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
