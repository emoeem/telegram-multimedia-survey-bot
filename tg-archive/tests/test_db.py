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

    stats = db.stats()
    assert stats["chats"] == 1
    assert stats["messages"] == 1

    rows = db.conn.execute("SELECT account_id FROM chats").fetchall()
    assert [r[0] for r in rows] == [1]

    db.close()
