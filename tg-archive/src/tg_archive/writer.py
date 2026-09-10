"""Channel Writer: posts normalised messages into the archive channel.

copy  - repost as your own message with #hashtag metadata (single-channel
        organisation; required because Telegram forwards cannot carry added
        tags).
forward - native forward: highest fidelity, no added tags. Server rejects
        protected chats with CHAT_FORWARDS_RESTRICTED (planner should already
        have skipped those).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .config import ArchiveConfig
from .model import NormalizedMessage

# Media that cannot be re-uploaded through a plain send_file in the MVP.
TEXT_FALLBACK_TYPES = {
    "poll",
    "dice",
    "game",
    "contact",
    "geo",
    "venue",
    "invoice",
    "webpage",
    "other",
}


@dataclass
class PostResult:
    ok: bool
    channel_message_id: Optional[int] = None
    error: str = ""
    skipped: bool = False


class ChannelWriter:
    """Stateless writer; callers are responsible for pacing and retries."""

    def __init__(self, client: Any, cfg: ArchiveConfig):
        self.client = client
        self.cfg = cfg

    async def resolve_channel(self, channel: str) -> Any:
        """Resolve and return the channel entity; verify it is a channel."""

        entity = await self.client.get_entity(channel)
        if not str(getattr(entity, "_", "")).lower().startswith("channel"):
            raise ValueError(
                f"{channel!r} is not a channel. Create a private channel and "
                "invite your account as administrator."
            )
        return entity

    async def post(
        self,
        chat_entity: Any,
        channel_entity: Any,
        message: Any,
        nm: NormalizedMessage,
        caption: str,
        mode: str,
    ) -> PostResult:
        if mode == "forward":
            return await self._forward(chat_entity, channel_entity, message)
        return await self._copy(channel_entity, message, nm, caption)

    async def _forward(
        self,
        chat_entity: Any,
        channel_entity: Any,
        message: Any,
    ) -> PostResult:
        try:
            result = await self.client.forward_messages(
                channel_entity,
                messages=[message.id],
                from_peer=chat_entity,
            )
            if isinstance(result, (list, tuple)):
                first = result[0] if result else None
                mid = getattr(first, "id", None)
            else:
                mid = getattr(result, "id", None)
            return PostResult(ok=mid is not None, channel_message_id=mid)
        except Exception as exc:  # noqa: BLE001 - surface as failed post
            return PostResult(ok=False, error=str(exc))

    async def _copy(
        self,
        channel_entity: Any,
        message: Any,
        nm: NormalizedMessage,
        caption: str,
    ) -> PostResult:
        try:
            if nm.has_media and nm.content_type not in TEXT_FALLBACK_TYPES:
                cached = await self._download(message)
                try:
                    extra: dict[str, Any] = {}
                    if nm.content_type == "voice":
                        extra["voice_note"] = True
                    elif nm.content_type == "video_note":
                        extra["video_note"] = True
                    elif nm.content_type in {"video", "animation"}:
                        extra["supports_streaming"] = True
                    sent = await self.client.send_file(
                        channel_entity,
                        file=cached,
                        caption=caption,
                        **extra,
                    )
                finally:
                    self._cleanup(cached)
            else:
                sent = await self.client.send_message(channel_entity, caption)
            mid = getattr(sent, "id", None)
            if isinstance(sent, (list, tuple)) and sent:
                mid = getattr(sent[-1], "id", None)
            return PostResult(ok=mid is not None, channel_message_id=mid)
        except Exception as exc:  # noqa: BLE001 - surface as failed post
            return PostResult(ok=False, error=str(exc))

    async def _download(self, message: Any) -> Path:
        cache_dir = self.cfg.resolved_media_cache / str(message.id)
        cache_dir.mkdir(parents=True, exist_ok=True)
        target = str(cache_dir) + os.sep  # keep original filename
        result = await self.client.download_media(message, file=target)
        if isinstance(result, (list, tuple)):
            paths = [Path(p) for p in result if p]
            if not paths:
                raise RuntimeError("download_media returned no files")
            # Album members each carry one file; take the first in the MVP.
            return paths[0]
        if result is None:
            raise RuntimeError("download_media returned nothing")
        path = Path(result)
        if not path.exists():
            # Telethon may append a guessed extension to the directory path.
            found = list(cache_dir.iterdir())
            if not found:
                raise RuntimeError(f"downloaded file missing: {path}")
            path = found[0]
        return path

    @staticmethod
    def _cleanup(path: Path) -> None:
        parent = path.parent
        try:
            if path.exists():
                path.unlink()
            if parent.exists() and parent.is_dir():
                shutil.rmtree(parent, ignore_errors=True)
        except OSError:
            pass
