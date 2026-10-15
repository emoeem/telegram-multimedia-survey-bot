#!/usr/bin/env python3
"""Generate visual + audio assets for the 晚安，苏晚棠 galgame survey.

Outputs into scripts/galgame/assets/:
  cover.jpg + 11 scene JPEGs (abstract, no figures)
  bgm-{rain,distance,warm,deep,playful,dawn}.mp3 — seamless loops, one per page

All partials/LFOs are loop-quantized (integer cycles per loop) so every track
seams without a click; the rain layer is looped via overlap-add.
Deterministic: fixed seed.
"""

from __future__ import annotations

import math
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wenai"))
from build_assets import (  # noqa: E402
    add_bokeh,
    add_glow,
    add_silk,
    add_stars,
    finish,
    grain,
    page,
    scene,
    silk_curve,
    vignette,
    vertical_gradient,
)

ASSETS = Path(__file__).resolve().parent / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)
RNG = np.random.default_rng(20261011)


# -------------------------------------------------------------------- images

def build_images() -> None:
    # cover: 雨夜城市频率（全局背景）
    page(
        ASSETS / "cover.jpg",
        [(0.0, (10, 14, 26)), (0.45, (30, 38, 62)), (1.0, (8, 10, 20))],
        [(0.72, 0.22, 0.10, (196, 214, 255), 0.55), (0.2, 0.8, 0.24, (52, 70, 120), 0.40)],
        [(silk_curve(60, 0.62, 0.10), 46, (110, 140, 210), 0.30, 30),
         (silk_curve(60, 0.80, 0.07), 30, (80, 105, 170), 0.26, 26),
         (silk_curve(60, 0.44, 0.05), 20, (170, 195, 245), 0.16, 20)],
        stars=110,
    )
    # p1: 电台直播间（暖橙 ON AIR）
    page(
        ASSETS / "p1-radio.jpg",
        [(0.0, (26, 14, 6)), (0.5, (66, 38, 14)), (1.0, (16, 9, 4))],
        [(0.5, 0.3, 0.2, (255, 176, 92), 0.42), (0.82, 0.18, 0.07, (255, 120, 70), 0.30)],
        [(silk_curve(60, 0.55, 0.08), 40, (230, 150, 80), 0.24, 28),
         (silk_curve(2, 0.30, 0.0), 4, (255, 200, 140), 0.35, 2),
         (silk_curve(2, 0.34, 0.0), 4, (255, 200, 140), 0.30, 2)],
    )
    # p2: 深夜手机屏幕光（蓝调）
    page(
        ASSETS / "p2-phone.jpg",
        [(0.0, (7, 10, 22)), (0.55, (16, 24, 46)), (1.0, (5, 7, 16))],
        [(0.62, 0.62, 0.16, (150, 180, 235), 0.50)],
        [(silk_curve(60, 0.78, 0.06), 40, (90, 120, 190), 0.22, 30)],
        stars=40,
    )
    # 距离线: 两扇亮灯的窗 / 黎明剪影
    scene(
        ASSETS / "d1-windows.jpg",
        [(0.0, (10, 14, 30)), (0.55, (22, 30, 56)), (1.0, (6, 8, 20))],
        [(0.28, 0.42, 0.06, (255, 214, 150), 0.55), (0.72, 0.5, 0.055, (210, 225, 255), 0.5)],
        [(140, 170, 230), (255, 210, 150)],
        stars=80,
    )
    page(
        ASSETS / "d7-dawn.jpg",
        [(0.0, (16, 20, 34)), (0.6, (44, 52, 78)), (0.88, (150, 150, 160)), (1.0, (30, 34, 52))],
        [(0.5, 0.86, 0.22, (230, 220, 210), 0.40)],
        [(silk_curve(60, 0.86, 0.03), 60, (200, 205, 215), 0.24, 36)],
        stars=30,
    )
    # 慢热线: 台灯书桌 / 清晨两只杯子
    page(
        ASSETS / "a1-desk.jpg",
        [(0.0, (28, 18, 8)), (0.5, (72, 48, 22)), (1.0, (20, 13, 6))],
        [(0.36, 0.28, 0.18, (255, 196, 110), 0.50), (0.78, 0.75, 0.12, (180, 120, 70), 0.30)],
        [(silk_curve(60, 0.6, 0.07), 40, (220, 160, 95), 0.26, 28),
         (silk_curve(2, 0.42, 0.0), 5, (255, 214, 150), 0.30, 2)],
    )
    page(
        ASSETS / "a7-morning.jpg",
        [(0.0, (40, 30, 20)), (0.55, (110, 84, 52)), (0.85, (208, 178, 132)), (1.0, (60, 46, 30))],
        [(0.3, 0.35, 0.16, (255, 226, 170), 0.45), (0.62, 0.6, 0.14, (255, 210, 150), 0.38)],
        [(silk_curve(60, 0.78, 0.04), 46, (240, 205, 155), 0.28, 30)],
    )
    # 深入线: 深夜窗帘月光 / 缠绕耳机线
    page(
        ASSETS / "b1-curtain.jpg",
        [(0.0, (8, 10, 24)), (0.5, (24, 28, 56)), (1.0, (5, 6, 18))],
        [(0.3, 0.3, 0.16, (170, 185, 240), 0.42), (0.66, 0.72, 0.1, (120, 140, 220), 0.30)],
        [(silk_curve(60, 0.5, 0.12), 54, (110, 130, 210), 0.26, 34),
         (silk_curve(60, 0.68, 0.09), 38, (90, 105, 185), 0.22, 28)],
        stars=60,
    )
    page(
        ASSETS / "b7-earphone.jpg",
        [(0.0, (12, 12, 22)), (0.5, (34, 32, 52)), (1.0, (8, 8, 16))],
        [(0.5, 0.5, 0.2, (150, 140, 230), 0.36)],
        [(silk_curve(60, 0.45, 0.10), 34, (160, 150, 240), 0.30, 22),
         (silk_curve(60, 0.62, 0.09), 26, (130, 120, 215), 0.26, 20),
         (silk_curve(60, 0.76, 0.08), 22, (110, 100, 195), 0.22, 18)],
        stars=50,
    )
    # 默契线: 客厅猫与外卖 / 键盘上的猫
    page(
        ASSETS / "cg1-cat.jpg",
        [(0.0, (30, 22, 12)), (0.5, (74, 56, 30)), (1.0, (22, 16, 9))],
        [(0.35, 0.3, 0.16, (255, 200, 120), 0.44), (0.72, 0.7, 0.12, (255, 160, 90), 0.30)],
        [(silk_curve(60, 0.62, 0.08), 40, (235, 180, 110), 0.24, 28)],
        bokeh=(5, [(255, 210, 140), (255, 170, 110)]),
    )
    page(
        ASSETS / "cg7-paw.jpg",
        [(0.0, (26, 20, 12)), (0.55, (66, 50, 28)), (1.0, (18, 13, 8))],
        [(0.5, 0.42, 0.2, (255, 190, 110), 0.40)],
        [(silk_curve(60, 0.7, 0.06), 38, (225, 170, 100), 0.22, 26)],
        bokeh=(4, [(255, 200, 130)]),
    )
    # 尾声: 黎明信纸
    page(
        ASSETS / "e-dawn.jpg",
        [(0.0, (26, 22, 26)), (0.55, (72, 68, 84)), (0.86, (206, 188, 176)), (1.0, (44, 40, 48))],
        [(0.5, 0.84, 0.2, (255, 226, 196), 0.42)],
        [(silk_curve(60, 0.84, 0.03), 56, (250, 222, 190), 0.26, 32)],
        stars=20,
    )


