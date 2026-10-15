#!/usr/bin/env python3
"""立绘（立ち絵）导出：把 CC-BY 授权的外部立绘套图裁成问卷用的透明 WebP。

来源（许可与作者均已核对，见 SOURCE 与 sprite-manifest.json）：
  Codel Visual Novel Sprite — LisadiKaprio — OpenGameArt — CC-BY 4.0
  https://opengameart.org/content/codel-visual-novel-sprite
  页面原文：「The PSD-file (1078x2089) contains: a base (1 pose, 1 outfit on);
  7 different expressions + a blush. The pack also contains 12 PNG-files
  (same resolution) with premade emotions (with and without the blush).」

CC-BY 4.0 的强制条件只有「署名」：必须在使用处列出作者与许可。
署名文案由本脚本写进 sprite-manifest.json 的 `attribution`，
问卷侧由 scripts/galgame/update_galgame_survey.py 的 credit 节点一起下发。

用法：
  python3 scripts/galgame/build_sprites.py            # 导出（缺源包时自动下载）
  python3 scripts/galgame/build_sprites.py --verify   # 只校验磁盘与清单一致
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
CACHE = ROOT / ".sprite-cache"
MANIFEST = ROOT / "sprite-manifest.json"

SOURCE = {
    "title": "Codel Visual Novel Sprite",
    "author": "LisadiKaprio",
    "author_url": "https://opengameart.org/users/lisadikaprio",
    "page": "https://opengameart.org/content/codel-visual-novel-sprite",
    "download": "https://opengameart.org/sites/default/files/Codel%20sprite.zip",
    "license": "CC-BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "attribution": "Sprite \"Codel\" by LisadiKaprio (OpenGameArt), CC-BY 4.0",
    "source_sha256": "a5c011407841d670ca4ff18acb13d59f2c023a2afdba4a3be3b7c2915fa14760",
}

# 表情名 → 源包里的成品 PNG。表情名是脚本自己读图后定的（见 LABEL_NOTES），
# 不采用作者的文件序号，因为序号在包内无标注。
EXPRESSIONS = {
    "neutral": ("Codel3.png", "平静、无情绪起伏的默认神情"),
    "smile": ("Codel9.png", "眼睛睁开、嘴角上扬的浅笑"),
    "soft": ("Codel6.png", "闭眼、眉眼放松（安静/被安抚）"),
    "shy": ("Codel1.png", "半睑俯视 + 脸红（被看穿的窘）"),
    "blush": ("Codel2.png", "睁眼 + 脸红、唇线平（不知所措）"),
    "fluster": ("Codel10.png", "重脸红 + 泪光 + 张口（情绪冲破防线）"),
    "sad": ("Codel7.png", "含泪、眉心上挑（难过但还撑着）"),
    "cry": ("Codel8.png", "泪痕 + 张口露齿（哭腔、失控）"),
    "annoyed": ("Codel5.png", "闭眼皱眉、张嘴（别扭、抗议）"),
    "think": ("Codel4.png", "侧目斜视、眉不对齐（审视/不置可否）"),
    "pout": ("Codel12.png", "闭眼 + 脸红 + 抿嘴（害臊、别过脸）"),
}

# 原始 12 张身体完全相同（实测：与 Codel3 的差异 bbox 全部落在
# x∈[407,675] y∈[249,460] 的面部区域），所以不存在「换表情时道具凭空出现」
# 的连续性风险。
BODY_IDENTICAL_NOTE = "12 张差分仅面部像素不同，身体/姿势逐字节一致"

TARGET_HEIGHT = 1100          # 显示高度上限 ≈ 420 CSS px，2x DPR 下留有余量
WEBP_QUALITY = 82
ALPHA_CUTOFF = 128            # 源图边缘是硬 alpha，无需半透明


def download_source() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE / "Codel_sprite.zip"
    if not zip_path.is_file():
        # OGA 对无 UA 的请求返回 403，必须带浏览器 UA。
        subprocess.run(
            [
                "curl", "-fsSL", "--max-time", "180",
                "-A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
                "-e", SOURCE["page"],
                "-o", str(zip_path), SOURCE["download"],
            ],
            check=True,
        )
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    if SOURCE["source_sha256"] and digest != SOURCE["source_sha256"]:
        # 源站重新打包时哈希会变 —— 不静默接受，让人确认过再更新常量。
        print(f"警告：源包 sha256 与清单记录不同\n  记录 {SOURCE['source_sha256']}\n  实际 {digest}", file=sys.stderr)
    return zip_path


def extract(zip_path: Path) -> Path:
    out = CACHE / "extracted"
    if not (out / "Codel3.png").is_file():
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(out)
    return out


def trim(im: Image.Image, margin: int = 6) -> Image.Image:
    bbox = im.split()[3].getbbox()
    if not bbox:
        return im
    return im.crop(
        (
            max(0, bbox[0] - margin),
            max(0, bbox[1] - margin),
            min(im.width, bbox[2] + margin),
            min(im.height, bbox[3] + margin),
        )
    )


def export(src_dir: Path) -> list[dict]:
    ASSETS.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    for expression, (filename, note) in EXPRESSIONS.items():
        src_path = src_dir / filename
        im = Image.open(src_path).convert("RGBA")
        src_size = im.size
        im = trim(im)
        im = im.resize((round(im.width * TARGET_HEIGHT / im.height), TARGET_HEIGHT), Image.LANCZOS)
        # 保持半透明边缘：直接存带 alpha 的 WebP（比 256 色 PNG 更省且无渐变断层）。
        out = ASSETS / f"sprite-{expression}.webp"
        im.save(out, "WEBP", quality=WEBP_QUALITY, method=6)
        data = out.read_bytes()
        records.append(
            {
                "slug": out.name,
                "expression": expression,
                "source_file": filename,
                "source_size": list(src_size),
                "size": list(im.size),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "mime": "image/webp",
                "label_note": note,
            }
        )
    return records


def write_manifest(records: list[dict]) -> None:
    MANIFEST.write_text(
        json.dumps(
            {
                "source": SOURCE,
                "license_note": (
                    "CC-BY 4.0 允许商用、修改、再分发；唯一强制条件是署名。"
                    "故本套立绘必须在游戏内 credits 与交付文档中列出 LisadiKaprio。"
                    "作者页面未对成人向用途设限（与 Ailearium 等明确禁止 R18 的素材不同）。"
                ),
                "body_identical_note": BODY_IDENTICAL_NOTE,
                "target_height": TARGET_HEIGHT,
                "expressions": records,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def verify() -> int:
    if not MANIFEST.is_file():
        print("缺少 sprite-manifest.json，先跑一次不带 --verify 的导出")
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    bad = 0
    for record in manifest["expressions"]:
        path = ASSETS / record["slug"]
        if not path.is_file():
            print(f"MISSING {record['slug']}")
            bad += 1
            continue
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        with Image.open(path) as im:
            size = list(im.size)
        ok = digest == record["sha256"] and len(data) == record["bytes"] and size == record["size"]
        print(f"{'OK  ' if ok else 'FAIL'} {record['slug']:24s} {size} {len(data) // 1024}KB")
        bad += 0 if ok else 1
    print(f"{len(manifest['expressions'])} 张，{bad} 张不一致")
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        return verify()
    zip_path = download_source()
    src_dir = extract(zip_path)
    records = export(src_dir)
    write_manifest(records)
    total = sum(r["bytes"] for r in records)
    for record in records:
        print(f"{record['expression']:8s} {record['source_file']:12s} {record['size']} {record['bytes'] // 1024}KB")
    print(f"共 {len(records)} 张，{total // 1024} KB → {ASSETS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
