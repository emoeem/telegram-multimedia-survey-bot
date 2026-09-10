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

    async def resolve_chat(self, chat_input: str) -> tuple[Any, ChatInfo]:
        entity = await self.client.get_entity(chat_input)
        chat = build_chat_info(entity)
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

    async def me_id(self) -> int:
        me = await self.client.get_me()
        return int(me.id)
