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
from .model import (
    CT_ANIMATION, CT_AUDIO, CT_TEXT, CT_VIDEO, CT_VIDEO_NOTE, CT_VOICE,
    TEXT_FALLBACK_TYPES, NormalizedMessage,
)


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
        """Resolve and return the channel/supergroup entity.

        Accepts both broadcast channels and megagroups (supergroups).
        """

        from telethon.tl.types import InputPeerChannel

        entity = None
        errors: list[str] = []

        try:
            entity = await self.client.get_entity(channel)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"direct({channel!r}): {exc}")

        if entity is None and isinstance(channel, str):
            try:
                entity = await self.client.get_entity(int(channel))
            except (ValueError, Exception) as exc:
                errors.append(f"int({channel}): {exc}")

        # Telegram 无法直接按标题（显示名称）查找实体，只能遍历对话列表匹配。
        if entity is None and isinstance(channel, str):
            from telethon.tl.types import Channel

            try:
                matches = []
                async for dialog in self.client.iter_dialogs():
                    name = getattr(dialog, "name", None) or getattr(dialog, "title", None)
                    if name != channel:
                        continue
                    if isinstance(dialog.entity, Channel):
                        matches.append(dialog.entity)
                if len(matches) == 1:
                    entity = matches[0]
                elif len(matches) > 1:
                    errors.append(
                        f"title({channel!r}): 找到 {len(matches)} 个同名频道，"
                        "请改用 @username 或数字 ID 指定"
                    )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"title({channel!r}): {exc}")

        if entity is None:
            raise ValueError(
                f"无法解析归档频道 {channel!r}。"
                f"尝试: {'; '.join(errors)}。"
                "请确认频道存在且你是管理员。"
            )

        entity_type = getattr(entity, "_", type(entity).__name__).lower()
        is_channel_like = (
            "channel" in entity_type
            or "megagroup" in entity_type
            or getattr(entity, "megagroup", False)
            or getattr(entity, "broadcast", False)
            or isinstance(entity, InputPeerChannel)
        )
        if not is_channel_like:
            raise ValueError(
                f"{channel!r} 不是频道或超级群（检测到类型为 {entity_type}）。"
                "请创建一个私有频道或超级群并将你的账号添加为管理员。"
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
                    if nm.content_type == CT_VOICE:
                        extra["voice_note"] = True
                    elif nm.content_type == CT_VIDEO_NOTE:
                        extra["video_note"] = True
                    elif nm.content_type in {CT_VIDEO, CT_ANIMATION}:
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
