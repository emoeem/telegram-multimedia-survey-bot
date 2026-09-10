"""Convert Telethon objects into the internal model.

The normalizer works primarily on ``Message.to_dict()`` output so parsing is
stable and unit-testable without a live connection.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .model import ChatInfo, NormalizedMessage


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat(timespec="seconds")
    return str(value)


def peer_to_chat_id(peer: Any) -> Optional[int]:
    """Normalise a TL peer (dict from to_dict, or TL object) to a chat id int."""

    if peer is None:
        return None
    if isinstance(peer, dict):
        kind = peer.get("_", "")
        if kind == "PeerUser":
            return int(peer.get("user_id", 0))
        if kind == "PeerChat":
            return int(peer.get("chat_id", 0))
        if kind == "PeerChannel":
            return -(10**12) - int(peer.get("channel_id", 0))
        # Entities serialised to dict
        if kind in {"User", "Chat", "Channel", "ChatForbidden", "ChannelForbidden"}:
            cid = int(peer.get("id", 0))
            if kind in {"Channel", "ChannelForbidden"} and cid > 0:
                return -(10**12) - cid
            return cid
        return None

    # TL objects
    try:
        from telethon.utils import get_peer_id

        return get_peer_id(peer)
    except Exception:  # telethon unavailable or unexpected object
        raw_id = getattr(peer, "id", None)
        return int(raw_id) if raw_id is not None else None


def _first(d: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in d and d[key] is not None:
            return d[key]
    return default


def _media_kind(raw: dict[str, Any]) -> Optional[str]:
    media = raw.get("media")
    if media is None:
        return None
    kind = media.get("_", "")
    if kind.startswith("MessageMedia"):
        inner = kind[len("MessageMedia") :]
    else:
        inner = kind
    return inner


def _media_details(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Best-effort media metadata; download uses the original message, not this."""

    media = raw.get("media")
    if media is None:
        return []
    kind = _media_kind(raw) or "media"
    info: dict[str, Any] = {"kind": kind}
    inner = media.get(kind[:1].lower() + kind[1:]) or media.get("photo") or media.get("document")
    if isinstance(inner, dict):
        if "id" in inner:
            info["tg_file_id"] = inner.get("id")
        if "size" in inner:
            info["size_bytes"] = inner.get("size")
        if "dc_id" in inner:
            info["dc_id"] = inner.get("dc_id")
        if "mime_type" in inner:
            info["mime_type"] = inner.get("mime_type")
        attrs = inner.get("attributes") or []
        for attr in attrs:
            aname = (attr.get("_") or "").lower()
            if aname == "documentattributefilename":
                info["file_name"] = attr.get("file_name")
            elif aname == "documentattributemime":  # legacy
                info["mime_type"] = attr.get("mime_type")
            elif "video" in aname:
                info.update(
                    {
                        k: attr.get(k)
                        for k in ("duration", "w", "h")
                        if attr.get(k) is not None
                    }
                )
            elif "audio" in aname:
                info.update(
                    {
                        k: attr.get(k)
                        for k in ("duration", "title", "performer")
                        if attr.get(k) is not None
                    }
                )
    sizes = inner.get("sizes") if isinstance(inner, dict) else None
    if isinstance(sizes, list) and sizes:
        photo_sizes = [
            s
            for s in sizes
            if isinstance(s, dict)
            and s.get("_")
            in {"PhotoSize", "PhotoSizeProgressive", "PhotoCachedSize"}
        ]
        if photo_sizes:
            largest = max(
                photo_sizes,
                key=lambda s: int(s.get("size", 0) or 0),
            )
            info["width"] = largest.get("w")
            info["height"] = largest.get("h")
    return [info]


def _media_mime(raw: dict[str, Any]) -> str:
    details = _media_details(raw)
    return str(details[0].get("mime_type", "")) if details else ""


def _document_attrs(raw: dict[str, Any]) -> list[str]:
    media = raw.get("media") or {}
    doc = media.get("document") or {}
    return [str(attr.get("_", "")) for attr in doc.get("attributes") or []]


