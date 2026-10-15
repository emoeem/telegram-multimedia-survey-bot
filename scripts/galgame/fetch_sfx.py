#!/usr/bin/env python3
"""界面音效（SFX）获取与母带处理 —— 《晚安，苏晚棠》互动视觉小说。

来源：魔王魂（maou.audio），与 BGM 同一许可（CC BY 4.0 / 等效自订条款，
个人·商用均可，著作表记必要，禁止单件再配布）。见 https://maou.audio/rule/

为什么是这几首：魔王魂的每首音效都由作者自己写了用途标签（決定音 / キャンセル音 /
紙をめくる音 / スイッチ音），所以「哪首用在哪个交互」有作者原话可依，不是看文件名猜。
候选池（.se-raw/，65 首 system + onepoint + 素材）先做过 ffmpeg 频谱图与客观测量，
逐条对照标签与频谱形态后才定下这 5 条。

母带策略：所有成品统一归一到真峰值 -3.0 dBTP，**相对音量不写进素材**，
由前端 sfx.ts 里按 bus/gain 的 dB 表决定（audio-design：混音在总线，不在单件）。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / ".se-raw"
CACHE_DIR = HERE / ".se-cache"
ASSETS_DIR = HERE / "assets"
MANIFEST = HERE / "sfx-manifest.json"

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)

LICENCE = "CC BY 4.0"
LICENCE_URL = "https://maou.audio/rule/"
ARTIST = "森田交一 (Koichi Morita)"
CREDIT = "魔王魂 (maou.audio)"

# 目标真峰值：全部一致，保证「谁更响」只由前端 dB 表决定。
TARGET_TP_DB = -3.0

# out_name, cue, 源标题, 作者原话用途, page_url, mp3_url, 裁剪起点秒, 淡出秒, 前端基准 dB
TRACKS = [
    dict(
        out="sfx-select.mp3",
        cue="select",
        source_title="システム26",
        source_note="決定音。（0.131s，全池最短的「決定音」，频谱是一条明亮短促的宽带脉冲）",
        page="https://maou.audio/se_system26/",
        mp3="https://maou.audio/sound/se/maou_se_system26.mp3",
        trim_start=0.015,
        fade_out=0.02,
        used_for="选项被按下的轻点反馈（不抢戏，所以取全池最短的一条）",
    ),
    dict(
        out="sfx-confirm.mp3",
        cue="confirm",
        source_title="システム44",
        source_note="決定音。（0.444s，瞬态锐利、衰减干净，频谱呈单次宽带爆发）",
        page="https://maou.audio/se_system44/",
        mp3="https://maou.audio/sound/se/maou_se_system44.mp3",
        trim_start=0.015,
        fade_out=0.03,
        used_for="提交问卷 / 确认退出 / 结局确认——不可逆动作的确认音",
    ),
    dict(
        out="sfx-cancel.mp3",
        cue="cancel",
        source_title="システム18",
        source_note="キャンセル音。（0.287s，作者明确标注为取消音，衰减极快）",
        page="https://maou.audio/se_system18/",
        mp3="https://maou.audio/sound/se/maou_se_system18.mp3",
        trim_start=0.015,
        fade_out=0.03,
        used_for="返回上一题 / 取消退出 / 关闭弹窗",
    ),
    dict(
        out="sfx-page.mp3",
        cue="page",
        source_title="紙01",
        source_note="紙をめくる音。（1.176s，频谱为两段宽带噪声，即两下翻纸）",
        page="https://maou.audio/se_sound_paper01/",
        mp3="https://maou.audio/sound/se/maou_se_sound_paper01.mp3",
        trim_start=0.06,
        fade_out=0.05,
        used_for="推进到下一段剧情 / 下一页",
    ),
    dict(
        out="sfx-transition.mp3",
        cue="transition",
        source_title="スイッチ01",
        source_note="スイッチ音。（0.549s，全池最轻的一条：RMS −26.8dB，切换类语义）",
        page="https://maou.audio/se_sound_switch01/",
        mp3="https://maou.audio/sound/se/maou_se_sound_switch01.mp3",
        trim_start=0.03,
        fade_out=0.05,
        used_for="页/场景切换（含进入结局）——最轻，避免每次换页都「啪」一下",
    ),
]


def sh(cmd: list[str], text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=text)


def download(spec: dict) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dst = CACHE_DIR / f"{spec['source_title']}.mp3"
    if dst.is_file() and dst.stat().st_size > 500:
        return dst
    result = sh([
        "curl", "-sS", "-A", UA, "-e", spec["page"], "-o", str(dst), spec["mp3"],
    ])
    if not dst.is_file() or dst.stat().st_size <= 500:
        raise RuntimeError(f"下载失败 {spec['mp3']}: {result.stderr[:200]}")
    return dst


def probe(path: Path) -> dict:
    out = sh([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels",
        "-show_entries", "format=duration,bit_rate", "-of", "json", str(path),
    ]).stdout
    data = json.loads(out or "{}")
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    return {
        "duration": round(float(fmt.get("duration") or 0), 3),
        "kbps": round(int(fmt.get("bit_rate") or 0) / 1000),
        "sample_rate": int(stream.get("sample_rate") or 44100),
        "channels": int(stream.get("channels") or 2),
    }


def true_peak_db(path: Path) -> float:
    """ebur128=peak=true 的 True peak（比 sample peak 更保守，能抓住编码间插值）。"""
    out = sh([
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-",
    ]).stderr
    peaks = re.findall(r"Peak:\s*(-?\d+\.?\d*)", out)
    return float(peaks[-1]) if peaks else 0.0


def loudness(path: Path) -> dict:
    out = sh([
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "ebur128=peak=true", "-f", "null", "-",
    ]).stderr
    summary = out.split("Summary:")[-1]
    def grab(label: str) -> float:
        match = re.search(rf"{label}:\s*(-?\d+\.?\d*)", summary)
        return float(match.group(1)) if match else 0.0
    return {
        "lufs": grab("I"),
        "lra": grab("LRA"),
        "true_peak_db": grab("Peak"),
    }


def master(src: Path, spec: dict) -> dict:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    dst = ASSETS_DIR / spec["out"]
    sample = probe(src)
    peak = true_peak_db(src)
    gain = TARGET_TP_DB - peak
    filters = [
        f"atrim=start={spec['trim_start']}",
        "asetpts=PTS-STARTPTS",
        "afade=t=in:st=0:d=0.004",
        f"volume={gain:.2f}dB",
        "areverse",
        f"afade=t=in:st=0:d={spec['fade_out']}",
        "areverse",
    ]
    result = sh([
        "ffmpeg", "-v", "error", "-y", "-i", str(src),
        "-af", ",".join(filters),
        "-c:a", "libmp3lame", "-b:a", "96k",
        "-ar", str(sample["sample_rate"]), "-ac", str(sample["channels"]),
        str(dst),
    ])
    if result.returncode != 0 or not dst.is_file():
        raise RuntimeError(f"母带失败 {spec['out']}: {result.stderr[:300]}")
    return {
        "source_meta": sample,
        "gain_applied_db": round(gain, 2),
        "mastered": {**probe(dst), "bytes": dst.stat().st_size},
        "loudness": loudness(dst),
    }


def main() -> int:
    verify_only = "--verify" in sys.argv
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("需要 ffmpeg")
    manifest = {
        "licence": LICENCE,
        "licence_url": LICENCE_URL,
        "artist": ARTIST,
        "credit": CREDIT,
        "source_site": "https://maou.audio/category/se/",
        "mastering": {"target_true_peak_db": TARGET_TP_DB, "codec": "libmp3lame -b:a 96k"},
        "tracks": [],
    }
    failures: list[str] = []
    for spec in TRACKS:
        entry = {k: spec[k] for k in ("out", "cue", "source_title", "source_note", "page", "mp3", "used_for")}
        entry.update({"artist": ARTIST, "credit": CREDIT, "licence": LICENCE, "licence_url": LICENCE_URL})
        dst = ASSETS_DIR / spec["out"]
        if verify_only:
            if not dst.is_file():
                failures.append(f"{spec['out']} 不存在")
                continue
            entry["mastered"] = {**probe(dst), "bytes": dst.stat().st_size}
            entry["loudness"] = loudness(dst)
        else:
            entry.update(master(download(spec), spec))
        manifest["tracks"].append(entry)
        print(
            f"✓ {spec['out']:20s} {spec['source_title']:12s} "
            f"{entry['mastered']['duration']:5.3f}s "
            f"{entry['mastered']['bytes'] // 1024:3d}KB "
            f"TP {entry['loudness']['true_peak_db']:5.1f}dB "
            f"LUFS {entry['loudness']['lufs']:6.1f}"
        )
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n清单 → {MANIFEST}")
    for failure in failures:
        print(f"FAIL {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
