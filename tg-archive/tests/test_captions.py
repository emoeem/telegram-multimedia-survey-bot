from tg_archive.captions import (
    CAPTION_LIMIT,
    CaptionOptions,
    build_caption,
    hashtag,
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
    assert caption.endswith("…(截断)")


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
        CaptionOptions(chat_tag=False, user_tag=False, date_tag=False),
    )
    assert "#" not in caption
