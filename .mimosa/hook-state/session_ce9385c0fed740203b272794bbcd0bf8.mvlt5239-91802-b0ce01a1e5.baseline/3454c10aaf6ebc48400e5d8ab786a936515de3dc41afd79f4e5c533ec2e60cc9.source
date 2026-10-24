"""SQLite archive layer: index + checkpoint + anti-duplicate.

Schema is a trimmed version of the research report §16: local stable primary
keys, Telegram ids as source keys, an events table for edits/deletes, and a
mirror log that makes channel writing idempotent/resumable.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from .model import ChatInfo, NormalizedMessage
from .normalizer import utc_now_iso

log = logging.getLogger(__name__)

# Lock contention is handled by PRAGMA busy_timeout (see ArchiveDB.__init__).
# A Python-level retry wrapper was removed: it slept synchronously inside
# async request handlers, and it was never applied to any method anyway.



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

-- Account-scoped listings (web /api/messages, /api/stats) filter on
-- account_id and order by date, which none of the chat-scoped indexes serve.
CREATE INDEX IF NOT EXISTS idx_messages_account_date
    ON messages(account_id, deleted_at, date DESC, tg_message_id DESC);

CREATE INDEX IF NOT EXISTS idx_mirror_log_lookup
    ON mirror_log(chat_id, tg_message_id, mirrored_at, id);

CREATE INDEX IF NOT EXISTS idx_events_chat
    ON events(chat_id, tg_message_id);
"""

