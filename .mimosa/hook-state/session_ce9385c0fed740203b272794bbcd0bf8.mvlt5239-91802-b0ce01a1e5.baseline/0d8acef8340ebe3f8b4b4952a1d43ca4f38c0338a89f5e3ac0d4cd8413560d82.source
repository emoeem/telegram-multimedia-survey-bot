#!/usr/bin/env python3
"""Render the 17 scene illustrations the visual novel needs.

WHY THIS EXISTS
---------------
`build_assets.py` produced abstract gradient/bokeh plates: no staging, and
several actively mismatched their scene (`cg1-cat.jpg` showed no cat,
`a1-desk.jpg` showed no desk lamp). This renderer draws *composed* scenes
instead — layered depth, a subject silhouette, one key light — under a single
art direction:

  * one key light per scene (warm, upper-left for interiors; cool, upper-right
    for night exteriors) with a bloom pass, so the set reads as one story
  * figures are silhouettes with rim light only (no faces), which keeps the
    style coherent and avoids fake-looking synthetic faces we cannot draw
  * the bottom third stays low-contrast because the VN textbox overlays it
  * 1600x1000 (16:10), progressive JPEG q=88, one palette per storyline:
      prologue/rain  indigo + amber lamp
      距离线 / D       cold blue + one warm window
      慢热线 / A       amber and brown
      深入线 / B       violet and indigo
      默契线 / C       warm orange
      尾声             rose and cream

It also writes `scene-alt.json` (slug -> Chinese alt text) so the definition can
carry real alternative text, which phase 5 requires and which was empty before.

Everything here is original procedural artwork: no third-party asset is
downloaded, so there is no licence to clear and no attribution to carry.

Usage:
    python3 scripts/galgame/render_scenes.py            # render all
    python3 scripts/galgame/render_scenes.py --only cg1-cat
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent.parent
ASSETS = ROOT / "scripts" / "galgame" / "assets"
W, H = 1600, 1000

# --- shared art direction --------------------------------------------------
INK = (6, 7, 12)          # base silhouette colour before tinting
RIM_WARM = (255, 214, 158)
RIM_COOL = (178, 202, 255)


# ----------------------------------------------------------------- utilities
def base(stops: list[tuple[float, tuple[int, int, int]]]) -> Image.Image:
    """Vertical gradient from (position, rgb) stops."""
    positions = [p for p, _ in stops]
    arr = np.zeros((H, W, 3), dtype=np.float32)
    ramp = np.linspace(0, 1, H)
    for channel in range(3):
        arr[:, :, channel] = np.interp(ramp, positions, [c[channel] for _, c in stops])[:, None]
    return Image.fromarray(arr.astype(np.uint8), "RGB")


def _mask(size: tuple[int, int] = (W, H)) -> Image.Image:
    return Image.new("L", size, 0)


def _add(img: Image.Image, layer: Image.Image, mask: Image.Image) -> Image.Image:
    black = Image.new("RGB", img.size, (0, 0, 0))
    return ImageChops.add(img, Image.composite(layer, black, mask))


def glow(img, cx, cy, r, color, strength=1.0, blur=0.55):
    m = _mask(img.size)
    ImageDraw.Draw(m).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(max(1.0, r * blur)))
    m = m.point(lambda v: min(255, int(v * strength)))
    return _add(img, Image.new("RGB", img.size, color), m)


def beam(img, points, color, strength=1.0, blur_frac=0.06):
    """Soft additive light cone — `points` is a polygon."""
    m = _mask(img.size)
    ImageDraw.Draw(m).polygon(points, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(max(2.0, W * blur_frac)))
    m = m.point(lambda v: min(255, int(v * strength)))
    return _add(img, Image.new("RGB", img.size, color), m)


def _pts(shape):
    """Coerce any numeric sequence to plain float tuples (PIL rejects ndarrays)."""
    return [(float(x), float(y)) for x, y in shape]


def _norm(items):
    """Accept either a polygon point list or {"e": (x0,y0,x1,y1)} for an ellipse."""
    out = []
    for item in items:
        if isinstance(item, dict) and "e" in item:
            out.append(("e", [float(v) for v in item["e"]]))
        else:
            out.append(("p", _pts(item)))
    return out


def _paint(draw, items, fill):
    for kind, data in items:
        if kind == "e":
            draw.ellipse(data, fill=fill)
        else:
            draw.polygon(data, fill=fill)


def _shift(items, dx, dy):
    return [
        ("e", [d[0] + dx, d[1] + dy, d[2] + dx, d[3] + dy]) if k == "e"
        else ("p", [(x + dx, y + dy) for x, y in d])
        for k, d in items
    ]


def sil(img, items, ink=INK, rim=None, rim_width=6, rim_offset=(-7, -7), feather=1.1):
    """Compose solid silhouettes, optionally with a rim light on the key-lit side.

    The rim is the silhouette shifted toward the light minus the silhouette
    itself, so it appears as a crescent along one edge. Tracing the whole
    perimeter instead produces a neon outline that reads as wireframe, not form.
    """
    items = _norm(items)
    if rim is not None:
        m = _mask(img.size)
        _paint(ImageDraw.Draw(m), _shift(items, *rim_offset), 255)
        if feather:
            m = m.filter(ImageFilter.GaussianBlur(feather))
        body = _mask(img.size)
        _paint(ImageDraw.Draw(body), items, 255)
        m = ImageChops.subtract(m, body.filter(ImageFilter.GaussianBlur(0.8)))
        img = _add(img, Image.new("RGB", img.size, rim), m)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    _paint(ImageDraw.Draw(overlay), items, INK + (255,))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def form_light(img, cx, cy, r, color, strength=0.22):
    """Lift the near face of a silhouette after it is drawn, so forms read as solid."""
    return glow(img, cx, cy, r, color, strength=strength, blur=0.9)


def rects(img, boxes, color, alpha=255, blur=0.0):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for box in boxes:
        d.rectangle([float(v) for v in box], fill=color + (alpha,))
    if blur:
        overlay = overlay.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def lines(img, segments, color, width=2, alpha=200, blur=0.6):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for seg in segments:
        d.line(_pts(seg), fill=color + (alpha,), width=width)
    if blur:
        overlay = overlay.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def rain(img, count, angle_deg=-14, color=(170, 196, 240), alpha=52, length=(60, 190), seed=7):
    rng = np.random.default_rng(seed)
    slope = math.tan(math.radians(angle_deg))
    segs = []
    for _ in range(count):
        x = rng.uniform(-100, W)
        y = rng.uniform(-100, H)
        span = rng.uniform(*length)
        segs.append([(x, y), (x + slope * span, y + span)])
    return lines(img, segs, color, width=2, alpha=alpha, blur=0.7)


def droplets(img, count, seed=11, color=(190, 214, 255), alpha=34):
    rng = np.random.default_rng(seed)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(3, 15)
        d.ellipse([x, y, x + r, y + r * 1.25], fill=color + (int(alpha * rng.uniform(0.5, 1.4)),))
    overlay = overlay.filter(ImageFilter.GaussianBlur(1.6))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def bokeh(img, count, colors, seed=5, rmin=26, rmax=110, ymin=0.1, ymax=1.0, alpha=64):
    rng = np.random.default_rng(seed)
    out = img
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(ymin * H, ymax * H)
        r = rng.uniform(rmin, rmax)
        out = glow(out, x, y, r, colors[int(rng.integers(0, len(colors)))],
                   strength=rng.uniform(0.10, 0.30), blur=0.85)
    return out


def dust(img, count, seed=3, color=(255, 232, 196), alpha=90):
    rng = np.random.default_rng(seed)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(1.2, 4.0)
        d.ellipse([x, y, x + r, y + r], fill=color + (int(alpha * rng.uniform(0.4, 1.2)),))
    overlay = overlay.filter(ImageFilter.GaussianBlur(0.8))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def stars(img, count, seed=2, alpha=190):
    rng = np.random.default_rng(seed)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, H * 0.62)
        r = rng.uniform(0.8, 2.4)
        d.ellipse([x, y, x + r, y + r], fill=(226, 234, 255, int(alpha * rng.uniform(0.3, 1.0))))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def skyline(rng, baseline, heights, ink, rim=None, img=None, lit=0):
    """A city silhouette; returns (shapes, lit_window_boxes)."""
    shapes, boxes = [], []
    x = -40
    while x < W + 40:
        bw = rng.uniform(70, 190)
        bh = rng.uniform(*heights)
        top = baseline - bh
        shapes.append([(x, baseline), (x, top), (x + bw, top), (x + bw, baseline)])
        if lit:
            for _ in range(lit):
                if rng.random() < 0.5:
                    wx = rng.uniform(x + 10, x + bw - 26)
                    wy = rng.uniform(top + 16, baseline - 30)
                    boxes.append([wx, wy, wx + rng.uniform(8, 16), wy + rng.uniform(10, 20)])
        x += bw + rng.uniform(6, 26)
    return shapes, boxes


def finish(img, vignette=0.55, grain=5.0, bloom=True):
    if bloom:
        bright = img.point(lambda v: max(0, v - 186) * 3)
        img = ImageChops.add(img, bright.filter(ImageFilter.GaussianBlur(26)))
    arr = np.asarray(img, dtype=np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    dx = (xx - W / 2) / (W / 2)
    dy = (yy - H / 2) / (H / 2)
    radial = np.clip(1.0 - vignette * (dx * dx + dy * dy) * 0.55, 0.0, 1.0)
    arr *= radial[:, :, None]
    rng = np.random.default_rng(99)
    arr += rng.normal(0, grain, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def save(img: Image.Image, name: str) -> None:
    path = ASSETS / name
    img.convert("RGB").save(path, "JPEG", quality=88, progressive=True, optimize=True)
    print(f"  {name:22s} {path.stat().st_size:>8d} B")


# --------------------------------------------------------------------- scenes
def cover():
    img = base([(0.0, (9, 12, 26)), (0.45, (26, 34, 62)), (0.78, (14, 18, 38)), (1.0, (6, 8, 18))])
    img = stars(img, 150, seed=4)
    img = glow(img, W * 0.78, H * 0.16, 220, (150, 176, 235), 0.30)
    rng = np.random.default_rng(21)
    shapes, windows = skyline(rng, H * 0.74, (120, 380), INK, lit=5)
    img = sil(img, shapes, ink=(9, 12, 22), rim=(70, 92, 150), rim_offset=(-6, -6))
    img = rects(img, windows, (255, 206, 142), alpha=180, blur=0.8)
    img = form_light(img, W * 0.34, H * 0.52, 520, (110, 142, 210), 0.16)
    # the "frequency" motif: arcs broadcast from the studio window
    for i in range(4):
        r = 150 + i * 118
        img = lines(img, [
            [(W * 0.5 + r * math.cos(a), H * 0.78 + r * math.sin(a) * 0.42)
             for a in np.linspace(math.pi * 1.03, math.pi * 1.97, 40)]
        ], (138, 172, 240), width=3, alpha=52 - i * 9, blur=3.4)
    img = rain(img, 220, seed=9)
    img = glow(img, W * 0.5, H * 0.78, 210, (168, 196, 255), 0.22)
    return finish(img, vignette=0.72)


def p1_radio():
    img = base([(0.0, (26, 14, 6)), (0.52, (74, 42, 16)), (0.80, (46, 26, 10)), (1.0, (14, 9, 4))])
    img = glow(img, W * 0.30, H * 0.20, 260, (255, 178, 96), 0.34)
    img = beam(img, [(W * 0.10, H * 0.02), (W * 0.46, H * 0.02), (W * 0.72, H * 0.80), (W * 0.02, H * 0.80)],
               (255, 196, 120), 0.26)
    # desk
    img = rects(img, [[0, H * 0.78, W, H]], (28, 17, 8), alpha=255)
    img = lines(img, [[(0, H * 0.78), (W, H * 0.78)]], (255, 206, 140), width=3, alpha=120, blur=1.4)
    # microphone: capsule + grille + yoke + stand
    cx, cy, r = W * 0.34, H * 0.44, 96
    img = sil(img, [[(cx, cy - r), (cx + r, cy - r * 0.3), (cx + r, cy + r * 0.5),
                     (cx, cy + r), (cx - r, cy + r * 0.5), (cx - r, cy - r * 0.3)]],
              ink=(20, 12, 6), rim=RIM_WARM, rim_offset=(-8, -8))
    img = form_light(img, cx - 170, cy - 150, 330, (255, 186, 116), 0.22)
    img = lines(img, [[(cx - r * 0.8, cy + dy), (cx + r * 0.8, cy + dy)] for dy in (-40, -14, 14, 40)],
                (96, 66, 34), width=3, alpha=170)
    img = rects(img, [[cx - 7, cy + r, cx + 7, H * 0.78]], (18, 11, 6))
    img = rects(img, [[cx - 96, H * 0.78 - 14, cx + 96, H * 0.78]], (14, 9, 5))
    # ON AIR lamp
    img = glow(img, W * 0.74, H * 0.20, 130, (255, 92, 74), 0.42)
    img = rects(img, [[W * 0.68, H * 0.155, W * 0.80, H * 0.245]], (58, 18, 14), alpha=210, blur=1.2)
    img = rects(img, [[W * 0.695, H * 0.175, W * 0.785, H * 0.225]], (255, 118, 92), alpha=225, blur=2.4)
    # level meter
    for i in range(9):
        h = 22 + (i % 4) * 17
        img = rects(img, [[W * 0.855 + i * 15, H * 0.30 - h, W * 0.855 + i * 15 + 8, H * 0.30]],
                    (255, 186, 110), alpha=150 if i % 3 else 205, blur=0.5)
    return finish(dust(img, 90, seed=6), vignette=0.62)


def p2_phone():
    img = base([(0.0, (7, 10, 22)), (0.5, (16, 24, 46)), (1.0, (5, 7, 16))])
    # rain-streaked window behind
    img = rain(img, 170, seed=13, alpha=38)
    img = rects(img, [[0, H * 0.06, W, H * 0.075], [0, H * 0.52, W, H * 0.535],
                      [W * 0.30, 0, W * 0.315, H], [W * 0.70, 0, W * 0.715, H]],
                (4, 6, 14), alpha=235)
    img = glow(img, W * 0.62, H * 0.60, 300, (140, 176, 240), 0.34)
    # phone, tilted, held low-left
    img = sil(img, [[(W * 0.30, H * 0.44), (W * 0.53, H * 0.36), (W * 0.59, H * 0.86), (W * 0.36, H * 0.92)]],
              ink=(10, 13, 24), rim=RIM_COOL, rim_offset=(-7, -7))
    img = glow(img, W * 0.455, H * 0.62, 190, (176, 206, 255), 0.44)
    # the lit screen itself
    img = rects(img, [[W * 0.352, H * 0.45, W * 0.556, H * 0.70]], (206, 226, 255), alpha=120, blur=6.0)
    img = beam(img, [(W * 0.34, H * 0.44), (W * 0.56, H * 0.38), (W * 0.16, H * 0.02), (W * 0.02, H * 0.10)],
               (150, 184, 240), 0.20)
    return finish(droplets(img, 70, seed=8), vignette=0.66)


def d1_windows():
    img = base([(0.0, (8, 11, 26)), (0.5, (22, 30, 56)), (1.0, (6, 8, 20))])
    img = stars(img, 90, seed=17)
    rng = np.random.default_rng(31)
    # two facing blocks with a gap of night sky between them
    left = [[-40, H], [-40, H * 0.24], [W * 0.34, H * 0.30], [W * 0.34, H]]
    right = [[W * 0.66, H], [W * 0.66, H * 0.20], [W + 40, H * 0.26], [W + 40, H]]
    img = sil(img, [left, right], ink=(7, 9, 18), rim=(74, 96, 156), rim_offset=(6, -6))
    for _ in range(9):
        x = rng.uniform(-20, W * 0.30)
        y = rng.uniform(H * 0.36, H * 0.86)
        img = rects(img, [[x, y, x + 15, y + 22]], (255, 202, 138), alpha=110, blur=0.9)
    # the two facing lit windows: one warm, one cool
    img = glow(img, W * 0.24, H * 0.44, 150, (255, 200, 132), 0.42)
    img = rects(img, [[W * 0.205, H * 0.40, W * 0.275, H * 0.50]], (255, 214, 158), alpha=210, blur=1.4)
    img = glow(img, W * 0.76, H * 0.50, 150, (176, 206, 255), 0.40)
    img = rects(img, [[W * 0.725, H * 0.46, W * 0.795, H * 0.56]], (208, 226, 255), alpha=200, blur=1.4)
    img = rain(img, 230, seed=19)
    img = glow(img, W * 0.5, H * 0.96, 320, (40, 56, 104), 0.30)
    return finish(img, vignette=0.70)


def d7_dawn():
    img = base([(0.0, (20, 26, 46)), (0.42, (52, 60, 88)), (0.70, (146, 142, 148)),
                (0.78, (214, 196, 176)), (1.0, (26, 30, 48))])
    img = glow(img, W * 0.56, H * 0.74, 420, (255, 226, 196), 0.40)
    rng = np.random.default_rng(43)
    shapes, _ = skyline(rng, H * 0.74, (90, 250), INK)
    img = sil(img, shapes, ink=(18, 22, 40), rim=(226, 214, 214), rim_offset=(6, -6))
    # rooftop railing in the foreground, kept low and sparse so it frames rather
    # than turning the frame into a grid
    posts = [[[x, H * 0.83], [x, H * 1.02]] for x in range(110, W + 110, 236)]
    img = lines(img, posts, (10, 12, 22), width=7, alpha=240, blur=0.7)
    img = lines(img, [[(0, H * 0.83), (W, H * 0.83)], [(0, H * 0.89), (W, H * 0.89)]],
                (10, 12, 22), width=9, alpha=240, blur=0.7)
    for bx, by in ((W * 0.18, H * 0.30), (W * 0.24, H * 0.26), (W * 0.30, H * 0.31)):
        img = lines(img, [[(bx, by), (bx + 16, by - 3)]], (30, 34, 52), width=3, alpha=180)
        img = lines(img, [[(bx + 8, by - 2), (bx + 22, by - 5)]], (30, 34, 52), width=3, alpha=180)
    return finish(img, vignette=0.58)


def a1_desk():
    img = base([(0.0, (26, 17, 8)), (0.5, (72, 48, 22)), (0.80, (44, 29, 14)), (1.0, (16, 11, 6))])
    # lamp cone from upper-left toward the desk
    img = beam(img, [(W * 0.20, H * 0.20), (W * 0.34, H * 0.20), (W * 0.66, H * 0.78), (W * 0.02, H * 0.78)],
               (255, 200, 126), 0.34, blur_frac=0.05)
    img = glow(img, W * 0.27, H * 0.24, 200, (255, 206, 138), 0.36)
    # lamp: shade + arm + base
    img = sil(img, [
        [(W * 0.20, H * 0.24), (W * 0.34, H * 0.22), (W * 0.36, H * 0.30), (W * 0.19, H * 0.32)],
        [(W * 0.265, H * 0.32), (W * 0.285, H * 0.32), (W * 0.295, H * 0.70), (W * 0.255, H * 0.70)],
        [(W * 0.20, H * 0.70), (W * 0.35, H * 0.70), (W * 0.35, H * 0.74), (W * 0.20, H * 0.74)],
    ], ink=(22, 14, 7), rim=RIM_WARM, rim_offset=(-7, -7))
    img = form_light(img, W * 0.24, H * 0.36, 320, (255, 194, 120), 0.20)
    # desk surface
    img = rects(img, [[0, H * 0.74, W, H]], (30, 19, 9), alpha=255)
    img = lines(img, [[(0, H * 0.74), (W, H * 0.74)]], (255, 206, 140), width=3, alpha=110, blur=1.6)
    # manuscript sheets, fanned, with ruled lines
    sheets = [
        [(W * 0.40, H * 0.96), (W * 0.42, H * 0.76), (W * 0.72, H * 0.79), (W * 0.70, H * 0.99)],
        [(W * 0.47, H * 0.97), (W * 0.50, H * 0.78), (W * 0.80, H * 0.81), (W * 0.77, H * 1.00)],
        [(W * 0.54, H * 0.98), (W * 0.57, H * 0.80), (W * 0.87, H * 0.83), (W * 0.84, H * 1.01)],
    ]
    img = sil(img, sheets, ink=(208, 186, 152), rim=None)
    img = lines(img, [[((x0 + x1) / 2 - 40, (y0 + y1) / 2 + d), ((x0 + x1) / 2 + 90, (y0 + y1) / 2 + d + 5)]
                      for d in (-22, 0, 22) for x0, y0, x1, y1 in [(W * 0.54, H * 0.80, W * 0.87, H * 0.83)]],
                (120, 100, 78), width=2, alpha=120)
    # pen
    img = sil(img, [[(W * 0.44, H * 0.99), (W * 0.47, H * 0.86), (W * 0.485, H * 0.865), (W * 0.458, H * 0.995)]],
              ink=(28, 22, 30), rim=(255, 226, 170), rim_offset=(-4, -4))
    # coffee cup
    img = sil(img, [[(W * 0.885, H * 0.86), (W * 0.93, H * 0.86), (W * 0.925, H * 0.98), (W * 0.89, H * 0.98)]],
              ink=(30, 20, 12), rim=RIM_WARM, rim_offset=(-5, -5))
    return finish(dust(img, 110, seed=12), vignette=0.60)


def a7_morning():
    img = base([(0.0, (58, 42, 26)), (0.45, (128, 98, 60)), (0.72, (206, 176, 132)), (0.86, (96, 74, 48)),
                (1.0, (44, 34, 22))])
    # window light patch falling across the desk
    img = beam(img, [(W * 0.06, 0), (W * 0.30, 0), (W * 0.62, H * 0.75), (W * 0.16, H * 0.75)],
               (255, 232, 186), 0.30, blur_frac=0.04)
    img = rects(img, [[0, H * 0.74, W, H]], (74, 56, 34), alpha=255)
    img = lines(img, [[(0, H * 0.74), (W, H * 0.74)]], (255, 236, 198), width=3, alpha=140, blur=1.6)
    # two cups side by side (the "two cups" the scene calls for)
    for cx, sc, steam in ((W * 0.40, 1.0, True), (W * 0.56, 0.94, False)):
        rw, rh = 62 * sc, 74 * sc
        base_y = H * 0.90
        img = sil(img, [[(cx - rw, base_y - rh), (cx + rw, base_y - rh), (cx + rw * 0.86, base_y),
                         (cx - rw * 0.86, base_y)]], ink=(54, 38, 24), rim=(255, 238, 202),
                  rim_offset=(-6, -6), )
        img = lines(img, [[(cx - rw, base_y - rh), (cx + rw, base_y - rh)]], (255, 236, 202), width=4, alpha=200)
        if steam:
            for i in range(3):
                pts = [(cx - 10 + 14 * i + 8 * math.sin(t / 5.0), base_y - rh - 8 - t * 3.2) for t in range(22)]
                img = lines(img, [pts], (255, 246, 226), width=4, alpha=64, blur=3.2)
    img = form_light(img, W * 0.30, H * 0.52, 420, (255, 220, 168), 0.18)
    # notebook + pen
    img = sil(img, [[(W * 0.66, H * 0.99), (W * 0.70, H * 0.80), (W * 0.94, H * 0.84), (W * 0.90, H * 1.01)]],
              ink=(96, 74, 50), rim=(255, 238, 202), rim_offset=(-5, -5))
    img = sil(img, [[(W * 0.30, H * 1.00), (W * 0.34, H * 0.90), (W * 0.355, H * 0.905), (W * 0.315, H * 1.005)]],
              ink=(40, 30, 22))
    return finish(dust(img, 100, seed=15), vignette=0.55)


def b1_curtain():
    img = base([(0.0, (8, 10, 24)), (0.5, (24, 28, 56)), (1.0, (5, 6, 18))])
    img = glow(img, W * 0.70, H * 0.20, 240, (156, 176, 240), 0.30)
    # window: bright cool rectangle with mullions
    img = rects(img, [[W * 0.50, H * 0.06, W * 0.98, H * 0.72]], (44, 54, 100), alpha=255)
    img = glow(img, W * 0.74, H * 0.38, 280, (150, 176, 240), 0.38)
    img = rects(img, [[W * 0.735, H * 0.06, W * 0.745, H * 0.72], [W * 0.50, H * 0.37, W * 0.98, H * 0.385]],
                (8, 10, 22), alpha=255)
    # curtain: two flowing panels with sinusoidal folds
    for x0, x1, phase in ((W * 0.30, W * 0.52, 0.0), (W * 0.96, W * 1.10, 1.6)):
        pts = []
        for i in range(28):
            t = i / 27
            y = t * H
            x = x0 + (x1 - x0) * t * 0.10 + 22 * math.sin(t * 8.2 + phase)
            pts.append((x, y))
        poly = pts + [(x + 150, y) for x, y in reversed(pts)]
        img = sil(img, [poly], ink=(10, 12, 26), rim=(148, 170, 236), rim_offset=(9, -3))
    img = form_light(img, W * 0.62, H * 0.42, 380, (150, 172, 238), 0.16)
    # floor light pool
    img = beam(img, [(W * 0.52, H), (W * 0.98, H), (W * 0.86, H * 0.72), (W * 0.62, H * 0.72)],
               (140, 168, 236), 0.22, blur_frac=0.06)
    return finish(dust(img, 120, seed=18), vignette=0.66)


def b7_earphone():
    img = base([(0.0, (12, 12, 24)), (0.5, (34, 32, 54)), (1.0, (8, 8, 16))])
    img = glow(img, W * 0.50, H * 0.46, 300, (146, 136, 232), 0.32)
    # a cord that loops into a loose knot
    t = np.linspace(0, 2 * math.pi, 260)
    cord = [(float(W * 0.50 + 300 * math.sin(a) * (1 + 0.28 * math.cos(3 * a)) * 0.55),
             float(H * 0.52 + 210 * math.sin(2 * a) * 0.55)) for a in t]
    img = lines(img, [cord], (18, 16, 32), width=16, alpha=255, blur=0.6)
    img = lines(img, [cord], (186, 172, 255), width=5, alpha=130, blur=1.4)
    # two earbuds, one either side of the knot
    for cx, cy in ((W * 0.24, H * 0.36), (W * 0.78, H * 0.70)):
        img = sil(img, [[(cx - 46, cy - 30), (cx + 46, cy - 40), (cx + 52, cy + 34), (cx - 40, cy + 42)]],
                  ink=(16, 14, 28), rim=(196, 184, 255), rim_offset=(-6, -6))
        img = sil(img, [[(cx - 14, cy + 30), (cx + 12, cy + 26), (cx + 10, cy + 74), (cx - 16, cy + 76)]],
                  ink=(16, 14, 28))
    return finish(dust(img, 90, seed=22, color=(214, 206, 255)), vignette=0.64)


def cg1_cat():
    img = base([(0.0, (30, 22, 12)), (0.5, (78, 58, 30)), (1.0, (22, 16, 9))])
    img = glow(img, W * 0.26, H * 0.24, 280, (255, 196, 118), 0.36)
    img = rects(img, [[0, H * 0.72, W, H]], (34, 24, 12), alpha=255)
    img = lines(img, [[(0, H * 0.72), (W, H * 0.72)]], (255, 202, 136), width=3, alpha=110, blur=1.6)
    # a sitting cat, built from ellipses so the anatomy reads as an animal
    cx = W * 0.34
    img = sil(img, [
        {"e": (cx - 190, H * 0.44, cx + 150, H * 0.74)},                       # haunch
        {"e": (cx - 110, H * 0.22, cx + 62, H * 0.51)},                        # head
        [(cx - 106, H * 0.31), (cx - 124, H * 0.15), (cx - 58, H * 0.25)],      # left ear
        [(cx - 4, H * 0.25), (cx + 58, H * 0.14), (cx + 50, H * 0.31)],         # right ear
        {"e": (cx - 208, H * 0.60, cx - 120, H * 0.74)},                       # front paw
        [(cx - 190, H * 0.70), (cx - 96, H * 0.52), (cx + 60, H * 0.52), (cx + 150, H * 0.72)],
    ], ink=(22, 16, 10), rim=(255, 206, 146), rim_offset=(-10, -10))
    img = form_light(img, cx - 150, H * 0.34, 340, (255, 192, 118), 0.20)
    # tail curling along the table toward the takeout box
    tail = [(cx + 120 + 96 * math.sin(a), H * 0.71 + 26 * (1 - math.cos(a)) - 30 * a)
            for a in np.linspace(0, 1.7, 40)]
    img = lines(img, [tail], (22, 16, 10), width=24, alpha=255, blur=1.1)
    img = lines(img, [tail], (255, 202, 142), width=5, alpha=80, blur=2.8)
    # takeout box + chopsticks
    img = sil(img, [[(W * 0.66, H * 0.72), (W * 0.88, H * 0.68), (W * 0.90, H * 0.84), (W * 0.68, H * 0.88)]],
              ink=(48, 34, 20), rim=(255, 214, 150), rim_offset=(-6, -6))
    img = lines(img, [[(W * 0.90, H * 0.90), (W * 0.98, H * 0.72)], [(W * 0.92, H * 0.905), (W * 1.00, H * 0.73)]],
                (232, 210, 176), width=5, alpha=200)
    return finish(bokeh(img, 9, [(255, 210, 140), (255, 168, 104)], seed=24, ymin=0.05, ymax=0.6), vignette=0.58)


def cg7_paw():
    img = base([(0.0, (26, 20, 12)), (0.55, (68, 52, 28)), (1.0, (16, 12, 8))])
    img = glow(img, W * 0.44, H * 0.30, 300, (255, 196, 118), 0.34)
    # keyboard in perspective: rows of key caps
    y0, rows = H * 0.52, 4
    for r in range(rows):
        ry = y0 + r * 92
        depth = 1 + r * 0.10
        for c in range(11):
            x = -30 + c * (W * 0.108) * depth
            wcap = W * 0.086 * depth
            img = sil(img, [[(x, ry), (x + wcap, ry - 10), (x + wcap, ry + 58), (x, ry + 68)]],
                      ink=(44, 34, 22), rim=(255, 208, 148), rim_offset=(-3, -3))
    # the cat's paw resting on the keys: pad + four toes
    img = sil(img, [
        [(W * 0.36, H * 0.94), (W * 0.34, H * 0.62), (W * 0.52, H * 0.52), (W * 0.64, H * 0.66),
         (W * 0.62, H * 0.94)],
        [(W * 0.36, H * 0.66), (W * 0.34, H * 0.54), (W * 0.40, H * 0.52), (W * 0.42, H * 0.62)],
        [(W * 0.43, H * 0.60), (W * 0.43, H * 0.48), (W * 0.49, H * 0.47), (W * 0.49, H * 0.58)],
        [(W * 0.51, H * 0.58), (W * 0.52, H * 0.47), (W * 0.58, H * 0.48), (W * 0.57, H * 0.60)],
        [(W * 0.58, H * 0.62), (W * 0.61, H * 0.52), (W * 0.66, H * 0.55), (W * 0.63, H * 0.65)],
    ], ink=(22, 16, 10), rim=(255, 212, 152), rim_offset=(-8, -8))
    img = form_light(img, W * 0.36, H * 0.50, 430, (255, 198, 124), 0.20)
    return finish(bokeh(img, 7, [(255, 206, 136)], seed=26, ymin=0.02, ymax=0.4), vignette=0.58)


def e_dawn():
    img = base([(0.0, (34, 28, 34)), (0.4, (86, 76, 92)), (0.66, (188, 168, 160)),
                (0.76, (232, 212, 196)), (1.0, (52, 46, 54))])
    img = glow(img, W * 0.62, H * 0.70, 420, (255, 236, 220), 0.36)
    # window frame with dawn coming through
    img = lines(img, [[(W * 0.10, H * 0.04), (W * 0.10, H * 0.74)], [(W * 0.90, H * 0.04), (W * 0.90, H * 0.74)],
                      [(W * 0.10, H * 0.04), (W * 0.90, H * 0.04)], [(W * 0.10, H * 0.74), (W * 0.90, H * 0.74)],
                      [(W * 0.50, H * 0.04), (W * 0.50, H * 0.74)]],
                (16, 14, 20), width=16, alpha=255, blur=0.8)
    # sill + a letter with ruled lines and a signature rule
    img = sil(img, [[(0, H * 0.74), (W, H * 0.74), (W, H * 0.82), (0, H * 0.82)]], ink=(28, 24, 30))
    img = sil(img, [[(W * 0.30, H * 0.98), (W * 0.34, H * 0.74), (W * 0.72, H * 0.76), (W * 0.68, H * 1.00)]],
              ink=(246, 236, 224), rim=(255, 246, 236), rim_offset=(-4, -4))
    img = lines(img, [[(W * 0.40, H * 0.84 + d), (W * 0.64, H * 0.85 + d)] for d in (0, 26, 52, 78)],
                (150, 132, 126), width=2, alpha=150)
    img = lines(img, [[(W * 0.50, H * 0.96), (W * 0.63, H * 0.965)]], (96, 72, 76), width=3, alpha=190)
    img = sil(img, [[(W * 0.76, H * 0.99), (W * 0.79, H * 0.80), (W * 0.805, H * 0.805), (W * 0.775, H * 1.00)]],
              ink=(46, 38, 48), rim=(255, 240, 226), rim_offset=(-4, -4))
    return finish(dust(img, 120, seed=28, color=(255, 240, 226)), vignette=0.55)


def gate_four():
    """The four-opening choice: four doorways, each with its own light."""
    img = base([(0.0, (14, 14, 26)), (0.5, (28, 28, 48)), (1.0, (10, 10, 20))])
    lights = [(255, 186, 112), (150, 186, 250), (188, 156, 246), (255, 152, 96)]
    for i, color in enumerate(lights):
        x = W * 0.045 + i * W * 0.242
        dw, dh = W * 0.185, H * 0.62
        y = H * 0.16
        img = glow(img, x + dw / 2, y + dh * 0.55, dh * 0.42, color, 0.30)
        img = rects(img, [[x + dw * 0.14, y + dh * 0.10, x + dw * 0.86, y + dh * 0.97]],
                    color, alpha=150, blur=26.0)
        img = sil(img, [[(x, y), (x + dw, y), (x + dw, y + dh), (x, y + dh)]],
                  ink=(8, 8, 16), rim=color, rim_offset=(-8, -8))
        img = lines(img, [[(x + dw * 0.14, y + dh), (x + dw * 0.14, y + dh * 0.10),
                           (x + dw * 0.86, y + dh * 0.10), (x + dw * 0.86, y + dh)]],
                    (6, 6, 14), width=9, alpha=255, blur=0.6)
    img = lines(img, [[(0, H * 0.78), (W, H * 0.78)]], (120, 128, 176), width=3, alpha=90, blur=2.4)
    return finish(dust(img, 110, seed=33), vignette=0.62)


def d6_consent():
    """距离线 consent: the door left ajar — warmth offered, not taken."""
    img = base([(0.0, (8, 11, 26)), (0.5, (24, 32, 58)), (1.0, (6, 8, 20))])
    img = rects(img, [[0, 0, W * 0.58, H]], (10, 13, 28), alpha=255)
    img = glow(img, W * 0.58, H * 0.48, 320, (255, 198, 130), 0.34)
    beam_pts = [(W * 0.58, H * 0.02), (W * 0.72, H * 0.02), (W * 1.02, H * 0.98), (W * 0.58, H * 0.98)]
    img = beam(img, beam_pts, (255, 206, 146), 0.28)
    img = sil(img, [[(W * 0.44, H), (W * 0.44, 0), (W * 0.58, H * 0.02), (W * 0.58, H * 0.98)],
                    [(W * 0.50, H * 0.62), (W * 0.545, H * 0.60), (W * 0.545, H * 0.66), (W * 0.50, H * 0.68)]],
              ink=(9, 11, 24), rim=RIM_WARM, rim_offset=(-7, -7))
    img = lines(img, [[(0, H * 0.86), (W * 0.58, H * 0.80)]], (12, 15, 32), width=10, alpha=255, blur=1.2)
    return finish(dust(img, 90, seed=35), vignette=0.68)


def a6_consent():
    """慢热线 consent: the manuscript closed, the lamp turned low."""
    img = base([(0.0, (22, 14, 7)), (0.5, (58, 38, 18)), (1.0, (14, 10, 5))])
    img = glow(img, W * 0.28, H * 0.26, 190, (255, 196, 122), 0.24)
    img = beam(img, [(W * 0.22, H * 0.24), (W * 0.32, H * 0.24), (W * 0.52, H * 0.74), (W * 0.06, H * 0.74)],
               (255, 198, 128), 0.22)
    img = sil(img, [
        [(W * 0.20, H * 0.24), (W * 0.32, H * 0.22), (W * 0.33, H * 0.30), (W * 0.19, H * 0.31)],
        [(W * 0.25, H * 0.31), (W * 0.265, H * 0.31), (W * 0.27, H * 0.68), (W * 0.24, H * 0.68)],
        [(W * 0.19, H * 0.68), (W * 0.32, H * 0.68), (W * 0.32, H * 0.72), (W * 0.19, H * 0.72)],
    ], ink=(18, 12, 6), rim=RIM_WARM, rim_offset=(-6, -6))
    img = rects(img, [[0, H * 0.72, W, H]], (26, 17, 8), alpha=255)
    img = lines(img, [[(0, H * 0.72), (W, H * 0.72)]], (255, 202, 138), width=3, alpha=90, blur=1.8)
    # a closed manuscript: two stacked sheets, no fanned pages
    img = sil(img, [[(W * 0.44, H * 0.97), (W * 0.47, H * 0.79), (W * 0.76, H * 0.82), (W * 0.73, H * 1.00)]],
              ink=(196, 176, 146), rim=(255, 232, 190), rim_offset=(-4, -4))
    img = lines(img, [[(W * 0.47, H * 0.79), (W * 0.76, H * 0.82)]], (120, 104, 84), width=3, alpha=160)
    img = sil(img, [[(W * 0.82, H * 0.88), (W * 0.865, H * 0.88), (W * 0.86, H * 0.99), (W * 0.825, H * 0.99)]],
              ink=(30, 20, 12), rim=RIM_WARM, rim_offset=(-5, -5))
    return finish(dust(img, 80, seed=37), vignette=0.62)


def b6_consent():
    """深入线 consent: the earbud cord set down inside the drawn curtain."""
    img = base([(0.0, (10, 10, 24)), (0.5, (30, 28, 54)), (1.0, (7, 7, 16))])
    img = rects(img, [[W * 0.56, H * 0.06, W, H * 0.70]], (40, 46, 86), alpha=255)
    img = glow(img, W * 0.78, H * 0.34, 250, (150, 168, 236), 0.28)
    # curtain drawn further across, folds closer together
    for x0, phase in ((W * 0.40, 0.0), (W * 0.58, 1.1), (W * 0.74, 2.2)):
        pts = []
        for i in range(26):
            t = i / 25
            x = x0 + 14 * math.sin(t * 9.0 + phase)
            pts.append((x, t * H))
        poly = pts + [(x + 76, y) for x, y in reversed(pts)]
        img = sil(img, [poly], ink=(10, 11, 24), rim=(144, 162, 232), rim_offset=(8, -3))
    # cord laid down, loose
    cord = [(float(W * 0.22 + 180 * math.cos(a)), float(H * 0.74 + 60 * math.sin(2 * a)))
            for a in np.linspace(0, 3.1, 120)]
    img = lines(img, [cord], (16, 14, 30), width=12, alpha=255, blur=0.6)
    img = lines(img, [cord], (176, 164, 250), width=4, alpha=110, blur=1.4)
    img = sil(img, [[(W * 0.18, H * 0.70), (W * 0.26, H * 0.66), (W * 0.28, H * 0.76), (W * 0.20, H * 0.80)]],
              ink=(15, 13, 28), rim=(196, 184, 255), rim_offset=(-5, -5))
    return finish(dust(img, 90, seed=39, color=(212, 204, 255)), vignette=0.66)


def c6_consent():
    """默契线 consent: the cat asleep, the screen dark, the night ending well."""
    img = base([(0.0, (26, 19, 11)), (0.5, (66, 48, 25)), (1.0, (18, 13, 8))])
    img = glow(img, W * 0.30, H * 0.26, 240, (255, 190, 112), 0.28)
    img = rects(img, [[0, H * 0.70, W, H]], (30, 21, 11), alpha=255)
    img = lines(img, [[(0, H * 0.70), (W, H * 0.70)]], (255, 198, 130), width=3, alpha=100, blur=1.8)
    # a blanket with a curled cat on it
    img = sil(img, [[(W * 0.14, H * 0.88), (W * 0.22, H * 0.70), (W * 0.60, H * 0.66), (W * 0.72, H * 0.86),
                     (W * 0.60, H * 0.97), (W * 0.20, H * 0.97)]], ink=(58, 40, 22))
    img = sil(img, [
        [(W * 0.28, H * 0.80), (W * 0.34, H * 0.68), (W * 0.54, H * 0.68), (W * 0.60, H * 0.82),
         (W * 0.46, H * 0.88), (W * 0.32, H * 0.86)],
        [(W * 0.34, H * 0.72), (W * 0.36, H * 0.62), (W * 0.42, H * 0.68)],
        [(W * 0.44, H * 0.70), (W * 0.46, H * 0.60), (W * 0.52, H * 0.67)],
    ], ink=(20, 14, 9), rim=(255, 200, 134), rim_offset=(-7, -7))
    img = form_light(img, W * 0.32, H * 0.56, 360, (255, 190, 118), 0.18)
    tail = [(W * 0.56 + 70 * math.sin(a), H * 0.84 - a * 120) for a in np.linspace(0, 0.7, 24)]
    img = lines(img, [tail], (20, 14, 9), width=20, alpha=255, blur=1.0)
    # the phone, face down, screen dark
    img = sil(img, [[(W * 0.78, H * 0.72), (W * 0.94, H * 0.74), (W * 0.92, H * 0.90), (W * 0.76, H * 0.88)]],
              ink=(38, 28, 16), rim=(255, 206, 144), rim_offset=(-5, -5))
    return finish(bokeh(img, 6, [(255, 200, 132)], seed=41, ymin=0.02, ymax=0.34), vignette=0.60)


SCENES: dict[str, tuple] = {
    "cover.jpg": (cover, "封面：雨夜的电台频率。深靛蓝雨幕、城市剪影与一圈圈扩散的电波，右上角一点冷月。"),
    "p1-radio.jpg": (p1_radio, "午夜电台直播间。暖橙台面、正对镜头的电容麦克风，右上角亮着红色的 ON AIR 灯与电平表。"),
    "p2-phone.jpg": (p2_phone, "深夜，一块亮起的手机屏幕。冷蓝光从屏幕射向雨痕密布的窗，玻璃上挂着水珠。"),
    "d1-windows.jpg": (d1_windows, "两栋隔着夜色的楼。左边一扇暖黄的窗，右边一扇冷白的窗，中间是下着雨的夜空。"),
    "d7-dawn.jpg": (d7_dawn, "天快亮了。从天台栏杆望出去，城市剪影上方是一线破晓的暖白，几只鸟掠过。"),
    "a1-desk.jpg": (a1_desk, "书桌一角。台灯把橙黄的光锥压在手稿上，纸页散开，旁边一支笔和一只咖啡杯。"),
    "a7-morning.jpg": (a7_morning, "清晨的桌面。窗光斜照进来，两只杯子并排放在桌上，一只还冒着热气。"),
    "b1-curtain.jpg": (b1_curtain, "月光下的窗与窗帘。冷色窗格透亮，纱帘被风掀起，光落在地板上。"),
    "b7-earphone.jpg": (b7_earphone, "一副缠绕成结的耳机。紫调光线里，耳机线绕成一圈柔软的结，两只耳塞分在两侧。"),
    "cg1-cat.jpg": (cg1_cat, "客厅的暖灯下，一只猫端坐在桌上，尾巴向上卷起，旁边摊着外卖盒与筷子。"),
    "cg7-paw.jpg": (cg7_paw, "近景：一只猫爪搭在键盘上，四枚趾垫压在键帽之间，灯光从左上照下来。"),
    "e-dawn.jpg": (e_dawn, "尾声：破晓的信纸。窗口灌进淡玫瑰色的晨光，信纸上写着几行字，落款处一横署名。"),
    "gate-four.jpg": (gate_four, "四个开场：四道并排的门，分别透出暖金、冷蓝、紫罗兰与橙红的光，等你挑一个。"),
    "d6-consent.jpg": (d6_consent, "一扇半掩的门，暖光从门缝铺进来，落在黑暗的地板上。"),
    "a6-consent.jpg": (a6_consent, "台灯调暗了。合起的手稿叠在桌角，咖啡杯还温着，光只剩薄薄一层。"),
    "b6-consent.jpg": (b6_consent, "窗帘再拉近了一些，耳机线被轻轻放在一旁，月光压在布褶上。"),
    "c6-consent.jpg": (c6_consent, "猫在毯子上蜷成一团睡着了，手机屏幕朝下扣着，屋里只剩一盏暖黄的小灯。"),
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="只渲染某一个文件（不含扩展名）")
    args = parser.parse_args()

    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (fn, alt) in SCENES.items():
        if args.only and not name.startswith(args.only):
            continue
        save(fn(), name)
        manifest[name] = alt
    if not args.only:
        (ROOT / "scripts" / "galgame" / "scene-alt.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"  scene-alt.json: {len(manifest)} 条 alt 文本")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
