#!/usr/bin/env python3
"""Generate the visual assets and BGM loop for the 文爱偏好问卷 (wenai survey).

Outputs into scripts/wenai/assets/:
  - cover.jpg  (1920x1200, survey theme background)
  - p1..p7.jpg, closing.jpg  (1600x1000, per-page note images)
  - scene-*.jpg  (800x600, scene option thumbnails)
  - bgm.mp3  (seamless ambient loop used as theme.audio)

All images are abstract (gradients, glows, silk curves, grain) — no figures.
Deterministic: fixed RNG seed, re-runnable.
"""

from __future__ import annotations

import math
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

RNG = np.random.default_rng(2026)


# ---------------------------------------------------------------- primitives

def vertical_gradient(w: int, h: int, stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    """Stops are (position 0..1, rgb). Returns float32 array (h, w, 3)."""
    positions = np.array([p for p, _ in stops])
    colors = np.array([c for _, c in stops], dtype=np.float64)
    ys = np.linspace(0.0, 1.0, h)
    img = np.empty((h, 3), dtype=np.float64)
    for ch in range(3):
        img[:, ch] = np.interp(ys, positions, colors[:, ch])
    return np.repeat(img[:, None, :], w, axis=1)


def add_glow(img: np.ndarray, cx: float, cy: float, radius: float, color: tuple[int, int, int], strength: float) -> None:
    """Additive gaussian blob; cx/cy/radius are fractions of width/height/width."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    d2 = (xx - cx * w) ** 2 + (yy - cy * h) ** 2
    blob = np.exp(-d2 / (2 * (radius * w) ** 2))
    for ch in range(3):
        img[:, :, ch] += strength * color[ch] * blob


def add_silk(img: np.ndarray, points: list[tuple[float, float]], width_px: int, color: tuple[int, int, int], strength: float, blur: int = 24) -> None:
    """Blend a blurred smooth curve through fractional points, additive-lighten."""
    h, w = img.shape[:2]
    layer = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(layer)
    pts = [(int(px * w), int(py * h)) for px, py in points]
    draw.line(pts, fill=255, width=width_px, joint="curve")
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    mask = np.asarray(layer, dtype=np.float64) / 255.0
    for ch in range(3):
        img[:, :, ch] += strength * color[ch] * mask


def add_stars(img: np.ndarray, count: int, brightness: float = 0.5) -> None:
    h, w = img.shape[:2]
    xs = RNG.integers(0, w, count)
    ys = RNG.integers(0, int(h * 0.7), count)
    vals = RNG.uniform(0.3, 1.0, count)
    for x, y, v in zip(xs, ys, vals):
        img[y, x] += brightness * v * 255


def add_bokeh(img: np.ndarray, count: int, colors: list[tuple[int, int, int]], y_min: float = 0.1, y_max: float = 0.9) -> None:
    """Soft out-of-focus light discs."""
    h, w = img.shape[:2]
    layer = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for _ in range(count):
        color = colors[int(RNG.integers(0, len(colors)))]
        r = int(RNG.uniform(w * 0.02, w * 0.07))
        cx = int(RNG.uniform(0, w))
        cy = int(RNG.uniform(y_min * h, y_max * h))
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(w * 0.012))
    img += np.asarray(layer, dtype=np.float64) * 0.55


def vignette(img: np.ndarray, strength: float = 0.45) -> None:
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    img *= (1.0 - strength * np.clip(d - 0.55, 0, 1) ** 1.5)[:, :, None]


def grain(img: np.ndarray, sigma: float = 4.0) -> None:
    img += RNG.normal(0.0, sigma, img.shape)


def silk_curve(n_points: int, y_base: float, wobble: float, x_span: tuple[float, float] = (-0.05, 1.05)) -> list[tuple[float, float]]:
    xs = np.linspace(x_span[0], x_span[1], n_points)
    phase = RNG.uniform(0, 2 * math.pi)
    ys = y_base + wobble * np.sin(np.linspace(0, 2 * math.pi, n_points) * RNG.uniform(0.8, 1.4) + phase)
    return [(float(x), float(y)) for x, y in zip(xs, ys)]


def finish(img: np.ndarray, path: Path, width: int, height: int, quality: int = 82) -> None:
    img = np.clip(img, 0, 255).astype(np.uint8)
    im = Image.fromarray(img).resize((width, height), Image.LANCZOS)
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"✓ {path.name} {width}x{height} {path.stat().st_size // 1024}KB")


def page(path: Path, stops, glows, silks, stars: int = 0, bokeh: list | None = None) -> None:
    w, h = 1600, 1000
    img = vertical_gradient(w, h, stops)
    for cx, cy, r, color, strength in glows:
        add_glow(img, cx, cy, r, color, strength)
    for pts, width_px, color, strength, blur in silks:
        add_silk(img, pts, width_px, color, strength, blur)
    if stars:
        add_stars(img, stars)
    if bokeh:
        add_bokeh(img, *bokeh)
    vignette(img)
    grain(img)
    finish(img, path, w, h)


def scene(path: Path, stops, glows, bokeh_colors: list, stars: int = 0, extra_silks: list | None = None) -> None:
    w, h = 800, 600
    img = vertical_gradient(w, h, stops)
    for cx, cy, r, color, strength in glows:
        add_glow(img, cx, cy, r, color, strength)
    for pts, width_px, color, strength, blur in extra_silks or []:
        add_silk(img, pts, width_px, color, strength, blur)
    if stars:
        add_stars(img, stars)
    add_bokeh(img, 7, bokeh_colors)
    vignette(img, 0.5)
    grain(img, 3.5)
    finish(img, path, w, h)


# -------------------------------------------------------------------- images

def build_images() -> None:
    # Cover: deep wine night, pale moon high right, crimson silk.
    page(
        ASSETS / "cover.jpg",
        [(0.0, (24, 7, 16)), (0.45, (66, 17, 34)), (1.0, (16, 4, 10))],
        [(0.78, 0.20, 0.11, (255, 224, 226), 0.85), (0.2, 0.85, 0.25, (120, 26, 46), 0.35)],
        [(silk_curve(60, 0.62, 0.10), 60, (196, 62, 84), 0.35, 30),
         (silk_curve(60, 0.78, 0.08), 40, (150, 40, 62), 0.28, 26),
         (silk_curve(60, 0.42, 0.06), 26, (230, 120, 138), 0.16, 20)],
    )
    # p1 序: near-black charcoal with a low rose ember.
    page(
        ASSETS / "p1.jpg",
        [(0.0, (13, 10, 15)), (0.6, (28, 16, 24)), (1.0, (10, 7, 11))],
        [(0.3, 0.88, 0.22, (214, 92, 110), 0.30)],
        [(silk_curve(50, 0.8, 0.05), 34, (196, 74, 96), 0.20, 30)],
    )
    # p2 底色: indigo dusk with drifting mist and faint stars.
    page(
        ASSETS / "p2.jpg",
        [(0.0, (14, 18, 38)), (0.5, (37, 27, 61)), (1.0, (10, 10, 24))],
        [(0.7, 0.75, 0.2, (140, 120, 220), 0.28)],
        [(silk_curve(60, 0.55, 0.12), 70, (120, 100, 200), 0.22, 40),
         (silk_curve(60, 0.72, 0.09), 46, (90, 80, 170), 0.18, 30)],
        stars=90,
    )
    # p3 幕布: deep teal-navy stage with warm bokeh footlights.
    page(
        ASSETS / "p3.jpg",
        [(0.0, (8, 20, 32)), (0.55, (16, 38, 58)), (1.0, (6, 12, 22))],
        [(0.5, 0.12, 0.18, (200, 220, 255), 0.22)],
        [(silk_curve(60, 0.9, 0.04), 80, (30, 70, 100), 0.30, 40)],
        bokeh=(9, [(255, 190, 120), (255, 140, 150), (180, 210, 255)]),
    )
    # p4 尺度: ember red with flowing heat waves.
    page(
        ASSETS / "p4.jpg",
        [(0.0, (32, 6, 12)), (0.5, (87, 16, 32)), (1.0, (42, 7, 16))],
        [(0.35, 0.25, 0.2, (255, 120, 110), 0.30)],
        [(silk_curve(60, 0.45, 0.10), 50, (255, 110, 100), 0.25, 28),
         (silk_curve(60, 0.65, 0.09), 36, (220, 70, 80), 0.22, 24),
         (silk_curve(60, 0.82, 0.07), 28, (180, 50, 70), 0.18, 22)],
    )
    # p5 界限: cold iron slate with hard horizontal lines.
    page(
        ASSETS / "p5.jpg",
        [(0.0, (14, 17, 21)), (0.5, (29, 36, 44)), (1.0, (11, 13, 17))],
        [(0.5, 0.3, 0.25, (150, 180, 210), 0.18)],
        [(silk_curve(2, 0.35, 0.0), 3, (200, 220, 240), 0.35, 1),
         (silk_curve(2, 0.55, 0.0), 2, (180, 200, 225), 0.30, 1),
         (silk_curve(2, 0.75, 0.0), 3, (200, 220, 240), 0.28, 1)],
    )
    # p6 安全词: warm amber dusk, calm and soft.
    page(
        ASSETS / "p6.jpg",
        [(0.0, (29, 18, 6)), (0.5, (74, 44, 18)), (1.0, (22, 12, 5))],
        [(0.5, 0.55, 0.24, (255, 196, 120), 0.34)],
        [(silk_curve(60, 0.6, 0.08), 46, (255, 180, 110), 0.22, 32)],
    )
    # p7 落笔: rose-gold dawn on the horizon.
    page(
        ASSETS / "p7.jpg",
        [(0.0, (28, 13, 18)), (0.62, (92, 44, 58)), (0.86, (196, 128, 118)), (1.0, (60, 24, 30))],
        [(0.5, 0.84, 0.2, (255, 200, 170), 0.40)],
        [(silk_curve(60, 0.86, 0.03), 60, (255, 190, 160), 0.28, 34)],
        stars=40,
    )
    # closing 信已封好: deep plum with a wax-seal glow.
    page(
        ASSETS / "closing.jpg",
        [(0.0, (23, 11, 18)), (0.55, (58, 22, 38)), (1.0, (17, 8, 13))],
        [(0.5, 0.5, 0.16, (230, 120, 140), 0.42)],
        [(silk_curve(60, 0.7, 0.08), 40, (170, 60, 90), 0.24, 30)],
    )
    # Scene thumbnails (800x600).
    scene(
        ASSETS / "scene-latenight.jpg",
        [(0.0, (8, 12, 30)), (0.6, (18, 26, 58)), (1.0, (6, 8, 20))],
        [(0.72, 0.68, 0.13, (170, 200, 255), 0.50)],
        [(120, 160, 255), (90, 120, 220)], stars=70,
    )
    scene(
        ASSETS / "scene-hotel.jpg",
        [(0.0, (24, 16, 10)), (0.6, (58, 38, 20)), (1.0, (14, 9, 6))],
        [(0.3, 0.35, 0.14, (255, 190, 110), 0.55)],
        [(255, 190, 110), (255, 150, 90)],
        extra_silks=[(silk_curve(40, 0.2, 0.02, (0.5, 1.05)), 26, (255, 210, 150), 0.22, 18)],
    )
    scene(
        ASSETS / "scene-office.jpg",
        [(0.0, (12, 16, 22)), (0.6, (26, 34, 46)), (1.0, (9, 12, 16))],
        [(0.5, 0.2, 0.2, (190, 210, 235), 0.26)],
        [(170, 200, 240), (140, 170, 210)],
        extra_silks=[(silk_curve(2, 0.18 + 0.10 * i, 0.0), 8, (210, 228, 248), 0.30, 2) for i in range(5)],
    )
    scene(
        ASSETS / "scene-ancient.jpg",
        [(0.0, (36, 6, 10)), (0.55, (96, 18, 28)), (1.0, (30, 5, 9))],
        [(0.32, 0.75, 0.10, (255, 170, 90), 0.55), (0.68, 0.72, 0.08, (255, 160, 80), 0.45)],
        [(255, 170, 90), (220, 60, 70)],
        extra_silks=[(silk_curve(60, 0.5, 0.12), 40, (200, 50, 60), 0.30, 26),
                     (silk_curve(60, 0.68, 0.10), 30, (160, 40, 52), 0.25, 22)],
    )
    scene(
        ASSETS / "scene-fantasy.jpg",
        [(0.0, (16, 8, 40)), (0.55, (48, 24, 88)), (1.0, (10, 6, 26))],
        [(0.6, 0.3, 0.2, (150, 130, 255), 0.35)],
        [(150, 130, 255), (110, 200, 230), (220, 150, 255)],
        stars=110,
        extra_silks=[(silk_curve(60, 0.35, 0.10), 30, (140, 220, 255), 0.28, 24)],
    )
    scene(
        ASSETS / "scene-city.jpg",
        [(0.0, (10, 10, 18)), (0.6, (24, 18, 34)), (1.0, (8, 8, 14))],
        [(0.25, 0.8, 0.12, (255, 110, 160), 0.40), (0.75, 0.72, 0.10, (110, 210, 255), 0.35)],
        [(255, 110, 160), (110, 210, 255), (255, 190, 120)],
    )


# ---------------------------------------------------------------------- bgm

def build_bgm() -> None:
    """A seamless ambient loop: every partial and LFO completes integer cycles
    over the loop length, so the seam is mathematically silent."""
    rate = 44100
    duration = 40.0
    n = int(rate * duration)
    t = np.arange(n) / rate

    def loop_freq(f: float) -> float:
        return round(f * duration) / duration

    # A-minor add9 pad (A2 E3 A3 C4 E4 B4) with slow per-voice swells; the
    # A3 voice is a detuned pair (both loop-quantized) for a 0.4 Hz chorus.
    voices = [
        (55.0, 0.22, 1), (110.0, 0.28, 1), (164.81, 0.18, 2),
        (220.0, 0.14, 3), (220.4, 0.12, 3), (261.63, 0.12, 2),
        (329.63, 0.08, 4), (493.88, 0.04, 5),
    ]
    audio = np.zeros(n)
    for freq, amp, lfo_cycles in voices:
        f = loop_freq(freq)
        lfo = 0.72 + 0.28 * np.sin(2 * np.pi * lfo_cycles * t / duration + RNG.uniform(0, 2 * math.pi))
        audio += amp * lfo * np.sin(2 * np.pi * f * t)

    # Gentle one-cycle-per-loop breathing on the whole bed.
    audio *= 0.88 + 0.12 * np.sin(2 * np.pi * t / duration - math.pi / 2)

    # Soft spectral tilt: keep the bed below ~1.8 kHz.
    spectrum = np.fft.rfft(audio)
    freqs = np.fft.rfftfreq(n, 1 / rate)
    spectrum *= 1.0 / (1.0 + (freqs / 1800.0) ** 4)
    audio = np.fft.irfft(spectrum, n)

    audio = audio / np.max(np.abs(audio)) * 0.5
    pcm = (audio * 32767).astype(np.int16)

    wav_path = ASSETS / "bgm.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())

    mp3_path = ASSETS / "bgm.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(wav_path), "-codec:a", "libmp3lame", "-b:a", "96k", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    print(f"✓ bgm.mp3 {duration:.0f}s seamless loop {mp3_path.stat().st_size // 1024}KB")


if __name__ == "__main__":
    build_images()
    build_bgm()
