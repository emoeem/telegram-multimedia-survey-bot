#!/usr/bin/env python3
"""Generate the fixed semantic-parser regression fixture.

The resulting PDF intentionally contains the shapes the parser must handle:
forms title, repeated headers/footers, required markers, single choice,
yes/no, open text, rating, multiple choice, long options, page ranges, and
images in question/option/unattached positions.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf as fitz


OUT_PATH = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "情景-沉沦的欲望.pdf"


def png_bytes(rgb: tuple[int, int, int]) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 32, 32))
    pix.clear_with((rgb[0] << 16) | (rgb[1] << 8) | rgb[2])
    return pix.tobytes("png")


def add_header_footer(page: fitz.Page) -> None:
    page.insert_text((60, 42), "内部问卷", fontsize=9, fontname="china-s")
    page.insert_text((60, 800), "请勿外传", fontsize=9, fontname="china-s")
    page.insert_text((540, 800), f"{page.number + 1} / 3", fontsize=9)


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()

    # Page 1: title, single choice with question media, yes/no.
    page = doc.new_page(width=595, height=842)
    add_header_footer(page)
    page.insert_text((60, 68), "情景-沉沦的欲望", fontsize=22, fontname="china-s")
    page.insert_text((60, 96), "观众反馈调查问卷", fontsize=14, fontname="china-s")
    page.insert_text(
        (60, 150),
        "* 1. 你对剧情的整体满意度如何？",
        fontsize=12,
        fontname="china-s",
    )
    page.insert_image(
        fitz.Rect(80, 175, 150, 205),
        stream=png_bytes((220, 220, 240)),
    )
    for y, label in [
        (225, "A. 非常满意"),
        (255, "B. 比较满意"),
        (285, "C. 一般"),
        (315, "D. 不满意"),
    ]:
        page.insert_text((90, y), label, fontsize=11, fontname="china-s")

    page.insert_text(
        (60, 370),
        "2. 你是否愿意把这部剧推荐给朋友？",
        fontsize=12,
        fontname="china-s",
    )
    page.insert_text((90, 410), "是", fontsize=11, fontname="china-s")
    page.insert_text((140, 410), "否", fontsize=11, fontname="china-s")

    # Page 2: open question and rating question.
    page = doc.new_page(width=595, height=842)
    add_header_footer(page)
    page.insert_text(
        (60, 120),
        "3. 请描述最触动你的场景。",
        fontsize=12,
        fontname="china-s",
    )
    page.insert_text(
        (60, 210),
        "4. 请为角色塑造打分。",
        fontsize=12,
        fontname="china-s",
    )
    for y, label in [
        (240, "1. 非常差"),
        (270, "2. 较差"),
        (300, "3. 一般"),
        (330, "4. 较好"),
        (360, "5. 非常好"),
    ]:
        page.insert_text((90, y), label, fontsize=11, fontname="china-s")

    # Page 3: multiple choice with long option, option media, unattached media.
    page = doc.new_page(width=595, height=842)
    add_header_footer(page)
    page.insert_text(
        (60, 120),
        "5. 以下哪些元素吸引你？(可多选)",
        fontsize=12,
        fontname="china-s",
    )
    page.insert_text(
        (90, 160),
        "A. 演员表演",
        fontsize=11,
        fontname="china-s",
    )
    page.insert_text(
        (90, 180),
        "以及他们在关键场景中的情绪细节处理",
        fontsize=10,
        fontname="china-s",
    )
    page.insert_text(
        (90, 215),
        "B. 摄影与美术",
        fontsize=11,
        fontname="china-s",
    )
    page.insert_image(
        fitz.Rect(200, 215, 260, 235),
        stream=png_bytes((230, 210, 210)),
    )
    page.insert_text(
        (90, 255),
        "C. 台词与配乐",
        fontsize=11,
        fontname="china-s",
    )
    page.insert_text(
        (60, 330),
        "6. 你对本次问卷还有哪些建议？",
        fontsize=12,
        fontname="china-s",
    )
    page.insert_image(
        fitz.Rect(430, 700, 520, 760),
        stream=png_bytes((210, 230, 210)),
    )

    doc.save(OUT_PATH)
    doc.close()
    print(OUT_PATH)


if __name__ == "__main__":
    main()
