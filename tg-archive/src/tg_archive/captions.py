"""Caption / hashtag strategy for channel posts.

Research report appendix A.5.1: a single private channel organised with
hashtags like #chat:<name>, #user:<id>, #2026-09. This module builds those
tags plus a compact source line. Forward mode cannot attach extra text, so the
tags only apply to the copy writer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .model import NormalizedMessage

TEXT_LIMIT = 4000  # safe margin under Telegram's 4096 char message limit
CAPTION_LIMIT = 1024  # media caption limit
ELLIPSIS = "\n…(截断)"


@dataclass(frozen=True)
class CaptionOptions:
    chat_tag: bool = True
    user_tag: bool = True
    date_tag: bool = True
    include_link: bool = False


def hashtag(value: str, prefix: str) -> str:
    """Turn arbitrary title/id into a searchable tag like ``#chat_my_group``.

    Telegram treats ':' and '-' as word separators, so ``#chat:name`` or
    ``#2026-09`` would not be searchable as one tag. Underscores and a letter
    prefix are used instead.
    """

    text = re.sub(r"[^\w\u4e00-\u9fff]+", "_", str(value), flags=re.UNICODE)
    text = text.strip("_")
    text = re.sub(r"_+", "_", text)
    if not text:
        return prefix
    return f"{prefix}_{text[:64]}"


def build_tags(
    chat_title: str,
    chat_id: int,
    sender_id: Optional[int],
    date_iso: str,
    opts: CaptionOptions,
) -> str:
    tags: list[str] = []
    if opts.chat_tag:
        tags.append("#" + hashtag(chat_title or str(chat_id), "chat"))
    if opts.user_tag:
        if sender_id is not None:
            tags.append("#" + hashtag(str(sender_id), "user"))
        else:
            tags.append("#user_none")
    if opts.date_tag:
        tags.append("#" + hashtag(date_iso[:7], "date"))
    return " ".join(tags)


def source_line(
    chat_title: str,
    chat_id: int,
    tg_message_id: int,
    date_iso: str,
    include_link: bool,
) -> str:
    when = date_iso.replace("T", " ")[:16] + " UTC"
    line = f"📅 {when} · 📌 {chat_title or chat_id} · msg {tg_message_id}"
    if include_link:
        cid = chat_id
        if cid < -1000000000000:
            link_id = str(-(cid + 10**12))
            line += f"\n🔗 https://t.me/c/{link_id}/{tg_message_id}"
        elif chat_id > 0:
            # Users/private chats cannot be deep linked by numeric id reliably.
            line += "\n🔗 (private chat, no public link)"
    return line


def _fit(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - len(ELLIPSIS)]
    # cut at a line break when possible
    br = cut.rfind("\n")
    if br > limit // 2:
        cut = cut[:br]
    return cut + ELLIPSIS


def build_caption(
    msg: NormalizedMessage,
    chat_title: str,
    opts: CaptionOptions,
) -> str:
    """Compose the channel post body for copy mode."""

    tags = build_tags(
        chat_title,
        msg.tg_chat_id,
        msg.sender_id,
        msg.date,
        opts,
    )
    meta = source_line(
        chat_title,
        msg.tg_chat_id,
        msg.tg_message_id,
        msg.date,
        opts.include_link,
    )
    body = msg.text or ""
    if msg.has_media:
        # Media caption: hashtags + original caption + source line.
        content = "\n".join(part for part in (tags, body, meta) if part)
        return _fit(content, CAPTION_LIMIT)
    content = "\n".join(part for part in (tags, body, meta) if part)
    return _fit(content, TEXT_LIMIT)
