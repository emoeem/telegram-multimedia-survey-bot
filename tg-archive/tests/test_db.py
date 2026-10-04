from tg_archive.db import ArchiveDB
from tg_archive.model import ChatInfo, NormalizedMessage


def _chat() -> ChatInfo:
    return ChatInfo(
        tg_chat_id=-100123,
        type="channel",
        title="源频道",
        has_protected_content=False,
    )


def _msg(tg_id: int, text: str, date: str = "2026-09-01T00:00:00+00:00") -> NormalizedMessage:
    return NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=tg_id,
        date=date,
        content_type="text",
        text=text,
    )


def test_chat_and_message_roundtrip(tmp_path):
    db = ArchiveDB(tmp_path / "a.sqlite3")
    chat_id = db.upsert_chat(_chat())
    inserted, updated = db.upsert_messages(chat_id, [_msg(1, "a"), _msg(2, "b")])
    assert (inserted, updated) == (2, 0)
    inserted, updated = db.upsert_messages(chat_id, [_msg(2, "b2"), _msg(3, "c")])
    assert (inserted, updated) == (1, 1)
    row = db.get_message_row(chat_id, 2)
    assert row["text"] == "b2"
    assert db.stats()["messages"] == 3


def test_cursor(tmp_path):
    db = ArchiveDB(tmp_path / "b.sqlite3")
    chat_id = db.upsert_chat(_chat())
    assert db.get_last_sync_id(chat_id) is None
    db.set_sync_cursor(chat_id, 99)
    assert db.get_last_sync_id(chat_id) == 99


def test_pending_and_mirror_log(tmp_path):
    db = ArchiveDB(tmp_path / "c.sqlite3")
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(
        chat_id,
        [_msg(1, "one", "2026-09-01T00:00:00+00:00"), _msg(2, "two", "2026-09-02T00:00:00+00:00")],
    )
    pending = db.pending_mirror(chat_id, "copy", limit=10)
    assert [p["tg_message_id"] for p in pending] == [1, 2]

    db.mark_mirrored(chat_id, 1, "copy", -100999, 501)
    pending = db.pending_mirror(chat_id, "copy", limit=10)
    assert [p["tg_message_id"] for p in pending] == [2]

    db.mark_skipped(chat_id, 2, "copy", "nope")
    assert db.pending_mirror(chat_id, "copy", limit=10) == []

    db.mark_mirrored(chat_id, 1, "forward", -100999, 601)
    assert db.mirror_status(chat_id, 1, "copy")["status"] == "done"
    assert db.mirror_status(chat_id, 1, "forward")["status"] == "done"


def test_failed_retry_and_max(tmp_path):
    db = ArchiveDB(tmp_path / "d.sqlite3")
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(chat_id, [_msg(1, "x")])
    db.mark_failed(chat_id, 1, "copy", "boom", max_attempts=3)
    assert db.pending_mirror(chat_id, "copy", limit=10, max_attempts=3)
    db.mark_failed(chat_id, 1, "copy", "boom", max_attempts=3)
    assert db.pending_mirror(chat_id, "copy", limit=10, max_attempts=3)
    db.mark_failed(chat_id, 1, "copy", "boom", max_attempts=3)
    assert db.pending_mirror(chat_id, "copy", limit=10, max_attempts=3) == []
    assert db.mirror_status(chat_id, 1, "copy")["status"] == "skipped"


def test_media_only_and_deleted(tmp_path):
    db = ArchiveDB(tmp_path / "e.sqlite3")
    chat_id = db.upsert_chat(_chat())
    media = NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=10,
        date="2026-09-01T00:00:00+00:00",
        content_type="photo",
        text="",
        has_media=True,
        media=[{"kind": "Photo"}],
    )
    db.upsert_messages(chat_id, [_msg(9, "text"), media])
    assert [p["tg_message_id"] for p in db.pending_mirror(chat_id, "copy", 10, media_only=True)] == [10]
    db.mark_deleted(chat_id, 9)
    assert [p["tg_message_id"] for p in db.pending_mirror(chat_id, "copy", 10)] == [10]


def test_clear_skipped_protected_reopens_only_protection_rows(tmp_path):
    db = ArchiveDB(tmp_path / "f.sqlite3")
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(chat_id, [_msg(1, "x"), _msg(2, "y")])
    db.mark_skipped(chat_id, 1, "copy", "protected chat (default policy)")
    db.mark_skipped(chat_id, 2, "copy", "user chose to skip")
    assert db.clear_skipped_protected(chat_id, "copy") == 1
    assert [p["tg_message_id"] for p in db.pending_mirror(chat_id, "copy", 10)] == [1]