# ----------------------------------------------------------------------- bgm

RATE = 44100


def loop_freq(f: float, duration: float) -> float:
    return round(f * duration) / duration


def seamless_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """White noise made loop-continuous via 50% overlap-add with a half-shift."""
    x = rng.standard_normal(n)
    w = np.hanning(n)
    up = np.concatenate([np.linspace(0, 1, n // 2), np.linspace(1, 0, n - n // 2)])
    return x * up + np.roll(x, -n // 2) * (1 - up)


def lowpass(audio: np.ndarray, rate: int, cutoff: float) -> np.ndarray:
    spectrum = np.fft.rfft(audio)
    freqs = np.fft.rfftfreq(len(audio), 1 / rate)
    spectrum *= 1.0 / (1.0 + (freqs / cutoff) ** 4)
    return np.fft.irfft(spectrum, len(audio))


def encode(name: str, audio: np.ndarray) -> None:
    wav_path = ASSETS / f"{name}.wav"
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())
    mp3_path = ASSETS / f"{name}.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-b:a", "96k", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    print(f"✓ {name}.mp3 {len(audio) / RATE:.0f}s {mp3_path.stat().st_size // 1024}KB")


def build_pad(name: str, duration: float, voices: list[tuple[float, float, int]],
              cutoff: float, rain_db: float = 0.0, rng_seed: int = 7) -> None:
    rng = np.random.default_rng(rng_seed)
    n = int(RATE * duration)
    t = np.arange(n) / RATE
    audio = np.zeros(n)
    for freq, amp, lfo_cycles in voices:
        f = loop_freq(freq, duration)
        lfo = 0.72 + 0.28 * np.sin(2 * np.pi * lfo_cycles * t / duration + rng.uniform(0, 2 * math.pi))
        audio += amp * lfo * np.sin(2 * np.pi * f * t)
    if rain_db > 0:
        rain = seamless_noise(n, rng)
        rain = lowpass(rain, RATE, 2600)
        rain = rain / np.max(np.abs(rain))
        # 雨的落点起伏：整数周期的呼吸包络
        rain *= 0.6 + 0.4 * np.sin(2 * np.pi * t / duration + rng.uniform(0, 2 * math.pi))
        audio += (10 ** (rain_db / 20)) * rain * 0.35
    audio *= 0.88 + 0.12 * np.sin(2 * np.pi * t / duration - math.pi / 2)
    audio = lowpass(audio, RATE, cutoff)
    audio = audio / np.max(np.abs(audio)) * 0.5
    encode(name, audio)


def build_plucks(name: str, duration: float, roots: list[float], cutoff: float) -> None:
    """默契线：轻快的拨弦点，全部落在整周期网格上。"""
    n = int(RATE * duration)
    t = np.arange(n) / RATE
    rng = np.random.default_rng(11)
    audio = np.zeros(n)
    slots = 16  # 每循环 16 个格点
    slot_len = n / slots
    for k in range(slots):
        if k % 3 == 2:
            continue  # 留白
        freq = loop_freq(roots[int(rng.integers(0, len(roots)))], duration)
        start = int(k * slot_len)
        seg = n - start
        tt = np.arange(min(seg, int(RATE * 1.2))) / RATE
        env = np.exp(-tt * 3.2)
        audio[start:start + len(tt)] += 0.30 * env * (
            np.sin(2 * np.pi * freq * tt) + 0.4 * np.sin(2 * np.pi * freq * 2 * tt)
        )
    pad_voices = [(roots[0] / 2, 0.20, 1), (roots[0], 0.12, 2)]
    for freq, amp, lfo in pad_voices:
        f = loop_freq(freq, duration)
        audio += amp * (0.8 + 0.2 * np.sin(2 * np.pi * lfo * t / duration)) * np.sin(2 * np.pi * f * t)
    audio = lowpass(audio, RATE, cutoff)
    audio = audio / np.max(np.abs(audio)) * 0.5
    encode(name, audio)


def build_bgm() -> None:
    # 0/1 页 · 雨夜主题（雨声 + 冷调 pad）
    build_pad("bgm-rain", 40.0,
              [(55.0, 0.20, 1), (110.0, 0.22, 1), (164.81, 0.14, 2), (220.0, 0.10, 3),
               (261.63, 0.09, 2), (329.63, 0.06, 4)],
              cutoff=1500, rain_db=-8.0, rng_seed=3)
    # 2 页 · 距离线（清冷稀疏，高音区留白）
    build_pad("bgm-distance", 36.0,
              [(73.42, 0.16, 1), (146.83, 0.18, 1), (220.0, 0.10, 2), (293.66, 0.08, 3),
               (440.0, 0.04, 5)],
              cutoff=1300, rain_db=-14.0, rng_seed=4)
    # 3 页 · 慢热线（暖调慢板，F 大调色彩）
    build_pad("bgm-warm", 36.0,
              [(87.31, 0.20, 1), (174.61, 0.18, 2), (261.63, 0.12, 2), (349.23, 0.09, 3),
               (523.25, 0.04, 5)],
              cutoff=1700, rng_seed=5)
    # 4 页 · 深入线（低音加密，张力）
    build_pad("bgm-deep", 40.0,
              [(49.0, 0.26, 1), (98.0, 0.24, 1), (146.83, 0.16, 2), (196.0, 0.12, 3),
               (233.08, 0.10, 2), (293.66, 0.07, 4), (587.33, 0.03, 6)],
              cutoff=1400, rng_seed=6)
    # 5 页 · 默契线（明亮轻快拨弦）
    build_plucks("bgm-playful", 32.0, [261.63, 329.63, 392.0, 523.25], cutoff=2400)
    # 6 页 · 尾声（黎明亮色）
    build_pad("bgm-dawn", 40.0,
              [(65.41, 0.18, 1), (130.81, 0.20, 1), (196.0, 0.14, 2), (261.63, 0.12, 3),
               (329.63, 0.09, 4), (659.26, 0.04, 6)],
              cutoff=2200, rng_seed=8)


if __name__ == "__main__":
    build_images()
    build_bgm()
