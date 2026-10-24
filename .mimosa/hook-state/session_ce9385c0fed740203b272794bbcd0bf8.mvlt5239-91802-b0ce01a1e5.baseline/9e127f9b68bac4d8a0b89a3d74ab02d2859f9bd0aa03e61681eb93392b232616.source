#!/usr/bin/env python3
"""把 BGM 映射写进 galgame-survey.json 的 settings.theme.audio。

两层，后者优先级更高（前端 `bgmUrl` 先查 byQuestion 再查 byPage）：
  * byPage      —— 页级底色，键 = pages 数组下标（0 起）
  * byQuestion  —— 节点级提示，键 = 题目 `order`（1 起），用于关键转折与结局

曲目来自 魔王魂 (maou.audio)，CC BY 4.0 等效条款，需著作表记。
每个 cue 的依据是作曲者自打的情绪 tag + 我们实测的谱心/起始率（见 bgm-manifest.json），
不是凭曲名猜的。用法：
    python3 scripts/galgame/apply_audio.py            # dry-run，打印 diff
    python3 scripts/galgame/apply_audio.py --apply    # 写回 JSON
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SURVEY_JSON = ROOT / "galgame-survey.json"
ASSETS_DIR = ROOT / "assets"
MANIFEST = ROOT / "bgm-manifest.json"

# 页级底色：页下标 → (文件, 该页在故事里是什么情绪)
BY_PAGE = {
    "0": ("bgm-rain.mp3", "序章·雨夜频率 —— 雨、静、独处"),
    "1": ("bgm-rain.mp3", "第一章 —— 仍在同一个雨夜，不加新情绪"),
    "2": ("bgm-distance.mp3", "D 线·隔着一座城 —— 郷愁/寂しい/穏やか"),
    "3": ("bgm-warm.mp3", "A 线·台灯与手稿 —— カフェ/のどか，室内暖光"),
    "4": ("bgm-deep.mp3", "B 线·凌晨三点的语音条 —— 回想/夢，夜里低语"),
    "5": ("bgm-playful.mp3", "C 线·猫、外卖与碎碎念 —— かわいい/3 拍子，轻快"),
    "6": ("bgm-finale.mp3", "尾声·天亮之前 —— オープニング/壮大，收束"),
}

# 节点级提示：order → (文件, 依据)
BY_QUESTION = {
    # 开场的选择本身就该被听见：静か/勇気/感動，中频 972Hz，比雨夜亮一档
    "8": ("bgm-secret.mp3", "q-gate 四选一：第一次主动选择"),
    # 同意关卡——她给出一条可以停下的线，情绪是「鼓起勇气」而非暧昧升温
    "26": ("bgm-secret.mp3", "q-a6 同意关卡"),
    "38": ("bgm-secret.mp3", "q-b6 同意关卡"),
    # 亲密场景：ピアノ/ハープ/回想/夢，起始率最低(0.22/s)，最沉浸。
    # 27 (A 线) 落在第 3 页，页级是 warm 暖光，需要覆盖；
    # 39 (B 线) 落在第 4 页，页级本来就是 deep，不写冗余项。
    "27": ("bgm-deep.mp3", "n-a7 亲密场景"),
    # 失联与追问：暗い/悲しみ/挫折/雨，谱心最高(1744Hz)，是四条线共用的下坠
    "17": ("bgm-tension.mp3", "n-d9 失联"),
    "18": ("bgm-tension.mp3", "q-d10 追问"),
    "29": ("bgm-tension.mp3", "n-a9 失联"),
    "30": ("bgm-tension.mp3", "q-a10 追问"),
    "41": ("bgm-tension.mp3", "n-b9 失联"),
    "42": ("bgm-tension.mp3", "q-b10 追问"),
    "53": ("bgm-tension.mp3", "n-cg9 失联"),
    "54": ("bgm-tension.mp3", "q-cg10 追问"),
    # 四个结局各自收束——都在各自线族的页上，页级底色会给错情绪，必须节点级覆盖
    "19": ("bgm-finale.mp3", "n-d11 结局·隔座的月光"),
    "31": ("bgm-finale.mp3", "n-a11 结局·批注版"),
    "43": ("bgm-finale.mp3", "n-b11 结局·六十秒"),
    "55": ("bgm-finale.mp3", "n-cg11 结局·爪印"),
}


def die(msg: str) -> None:
    print(f"错误: {msg}", file=sys.stderr)
    raise SystemExit(1)


def check_files(names: set[str]) -> None:
    planned = set(MANIFEST_MAP)
    for name in sorted(names):
        if name not in planned:
            die(f"{name} 不在 bgm-manifest.json 里（未规划的曲目）")
        if not (ASSETS_DIR / name).is_file():
            die(f"缺少素材文件 {ASSETS_DIR / name}")


MANIFEST_MAP: dict[str, tuple[str, str]] = {}


def load_manifest() -> None:
    if not MANIFEST.is_file():
        die(f"缺少 {MANIFEST}，先跑 fetch_bgm.py")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    tracks = data["tracks"] if isinstance(data, dict) and "tracks" in data else data
    for entry in tracks:
        name = entry.get("file") or entry.get("out")
        if name:
            MANIFEST_MAP[name] = (entry.get("source_title", ""), entry.get("source_page", ""))


def main() -> None:
    apply = "--apply" in sys.argv
    load_manifest()

    by_page = {k: f"kv://{v}" for k, (v, _) in BY_PAGE.items()}
    by_question = {k: f"kv://{v}" for k, (v, _) in BY_QUESTION.items()}
    check_files({v for v, _ in BY_PAGE.values()} | {v for v, _ in BY_QUESTION.values()})

    data = json.loads(SURVEY_JSON.read_text(encoding="utf-8"))
    theme = data["survey"]["settings"]["theme"]
    before = json.dumps(theme.get("audio"), ensure_ascii=False, sort_keys=True)

    audio = theme.setdefault("audio", {})
    audio["url"] = "kv://bgm-rain.mp3"
    audio["byPage"] = by_page
    audio["byQuestion"] = by_question
    after = json.dumps(audio, ensure_ascii=False, sort_keys=True)

    print(f"byPage     : {len(by_page)} 项")
    for key, (name, why) in BY_PAGE.items():
        print(f"  [{key}] {name:20s} {why}")
    print(f"byQuestion : {len(by_question)} 项")
    for key, (name, why) in sorted(BY_QUESTION.items(), key=lambda kv: int(kv[0])):
        print(f"  [{key:>2}] {name:20s} {why}")

    if before == after:
        print("\n无需改动：JSON 里的 audio 已是目标映射。")
        return
    if not apply:
        print(f"\n[dry-run] audio 需要更新（{len(before)} → {len(after)} 字符）。加 --apply 写回。")
        return

    backup = ROOT / "galgame-survey.preaudio.json"
    if not backup.exists():
        backup.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"已备份原始 JSON → {backup.name}")
    SURVEY_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写回 {SURVEY_JSON.relative_to(ROOT.parent.parent)}")


if __name__ == "__main__":
    main()