def test_migration_old_schema_no_account_id_topic_id(tmp_path):
    import sqlite3

    old_path = tmp_path / "old.sqlite3"
    raw = sqlite3.connect(str(old_path))
    raw.executescript(
        """
        CREATE TABLE chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_chat_id INTEGER NOT NULL UNIQUE,
            type TEXT NOT NULL,
            title TEXT,
            username TEXT,
            access_hash INTEGER,
            has_protected_content INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            tg_message_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            content_type TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            has_media INTEGER NOT NULL DEFAULT 0,
            media_json TEXT NOT NULL DEFAULT '[]',
            sender_id INTEGER,
            edit_date TEXT,
            grouped_id INTEGER,
            reply_to_msg_id INTEGER,
            reply_to_chat_id INTEGER,
            forward_from_chat_id INTEGER,
            forward_from_message_id INTEGER,
            raw_json TEXT NOT NULL DEFAULT '{}',
            deleted INTEGER NOT NULL DEFAULT 0,
            UNIQUE (chat_id, tg_message_id)
        );
        INSERT INTO chats (tg_chat_id, type, title, has_protected_content)
        VALUES (-10042, 'channel', '老频道', 0);
        INSERT INTO messages (chat_id, tg_message_id, date, content_type, text)
        VALUES (1, 7, '2026-08-01T00:00:00+00:00', 'text', 'hello');
        """
    )
    raw.commit()
    raw.close()

    db = ArchiveDB(old_path)
    cols = {
        "chats": [r[1] for r in db.conn.execute("PRAGMA table_info(chats)")],
        "messages": [r[1] for r in db.conn.execute("PRAGMA table_info(messages)")],
    }
    assert "account_id" in cols["chats"]
    assert "account_id" in cols["messages"]
    assert "topic_id" in cols["messages"]
    # the legacy fixture is missing grouped_id; the migration must add it or
    # SCHEMA's CREATE INDEX ... (chat_id, grouped_id) fails
    assert "grouped_id" in cols["messages"]

    stats = db.stats()
    assert stats["chats"] == 1
    assert stats["messages"] == 1

    rows = db.conn.execute("SELECT account_id FROM chats").fetchall()
    assert [r[0] for r in rows] == [1]

    db.close()


# The pre-account_id schema shipped in the project's first commit combined
# `messages.chat_id REFERENCES chats(id) ON DELETE CASCADE` with a non-composite
# `chats.tg_chat_id UNIQUE`. Rebuilding that table with DROP TABLE while
# `PRAGMA foreign_keys=ON` made SQLite run an implicit DELETE FROM chats, which
# cascaded into messages and silently destroyed the whole index.
_LEGACY_V1_SCHEMA = """
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER UNIQUE,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chats (
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
CREATE TABLE messages (
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
INSERT INTO chats (tg_chat_id, type, title, last_sync_message_id)
VALUES (-100123, 'channel', 'A', 3), (-100456, 'channel', 'B', NULL);
INSERT INTO messages (chat_id, tg_message_id, date, text) VALUES
    (1, 1, '2026-01-01T00:00:00+00:00', 'first'),
    (1, 2, '2026-01-02T00:00:00+00:00', 'second'),
    (2, 9, '2026-02-01T00:00:00+00:00', 'in B');
CREATE TABLE mirror_log (
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
"""


def test_migration_keeps_messages_when_child_has_fk_cascade(tmp_path):
    """Regression: the chats rebuild used to cascade-delete every message."""
    import sqlite3

    old_path = tmp_path / "v1.sqlite3"
    raw = sqlite3.connect(str(old_path))
    raw.executescript(_LEGACY_V1_SCHEMA)
    raw.execute(
        "INSERT INTO mirror_log (chat_id, tg_message_id, mode, status) "
        "VALUES (1, 1, 'copy', 'done')"
    )
    raw.commit()
    before = raw.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    assert before == 3
    raw.close()

    db = ArchiveDB(old_path)
    assert db.conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == before
    assert db.conn.execute("SELECT COUNT(*) FROM chats").fetchone()[0] == 2
    assert db.conn.execute("SELECT COUNT(*) FROM mirror_log").fetchone()[0] == 1
    # the cursor must still point at a message that actually exists
    assert db.conn.execute(
        "SELECT last_sync_message_id FROM chats WHERE tg_chat_id = -100123"
    ).fetchone()[0] == 3
    # missing uniqueness is now enforced by an index, so upserts still work
    assert db.upsert_chat(_chat()) == 1
    db.close()


