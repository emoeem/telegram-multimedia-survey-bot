"""Mirror engine: collect -> index -> plan -> write to the archive channel.

The engine is intentionally conservative:
  * protected chats (has_protected_content / noforwards) are skipped by
    default; only an explicit ``--protected text_only`` opt-in mirrors plain
    text, never media, and never in forward mode (the server refuses it).
  * service messages are never mirrored.
  * a mirror log makes the process idempotent and resumable.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .captions import CaptionOptions, build_caption
from .collector import Collector
from .config import ArchiveConfig
from .db import ArchiveDB
from .model import NormalizedMessage
from .normalizer import normalize_message, peer_to_chat_id
from .writer import ChannelWriter, PostResult


@dataclass
class MirrorStats:
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    posted: int = 0
    failed: int = 0
    skipped: int = 0


def _flood_seconds(error: str) -> int:
    match = re.search(r"A wait of (\d+) seconds", error, re.IGNORECASE)
    if match:
        return min(int(match.group(1)), 300)
    if "flood" in error.lower():
        return 20
    return 0


class MirrorEngine:
    def __init__(
        self,
        client: Any,
        cfg: ArchiveConfig,
        db: ArchiveDB,
        *,
        dry_run: bool = False,
        yes: bool = False,
        listen: bool = False,
        progress: Callable[[str], None] = print,
        account_id: int = 1,
        topic_id: Optional[int] = None,
        include_topics: Optional[list[int]] = None,
        exclude_topics: Optional[list[int]] = None,
    ):
        self.client = client
        self.cfg = cfg
        self.db = db
        self.dry_run = dry_run
        self.yes = yes
        self.listen = listen
        self.progress = progress
        self.account_id = account_id
        self.topic_id = topic_id
        self.include_topics = set(include_topics) if include_topics else None
        self.exclude_topics = set(exclude_topics) if exclude_topics else None
        self.stats = MirrorStats()
        self.collector = Collector(client, cfg, progress=self.progress)
        self.writer = ChannelWriter(client, cfg)

    # ------------------------------------------------------------------ run

    async def run(self, chat_input: str, channel_input: Optional[str] = None) -> int:
        chat_db_row = self._find_cached_chat(chat_input)
        entity, chat = await self.collector.resolve_chat(chat_input, db_row=chat_db_row)
        channel_target = channel_input or self.cfg.channel

        if chat.type in {"private", "group"} and not self.dry_run:
            self.progress(
                "⚠️  归档私聊/普通群到频道会把内容复制成你自己的帖子，"
                "只应归档你有权且允许这样使用的聊天。"
            )

        if channel_target:
            channel_entity = await self.writer.resolve_channel(channel_target)
            if self._same_peer(chat.tg_chat_id, channel_entity):
                raise ValueError("source chat and archive channel must be different")
        else:
            channel_entity = None

        chat_local_id = self.db.upsert_chat(chat)
        cursor = self.db.get_last_sync_id(chat_local_id)
        sync_state = self.db.get_sync_state(chat_local_id)
        incremental = sync_state == "synced" and cursor is not None

        self.progress(
            f"📥 同步 {chat.title or chat.tg_chat_id} "
            f"(type={chat.type}, protected={'是' if chat.has_protected_content else '否'})"
        )
        total_fetched = 0
        new_rows = 0
        newest_seen = cursor or 0
        complete = True
        async for page in self.collector.iter_history(
            entity,
            chat,
            after_id=cursor if incremental else None,
        ):
            page = [m for m in page if self._topic_match(m)]
            if not page:
                continue
            inserted, updated = self.db.upsert_messages(
                chat_local_id, page, account_id=self.account_id,
            )
            self.stats.fetched += len(page)
            self.stats.inserted += inserted
            self.stats.updated += updated
            total_fetched += len(page)
            new_rows += inserted
            newest_seen = max(newest_seen, *(m.tg_message_id for m in page))
            self.progress(
                f"  同步中… 已入库 {total_fetched} 条"
                f"（新增 {self.stats.inserted} / 更新 {self.stats.updated}）"
            )
            if self.cfg.fetch_limit is not None and new_rows >= self.cfg.fetch_limit:
                complete = False
                self.progress(
                    f"  ⏸  本次新增达到上限 {self.cfg.fetch_limit} 条；"
                    "下次运行会重扫并幂等跳过已入库页，继续补齐更旧的消息。"
                )
                break

        if complete:
            if total_fetched:
                self.db.set_sync_cursor(chat_local_id, newest_seen)
                self.progress(f"  ✅ 同步完成，游标推进到 #{newest_seen}")
            elif not incremental:
                # Chat exists but has no messages: pin the cursor so later
                # incremental runs do not refetch the whole history every time.
                self.db.set_sync_cursor(chat_local_id, 0)

        protected = bool(chat.has_protected_content)

        if protected and self.cfg.protected_policy != "skip":
            reopened = self.db.clear_skipped_protected(
                chat_local_id, self.cfg.writer_mode
            )
            if reopened:
                self.progress(
                    f"  ↻ 已重新开启 {reopened} 条此前因保护策略跳过的消息"
                    f"（当前策略：{self.cfg.protected_policy}）"
                )

        pending = self.db.pending_mirror(
            chat_local_id,
            mode=self.cfg.writer_mode,
            limit=self.cfg.max_posts,
            media_only=self.cfg.media_only,
            since=self.cfg.since,
            until=self.cfg.until,
        )

        if protected and self.cfg.protected_policy == "skip":
            for row in pending:
                self.db.mark_skipped(
                    chat_local_id,
                    row["tg_message_id"],
                    self.cfg.writer_mode,
                    "protected chat (default policy)",
                )
                self.stats.skipped += 1
            self.progress(
                f"⛔ 源聊天启用了内容保护：按默认策略 {self.stats.skipped} 条未写入频道"
                "（仅保留本地索引）。如需归档请显式使用 "
                "--protected text_only（仅文字）或 --protected allow_media（含媒体，高风险）。"
            )
            pending = []

        if self.dry_run:
            self._show_plan(pending, protected)
            return 0

        if not pending:
            self.progress("✅ 没有待写入频道的消息。")
            if self.listen:
                await self._listen_loop(entity, chat, chat_local_id, channel_entity)
            return 0

        if not channel_entity:
            raise ValueError(
                "no archive channel configured: pass --channel or set "
                "TG_ARCHIVE_CHANNEL in .env"
            )

        label = f"将把 {len(pending)} 条消息以 "
        label += "copy（带 #标签）" if self.cfg.writer_mode == "copy" else "forward（原样转发）"
        label += f" 写入 {channel_target}（本次最多 {self.cfg.max_posts} 条）"
        self.progress(label)
        if protected and self.cfg.protected_policy == "text_only":
            self.progress(
                "⚠️  高级模式：受保护聊天仅复制纯文字消息，媒体一律不复制。"
                "复制仍可能违背源聊天所有者的意图，请自行确认你有权这样做。"
            )
        if protected and self.cfg.protected_policy == "allow_media":
            self.progress(
                "⛔ 高级模式 allow_media：将对受保护聊天执行「下载 → 重发」，"
                "绕过源聊天设置的保存/转发限制。"
            )
            self.progress(
                "   这违背聊天所有者的保存意图并违反 Telegram 平台规则，"
                "可能导致账号被风控/封禁；只应在你确认有权这样做的聊天上使用。"
            )
        if not self.yes:
            answer = input("继续？[y/N] ").strip().lower()
            if answer not in {"y", "yes"}:
                self.progress("已取消。")
                return 1

        await self._write_pending(
            entity,
            chat,
            chat_local_id,
            channel_entity,
            pending,
        )
        self._show_stats()
        if self.listen:
            await self._listen_loop(entity, chat, chat_local_id, channel_entity)
        return 0

    # ------------------------------------------------------------- helpers

    def _topic_match(self, msg: NormalizedMessage) -> bool:
        """Return True if the message should be included given topic filters."""
        if self.topic_id is not None:
            return msg.topic_id == self.topic_id
        if self.include_topics is not None:
            if not self.include_topics:
                return True
            return msg.topic_id in self.include_topics
        if self.exclude_topics is not None and msg.topic_id in self.exclude_topics:
            return False
        return True

    # ------------------------------------------------------------- decisions

    def _find_cached_chat(self, chat_input: Any) -> Optional[dict[str, Any]]:
        """Look up a previously seen chat in the local index.

        Returns a db row dict if found (with tg_chat_id, access_hash, etc.),
        which resolve_chat can use to build an InputPeer as fallback.
        """

        assert self.db is not None
        try:
            as_int = int(chat_input)
        except (TypeError, ValueError):
            as_int = None

        rows = self.db.conn.execute(
            "SELECT * FROM chats WHERE account_id = ?", (self.account_id,)
        ).fetchall()
        for row in rows:
            d = dict(row)
            tg_id = d.get("tg_chat_id")
            if str(tg_id) == str(chat_input) or (as_int is not None and tg_id == as_int):
                return d
            if d.get("username") and d["username"] == str(chat_input).lstrip("@"):
                return d
        return None

    def _decision(
        self,
        row: dict[str, Any],
        chat: Any,
        protected: bool,
    ) -> tuple[bool, str]:
        """Return (should_post, skip_reason)."""

        content_type = row["content_type"]
        if content_type == "service" or content_type.startswith("service"):
            return False, "service message"
        if row["deleted_at"]:
            return False, "deleted"
        if protected:
            reason = self._protected_skip_reason(
                self.cfg.protected_policy,
                self.cfg.writer_mode,
                bool(row["has_media"]),
            )
            if reason:
                return False, reason
        return True, ""

    @staticmethod
    def _protected_skip_reason(
        policy: str,
        mode: str,
        has_media: bool,
    ) -> str:
        """Return a skip reason when the current policy forbids this message."""

        if policy == "skip":
            return "protected chat (default policy)"
        if mode == "forward":
            return "protected chat cannot be forwarded"
        if policy == "text_only" and has_media:
            return "protected chat media never copied under text_only"
        return ""

    async def _write_pending(
        self,
        entity: Any,
        chat: Any,
        chat_local_id: int,
        channel_entity: Any,
        pending: list[dict[str, Any]],
    ) -> None:
        protected = bool(chat.has_protected_content)
        decided: list[dict[str, Any]] = []
        for row in pending:
            should, reason = self._decision(row, chat, protected)
            if not should:
                self.db.mark_skipped(
                    chat_local_id,
                    row["tg_message_id"],
                    self.cfg.writer_mode,
                    reason,
                )
                self.stats.skipped += 1
                continue
            decided.append(row)

        BATCH = 100
        raw_by_id: dict[int, Any] = {}
        for i in range(0, len(decided), BATCH):
            batch_ids = [r["tg_message_id"] for r in decided[i : i + BATCH]]
            raw_by_id.update(
                await self.collector.get_messages_batch(entity, batch_ids)
            )

        for row in decided:
            mid = row["tg_message_id"]
            raw_message = raw_by_id.get(mid)
            if raw_message is None:
                self.db.mark_skipped(
                    chat_local_id,
                    mid,
                    self.cfg.writer_mode,
                    "message gone from source since sync",
                )
                self.stats.skipped += 1
                continue

            nm = normalize_message(raw_message, chat)
            if nm.is_service:
                self.db.mark_skipped(
                    chat_local_id,
                    row["tg_message_id"],
                    self.cfg.writer_mode,
                    "service message",
                )
                self.stats.skipped += 1
                continue

            caption = ""
            if self.cfg.writer_mode == "copy":
                caption = build_caption(
                    nm,
                    chat.title,
                    CaptionOptions(
                        chat_tag=self.cfg.chat_tag,
                        user_tag=self.cfg.user_tag,
                        date_tag=self.cfg.date_tag,
                        include_link=self.cfg.include_link,
                    ),
                )

            result = await self._post_with_retry(
                entity,
                channel_entity,
                raw_message,
                nm,
                caption,
            )
            if result.ok:
                self.db.mark_mirrored(
                    chat_local_id,
                    row["tg_message_id"],
                    self.cfg.writer_mode,
                    peer_to_chat_id(channel_entity) or 0,
                    int(result.channel_message_id or 0),
                )
                self.stats.posted += 1
                self.progress(
                    f"  ✅ #{row['tg_message_id']} -> #{result.channel_message_id}"
                )
                if self.cfg.post_delay_seconds > 0:
                    await asyncio.sleep(self.cfg.post_delay_seconds)
            else:
                self.db.mark_failed(
                    chat_local_id,
                    row["tg_message_id"],
                    self.cfg.writer_mode,
                    result.error,
                )
                self.stats.failed += 1
                self.progress(f"  ❌ #{row['tg_message_id']}: {result.error[:180]}")

    async def _post_with_retry(
        self,
        entity: Any,
        channel_entity: Any,
        raw_message: Any,
        nm: NormalizedMessage,
        caption: str,
    ) -> PostResult:
        for _ in range(3):
            result = await self.writer.post(
                entity,
                channel_entity,
                raw_message,
                nm,
                caption,
                self.cfg.writer_mode,
            )
            if result.ok or not result.error:
                return result
            wait = _flood_seconds(result.error)
            if wait > 0:
                self.progress(f"  ⏳ FloodWait ~{wait}s，稍候重试…")
                await asyncio.sleep(wait)
                continue
            return result
        return result

    # ------------------------------------------------------------ reporting

    def _show_plan(self, pending: list[dict[str, Any]], protected: bool) -> None:
        if not pending:
            self.progress("🔎 干跑：没有待写入消息（未连接到频道）。")
            return
        self.progress(f"🔎 干跑：将写入 {len(pending)} 条（不会真正发送）。前 20 条：")
        for row in pending[:20]:
            text = (row["text"] or "").replace("\n", " ")[:60]
            marker = "🛡️" if protected else "  "
            self.progress(
                f"  {marker} #{row['tg_message_id']} [{row['content_type']}] {text}"
            )
        if len(pending) > 20:
            self.progress(f"  … 其余 {len(pending) - 20} 条")

    def _show_stats(self) -> None:
        s = self.stats
        self.progress(
            f"📊 本次：同步 {s.fetched}（新增 {s.inserted} / 更新 {s.updated}），"
            f"写入频道 {s.posted}，跳过 {s.skipped}，失败 {s.failed}"
        )
        total = self.db.stats()
        self.progress(
            f"🗄  本地索引：聊天 {total['chats']}，消息 {total['messages']}，"
            f"已镜像 {total['mirrored']}，待处理 {total['pending']}"
        )

    @staticmethod
    def _same_peer(chat_id: int, channel_entity: Any) -> bool:
        raw = getattr(channel_entity, "to_dict", None)
        channel_id = None
        if callable(raw):
            channel_id = (raw() or {}).get("id")
        if channel_id is None:
            channel_id = getattr(channel_entity, "id", None)
        if channel_id is not None and channel_id > 0:
            # entity id for a channel is the inner positive id
            expected = -(10**12) - channel_id
        else:
            expected = channel_id
        return chat_id == expected

    # ----------------------------------------------------------------- listen

    async def _listen_loop(
        self,
        entity: Any,
        chat: Any,
        chat_local_id: int,
        channel_entity: Any,
    ) -> None:
        from telethon import events

        chat_id = chat.tg_chat_id

        @self.client.on(events.NewMessage(chats=entity))
        async def on_new(event: Any) -> None:
            nm = normalize_message(event.message, chat)
            if nm.is_service:
                return
            if not self._topic_match(nm):
                return
            self.db.upsert_messages(chat_local_id, [nm], account_id=self.account_id)
            self.db.set_sync_cursor(
                chat_local_id,
                max(nm.tg_message_id, self.db.get_last_sync_id(chat_local_id) or 0),
            )
            await self._mirror_one(
                entity, chat, chat_local_id, channel_entity, nm, event.message
            )

        @self.client.on(events.MessageEdited(chats=entity))
        async def on_edit(event: Any) -> None:
            nm = normalize_message(event.message, chat)
            self.db.upsert_messages(chat_local_id, [nm], account_id=self.account_id)
            self.db.log_event(
                chat_local_id,
                nm.tg_message_id,
                "edit",
                {"text": nm.text[:500]},
            )

        @self.client.on(events.MessageDeleted())
        async def on_delete(event: Any) -> None:
            if getattr(event, "chat_id", None) != chat_id:
                return
            for deleted_id in getattr(event, "deleted_ids", []) or []:
                self.db.mark_deleted(chat_local_id, deleted_id)

        self.progress("👂 监听中… Ctrl+C 退出。新消息将同步并写入频道。")
        await self.client.run_until_disconnected()

    async def _mirror_one(
        self,
        entity: Any,
        chat: Any,
        chat_local_id: int,
        channel_entity: Any,
        nm: NormalizedMessage,
        raw_message: Any,
    ) -> None:
        if self.dry_run or channel_entity is None:
            return
        if chat.has_protected_content:
            reason = self._protected_skip_reason(
                self.cfg.protected_policy,
                self.cfg.writer_mode,
                nm.has_media,
            )
            if reason:
                self.db.mark_skipped(
                    chat_local_id,
                    nm.tg_message_id,
                    self.cfg.writer_mode,
                    reason,
                )
                return
        if self.db.mirror_status(
            chat_local_id, nm.tg_message_id, self.cfg.writer_mode
        ):
            return

        caption = ""
        if self.cfg.writer_mode == "copy":
            caption = build_caption(
                nm,
                chat.title,
                CaptionOptions(
                    chat_tag=self.cfg.chat_tag,
                    user_tag=self.cfg.user_tag,
                    date_tag=self.cfg.date_tag,
                    include_link=self.cfg.include_link,
                ),
            )
        result = await self._post_with_retry(
            entity,
            channel_entity,
            raw_message,
            nm,
            caption,
        )
        if result.ok:
            self.db.mark_mirrored(
                chat_local_id,
                nm.tg_message_id,
                self.cfg.writer_mode,
                peer_to_chat_id(channel_entity) or 0,
                int(result.channel_message_id or 0),
            )
        else:
            self.db.mark_failed(
                chat_local_id,
                nm.tg_message_id,
                self.cfg.writer_mode,
                result.error,
            )
            self.progress(f"  ❌ 新消息 #{nm.tg_message_id}: {result.error[:180]}")