# Columns every table must have on top of the legacy schema. ADD COLUMN with a
# constant default only: SQLite rejects a non-constant default (e.g.
# datetime('now')) in ALTER TABLE.
_ENSURE_COLS: dict[str, dict[str, str]] = {
    "accounts": {
        "username": "ALTER TABLE accounts ADD COLUMN username TEXT",
        "first_name": "ALTER TABLE accounts ADD COLUMN first_name TEXT",
        "last_name": "ALTER TABLE accounts ADD COLUMN last_name TEXT",
        "is_active": "ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
    },
    "chats": {
        "account_id": "ALTER TABLE chats ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
        "type": "ALTER TABLE chats ADD COLUMN type TEXT NOT NULL DEFAULT 'other'",
        "title": "ALTER TABLE chats ADD COLUMN title TEXT NOT NULL DEFAULT ''",
        "username": "ALTER TABLE chats ADD COLUMN username TEXT",
        "access_hash": "ALTER TABLE chats ADD COLUMN access_hash INTEGER",
        "has_protected_content": (
            "ALTER TABLE chats ADD COLUMN has_protected_content INTEGER NOT NULL DEFAULT 0"
        ),
        "migrated_from_id": "ALTER TABLE chats ADD COLUMN migrated_from_id INTEGER",
        "last_sync_message_id": "ALTER TABLE chats ADD COLUMN last_sync_message_id INTEGER",
        "sync_state": "ALTER TABLE chats ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'idle'",
        "raw_json": "ALTER TABLE chats ADD COLUMN raw_json TEXT",
        "updated_at": "ALTER TABLE chats ADD COLUMN updated_at TEXT",
    },
    "messages": {
        "account_id": "ALTER TABLE messages ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
        "sender_id": "ALTER TABLE messages ADD COLUMN sender_id INTEGER",
        "edit_date": "ALTER TABLE messages ADD COLUMN edit_date TEXT",
        "grouped_id": "ALTER TABLE messages ADD COLUMN grouped_id INTEGER",
        "reply_to_msg_id": "ALTER TABLE messages ADD COLUMN reply_to_msg_id INTEGER",
        "reply_to_chat_id": "ALTER TABLE messages ADD COLUMN reply_to_chat_id INTEGER",
        "topic_id": "ALTER TABLE messages ADD COLUMN topic_id INTEGER",
        "forward_from_chat_id": "ALTER TABLE messages ADD COLUMN forward_from_chat_id INTEGER",
        "forward_from_msg_id": "ALTER TABLE messages ADD COLUMN forward_from_msg_id INTEGER",
        "is_outgoing": "ALTER TABLE messages ADD COLUMN is_outgoing INTEGER NOT NULL DEFAULT 0",
        "can_be_saved": "ALTER TABLE messages ADD COLUMN can_be_saved INTEGER NOT NULL DEFAULT 1",
        "deleted_at": "ALTER TABLE messages ADD COLUMN deleted_at TEXT",
        "media_json": "ALTER TABLE messages ADD COLUMN media_json TEXT",
        "raw_json": "ALTER TABLE messages ADD COLUMN raw_json TEXT",
    },
    # SCHEMA's idx_mirror_log_lookup references mirrored_at, so a legacy
    # mirror_log without it would abort executescript(SCHEMA).
    "mirror_log": {
        "status": "ALTER TABLE mirror_log ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
        "attempt": "ALTER TABLE mirror_log ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
        "channel_id": "ALTER TABLE mirror_log ADD COLUMN channel_id INTEGER",
        "channel_message_id": "ALTER TABLE mirror_log ADD COLUMN channel_message_id INTEGER",
        "skip_reason": "ALTER TABLE mirror_log ADD COLUMN skip_reason TEXT",
        "last_error": "ALTER TABLE mirror_log ADD COLUMN last_error TEXT",
        "mirrored_at": "ALTER TABLE mirror_log ADD COLUMN mirrored_at TEXT",
    },
    "events": {
        "payload_json": "ALTER TABLE events ADD COLUMN payload_json TEXT",
    },
}


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
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._enable_wal()
        # _migrate() toggles foreign_keys itself (only possible outside a
        # transaction) and re-enables it before returning.
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.account_id = account_id

    def _enable_wal(self) -> None:
        """Put the database in WAL mode.

        A brand-new file reports ``delete``, so the old guard
        ``if mode not in ("wal", "delete")`` never switched it on and every
        fresh install ran in rollback-journal mode (readers block writers).
        """

        try:
            mode = self.conn.execute("PRAGMA journal_mode").fetchone()[0]
            if mode.lower() in ("wal", "memory"):
                return
            try:
                self.conn.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                # e.g. a filesystem without shared-memory support: keep the
                # journal mode we already have rather than failing to open.
                pass
        except sqlite3.OperationalError:
            pass

    def _migrate(self) -> None:
        """Backward-compatible schema migration (additive and transactional).

        Only ever *adds* columns and *creates* unique indexes -- it never
        rebuilds a table with DROP TABLE. ``messages.chat_id`` references
        ``chats(id) ON DELETE CASCADE``, and SQLite performs an implicit
        ``DELETE FROM chats`` when a parent table is dropped while foreign
        keys are enabled, which silently wiped every indexed message. Missing
        uniqueness is expressed as a UNIQUE INDEX instead: an upsert's
        ``ON CONFLICT`` target is satisfied by a unique index just as well as
        by a table constraint.

        Must run BEFORE executescript(SCHEMA) so that ALTER TABLE ADD COLUMN
        runs before CREATE INDEX tries to reference the new columns.
        """

        cols: dict[str, list[str]] = {}
        for tbl in tuple(_ENSURE_COLS):
            try:
                cols[tbl] = [r[1] for r in self.conn.execute(f"PRAGMA table_info({tbl})")]
            except sqlite3.OperationalError:
                cols[tbl] = []

        # foreign_keys can only be toggled outside a transaction. Nothing here
        # drops a table any more, but re-pointing rows while merging duplicate
        # chats must not trip the ON DELETE CASCADE either.
        if self.conn.in_transaction:  # defensive: pragma would be a no-op
            self.conn.commit()
        self.conn.execute("PRAGMA foreign_keys=OFF")
        previous_isolation = self.conn.isolation_level
        self.conn.isolation_level = None  # take explicit BEGIN/COMMIT control
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                self._add_missing_columns(cols)
                self._ensure_unique_index(
                    "chats", "uq_chats_account_tg", ("account_id", "tg_chat_id")
                )
                self._ensure_unique_index(
                    "messages", "uq_messages_chat_msg", ("chat_id", "tg_message_id")
                )
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
        finally:
            self.conn.isolation_level = previous_isolation
            self.conn.execute("PRAGMA foreign_keys=ON")

        violations = self.conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            log.warning(
                "foreign key violations remain after migration: %s",
                [tuple(v) for v in violations[:10]],
            )

    def _add_missing_columns(self, cols: dict[str, list[str]]) -> None:
        for tbl, required in _ENSURE_COLS.items():
            existing = cols.get(tbl, [])
            if not existing:
                continue  # table not created yet: SCHEMA will do it
            for col, alter_sql in required.items():
                if col not in existing:
                    self.conn.execute(alter_sql)

    def _ensure_unique_index(
        self, table: str, index_name: str, columns: tuple[str, ...]
    ) -> None:
        """Guarantee UNIQUE(columns) without rebuilding the table."""

        exists = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if exists is None:
            return
        if self._has_unique_constraint(table, columns):
            return
        self._dedupe(table, columns)
        self.conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} "
            f"ON {table}({', '.join(columns)})"
        )

    def _has_unique_constraint(self, table: str, columns: tuple[str, ...]) -> bool:
        for idx in self.conn.execute(f"PRAGMA index_list({table})"):
            if not idx["unique"]:
                continue
            names = tuple(
                r[2] for r in self.conn.execute(f"PRAGMA index_info({idx['name']})")
            )
            if names == columns:
                return True
        return False

    def _dedupe(self, table: str, columns: tuple[str, ...]) -> int:
        """Merge rows that would violate the new unique index.

        Keeps the lowest rowid. For ``chats`` the child rows are re-pointed
        first so no message is lost by the merge.
        """

        keys = ", ".join(columns)
        groups = self.conn.execute(
            f"SELECT {keys}, MIN(rowid) AS keep_rowid, COUNT(*) AS n "
            f"FROM {table} GROUP BY {keys} HAVING n > 1"
        ).fetchall()
        if not groups:
            return 0

        where = " AND ".join(f"{c} IS ?" for c in columns)
        dropped = 0
        for group in groups:
            values = [group[c] for c in columns]
            keep_rowid = int(group["keep_rowid"])
            if table == "chats":
                dup_ids = [
                    int(r[0])
                    for r in self.conn.execute(
                        f"SELECT rowid FROM chats WHERE {where} AND rowid != ?",
                        values + [keep_rowid],
                    )
                ]
                for dup_id in dup_ids:
                    self._merge_chat_children(keep_rowid, dup_id)
                    self.conn.execute("DELETE FROM chats WHERE rowid = ?", (dup_id,))
                    dropped += 1
            else:
                cur = self.conn.execute(
                    f"DELETE FROM {table} WHERE {where} AND rowid != ?",
                    values + [keep_rowid],
                )
                dropped += int(cur.rowcount or 0)

        log.warning(
            "%s: merged %d duplicate row(s) before adding a unique index",
            table, dropped,
        )
        return dropped

    def _merge_chat_children(self, keep_id: int, dup_id: int) -> None:
        """Re-point messages/mirror_log/events from a duplicate chat row."""

        for child in ("messages", "mirror_log"):
            try:
                # OR IGNORE: keep the surviving chat's row when both parents
                # already carry the same (chat_id, tg_message_id[, mode]).
                self.conn.execute(
                    f"UPDATE OR IGNORE {child} SET chat_id = ? WHERE chat_id = ?",
                    (keep_id, dup_id),
                )
                self.conn.execute(f"DELETE FROM {child} WHERE chat_id = ?", (dup_id,))
            except sqlite3.OperationalError:
                pass  # table not created yet
        try:
            self.conn.execute(
                "UPDATE events SET chat_id = ? WHERE chat_id = ?", (keep_id, dup_id)
            )
        except sqlite3.OperationalError:
            pass


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
        topic_id: Optional[int] = None,
        include_topics: Optional[Iterable[int]] = None,
        exclude_topics: Optional[Iterable[int]] = None,
    ) -> list[dict[str, Any]]:
        """Rows that still need to be written to the channel, oldest first.

        Topic filters must be applied here, not only while fetching: rows
        indexed by an earlier unfiltered run are otherwise posted even though
        the user asked for a subset of topics.
        """

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

        # Same precedence as MirrorEngine._topic_match.
        include_list = list(include_topics) if include_topics is not None else None
        if topic_id is not None:
            clauses.append("m.topic_id = ?")
            params.append(topic_id)
        elif include_list:
            placeholders = ", ".join("?" for _ in include_list)
            clauses.append(f"m.topic_id IN ({placeholders})")
            params.extend(include_list)
        elif include_list is not None:
            pass  # empty include list means "all topics"
        elif exclude_topics:
            exclude_list = list(exclude_topics)
            placeholders = ", ".join("?" for _ in exclude_list)
            clauses.append(f"(m.topic_id IS NULL OR m.topic_id NOT IN ({placeholders}))")
            params.extend(exclude_list)

        if include_failed:
            clauses.append(
                """(
                    l.id IS NULL
                    OR (l.status = 'failed' AND l.attempt < ?)
                    OR l.status = 'posting'
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

    def mark_posting(
        self,
        chat_local_id: int,
        tg_message_id: int,
        mode: str,
    ) -> None:
        """Record that a post is about to be sent (before the network call).

        If the process dies between the send and mark_mirrored(), the row stays
        'posting' and the next run verifies the channel for its marker instead
        of blindly posting a duplicate.
        """

        self.conn.execute(
            """
            INSERT INTO mirror_log (chat_id, tg_message_id, mode, status)
            VALUES (?, ?, ?, 'posting')
            ON CONFLICT(chat_id, tg_message_id, mode) DO UPDATE SET
                status = 'posting'
            """,
            (chat_local_id, tg_message_id, mode),
        )
        self.conn.commit()

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
        *,
        deferred: bool = False,
    ) -> None:
        """Record a failed post.

        ``deferred`` (rate-limited/FloodWait) does not consume an attempt:
        otherwise a long flood would push the row to a terminal ``skipped``
        state and the message would never be retried.
        """

        existing = self.mirror_status(chat_local_id, tg_message_id, mode)
        attempt = existing["attempt"] if existing else 0
        if not deferred:
            attempt += 1
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

    def stats(
        self,
        account_id: Optional[int] = None,
        mode: Optional[str] = None,
    ) -> dict[str, Any]:
        """Index counters.

        ``mode`` makes the mirror counters ("mirrored"/"pending"/"failed")
        specific to one writer mode, matching what pending_mirror() will
        actually process. Without it they are mode-agnostic, so a chat archived
        in copy mode still counts as pending for a forward run and the number
        on screen disagrees with the work a run will do.
        """

        aid = account_id or self.account_id
        # "AND l.mode = ?" / params for the mirror_log-derived counters
        mode_clause = " AND l.mode = ?" if mode else ""
        mode_params: list[Any] = [mode] if mode else []

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
                f"""
                SELECT COUNT(*) FROM mirror_log l
                JOIN messages m ON m.chat_id = l.chat_id AND m.tg_message_id = l.tg_message_id
                WHERE m.account_id = ? AND l.status = 'done'{mode_clause}
                """,
                (aid, *mode_params),
            ).fetchone()[0]
        )
        counts["pending"] = int(
            self.conn.execute(
                f"""
                SELECT COUNT(*)
                FROM messages m
                LEFT JOIN mirror_log l
                       ON l.chat_id = m.chat_id
                      AND l.tg_message_id = m.tg_message_id{mode_clause}
                WHERE m.account_id = ? AND m.deleted_at IS NULL
                  AND (
                      l.id IS NULL
                      OR l.status = 'posting'
                      OR (l.status = 'failed' AND l.attempt < 5)
                  )
                """,
                (*mode_params, aid),
            ).fetchone()[0]
        )
        counts["failed"] = int(
            self.conn.execute(
                f"""
                SELECT COUNT(*) FROM mirror_log l
                JOIN messages m ON m.chat_id = l.chat_id AND m.tg_message_id = l.tg_message_id
                WHERE m.account_id = ? AND l.status = 'failed'{mode_clause}
                """,
                (aid, *mode_params),
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
        account_id: Optional[int] = None,
    ) -> int:
        """Create/update the account row and return its id.

        ``account_id`` is the session-file index (account 1 = archive.session,
        account N = archive_N.session) and is also the ``account_id`` used for
        chats/messages, so the row id is kept equal to it. Without that, a
        logout followed by a re-login produced a fresh AUTOINCREMENT id while
        the session file was still ``archive.session``, and /api/accounts
        reported a session that did not exist.

        If the same session index is logged into by a *different* Telegram
        user, that index's index rows are purged first: chats/messages/
        mirror_log belong to the previous user and must not be mixed.
        """

        existing = self.conn.execute(
            "SELECT id FROM accounts WHERE tg_user_id = ?", (tg_user_id,)
        ).fetchone()
        if existing is not None:
            target = int(existing["id"])
        elif account_id is not None:
            owner = self.conn.execute(
                "SELECT tg_user_id FROM accounts WHERE id = ?", (account_id,)
            ).fetchone()
            if owner is not None:
                # session index handed to a different Telegram user
                log.warning(
                    "session index %s switches from tg_user %s to %s: purging its old index rows",
                    account_id, owner["tg_user_id"], tg_user_id,
                )
                self._purge_account_data(account_id)
            else:
                # free slot: take it so rowid == session index
                self.conn.execute(
                    """
                    INSERT INTO accounts
                        (id, tg_user_id, username, phone, first_name, last_name, is_active)
                    VALUES (?, ?, ?, ?, ?, ?, 1)
                    """,
                    (account_id, tg_user_id, username, phone, first_name, last_name),
                )
                self.conn.commit()
                return int(account_id)
            target = int(account_id)
        else:
            row = self.conn.execute(
                "SELECT id FROM accounts WHERE tg_user_id = ?", (tg_user_id,)
            ).fetchone()
            target = int(row["id"]) if row else 0

        if target:
            self.conn.execute(
                """
                UPDATE accounts
                SET tg_user_id = ?, username = ?, phone = COALESCE(?, phone),
                    first_name = ?, last_name = ?, is_active = 1
                WHERE id = ?
                """,
                (tg_user_id, username, phone, first_name, last_name, target),
            )
            self.conn.commit()
            return target

        self.conn.execute(
            """
            INSERT INTO accounts (tg_user_id, username, phone, first_name, last_name, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(tg_user_id) DO UPDATE SET
                username = excluded.username,
                phone = COALESCE(excluded.phone, accounts.phone),
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

    def _purge_account_data(self, account_id: int) -> None:
        """Delete every index row of one account (chats/messages/log/events).

        Used by delete-account and when a session index changes owner. The
        account row itself is left alone so callers can decide its fate.
        """

        for child in ("mirror_log", "events"):
            self.conn.execute(
                f"DELETE FROM {child} WHERE chat_id IN "
                "(SELECT id FROM chats WHERE account_id = ?)",
                (account_id,),
            )
        self.conn.execute("DELETE FROM messages WHERE account_id = ?", (account_id,))
        self.conn.execute("DELETE FROM chats WHERE account_id = ?", (account_id,))
        self.conn.commit()

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
