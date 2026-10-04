from tg_archive.captions import (
    CAPTION_LIMIT,
    TEXT_LIMIT,
    CaptionOptions,
    build_caption,
    hashtag,
    idempotency_marker,
)
from tg_archive.model import NormalizedMessage


def test_hashtag_sanitizes():
    assert hashtag("My 中文 Chat!", "chat") == "chat_My_中文_Chat"
    assert hashtag("2026-09", "date") == "date_2026_09"
    assert hashtag("42", "user") == "user_42"
    assert hashtag("", "user") == "user"
    assert hashtag("a  b  c", "x") == "x_a_b_c"


def test_caption_text_contains_tags_and_source():
    nm = NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=5,
        date="2026-09-07T04:00:00+00:00",
        content_type="text",
        text="原文内容",
        sender_id=42,
    )
    caption = build_caption(nm, "我的群", CaptionOptions())
    assert "#chat_我的群" in caption
    assert "#user_42" in caption
    assert "#date_2026_09" in caption
    assert "原文内容" in caption
    assert "我的群 · msg 5" in caption
    assert len(caption) <= 4000


def test_media_caption_capped():
    nm = NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=6,
        date="2026-09-07T04:00:00+00:00",
        content_type="photo",
        text="x" * 3000,
        has_media=True,
        media=[{"kind": "Photo"}],
    )
    caption = build_caption(nm, "群", CaptionOptions())
    assert len(caption) <= CAPTION_LIMIT
    assert "…(截断)" in caption
    # the source line is the tail of the caption: truncating the assembled
    # string used to drop it, leaving the post untraceable
    assert caption.endswith("群 · msg 6")


def test_long_text_keeps_source_line_and_link():
    """Over-long text must lose body characters, never the metadata."""
    nm = NormalizedMessage(
        tg_chat_id=-1001234567890,
        tg_message_id=777,
        date="2026-09-07T04:00:00+00:00",
        content_type="text",
        text="长" * 5000,
    )
    caption = build_caption(nm, "源频道", CaptionOptions(include_link=True))
    assert len(caption) <= TEXT_LIMIT
    assert "msg 777" in caption
    assert "t.me/c/1234567890/777" in caption
    assert "…(截断)" in caption
    # a short message is still emitted verbatim
    short = NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=1,
        date="2026-09-07T04:00:00+00:00",
        content_type="text",
        text="hi",
    )
    assert "hi" in build_caption(short, "群", CaptionOptions())


def test_no_tags_when_disabled():
    nm = NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=1,
        date="2026-01-01T00:00:00+00:00",
        content_type="text",
        text="hi",
    )
    caption = build_caption(
        nm,
        "群",
        CaptionOptions(chat_tag=False, user_tag=False, date_tag=False, marker=False),
    )
    assert "#" not in caption


def test_caption_carries_a_unique_idempotency_marker():
    a = idempotency_marker(-1001234567890, 5)
    b = idempotency_marker(-1001234567890, 6)
    c = idempotency_marker(-100999, 5)
    assert a.startswith("#m_")
    assert len({a, b, c}) == 3

    nm = NormalizedMessage(
        tg_chat_id=-1001234567890,
        tg_message_id=5,
        date="2026-09-07T04:00:00+00:00",
        content_type="text",
        text="hi",
    )
    assert a in build_caption(nm, "群", CaptionOptions())
    assert a not in build_caption(nm, "群", CaptionOptions(marker=False))
