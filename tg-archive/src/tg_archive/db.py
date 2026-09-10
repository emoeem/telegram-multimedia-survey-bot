"""SQLite archive layer: index + checkpoint + anti-duplicate.

Schema is a trimmed version of the research report §16: local stable primary
keys, Telegram ids as source keys, an events table for edits/deletes, and a
mirror log that makes channel writing idempotent/resumable.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from .model import ChatInfo, NormalizedMessage
from .normalizer import utc_now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER UNIQUE,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_chat_id INTEGER UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL DEFAULT '',
    username TEXT,
    access_hash INTEGER,
    has_protected_content INTEGER NOT NULL DEFAULT 0,
    migrated_from_id INTEGER,
    last_sync_message_id INTEGER,
    sync_state TEXT NOT NULL DEFAULT 'idle',
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    tg_message_id INTEGER NOT NULL,
    sender_id INTEGER,
    date TEXT NOT NULL,
    edit_date TEXT,
    content_type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    has_media INTEGER NOT NULL DEFAULT 0,
    media_json TEXT,
    grouped_id INTEGER,
    reply_to_msg_id INTEGER,
    reply_to_chat_id INTEGER,
    forward_from_chat_id INTEGER,
    forward_from_msg_id INTEGER,
    is_outgoing INTEGER NOT NULL DEFAULT 0,
    can_be_saved INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    raw_json TEXT,
    UNIQUE (chat_id, tg_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_date
    ON messages(chat_id, date, tg_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_grouped
    ON messages(chat_id, grouped_id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    tg_message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- new | edit | delete
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mirror_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    tg_message_id INTEGER NOT NULL,
    mode TEXT NOT NULL,                -- copy | forward
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | skipped | failed
    attempt INTEGER NOT NULL DEFAULT 0,
    channel_id INTEGER,
    channel_message_id INTEGER,
    skip_reason TEXT,
    last_error TEXT,
    mirrored_at TEXT,
    UNIQUE (chat_id, tg_message_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_mirror_log_status
    ON mirror_log(status, chat_id);
"""


