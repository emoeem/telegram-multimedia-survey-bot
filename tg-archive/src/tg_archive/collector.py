"""MTProto collector on top of Telethon (a normal user session).

Only reads chats the logged-in account can access. All Telegram objects are
normalised before leaving this module.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Callable, Optional

from .config import ArchiveConfig
from .model import ChatInfo, NormalizedMessage
from .normalizer import build_chat_info, normalize_message

PAGE_SIZE = 200


class Collector:
    """Thin async wrapper over a connected TelegramClient."""

    def __init__(
        self,
        client: Any,
        cfg: ArchiveConfig,
        progress: Optional[Callable[[str], None]] = None,
    ):
        self.client = client
        self.cfg = cfg
        self.progress = progress or (lambda _text: None)

    async def resolve_chat(self, chat_input: Any, *, db_row: Optional[dict[str, Any]] = None) -> tuple[Any, ChatInfo]:
        """Resolve a chat from a string id, username, or entity.

        Tries get_entity first, then falls back to building an InputPeer
        from a previously cached db row (has access_hash) when the entity
        can no longer be fetched from Telegram directly.
        """

        entity = None
        errors: list[str] = []

        # 1. Direct try with the original input
        try:
            entity = await self.client.get_entity(chat_input)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"direct({chat_input!r}): {exc}")

        # 2. If it was a numeric string, also try as int
        if entity is None and isinstance(chat_input, str):
            try:
                as_int = int(chat_input)
                entity = await self.client.get_entity(as_int)
            except (ValueError, Exception) as exc:
                errors.append(f"int({chat_input}): {exc}")

        # 3. Fallback: build InputPeer from cached db row
        if entity is None and db_row is not None and db_row.get("access_hash"):
            from telethon.tl.types import InputPeerChannel, InputPeerChat, InputPeerUser

            tg_id = int(db_row["tg_chat_id"])
            ah = int(db_row["access_hash"]) if db_row["access_hash"] else 0
            if tg_id < -1000000000000:
                inner_id = -(10**12) - tg_id
                entity = InputPeerChannel(channel_id=inner_id, access_hash=ah)
            elif tg_id < 0:
                entity = InputPeerChat(chat_id=-tg_id)
            else:
                entity = InputPeerUser(user_id=tg_id, access_hash=ah)

        if entity is None:
            raise ValueError(
                f"cannot resolve chat {chat_input!r}. "
                f"Tried: {'; '.join(errors)}. "
                f"Maybe the channel is no longer accessible or session expired."
            )

        chat = build_chat_info(entity)
        if chat.tg_chat_id == 0 and db_row:
            chat = ChatInfo(
                tg_chat_id=int(db_row["tg_chat_id"]),
                type=db_row.get("type", "other"),
                title=db_row.get("title", ""),
                username=db_row.get("username"),
                access_hash=int(db_row["access_hash"]) if db_row.get("access_hash") else None,
                has_protected_content=bool(db_row.get("has_protected_content")),
                raw={},
            )
        if chat.tg_chat_id == 0:
            raise ValueError(f"cannot resolve chat id for {chat_input!r}")
        return entity, chat

    async def dialogs(self) -> list[ChatInfo]:
        out: list[ChatInfo] = []
        async for dialog in self.client.iter_dialogs(limit=None):
            chat = build_chat_info(dialog.entity)
            if not chat.title and dialog.name:
                chat = ChatInfo(
                    tg_chat_id=chat.tg_chat_id,
                    type=chat.type,
                    title=dialog.name,
                    username=chat.username,
                    access_hash=chat.access_hash,
                    has_protected_content=chat.has_protected_content,
                    raw=chat.raw,
                )
            out.append(chat)
        return out

    async def fetch_history(
        self,
        entity: Any,
        chat: ChatInfo,
        *,
        after_id: Optional[int] = None,
        total_limit: Optional[int] = None,
    ) -> list[NormalizedMessage]:
        """Fetch messages newer than ``after_id`` (newest first internally).

        Returns normalised messages in ascending chronological order.
        """

        collected: list[NormalizedMessage] = []
        async for page in self.iter_history(entity, chat, after_id=after_id):
            for item in page:
                collected.append(item)
                if total_limit is not None and len(collected) >= total_limit:
                    collected.sort(key=lambda m: (m.date, m.tg_message_id))
                    return collected
        collected.sort(key=lambda m: (m.date, m.tg_message_id))
        return collected

    async def iter_history(
        self,
        entity: Any,
        chat: ChatInfo,
        *,
        after_id: Optional[int] = None,
    ) -> AsyncIterator[list[NormalizedMessage]]:
        """Yield normalised history pages (newest page first, ids descending)."""

        offset_id = 0
        while True:
            page = await self._fetch_page(entity, offset_id, after_id)
            if not page:
                return
            yield [normalize_message(raw_message, chat) for raw_message in page]
            offset_id = page[-1].id
            if len(page) < PAGE_SIZE:
                return

    async def _fetch_page(self, entity: Any, offset_id: int, after_id: Optional[int]):
        from telethon.errors import FloodWaitError

        for attempt in range(4):
            try:
                return await self.client.get_messages(
                    entity,
                    limit=PAGE_SIZE,
                    offset_id=offset_id,
                    min_id=after_id or 0,
                )
            except FloodWaitError as exc:
                wait = min(max(int(getattr(exc, "seconds", 30)), 1), 300)
                self.progress(f"  ⏳ 同步 FloodWait ~{wait}s（第 {attempt + 1} 次重试）")
                await asyncio.sleep(wait)
        return await self.client.get_messages(
            entity,
            limit=PAGE_SIZE,
            offset_id=offset_id,
            min_id=after_id or 0,
        )

    async def get_message(self, entity: Any, msg_id: int) -> Optional[Any]:
        result = await self.client.get_messages(entity, ids=[msg_id])
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return result

    async def get_messages_batch(self, entity: Any, msg_ids: list[int]) -> dict[int, Any]:
        if not msg_ids:
            return {}
        result = await self.client.get_messages(entity, ids=msg_ids)
        by_id: dict[int, Any] = {}
        for msg in (result if isinstance(result, (list, tuple)) else [result]):
            mid = getattr(msg, "id", None)
            if mid is not None:
                by_id[int(mid)] = msg
        return by_id

    async def me_id(self) -> int:
        me = await self.client.get_me()
        return int(me.id)
