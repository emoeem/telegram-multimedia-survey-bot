#!/usr/bin/env python3
"""Fetch and master the 《晚安，苏晚棠》 BGM set from 魔王魂 (maou.audio).

Why 魔王魂: it publishes an explicit licence (CC BY 4.0 —
https://maou.audio/rule/) that permits use inside games and other content,
personal *and* commercial, with attribution. Each track page also carries
author-assigned mood tags, so the node→track mapping is justified by the
composer's own description rather than a guess.

The script:
  1. downloads each source mp3 (cached, so re-runs are offline),
  2. measures it (duration / loudness / true peak / spectral centroid / onset rate),
  3. masters a seamless loop — the last 4 s are crossfaded into the head so
     `audio.loop = true` has no seam — and normalises to -19 LUFS EBU R128,
  4. writes scripts/galgame/assets/bgm-*.mp3 plus bgm-manifest.json.

Usage:
    python3 scripts/galgame/fetch_bgm.py            # download + master
    python3 scripts/galgame/fetch_bgm.py --verify   # re-measure, no download
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
CACHE = os.path.join(ROOT, ".bgm-cache")
MANIFEST = os.path.join(ROOT, "bgm-manifest.json")

LICENCE = "CC BY 4.0"
LICENCE_URL = "https://maou.audio/rule/"
ARTIST = "森田交一 (Koichi Morita)"
CREDIT = "魔王魂 (maou.audio)"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64)"

# (out_name, 魔王魂 title, page_url, mp3_url, composer mood tags, loop seconds, use)
TRACKS = [
    ("bgm-rain.mp3", "ヒーリング14 雨の音無し版",
     "https://maou.audio/bgm_healing14b/",
     "https://maou.audio/sound/bgm/maou_bgm_healing14b.mp3",
     ["癒し", "ピアノ", "静寂", "夜明け"], 115,
     "序章 · 雨夜频率 —— 午夜电台、雨窗、独处"),
    ("bgm-secret.mp3", "ピアノ19",
     "https://maou.audio/bgm_piano19/",
     "https://maou.audio/sound/bgm/maou_bgm_piano19.mp3",
     ["静か", "勇気", "感動"], 110,
     "第一章 · 交换秘密的游戏 —— 试探着靠近的两个人"),
    ("bgm-distance.mp3", "ピアノ34",
     "https://maou.audio/bgm_piano34/",
     "https://maou.audio/sound/bgm/maou_bgm_piano34.mp3",
     ["郷愁", "寂しい", "穏やか"], 115,
     "距离线 · 隔座的月光 —— 克制、留白、想触碰又收回手"),
    ("bgm-warm.mp3", "アコースティック50",
     "https://maou.audio/bgm_acoustic50/",
     "https://maou.audio/sound/bgm/maou_bgm_acoustic50.mp3",
     ["カフェ", "ピアノ", "のどか", "ランチ"], 115,
     "慢热线 · 台灯与手稿 —— 日常的暖意"),
    ("bgm-deep.mp3", "ヒーリング10",
     "https://maou.audio/bgm_healing10/",
     "https://maou.audio/sound/bgm/maou_bgm_healing10.mp3",
     ["ピアノ", "ハープ", "回想", "夢", "癒し"], 110,
     "深入线 · 凌晨三点的语音条 —— 交心、亲密、回忆"),
    ("bgm-playful.mp3", "アコースティック44",
     "https://maou.audio/bgm_acoustic44/",
     "https://maou.audio/sound/bgm/maou_bgm_acoustic44.mp3",
     ["かわいい", "猫", "犬", "動物", "3拍子"], 96,
     "默契线 · 猫、外卖与碎碎念 —— 轻快俏皮"),
    ("bgm-finale.mp3", "オーケストラ03",
     "https://maou.audio/bgm_orchestra03/",
     "https://maou.audio/sound/bgm/maou_bgm_orchestra03.mp3",
     ["オープニング", "壮大", "感動"], 130,
     "尾声 · 天亮之前 —— 情绪释放与落幕"),
    ("bgm-tension.mp3", "ヒーリング11",
     "https://maou.audio/bgm_healing11/",
     "https://maou.audio/sound/bgm/maou_bgm_healing11.mp3",
     ["暗い", "悲しみ", "挫折", "雨"], 125,
     "关键转折节点（byQuestion 覆盖）—— 冲突与停顿"),
]


def sh(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(path: str) -> dict:
    out = sh(["ffprobe", "-v", "error", "-show_entries",
              "format=duration,bit_rate:stream=sample_rate,channels",
              "-of", "json", path]).stdout
    j = json.loads(out)
    st = j["streams"][0]
    return {
        "duration": round(float(j["format"]["duration"]), 1),
        "kbps": int(j["format"].get("bit_rate", 0)) // 1000,
        "sample_rate": int(st.get("sample_rate") or 0),
        "channels": st.get("channels"),
    }


def loudness(path: str) -> dict:
    """EBU R128 integrated loudness, LRA and true peak (ffmpeg ebur128)."""
    out = sh(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
              "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]).stderr
    tail = out[out.rfind("Integrated loudness"):] if "Integrated loudness" in out else out
    def grab(label: str, text: str):
        m = re.search(rf"{label}:\s*(-?[\d.]+)", text)
        return float(m.group(1)) if m else None
    return {
        "lufs": grab("I", tail),
        "lra": grab("LRA", tail),
        "true_peak_db": grab("Peak", tail[tail.rfind("True peak"):]) if "True peak" in tail else None,
    }


def timbre(path: str, seconds: float = 45.0) -> dict:
    """Spectral centroid (brightness) + onset rate (busyness) from raw PCM.

    Sanity-check that a track's measured character agrees with the composer's
    mood tags: a 'playful' cue should measure brighter and busier than a
    'quiet rain' cue. Pure numpy, no extra dependency.
    """
    import numpy as np

    # binary stdout: must NOT go through sh(), which decodes as text
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-t", str(seconds), "-i", path,
         "-ac", "1", "-ar", "22050", "-f", "s16le", "-"],
        capture_output=True).stdout
    if not raw:
        return {}
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if x.size < 8192:
        return {}
    sr, win, hop = 22050, 2048, 1024
    n = 1 + (x.size - win) // hop
    window = np.hanning(win)
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    cents, rms = [], []
    for k in range(0, n, 4):
        seg = x[k * hop: k * hop + win] * window
        spec = np.abs(np.fft.rfft(seg))
        total = spec.sum()
        if total > 1e-9:
            cents.append(float((spec * freqs).sum() / total))
        rms.append(float(np.sqrt((seg ** 2).mean())))
    rms = np.array(rms)
    rate = 0.0
    if rms.size > 4:
        d = np.diff(np.log(rms + 1e-4))
        rate = float((d > 0.6).mean()) * (sr / hop) / 4.0
    return {
        "centroid_hz": round(float(np.mean(cents)), 1) if cents else None,
        "onset_per_s": round(rate, 2),
        "mean_rms_db": round(float(20 * np.log10(rms.mean() + 1e-9)), 1) if rms.size else None,
    }


def master(src: str, dst: str, loop_seconds: float) -> None:
    """Seamless loop (tail→head crossfade) + EBU R128 normalisation to -19 LUFS."""
    dur = probe(src)["duration"]
    xf = 4.0
    if dur > loop_seconds + xf:
        fc = (f"[0:a]atrim=0:{loop_seconds},asetpts=PTS-STARTPTS[main];"
              f"[0:a]atrim={loop_seconds - xf}:{loop_seconds},asetpts=PTS-STARTPTS[tail];"
              f"[tail][main]acrossfade=d={xf}:c1=tri:c2=tri[loop];"
              f"[loop]loudnorm=I=-19:TP=-1.5:LRA=11[out]")
    else:
        fc = "[0:a]loudnorm=I=-19:TP=-1.5:LRA=11[out]"
    r = sh(["ffmpeg", "-y", "-v", "error", "-i", src, "-filter_complex", fc,
            "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "96k", "-ar", "44100",
            "-ac", "2", dst])
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {dst}: {r.stderr[:400]}")


def download(url: str, dst: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except Exception as e:
        print(f"  !! download failed {url}: {e}", file=sys.stderr)
        return False
    if len(data) < 10000:
        print(f"  !! suspiciously small ({len(data)} B): {url}", file=sys.stderr)
        return False
    open(dst, "wb").write(data)
    return True


def main() -> int:
    verify_only = "--verify" in sys.argv
    os.makedirs(ASSETS, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    manifest = []

    for name, title, page, mp3, tags, loop_s, use in TRACKS:
        cached = os.path.join(CACHE, os.path.basename(mp3))
        if not verify_only and not os.path.exists(cached):
            if not download(mp3, cached):
                continue
        dst = os.path.join(ASSETS, name)
        if not verify_only:
            if not os.path.exists(cached):
                print(f"  !! no source for {title}", file=sys.stderr)
                continue
            master(cached, dst, loop_s)

        entry = {
            "file": name,
            "source_title": title,
            "source_page": page,
            "source_mp3": mp3,
            "artist": ARTIST,
            "credit": CREDIT,
            "licence": LICENCE,
            "licence_url": LICENCE_URL,
            "composer_tags": tags,
            "used_for": use,
            "source_meta": probe(cached) if os.path.exists(cached) else None,
            "mastered": probe(dst) if os.path.exists(dst) else None,
            "loudness": loudness(dst) if os.path.exists(dst) else None,
            "timbre": timbre(dst) if os.path.exists(dst) else None,
        }
        manifest.append(entry)
        m, lo, ti = entry["mastered"] or {}, entry["loudness"] or {}, entry["timbre"] or {}
        print(f"  {name:19s} {title[:12]:12s} {m.get('duration', 0):6.1f}s "
              f"{lo.get('lufs')} LUFS tp={lo.get('true_peak_db')} "
              f"centroid={ti.get('centroid_hz')}Hz onsets={ti.get('onset_per_s')}/s")

    json.dump({"licence": LICENCE, "licence_url": LICENCE_URL, "artist": ARTIST,
               "credit": CREDIT, "tracks": manifest},
              open(MANIFEST, "w"), ensure_ascii=False, indent=1)
    print(f"\nwrote {os.path.relpath(MANIFEST, os.getcwd())} ({len(manifest)} tracks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
