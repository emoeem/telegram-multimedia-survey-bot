"""Internal stable data model (Normalizer output).

Telegram objects are normalised into these dataclasses before touching the
database or the channel writer, so switching collectors (TDLib / MTProto / Web)
does not ripple through the rest of the pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


CT_TEXT = "text"
CT_SERVICE = "service"
CT_PHOTO = "photo"
CT_DOCUMENT = "document"
CT_VIDEO = "video"
CT_AUDIO = "audio"
CT_ANIMATION = "animation"
CT_STICKER = "sticker"
CT_VOICE = "voice"
CT_VIDEO_NOTE = "video_note"
CT_CONTACT = "contact"
CT_POLL = "poll"
CT_DICE = "dice"
CT_GAME = "game"
CT_GEO = "geo"
CT_VENUE = "venue"
CT_INVOICE = "invoice"
CT_WEBPAGE = "webpage"
CT_OTHER = "other"

TEXT_FALLBACK_TYPES = frozenset({
    CT_POLL, CT_DICE, CT_GAME, CT_CONTACT, CT_GEO, CT_VENUE,
    CT_INVOICE, CT_WEBPAGE, CT_OTHER,
})

SERVICE_ACTIONS = {
    "MessageActionChatAddUser",
    "MessageActionChatDeleteUser",
    "MessageActionChatEditTitle",
    "MessageActionChatEditPhoto",
    "MessageActionChatDeletePhoto",
    "MessageActionChatJoinedByLink",
    "MessageActionChatCreate",
    "MessageActionChannelCreate",
    "MessageActionChannelMigrateFrom",
    "MessageActionChatMigrateTo",
    "MessageActionPinMessage",
    "MessageActionHistoryClear",
    "MessageActionGroupCall",
    "MessageActionTopicCreate",
    "MessageActionTopicEdit",
    "MessageActionTopicDelete",
    "MessageActionSetMessagesTTL",
    "MessageActionSecureValuesSent",
}


@dataclass(frozen=True)
class ChatInfo:
    """Minimal snapshot of a chat relevant for mirroring decisions."""

    tg_chat_id: int
    type: str  # private | bot | group | supergroup | channel
    title: str = ""
    username: Optional[str] = None
    access_hash: Optional[int] = None
    has_protected_content: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedMessage:
    """One message in the stable archive model."""

    tg_chat_id: int
    tg_message_id: int
    date: str  # ISO-8601 UTC
    content_type: str  # text|photo|video|document|audio|voice|sticker|animation|...
    text: str  # message body (for media: caption)
    has_media: bool = False
    media: list[dict[str, Any]] = field(default_factory=list)
    sender_id: Optional[int] = None
    edit_date: Optional[str] = None
    grouped_id: Optional[int] = None
    reply_to_msg_id: Optional[int] = None
    reply_to_chat_id: Optional[int] = None
    topic_id: Optional[int] = None
    forward_from_chat_id: Optional[int] = None
    forward_from_msg_id: Optional[int] = None
    is_outgoing: bool = False
    can_be_saved: bool = True
    is_service: bool = False
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def in_album(self) -> bool:
        return self.grouped_id is not None