def normalize_message(message: Any, chat: Optional[ChatInfo] = None) -> NormalizedMessage:
    """Turn a Telethon Message (or test double with to_dict()) into a stable row."""

    if hasattr(message, "to_dict") and callable(getattr(message, "to_dict")):
        raw = dict(message.to_dict() or {})
    else:
        raw = dict(getattr(message, "raw", {}) or {})

    chat_id = peer_to_chat_id(raw.get("peer_id"))
    if chat_id is None and chat is not None:
        chat_id = chat.tg_chat_id
    if chat_id is None:
        raise ValueError("cannot determine chat id from message")

    media_kind = _media_kind(raw)
    action = raw.get("action") or {}
    action_kind = action.get("_") if isinstance(action, dict) else None
    is_service = action_kind is not None

    text = raw.get("message") or ""
    if not isinstance(text, str):
        text = ""

    if is_service:
        content_type = "service"
    elif media_kind == "Photo":
        content_type = "photo"
    elif media_kind == "Document":
        content_type = "document"
        mime = _media_mime(raw)
        attrs = _document_attrs(raw)
        if "DocumentAttributeVideo" in attrs or "DocumentAttributeVideoName" in attrs:
            content_type = "video"
        elif "DocumentAttributeAudio" in attrs:
            content_type = "audio"
        elif "DocumentAttributeAnimated" in attrs or "video" in mime:
            content_type = "animation"
        elif "audio" in mime:
            content_type = "audio"
    elif media_kind in {
        "Sticker",
        "Video",
        "Audio",
        "Voice",
        "Animation",
        "VideoNote",
        "Contact",
    }:
        content_type = media_kind.lower()
    elif media_kind in {"Poll", "Game", "Dice", "GeoPoint", "Venue", "Invoice", "WebPage"}:
        content_type = media_kind.lower()
    elif media_kind == "Empty" or media_kind is None:
        content_type = "text"
    else:
        content_type = "other"

    from_peer = raw.get("from_id") or raw.get("from")
    sender_id = peer_to_chat_id(from_peer)

    reply = raw.get("reply_to") or {}
    reply_to = None
    reply_chat = None
    if isinstance(reply, dict):
        reply_to = reply.get("reply_to_msg_id") or reply.get("reply_to_random_id")
        reply_peer = reply.get("reply_to_peer_id")
        if reply_peer is not None:
            reply_chat = peer_to_chat_id(reply_peer)

    fwd = raw.get("fwd_from") or {}
    fwd_chat = None
    fwd_msg = None
    if isinstance(fwd, dict):
        fwd_chat = peer_to_chat_id(fwd.get("from_id"))
        fwd_msg = fwd.get("channel_post")

    # Message-level protection is a chat flag in MTProto; the "can be saved"
    # decision mirrors that flag so later stages can enforce the default policy.
    can_be_saved = True
    if chat is not None and chat.has_protected_content:
        can_be_saved = False

    return NormalizedMessage(
        tg_chat_id=chat_id,
        tg_message_id=int(raw.get("id", 0)),
        date=_iso(raw.get("date")) or utc_now_iso(),
        edit_date=_iso(raw.get("edit_date")),
        content_type=content_type,
        text=text,
        has_media=media_kind not in {None, "Empty"} and not is_service,
        media=_media_details(raw) if media_kind not in {None, "Empty"} else [],
        sender_id=sender_id,
        grouped_id=raw.get("grouped_id"),
        reply_to_msg_id=reply_to,
        reply_to_chat_id=reply_chat,
        forward_from_chat_id=fwd_chat,
        forward_from_msg_id=fwd_msg,
        is_outgoing=bool(raw.get("out")),
        can_be_saved=can_be_saved,
        is_service=is_service,
        raw=raw,
    )


def chat_type_of(entity: Any) -> str:
    kind = str(getattr(entity, "_", type(entity).__name__)).lower()
    if "user" in kind:
        return "private"
    if "channel" in kind:
        return "channel"
    if "chat" in kind:
        return "group"
    return "other"


def chat_has_protection(entity: Any) -> bool:
    if entity is None:
        return False
    direct = getattr(entity, "has_protected_content", None)
    if direct is not None:
        return bool(direct)
    noforwards = getattr(entity, "noforwards", None)
    if noforwards is not None:
        return bool(noforwards)
    raw = getattr(entity, "to_dict", None)
    if callable(raw):
        d = raw()
        return bool(d.get("noforwards") or d.get("has_protected_content"))
    return False


def build_chat_info(entity: Any) -> ChatInfo:
    """Snapshot chat metadata for the local index."""

    raw = {}
    if hasattr(entity, "to_dict") and callable(getattr(entity, "to_dict")):
        raw = dict(entity.to_dict() or {})
    kind = chat_type_of(entity)

    if raw.get("_") and "id" in raw:
        cid = peer_to_chat_id(raw)
    else:
        cid = peer_to_chat_id(entity)
    if cid is None:
        cid = int(raw.get("id", 0))
    if kind in {"channel", "supergroup"} and cid and cid > 0:
        cid = -(10**12) - cid

    title = ""
    if hasattr(entity, "title"):
        title = entity.title or ""
    if not title and hasattr(entity, "first_name"):
        title = " ".join(
            part
            for part in (
                getattr(entity, "first_name", None),
                getattr(entity, "last_name", None),
            )
            if part
        )

    return ChatInfo(
        tg_chat_id=cid,
        type=kind,
        title=title,
        username=getattr(entity, "username", None),
        access_hash=getattr(entity, "access_hash", None),
        has_protected_content=chat_has_protection(entity),
        raw=raw,
    )