def test_migration_dedupes_duplicates_instead_of_bricking(tmp_path):
    """A failing rebuild used to leave `_msg_new` behind, which then made every
    later connection fail with "table _msg_new already exists"."""
    import sqlite3

    path = tmp_path / "dupes.sqlite3"
    raw = sqlite3.connect(str(path))
    raw.executescript(
        """
        CREATE TABLE chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL DEFAULT 1,
            tg_chat_id INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'other',
            title TEXT NOT NULL DEFAULT '',
            UNIQUE (account_id, tg_chat_id)
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            tg_message_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO chats (account_id, tg_chat_id, title) VALUES (1, -100123, 'A');
        INSERT INTO messages (chat_id, tg_message_id, date, text) VALUES
            (1, 1, '2026-01-01T00:00:00+00:00', 'kept'),
            (1, 1, '2026-01-01T00:00:00+00:00', 'duplicate'),
            (1, 2, '2026-01-02T00:00:00+00:00', 'other');
        """
    )
    raw.commit()
    raw.close()

    for _ in range(2):  # second open proves no temporary table was left behind
        db = ArchiveDB(path)
        texts = [r[0] for r in db.conn.execute("SELECT text FROM messages ORDER BY id")]
        assert texts == ["kept", "other"]
        tables = {
            r[0]
            for r in db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "_msg_new" not in tables and "_chats_new" not in tables
        db.close()


def test_new_database_uses_wal(tmp_path):
    db = ArchiveDB(tmp_path / "wal.sqlite3")
    assert db.conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    db.close()


def test_pending_mirror_applies_topic_filters(tmp_path):
    """Topic rules must be applied when planning writes, not only while
    fetching: rows indexed by an earlier unfiltered run used to be posted even
    though the user had excluded their topic."""
    db = ArchiveDB(tmp_path / "topics.sqlite3")
    chat_id = db.upsert_chat(_chat())

    def msg(mid: int, topic: int | None) -> NormalizedMessage:
        return NormalizedMessage(
            tg_chat_id=-100123,
            tg_message_id=mid,
            date=f"2026-09-0{mid}T00:00:00+00:00",
            content_type="text",
            text=f"m{mid}",
            topic_id=topic,
        )

    db.upsert_messages(chat_id, [msg(1, 5), msg(2, 1), msg(3, None)])

    def ids(**kwargs) -> list[int]:
        return [
            r["tg_message_id"]
            for r in db.pending_mirror(chat_id, "copy", 50, **kwargs)
        ]

    assert ids() == [1, 2, 3]
    assert ids(topic_id=5) == [1]
    assert ids(include_topics={1}) == [2]
    assert ids(include_topics={5, 1}) == [1, 2]
    assert ids(include_topics=set()) == [1, 2, 3]  # empty include list = all
    assert ids(exclude_topics={1}) == [1, 3]  # NULL topic is never excluded
    assert ids(topic_id=5, exclude_topics={5}) == [1]  # topic_id wins
    db.close()


def test_migration_merges_duplicate_chats_without_losing_children(tmp_path):
    """Duplicate (account_id, tg_chat_id) rows must be merged by re-pointing
    their messages/mirror_log/events, not by dropping the parent row."""
    import sqlite3

    path = tmp_path / "dupchats.sqlite3"
    raw = sqlite3.connect(str(path))
    raw.executescript(
        """
        CREATE TABLE chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL DEFAULT 1,
            tg_chat_id INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'other',
            title TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
            tg_message_id INTEGER NOT NULL, date TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE mirror_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
            tg_message_id INTEGER NOT NULL, mode TEXT NOT NULL
        );
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
            tg_message_id INTEGER NOT NULL, kind TEXT NOT NULL
        );
        INSERT INTO chats (account_id, tg_chat_id, title)
            VALUES (1, -100123, 'A1'), (1, -100123, 'A2'), (1, -100999, 'B');
        INSERT INTO messages (chat_id, tg_message_id, date, text) VALUES
            (1, 1, '2026-01-01T00:00:00+00:00', 'on chat 1'),
            (2, 2, '2026-01-02T00:00:00+00:00', 'on chat 2'),
            (3, 9, '2026-01-04T00:00:00+00:00', 'chat B');
        INSERT INTO mirror_log (chat_id, tg_message_id, mode) VALUES (2, 2, 'copy');
        INSERT INTO events (chat_id, tg_message_id, kind) VALUES (2, 2, 'delete');
        """
    )
    raw.commit()
    raw.close()

    db = ArchiveDB(path)
    db.close()
    db = ArchiveDB(path)  # idempotent: second open must not re-merge

    chats = [tuple(r) for r in db.conn.execute("SELECT tg_chat_id, title FROM chats ORDER BY id")]
    assert chats == [(-100123, "A1"), (-100999, "B")]
    # both children survive, re-pointed at the surviving chat
    assert [
        (r["chat_id"], r["tg_message_id"]) for r in
        db.conn.execute("SELECT chat_id, tg_message_id FROM messages ORDER BY id")
    ] == [(1, 1), (1, 2), (3, 9)]
    assert [
        tuple(r) for r in
        db.conn.execute("SELECT chat_id, tg_message_id FROM mirror_log")
    ] == [(1, 2)]
    assert [
        tuple(r) for r in db.conn.execute("SELECT chat_id, tg_message_id FROM events")
    ] == [(1, 2)]
    db.close()


def test_save_account_keeps_rowid_aligned_with_the_session_index(tmp_path):
    """account 1 = archive.session, account N = archive_N.session. When the row
    is gone (logout before the fix), a re-login must not land on a fresh
    AUTOINCREMENT id."""
    db = ArchiveDB(tmp_path / "acc.sqlite3")

    first = db.save_account(tg_user_id=111, username="a", account_id=1)
    assert first == 1
    assert db.list_accounts()[0]["id"] == 1

    db.conn.execute("DELETE FROM accounts WHERE id = 1")
    db.conn.commit()
    again = db.save_account(tg_user_id=111, username="a2", account_id=1)
    assert again == 1, "re-login must reuse the session index, not a new rowid"
    assert db.get_account(1)["username"] == "a2"

    # a phone stored earlier is not wiped by a later call that omits it
    db.save_account(tg_user_id=111, phone="+123", account_id=1)
    db.save_account(tg_user_id=111, username="a3", account_id=1)
    assert db.get_account(1)["phone"] == "+123"

    # a second, different account keeps its own index
    second = db.save_account(tg_user_id=222, username="b", account_id=2)
    assert second == 2
    assert [a["id"] for a in db.list_accounts()] == [1, 2]
    db.close()


def test_session_index_switch_purges_the_previous_owner_rows(tmp_path):
    """Handing one session index to a different Telegram user must not mix the
    two accounts' index rows."""
    db = ArchiveDB(tmp_path / "switch.sqlite3")
    db.save_account(tg_user_id=222, username="b", account_id=2)
    chat_id = db.upsert_chat(_chat(), account_id=2)
    db.upsert_messages(chat_id, [_msg(1, "b's message")], account_id=2)
    db.mark_mirrored(chat_id, 1, "copy", -100999, 5)
    assert db.stats(2)["messages"] == 1

    switched = db.save_account(tg_user_id=333, username="c", account_id=2)
    assert switched == 2
    assert db.get_account(2)["username"] == "c"
    assert db.stats(2)["messages"] == 0
    assert db.stats(2)["chats"] == 0
    assert db.mirror_status(chat_id, 1, "copy") is None
    db.close()


def test_stats_pending_is_mode_specific(tmp_path):
    """"待处理" must match the work a run in that mode will actually do."""
    db = ArchiveDB(tmp_path / "modes.sqlite3")
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(chat_id, [_msg(1, "a"), _msg(2, "b")])
    db.mark_mirrored(chat_id, 1, "copy", -100999, 11)

    assert db.stats(1, mode="copy")["pending"] == 1
    assert db.stats(1, mode="copy")["mirrored"] == 1
    # nothing has been archived in forward mode yet
    assert db.stats(1, mode="forward")["pending"] == 2
    assert db.stats(1, mode="forward")["mirrored"] == 0
    # mode-agnostic call keeps the old behaviour
    assert db.stats(1)["pending"] == 1
    db.close()
