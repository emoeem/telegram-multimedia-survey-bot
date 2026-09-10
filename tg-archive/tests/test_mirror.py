"""Offline end-to-end tests of the mirror engine with a fake MTProto client."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from tg_archive.config import ArchiveConfig
from tg_archive.db import ArchiveDB
from tg_archive.mirror import MirrorEngine, _flood_seconds


class FakeMessage:
    def __init__(self, raw: dict):
        self.raw = raw

    @property
    def id(self) -> int:
        return self.raw["id"]

    def to_dict(self):
        return self.raw


class FakeEntity:
    def __init__(
        self,
        ident: int,
        title: str,
        *,
        kind: str = "Channel",
        protected: bool = False,
    ):
        self.id = ident
        self.title = title
        self.username = None
        self.access_hash = 1
        self._ = kind
        self.noforwards = protected

    def to_dict(self):
        return {
            "_": self._,
            "id": self.id,
            "title": self.title,
            "username": self.username,
            "access_hash": self.access_hash,
            "noforwards": self.noforwards,
        }


class FakeClient:
    def __init__(self, msgs: list[FakeMessage], source: FakeEntity):
        self.msgs = msgs
        self.source = source
        self.channel = FakeEntity(1001, "我的存档")
        self.sent_messages: list[dict] = []
        self.forwarded: list[tuple[int, int]] = []
        self.downloaded: list[str] = []

    async def get_entity(self, target: str):
        if target == "@src":
            return self.source
        if target in {"@arch", "-1000000001001"}:
            return self.channel
        raise ValueError(f"unknown entity {target}")

    async def get_messages(self, entity, limit=200, offset_id=0, min_id=0, ids=None):
        if ids is not None:
            wanted = set(ids)
            found = [m for m in self.msgs if m.id in wanted]
            return found or None
        ordered = sorted(
            [m for m in self.msgs if m.id > min_id],
            key=lambda m: -m.id,
        )
        if offset_id:
            ordered = [m for m in ordered if m.id < offset_id]
        return ordered[:limit]

    async def get_me(self):
        return SimpleNamespace(id=7, username="tester")

    async def send_message(self, channel, text):
        mid = len(self.sent_messages) + 1
        self.sent_messages.append({"type": "text", "text": text})
        return SimpleNamespace(id=mid)

    async def send_file(self, channel, file, caption=""):
        mid = len(self.sent_messages) + 1
        self.sent_messages.append({"type": "file", "file": str(file), "caption": caption})
        return SimpleNamespace(id=mid)

    async def forward_messages(self, channel, messages, from_peer):
        self.forwarded.extend((from_peer.id, mid) for mid in messages)
        return [SimpleNamespace(id=i) for i in range(1, len(messages) + 1)]

    async def download_media(self, message, file):
        path = Path(file) / f"file-{message.id}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        self.downloaded.append(str(path))
        return str(path)

    async def disconnect(self):
        pass


def _cfg(root: Path, **overrides) -> ArchiveConfig:
    base = dict(
        api_id=1,
        api_hash="x",
        session_path=Path("data/s.session"),
        db_path=Path("db.sqlite3"),
        media_cache=Path("media"),
        post_delay_seconds=0,
        max_posts=100,
    )
    base.update(overrides)
    return ArchiveConfig(root_dir=root, **base)


def _messages() -> list[FakeMessage]:
    return [
        FakeMessage(
            {
                "id": 1,
                "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
                "date": "2026-09-01T00:00:00+00:00",
                "message": "hello",
                "from_id": {"_": "PeerUser", "user_id": 42},
                "out": False,
            }
        ),
        FakeMessage(
            {
                "id": 2,
                "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
                "date": "2026-09-02T00:00:00+00:00",
                "message": "照片说明",
                "media": {
                    "_": "MessageMediaPhoto",
                    "photo": {"id": 99, "dc_id": 2},
                },
                "from_id": {"_": "PeerUser", "user_id": 42},
                "out": False,
            }
        ),
    ]


def _many_messages(count: int) -> list[FakeMessage]:
    return [
        FakeMessage(
            {
                "id": mid,
                "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
                "date": f"2026-09-01T00:{mid % 60:02d}:00+00:00",
                "message": f"message {mid}",
                "from_id": {"_": "PeerUser", "user_id": 42},
                "out": False,
            }
        )
        for mid in range(1, count + 1)
    ]


def run(engine, chat_input, channel_input=None) -> int:
    return asyncio.run(engine.run(chat_input, channel_input))


def test_dry_run_indexes_without_channel(tmp_path):
    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    code = run(engine, "@src")
    assert code == 0
    stats = db.stats()
    assert stats["messages"] == 2
    assert stats["pending"] == 2
    chat = db.get_chat(-1001234567890)
    assert chat is not None
    assert chat["last_sync_message_id"] == 2


def test_protected_chat_default_skip(tmp_path):
    source = FakeEntity(1234567890, "受保护", protected=True)
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    run(engine, "@src")
    assert db.stats()["messages"] == 2
    statuses = [
        db.mirror_status(1, mid, "copy")["status"]
        for mid in (1, 2)
    ]
    assert statuses == ["skipped", "skipped"]


def test_copy_posts_to_channel_in_order(tmp_path):
    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, yes=True, progress=lambda s: None)
    code = run(engine, "@src", "@arch")
    assert code == 0
    assert [p["type"] for p in client.sent_messages] == ["text", "file"]
    assert "#chat_源频道" in client.sent_messages[0]["text"]
    assert client.sent_messages[1]["caption"].startswith("#chat_源频道")
    assert db.stats()["mirrored"] == 2
    assert db.mirror_status(1, 1, "copy")["status"] == "done"
    assert db.mirror_status(1, 2, "copy")["status"] == "done"


def test_protected_text_only_posts_text_only(tmp_path):
    source = FakeEntity(1234567890, "受保护", protected=True)
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="text_only")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, yes=True, progress=lambda s: None)
    code = run(engine, "@src", "@arch")
    assert code == 0
    assert len(client.sent_messages) == 1
    assert client.sent_messages[0]["type"] == "text"
    assert db.mirror_status(1, 1, "copy")["status"] == "done"
    assert db.mirror_status(1, 2, "copy")["status"] == "skipped"
    assert client.downloaded == []


def test_protected_allow_media_posts_everything(tmp_path):
    source = FakeEntity(1234567890, "受保护", protected=True)
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="allow_media")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, yes=True, progress=lambda s: None)
    code = run(engine, "@src", "@arch")
    assert code == 0
    assert [p["type"] for p in client.sent_messages] == ["text", "file"]
    assert len(client.downloaded) == 1
    assert db.mirror_status(1, 1, "copy")["status"] == "done"
    assert db.mirror_status(1, 2, "copy")["status"] == "done"


def test_allow_media_reopens_rows_skipped_by_default_policy(tmp_path):
    source = FakeEntity(1234567890, "受保护", protected=True)
    client = FakeClient(_messages(), source)

    cfg_skip = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg_skip.resolved_db)
    engine_skip = MirrorEngine(
        client, cfg_skip, db, dry_run=True, progress=lambda s: None
    )
    assert run(engine_skip, "@src") == 0
    assert [db.mirror_status(1, mid, "copy")["status"] for mid in (1, 2)] == [
        "skipped",
        "skipped",
    ]

    cfg_allow = _cfg(tmp_path, writer_mode="copy", protected_policy="allow_media")
    engine_allow = MirrorEngine(
        client, cfg_allow, db, yes=True, progress=lambda s: None
    )
    assert run(engine_allow, "@src", "@arch") == 0
    assert db.mirror_status(1, 1, "copy")["status"] == "done"
    assert db.mirror_status(1, 2, "copy")["status"] == "done"


def test_protected_allow_media_forward_still_skipped(tmp_path):
    source = FakeEntity(1234567890, "受保护", protected=True)
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="forward", protected_policy="allow_media")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, yes=True, progress=lambda s: None)
    code = run(engine, "@src", "@arch")
    assert code == 0
    assert client.forwarded == []
    assert db.mirror_status(1, 1, "forward")["status"] == "skipped"
    assert db.mirror_status(1, 2, "forward")["status"] == "skipped"


def test_forward_mode(tmp_path):
    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="forward", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, yes=True, progress=lambda s: None)
    code = run(engine, "@src", "@arch")
    assert code == 0
    assert len(client.forwarded) == 2
    assert client.sent_messages == []
    assert db.stats()["mirrored"] == 2


def test_multi_page_full_sync(tmp_path):
    """450 messages exercise multiple history pages and a complete cursor."""

    source = FakeEntity(1234567890, "大群")
    client = FakeClient(_many_messages(450), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    code = run(engine, "@src")
    assert code == 0
    stats = db.stats()
    assert stats["messages"] == 450
    chat = db.get_chat(-1001234567890)
    assert chat["last_sync_message_id"] == 450


def test_fetch_limit_resumes_to_full_sync(tmp_path):
    """--fetch-limit pauses mid-backfill; the next run continues from the page
    floor without losing older messages and eventually completes."""

    source = FakeEntity(1234567890, "大群")
    client = FakeClient(_many_messages(450), source)

    cfg1 = _cfg(
        tmp_path,
        writer_mode="copy",
        protected_policy="skip",
        fetch_limit=250,
    )
    db = ArchiveDB(cfg1.resolved_db)
    engine1 = MirrorEngine(client, cfg1, db, dry_run=True, progress=lambda s: None)
    assert run(engine1, "@src") == 0
    chat = db.get_chat(-1001234567890)
    assert db.stats()["messages"] == 400
    assert chat["last_sync_message_id"] is None  # not marked synced yet
    assert chat["sync_state"] == "idle"

    cfg2 = _cfg(
        tmp_path,
        writer_mode="copy",
        protected_policy="skip",
        fetch_limit=250,
    )
    engine2 = MirrorEngine(client, cfg2, db, dry_run=True, progress=lambda s: None)
    assert run(engine2, "@src") == 0
    assert db.stats()["messages"] == 450
    chat = db.get_chat(-1001234567890)
    assert chat["last_sync_message_id"] == 450


def test_flood_wait_parsing():
    assert _flood_seconds("A wait of 91 seconds is required") == 91
    assert _flood_seconds("some flood error") == 20
    assert _flood_seconds("A wait of 999999 seconds") == 300
    assert _flood_seconds("network hiccup") == 0