class ArchiveDB:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "ArchiveDB":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ chats

    def upsert_chat(self, chat: ChatInfo) -> int:
        cur = self.conn.execute(
            """
            INSERT INTO chats (tg_chat_id, type, title, username, access_hash,
                               has_protected_content, raw_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(tg_chat_id) DO UPDATE SET
                type = excluded.type,
                title = excluded.title,
                username = excluded.username,
                access_hash = excluded.access_hash,
                has_protected_content = excluded.has_protected_content,
                raw_json = excluded.raw_json,
                updated_at = datetime('now')
            """,
            (
                chat.tg_chat_id,
                chat.type,
                chat.title,
                chat.username,
                chat.access_hash,
                1 if chat.has_protected_content else 0,
                json.dumps(chat.raw, ensure_ascii=False, default=str),
            ),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT id FROM chats WHERE tg_chat_id = ?", (chat.tg_chat_id,)
        ).fetchone()
        return int(row["id"])

    def get_chat(self, tg_chat_id: int) -> Optional[dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM chats WHERE tg_chat_id = ?", (tg_chat_id,)
        ).fetchone()
        return dict(row) if row else None

    def set_sync_cursor(self, chat_local_id: int, last_message_id: int) -> None:
        self.conn.execute(
            """
            UPDATE chats
            SET last_sync_message_id = ?, sync_state = 'synced',
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (last_message_id, chat_local_id),
        )
        self.conn.commit()

    def get_last_sync_id(self, chat_local_id: int) -> Optional[int]:
        row = self.conn.execute(
            "SELECT last_sync_message_id FROM chats WHERE id = ?", (chat_local_id,)
        ).fetchone()
        if row is None:
            return None
        return row["last_sync_message_id"]

    def get_sync_state(self, chat_local_id: int) -> Optional[str]:
        row = self.conn.execute(
            "SELECT sync_state FROM chats WHERE id = ?", (chat_local_id,)
        ).fetchone()
        return row["sync_state"] if row else None

    # --------------------------------------------------------------- messages

    def upsert_messages(
        self,
        chat_local_id: int,
        messages: Iterable[NormalizedMessage],
    ) -> tuple[int, int]:
        """Insert or update messages; returns (inserted, updated)."""

        inserted = updated = 0
        for msg in messages:
            cur = self.conn.execute(
                """
                INSERT INTO messages (
                    chat_id, tg_message_id, sender_id, date, edit_date,
                    content_type, text, has_media, media_json, grouped_id,
                    reply_to_msg_id, reply_to_chat_id, forward_from_chat_id,
                    forward_from_msg_id, is_outgoing, can_be_saved, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id, tg_message_id) DO NOTHING
                """,
                (
                    chat_local_id,
                    msg.tg_message_id,
                    msg.sender_id,
                    msg.date,
                    msg.edit_date,
                    msg.content_type,
                    msg.text,
                    1 if msg.has_media else 0,
                    json.dumps(msg.media, ensure_ascii=False, default=str),
                    msg.grouped_id,
                    msg.reply_to_msg_id,
                    msg.reply_to_chat_id,
                    msg.forward_from_chat_id,
                    msg.forward_from_msg_id,
                    1 if msg.is_outgoing else 0,
                    1 if msg.can_be_saved else 0,
                    json.dumps(msg.raw, ensure_ascii=False, default=str),
                ),
            )
            if cur.rowcount == 1:
                inserted += 1
                continue
            self.conn.execute(
                """
                UPDATE messages
                SET sender_id = ?, edit_date = ?, content_type = ?, text = ?,
                    has_media = ?, media_json = ?, grouped_id = ?,
                    is_outgoing = ?, can_be_saved = ?, raw_json = ?
                WHERE chat_id = ? AND tg_message_id = ?
                """,
                (
                    msg.sender_id,
                    msg.edit_date,
                    msg.content_type,
                    msg.text,
                    1 if msg.has_media else 0,
                    json.dumps(msg.media, ensure_ascii=False, default=str),
                    msg.grouped_id,
                    1 if msg.is_outgoing else 0,
                    1 if msg.can_be_saved else 0,
                    json.dumps(msg.raw, ensure_ascii=False, default=str),
                    chat_local_id,
                    msg.tg_message_id,
                ),
            )
            updated += 1
        self.conn.commit()
        return inserted, updated

    def log_event(
        self,
        chat_local_id: int,
        tg_message_id: int,
        kind: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> None:
        self.conn.execute(
            "INSERT INTO events (chat_id, tg_message_id, kind, payload_json) VALUES (?, ?, ?, ?)",
            (
                chat_local_id,
                tg_message_id,
                kind,
                json.dumps(payload or {}, ensure_ascii=False, default=str),
            ),
        )
        self.conn.commit()

    def mark_deleted(self, chat_local_id: int, tg_message_id: int) -> None:
        self.conn.execute(
            "UPDATE messages SET deleted_at = ? WHERE chat_id = ? AND tg_message_id = ?",
            (utc_now_iso(), chat_local_id, tg_message_id),
        )
        self.log_event(chat_local_id, tg_message_id, "delete")

    def get_message_row(self, chat_local_id: int, tg_message_id: int) -> Optional[dict[str, Any]]:
        row = self.conn.execute(
            """
            SELECT m.*, c.tg_chat_id AS tg_chat_id, c.title AS chat_title,
                   c.type AS chat_type, c.has_protected_content
            FROM messages m JOIN chats c ON c.id = m.chat_id
            WHERE m.chat_id = ? AND m.tg_message_id = ?
            """,
            (chat_local_id, tg_message_id),
        ).fetchone()
        return dict(row) if row else None

    # ---------------------------------------------------------------- mirror

    def pending_mirror(
        self,
        chat_local_id: int,
        mode: str,
        limit: int,
        *,
        media_only: bool = False,
        since: Optional[str] = None,
        until: Optional[str] = None,
        include_failed: bool = True,
        max_attempts: int = 5,
    ) -> list[dict[str, Any]]:
        """Rows that still need to be written to the channel, oldest first."""

        clauses = ["m.chat_id = ?", "m.deleted_at IS NULL"]
        params: list[Any] = [mode, chat_local_id]
        if media_only:
            clauses.append("m.has_media = 1")
        if since:
            clauses.append("m.date >= ?")
            params.append(since)
        if until:
            clauses.append("m.date < ?")
            params.append(until)
        if include_failed:
            clauses.append(
                """(
                    l.id IS NULL
                    OR (l.status = 'failed' AND l.attempt < ?)
                )"""
            )
            params.append(max_attempts)
        else:
            clauses.append("l.id IS NULL")
        params.append(limit)

        rows = self.conn.execute(
            f"""
            SELECT m.*, c.tg_chat_id AS src_tg_chat_id, c.title AS chat_title,
                   c.type AS chat_type, c.has_protected_content,
                   l.status AS mirror_status, l.attempt AS mirror_attempt
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN mirror_log l
                   ON l.chat_id = m.chat_id
                  AND l.tg_message_id = m.tg_message_id
                  AND l.mode = ?
            WHERE {' AND '.join(clauses)}
            ORDER BY m.date ASC, m.tg_message_id ASC
            LIMIT ?
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def mirror_status(
        self,
        chat_local_id: int,
        tg_message_id: int,
        mode: str,
    ) -> Optional[dict[str, Any]]:
        row = self.conn.execute(
            """
            SELECT * FROM mirror_log
            WHERE chat_id = ? AND tg_message_id = ? AND mode = ?
            """,
            (chat_local_id, tg_message_id, mode),
        ).fetchone()
        return dict(row) if row else None

    def mark_mirrored(
        self,
        chat_local_id: int,
        tg_message_id: int,
        mode: str,
        channel_id: int,
        channel_message_id: int,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO mirror_log (
                chat_id, tg_message_id, mode, status, attempt,
                channel_id, channel_message_id, mirrored_at
            ) VALUES (?, ?, ?, 'done', 1, ?, ?, datetime('now'))
            ON CONFLICT(chat_id, tg_message_id, mode) DO UPDATE SET
                status = 'done',
                channel_id = excluded.channel_id,
                channel_message_id = excluded.channel_message_id,
                last_error = NULL,
                mirrored_at = datetime('now')
            """,
            (chat_local_id, tg_message_id, mode, channel_id, channel_message_id),
        )
        self.conn.commit()

    def mark_skipped(
        self,
        chat_local_id: int,
        tg_message_id: int,
        mode: str,
        reason: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO mirror_log (
                chat_id, tg_message_id, mode, status, attempt, skip_reason
            ) VALUES (?, ?, ?, 'skipped', 1, ?)
            ON CONFLICT(chat_id, tg_message_id, mode) DO UPDATE SET
                status = 'skipped',
                skip_reason = excluded.skip_reason,
                last_error = NULL
            """,
            (chat_local_id, tg_message_id, mode, reason),
        )
        self.conn.commit()

    def clear_skipped_protected(self, chat_local_id: int, mode: str) -> int:
        """Reopen rows that were skipped because of content protection.

        Called when the user switches from the default skip policy to an
        explicit advanced policy (text_only / allow_media), so previously
        skipped messages become eligible again for the current mode.
        """

        cur = self.conn.execute(
            """
            DELETE FROM mirror_log
            WHERE chat_id = ? AND mode = ? AND status = 'skipped'
              AND (skip_reason LIKE 'protected%' OR skip_reason LIKE '%protection%')
            """,
            (chat_local_id, mode),
        )
        self.conn.commit()
        return int(cur.rowcount or 0)

    def mark_failed(
        self,
        chat_local_id: int,
        tg_message_id: int,
        mode: str,
        error: str,
        max_attempts: int = 5,
    ) -> None:
        existing = self.mirror_status(chat_local_id, tg_message_id, mode)
        attempt = (existing["attempt"] if existing else 0) + 1
        status = "failed" if attempt < max_attempts else "skipped"
        self.conn.execute(
            """
            INSERT INTO mirror_log (
                chat_id, tg_message_id, mode, status, attempt, last_error
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, tg_message_id, mode) DO UPDATE SET
                status = excluded.status,
                attempt = excluded.attempt,
                last_error = excluded.last_error,
                skip_reason = CASE WHEN excluded.status = 'skipped'
                    THEN 'too many failures: ' || excluded.last_error
                    ELSE skip_reason END
            """,
            (chat_local_id, tg_message_id, mode, status, attempt, error[:500]),
        )
        self.conn.commit()

    # ----------------------------------------------------------------- stats

    def stats(self) -> dict[str, Any]:
        counts: dict[str, Any] = {}
        for name, table in (
            ("chats", "chats"),
            ("messages", "messages"),
            ("mirrored", "mirror_log"),
            ("events", "events"),
        ):
            counts[name] = int(
                self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            )
        counts["pending"] = int(
            self.conn.execute(
                """
                SELECT COUNT(*)
                FROM messages m
                LEFT JOIN mirror_log l
                       ON l.chat_id = m.chat_id
                      AND l.tg_message_id = m.tg_message_id
                WHERE m.deleted_at IS NULL AND l.id IS NULL
                """
            ).fetchone()[0]
        )
        counts["failed"] = int(
            self.conn.execute(
                "SELECT COUNT(*) FROM mirror_log WHERE status = 'failed'"
            ).fetchone()[0]
        )
        return counts
