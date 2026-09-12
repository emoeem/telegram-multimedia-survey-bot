"""SQLite archive layer: index + checkpoint + anti-duplicate.

Schema is a trimmed version of the research report §16: local stable primary
keys, Telegram ids as source keys, an events table for edits/deletes, and a
mirror log that makes channel writing idempotent/resumable.
"""

from __future__ import annotations

import json
import logging
import random
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .model import ChatInfo, NormalizedMessage
from .normalizer import utc_now_iso

log = logging.getLogger(__name__)

_RETRYABLE_ERRORS = (
    sqlite3.OperationalError,
    sqlite3.DatabaseError,
)


def _retry_db(
    fn: Callable[..., Any],
    *,
    retries: int = 5,
    base_delay: float = 0.1,
) -> Callable[..., Any]:
    """Wrap a function to retry on transient SQLite errors (locked, I/O, etc.)."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        last_err: Optional[Exception] = None
        for attempt in range(retries):
            try:
                return fn(*args, **kwargs)
            except _RETRYABLE_ERRORS as exc:
                last_err = exc
                msg = str(exc).lower()
                is_busy = "locked" in msg or "busy" in msg or "i/o" in msg
                if not is_busy or attempt == retries - 1:
                    raise
                delay = base_delay * (2 ** attempt) + random.random() * 0.05
                log.warning(
                    "sqlite %s on attempt %d/%d, retrying in %.2fs: %s",
                    type(exc).__name__, attempt + 1, retries, delay, exc,
                )
                time.sleep(delay)
        raise last_err  # type: ignore[misc]

    return wrapper

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    tg_user_id INTEGER UNIQUE,
    phone TEXT,
    first_name TEXT,
    last_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL DEFAULT 1,
    tg_chat_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL DEFAULT '',
    username TEXT,
    access_hash INTEGER,
    has_protected_content INTEGER NOT NULL DEFAULT 0,
    migrated_from_id INTEGER,
    last_sync_message_id INTEGER,
    sync_state TEXT NOT NULL DEFAULT 'idle',
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, tg_chat_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL DEFAULT 1,
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
    topic_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_messages_topic
    ON messages(chat_id, topic_id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    tg_message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mirror_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    tg_message_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
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
    def __init__(self, path: Path, account_id: int = 1, check_same_thread: bool = True):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            check_same_thread=check_same_thread,
        )
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA busy_timeout=30000")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        try:
            mode = self.conn.execute("PRAGMA journal_mode").fetchone()[0]
            if mode.lower() not in ("wal", "delete"):
                try:
                    self.conn.execute("PRAGMA journal_mode=WAL")
                except sqlite3.OperationalError:
                    self.conn.execute("PRAGMA journal_mode=DELETE")
        except sqlite3.OperationalError:
            pass
        self._migrate()
        self.conn.executescript(SCHEMA)
        self.account_id = account_id

    def _migrate(self) -> None:
        """Backward-compatible schema migration.

        Must run BEFORE executescript(SCHEMA) so that ALTER TABLE ADD COLUMN
        runs before CREATE INDEX tries to reference the new columns.
        """

        cols: dict[str, list[str]] = {}
        for tbl in ("chats", "messages", "accounts"):
            try:
                cols[tbl] = [r[1] for r in self.conn.execute(f"PRAGMA table_info({tbl})")]
            except sqlite3.OperationalError:
                cols[tbl] = []

        _ensure_cols = {
            "accounts": {
                "username": "ALTER TABLE accounts ADD COLUMN username TEXT",
                "first_name": "ALTER TABLE accounts ADD COLUMN first_name TEXT",
                "last_name": "ALTER TABLE accounts ADD COLUMN last_name TEXT",
                "is_active": "ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
            },
            "chats": {
                "account_id": "ALTER TABLE chats ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
                "migrated_from_id": "ALTER TABLE chats ADD COLUMN migrated_from_id INTEGER",
                "last_sync_message_id": "ALTER TABLE chats ADD COLUMN last_sync_message_id INTEGER",
                "sync_state": "ALTER TABLE chats ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'idle'",
                "raw_json": "ALTER TABLE chats ADD COLUMN raw_json TEXT",
                "updated_at": "ALTER TABLE chats ADD COLUMN updated_at TEXT",
            },
            "messages": {
                "account_id": "ALTER TABLE messages ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
                "topic_id": "ALTER TABLE messages ADD COLUMN topic_id INTEGER",
                "is_outgoing": "ALTER TABLE messages ADD COLUMN is_outgoing INTEGER NOT NULL DEFAULT 0",
                "can_be_saved": "ALTER TABLE messages ADD COLUMN can_be_saved INTEGER NOT NULL DEFAULT 1",
                "deleted_at": "ALTER TABLE messages ADD COLUMN deleted_at TEXT",
                "forward_from_msg_id": "ALTER TABLE messages ADD COLUMN forward_from_msg_id INTEGER",
                "media_json": "ALTER TABLE messages ADD COLUMN media_json TEXT",
                "raw_json": "ALTER TABLE messages ADD COLUMN raw_json TEXT",
            },
        }

        for tbl, required in _ensure_cols.items():
            existing = cols.get(tbl, [])
            if not existing:
                continue
            for col, alter_sql in required.items():
                if col not in existing:
                    self.conn.execute(alter_sql)

        # --- Fix UNIQUE constraints that SQLite ALTER TABLE cannot add ---
        self._ensure_chats_unique()
        self._ensure_messages_unique()

    def _ensure_chats_unique(self) -> None:
        """Rebuild chats table if missing UNIQUE(account_id, tg_chat_id)."""
        create_sql = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chats'"
        ).fetchone()
        if create_sql is None:
            return
        has_composite = "UNIQUE (account_id, tg_chat_id)" in create_sql[0]
        if has_composite:
            return
        old_cols = [r[1] for r in self.conn.execute("PRAGMA table_info(chats)")]
        new_cols = [
            "id", "account_id", "tg_chat_id", "type", "title", "username",
            "access_hash", "has_protected_content", "migrated_from_id",
            "last_sync_message_id", "sync_state", "raw_json", "updated_at",
        ]
        col_exprs = []
        not_null_defaults = {
            "account_id": "1",
            "type": "'other'",
            "title": "''",
            "has_protected_content": "0",
            "sync_state": "'idle'",
            "updated_at": "datetime('now')",
        }
        for c in new_cols:
            if c in old_cols:
                if c in not_null_defaults:
                    col_exprs.append(f"COALESCE({c}, {not_null_defaults[c]})")
                else:
                    col_exprs.append(c)
            elif c in not_null_defaults:
                col_exprs.append(not_null_defaults[c])
            else:
                col_exprs.append("NULL")
        self.conn.executescript(f"""
            CREATE TABLE _chats_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL DEFAULT 1,
                tg_chat_id INTEGER NOT NULL,
                type TEXT NOT NULL DEFAULT 'other',
                title TEXT NOT NULL DEFAULT '',
                username TEXT,
                access_hash INTEGER,
                has_protected_content INTEGER NOT NULL DEFAULT 0,
                migrated_from_id INTEGER,
                last_sync_message_id INTEGER,
                sync_state TEXT NOT NULL DEFAULT 'idle',
                raw_json TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (account_id, tg_chat_id)
            );
            INSERT INTO _chats_new ({', '.join(new_cols)})
            SELECT {', '.join(col_exprs)} FROM chats;
            DROP TABLE chats;
            ALTER TABLE _chats_new RENAME TO chats;
        """)

    def _ensure_messages_unique(self) -> None:
        """Rebuild messages table if missing proper unique constraints."""
        create_sql = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
        ).fetchone()
        if create_sql is None:
            return
        has_composite = "UNIQUE (chat_id, tg_message_id)" in create_sql[0]
        if has_composite:
            return
        old_cols = [r[1] for r in self.conn.execute("PRAGMA table_info(messages)")]
        new_cols = [
            "id", "chat_id", "account_id", "tg_message_id", "sender_id", "date",
            "edit_date", "content_type", "text", "has_media", "media_json",
            "grouped_id", "reply_to_msg_id", "reply_to_chat_id", "topic_id",
            "forward_from_chat_id", "forward_from_msg_id", "is_outgoing",
            "can_be_saved", "deleted_at", "raw_json",
        ]
        col_exprs = []
        not_null_defaults = {
            "account_id": "1",
            "has_media": "0",
            "is_outgoing": "0",
            "can_be_saved": "1",
            "content_type": "'text'",
            "text": "''",
        }
        for c in new_cols:
            if c in old_cols:
                if c in not_null_defaults:
                    col_exprs.append(f"COALESCE({c}, {not_null_defaults[c]})")
                else:
                    col_exprs.append(c)
            elif c in not_null_defaults:
                col_exprs.append(not_null_defaults[c])
            else:
                col_exprs.append("NULL")
        self.conn.executescript(f"""
            CREATE TABLE _msg_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                account_id INTEGER NOT NULL DEFAULT 1,
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
                topic_id INTEGER,
                forward_from_chat_id INTEGER,
                forward_from_msg_id INTEGER,
                is_outgoing INTEGER NOT NULL DEFAULT 0,
                can_be_saved INTEGER NOT NULL DEFAULT 1,
                deleted_at TEXT,
                raw_json TEXT,
                UNIQUE (chat_id, tg_message_id)
            );
            INSERT INTO _msg_new ({', '.join(new_cols)})
            SELECT {', '.join(col_exprs)} FROM messages;
            DROP TABLE messages;
            ALTER TABLE _msg_new RENAME TO messages;
        """)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "ArchiveDB":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ chats

    def upsert_chat(self, chat: ChatInfo, account_id: Optional[int] = None) -> int:
        aid = account_id or self.account_id
        cur = self.conn.execute(
            """
            INSERT INTO chats (account_id, tg_chat_id, type, title, username,
                               access_hash, has_protected_content, raw_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(account_id, tg_chat_id) DO UPDATE SET
                type = excluded.type,
                title = excluded.title,
                username = excluded.username,
                access_hash = excluded.access_hash,
                has_protected_content = excluded.has_protected_content,
                raw_json = excluded.raw_json,
                updated_at = datetime('now')
            """,
            (
                aid,
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
            "SELECT id FROM chats WHERE account_id = ? AND tg_chat_id = ?",
            (aid, chat.tg_chat_id),
        ).fetchone()
        return int(row["id"])

    def get_chat(self, tg_chat_id: int, account_id: Optional[int] = None) -> Optional[dict[str, Any]]:
        aid = account_id or self.account_id
        row = self.conn.execute(
            "SELECT * FROM chats WHERE account_id = ? AND tg_chat_id = ?",
            (aid, tg_chat_id),
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
        account_id: Optional[int] = None,
    ) -> tuple[int, int]:
        """Insert or update messages; returns (inserted, updated)."""

        aid = account_id or self.account_id
        inserted = updated = 0
        for msg in messages:
            topic_id = getattr(msg, "topic_id", None)
            cur = self.conn.execute(
                """
                INSERT INTO messages (
                    chat_id, account_id, tg_message_id, sender_id, date, edit_date,
                    content_type, text, has_media, media_json, grouped_id,
                    reply_to_msg_id, reply_to_chat_id, topic_id,
                    forward_from_chat_id, forward_from_msg_id,
                    is_outgoing, can_be_saved, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id, tg_message_id) DO NOTHING
                """,
                (
                    chat_local_id,
                    aid,
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
                    topic_id,
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
                    has_media = ?, media_json = ?, grouped_id = ?, topic_id = ?,
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
                    topic_id,
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

    def stats(self, account_id: Optional[int] = None) -> dict[str, Any]:
        aid = account_id or self.account_id
        counts: dict[str, Any] = {}
        counts["accounts"] = int(
            self.conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        )
        counts["chats"] = int(
            self.conn.execute("SELECT COUNT(*) FROM chats WHERE account_id = ?", (aid,)).fetchone()[0]
        )
        counts["messages"] = int(
            self.conn.execute("SELECT COUNT(*) FROM messages WHERE account_id = ?", (aid,)).fetchone()[0]
        )
        counts["mirrored"] = int(
            self.conn.execute(
                """
                SELECT COUNT(*) FROM mirror_log l
                JOIN messages m ON m.chat_id = l.chat_id AND m.tg_message_id = l.tg_message_id
                WHERE m.account_id = ? AND l.status = 'done'
                """,
                (aid,),
            ).fetchone()[0]
        )
        counts["pending"] = int(
            self.conn.execute(
                """
                SELECT COUNT(*)
                FROM messages m
                LEFT JOIN mirror_log l
                       ON l.chat_id = m.chat_id
                      AND l.tg_message_id = m.tg_message_id
                WHERE m.account_id = ? AND m.deleted_at IS NULL AND l.id IS NULL
                """,
                (aid,),
            ).fetchone()[0]
        )
        counts["failed"] = int(
            self.conn.execute(
                """
                SELECT COUNT(*) FROM mirror_log l
                JOIN messages m ON m.chat_id = l.chat_id AND m.tg_message_id = l.tg_message_id
                WHERE m.account_id = ? AND l.status = 'failed'
                """,
                (aid,),
            ).fetchone()[0]
        )
        counts["events"] = int(
            self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        )
        return counts

    # -------------------------------------------------------------- accounts

    def save_account(
        self,
        *,
        tg_user_id: int,
        username: Optional[str] = None,
        phone: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
    ) -> int:
        self.conn.execute(
            """
            INSERT INTO accounts (tg_user_id, username, phone, first_name, last_name, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(tg_user_id) DO UPDATE SET
                username = excluded.username,
                phone = excluded.phone,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                is_active = 1
            """,
            (tg_user_id, username, phone, first_name, last_name),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT id FROM accounts WHERE tg_user_id = ?", (tg_user_id,)
        ).fetchone()
        return int(row["id"])

    def list_accounts(self) -> list[dict[str, Any]]:
        return [
            dict(r) for r in self.conn.execute(
                "SELECT * FROM accounts ORDER BY id"
            ).fetchall()
        ]

    def get_account(self, account_id: int) -> Optional[dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM accounts WHERE id = ?", (account_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_chats(self, account_id: Optional[int] = None) -> list[dict[str, Any]]:
        aid = account_id or self.account_id
        return [
            dict(r) for r in self.conn.execute(
                "SELECT * FROM chats WHERE account_id = ? ORDER BY updated_at DESC",
                (aid,),
            ).fetchall()
        ]
