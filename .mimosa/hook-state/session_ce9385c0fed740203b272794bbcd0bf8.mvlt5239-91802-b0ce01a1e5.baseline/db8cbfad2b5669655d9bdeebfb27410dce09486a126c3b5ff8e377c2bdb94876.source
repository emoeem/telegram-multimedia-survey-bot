"""Offline end-to-end tests of the mirror engine with a fake MTProto client."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from tg_archive.config import ArchiveConfig
from tg_archive.db import ArchiveDB
from tg_archive.model import ChatInfo
from tg_archive.mirror import FLOOD_WAIT_CAP, MirrorEngine, _flood_required, _flood_seconds


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

    async def get_messages(
        self, entity, limit=200, offset_id=0, min_id=0, ids=None, search=None
    ):
        if search is not None:
            # emulate server-side search over what this client already posted
            hits = [
                SimpleNamespace(id=i + 1)
                for i, sent in enumerate(self.sent_messages)
                if search in (sent.get("caption") or sent.get("text") or "")
            ]
            return hits[:limit]
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


class FloodingClient(FakeClient):
    """Every channel write is rejected with a FloodWait longer than the cap."""

    async def send_message(self, channel, text):
        raise RuntimeError(
            "A wait of 999999 seconds is required (caused by SendMessageRequest)"
        )

    async def send_file(self, channel, file, caption=""):
        raise RuntimeError(
            "A wait of 999999 seconds is required (caused by SendMediaRequest)"
        )


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
    # the applied wait is capped, but the required wait stays visible so a run
    # can defer instead of retrying too early
    assert _flood_seconds("A wait of 999999 seconds is required") == 3600
    assert _flood_required("A wait of 999999 seconds is required") == 999999
    assert _flood_seconds("network hiccup") == 0
    assert _flood_required("network hiccup") == 0


def test_unknown_protected_policy_fails_closed():
    """Anything unrecognised must skip, not allow."""
    for policy in ("text-only", "ALLOW_MEDIA", "", "yes"):
        assert MirrorEngine._protected_skip_reason(policy, "copy", True)
        assert MirrorEngine._protected_skip_reason(policy, "copy", False)
    # the three legitimate policies keep their meaning
    assert MirrorEngine._protected_skip_reason("skip", "copy", True)
    assert MirrorEngine._protected_skip_reason("text_only", "copy", True)
    assert MirrorEngine._protected_skip_reason("text_only", "copy", False) == ""
    assert MirrorEngine._protected_skip_reason("allow_media", "copy", True) == ""


def test_edited_message_cannot_smuggle_media_past_text_only(tmp_path):
    """The policy decision reads the indexed row, but the payload is
    re-normalized from the live message: a text message edited to add a photo
    must still be skipped under text_only."""
    source = FakeEntity(1234567890, "受保护", protected=True)
    messages = [
        FakeMessage(
            {
                "id": 1,
                "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
                "date": "2026-09-01T00:00:00+00:00",
                "message": "纯文字",
                "from_id": {"_": "PeerUser", "user_id": 42},
                "out": False,
            }
        )
    ]
    client = FakeClient(messages, source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="text_only")
    db = ArchiveDB(cfg.resolved_db)

    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    assert run(engine, "@src") == 0
    chat = db.get_chat(-1001234567890)
    assert chat["has_protected_content"] == 1
    assert db.conn.execute("SELECT has_media FROM messages").fetchone()[0] == 0

    # after indexing, the author edits the message to attach a photo
    messages[0].raw["media"] = {"_": "MessageMediaPhoto", "photo": {"id": 9, "dc_id": 2}}

    engine2 = MirrorEngine(
        client, cfg, db, dry_run=False, yes=True, progress=lambda s: None
    )
    assert run(engine2, "@src", "@arch") == 0

    assert client.sent_messages == []  # nothing downloaded or uploaded
    assert db.mirror_status(int(chat["id"]), 1, "copy")["status"] == "skipped"


def test_long_flood_wait_defers_without_burning_attempts(tmp_path):
    """A >FLOOD_WAIT_CAP wait must not consume the failure budget.

    Previously the wait was truncated to 300s, retries failed again, and after
    five runs the row became a terminal "skipped" that nothing ever selected.
    """
    source = FakeEntity(1234567890, "源频道")
    client = FloodingClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    chat_local_id = db.upsert_chat(
        ChatInfo(tg_chat_id=-1001234567890, type="channel", title="源频道")
    )

    for run_number in range(1, 8):
        engine = MirrorEngine(
            client, cfg, db, dry_run=False, yes=True, progress=lambda s: None
        )
        assert run(engine, "@src", "@arch") == 0
        assert client.sent_messages == []
        row = db.mirror_status(chat_local_id, 1, "copy")
        assert row is not None and row["status"] == "failed"
        assert row["attempt"] == 0, "a deferred flood must not count as an attempt"
        assert engine.stats.deferred == 2
        # still eligible on every later run, no matter how often it happens
        assert db.pending_mirror(chat_local_id, "copy", limit=10)


class ShortPageClient(FakeClient):
    """Some channels return fewer messages than requested (Telethon warns
    about this), which used to end the fetch loop early."""

    def __init__(self, msgs, source, max_per_call: int = 3):
        super().__init__(msgs, source)
        self.max_per_call = max_per_call

    async def get_messages(self, entity, limit=200, offset_id=0, min_id=0, ids=None):
        if ids is not None:
            return await super().get_messages(entity, limit, offset_id, min_id, ids)
        return await super().get_messages(
            entity,
            limit=min(limit, self.max_per_call),
            offset_id=offset_id,
            min_id=min_id,
        )


def test_short_pages_do_not_truncate_history(tmp_path):
    """A page shorter than PAGE_SIZE is not the end of history: stopping there
    pinned the cursor at the newest id and lost every older message forever."""
    source = FakeEntity(1234567890, "源频道")
    client = ShortPageClient(_many_messages(10), source, max_per_call=3)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)

    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    assert run(engine, "@src") == 0

    stored = [
        r[0]
        for r in db.conn.execute("SELECT tg_message_id FROM messages ORDER BY tg_message_id")
    ]
    assert stored == list(range(1, 11))  # before: only [8, 9, 10]
    chat = db.get_chat(-1001234567890)
    assert chat["last_sync_message_id"] == 10


def test_topic_filter_skips_other_topics_when_posting(tmp_path):
    """`--dry-run` indexes everything; a later filtered run must not post the
    already-indexed messages of excluded topics."""
    source = FakeEntity(1234567890, "源频道")

    def forum_message(mid: int, topic: int) -> FakeMessage:
        return FakeMessage(
            {
                "id": mid,
                "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
                "date": f"2026-09-0{mid}T00:00:00+00:00",
                "message": f"msg {mid}",
                "reply_to": {"topic_id": topic},
                "from_id": {"_": "PeerUser", "user_id": 42},
                "out": False,
            }
        )

    messages = [forum_message(1, 5), forum_message(2, 1), forum_message(3, 1)]
    client = FakeClient(messages, source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)

    # 1) unfiltered dry-run indexes all three
    engine = MirrorEngine(client, cfg, db, dry_run=True, progress=lambda s: None)
    assert run(engine, "@src") == 0
    assert db.stats()["messages"] == 3

    # 2) a run filtered to topic 5 must only post message 1
    engine2 = MirrorEngine(
        client, cfg, db, dry_run=False, yes=True, topic_id=5, progress=lambda s: None
    )
    assert run(engine2, "@src", "@arch") == 0
    assert len(client.sent_messages) == 1
    assert "msg 1" in client.sent_messages[0]["text"]


class FailingClient(FakeClient):
    """Every channel write fails with a permanent (non-flood) error."""

    async def send_message(self, channel, text):
        raise RuntimeError("CHAT_WRITE_FORBIDDEN")

    async def send_file(self, channel, file, caption=""):
        raise RuntimeError("CHAT_WRITE_FORBIDDEN")


class DownloadFailingClient(FakeClient):
    """Writes a partial file and then fails, like a dropped download."""

    async def download_media(self, message, file):
        directory = Path(file)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "partial.jpg").write_bytes(b"x")
        raise RuntimeError("download aborted")


def test_run_returns_nonzero_when_posts_fail(tmp_path):
    """Cron/CI must not see success when messages were not written."""
    source = FakeEntity(1234567890, "源频道")
    client = FailingClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(
        client, cfg, db, dry_run=False, yes=True, progress=lambda s: None
    )
    assert run(engine, "@src", "@arch") == 2
    assert engine.stats.failed == 2
    # the rows stay retryable
    assert db.pending_mirror(1, "copy", limit=10)


def test_failed_download_does_not_leak_temp_files(tmp_path):
    source = FakeEntity(1234567890, "源频道")
    client = DownloadFailingClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(
        client, cfg, db, dry_run=False, yes=True, progress=lambda s: None
    )
    assert run(engine, "@src", "@arch") == 2

    media_root = cfg.resolved_media_cache
    leftovers = list(media_root.iterdir()) if media_root.exists() else []
    assert leftovers == [], f"temp files leaked: {leftovers}"


def test_same_peer_recognises_input_peer_channel():
    """InputPeerChannel has no .id, which used to make the guard return False
    and allow archiving a chat into itself."""
    from telethon.tl.types import InputPeerChannel

    peer = InputPeerChannel(channel_id=1234567890, access_hash=1)
    assert MirrorEngine._same_peer(-(10**12) - 1234567890, peer) is True
    assert MirrorEngine._same_peer(-100999, peer) is False


def test_message_level_noforwards_follows_the_policy(tmp_path):
    """A per-message noforwards flag (not just the chat flag) must be honoured."""
    source = FakeEntity(1234567890, "普通频道")  # chat itself is NOT protected
    raw = {
        "id": 1,
        "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
        "date": "2026-09-01T00:00:00+00:00",
        "message": "受限制的图片",
        "media": {"_": "MessageMediaPhoto", "photo": {"id": 5, "dc_id": 2}},
        "noforwards": True,
        "from_id": {"_": "PeerUser", "user_id": 42},
        "out": False,
    }

    # default policy: skip
    client = FakeClient([FakeMessage(dict(raw))], source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine, "@src", "@arch") == 0
    assert client.sent_messages == []
    assert db.mirror_status(1, 1, "copy")["status"] == "skipped"
    assert "noforwards" in db.mirror_status(1, 1, "copy")["skip_reason"]

    # explicit allow_media opt-in still allows it (separate db: _cfg always
    # points at <root>/db.sqlite3)
    allow_root = tmp_path / "allow"
    allow_root.mkdir()
    client2 = FakeClient([FakeMessage(dict(raw))], source)
    cfg2 = _cfg(allow_root, writer_mode="copy", protected_policy="allow_media")
    db2 = ArchiveDB(cfg2.resolved_db)
    engine2 = MirrorEngine(client2, cfg2, db2, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine2, "@src", "@arch") == 0
    assert len(client2.sent_messages) == 1


def test_listen_path_retries_a_previously_failed_message(tmp_path):
    """mirror_status() is truthy for 'failed' too, which used to suppress the
    in-process retry of a live message."""
    from tg_archive.normalizer import normalize_message

    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    chat = ChatInfo(tg_chat_id=-1001234567890, type="channel", title="源频道")
    chat_local_id = db.upsert_chat(chat)
    raw = _messages()[0]
    nm = normalize_message(raw, chat)
    db.mark_failed(chat_local_id, 1, "copy", "temporary glitch")

    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    asyncio.run(
        engine._mirror_one(source, chat, chat_local_id, client.channel, nm, raw)
    )
    assert len(client.sent_messages) == 1
    assert db.mirror_status(chat_local_id, 1, "copy")["status"] == "done"



def _nm(mid: int, text: str, date: str = "2026-09-01T00:00:00+00:00"):
    from tg_archive.model import NormalizedMessage

    return NormalizedMessage(
        tg_chat_id=-1001234567890,
        tg_message_id=mid,
        date=date,
        content_type="text",
        text=text,
    )

def test_interrupted_post_is_recovered_from_the_channel(tmp_path):
    """A run that died between sending and recording leaves status 'posting';
    the next run must find the marker in the channel instead of re-posting."""
    from tg_archive.captions import idempotency_marker

    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    chat = ChatInfo(tg_chat_id=-1001234567890, type="channel", title="源频道")
    chat_local_id = db.upsert_chat(chat)
    db.upsert_messages(chat_local_id, [_nm(1, "hello")])
    db.mark_posting(chat_local_id, 1, "copy")  # as if the process died mid-send

    marker = idempotency_marker(-1001234567890, 1)
    client.sent_messages.append(
        {"type": "text", "text": f"#chat_x #user_42\nhello\n{marker}"}
    )

    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine, "@src", "@arch") == 0

    # only the photo (id 2) is newly posted; the text is recognised as sent
    assert len(client.sent_messages) == 2
    assert engine.stats.recovered == 1
    row = db.mirror_status(chat_local_id, 1, "copy")
    assert row["status"] == "done" and row["channel_message_id"] == 1


def test_posting_row_is_resent_when_the_channel_has_nothing(tmp_path):
    """If the marker is absent the message was never delivered: re-post it."""
    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    chat = ChatInfo(tg_chat_id=-1001234567890, type="channel", title="源频道")
    chat_local_id = db.upsert_chat(chat)
    db.upsert_messages(chat_local_id, [_nm(1, "hello")])
    db.mark_posting(chat_local_id, 1, "copy")

    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine, "@src", "@arch") == 0
    assert engine.stats.recovered == 0
    assert any(s.get("text") and "hello" in s["text"] for s in client.sent_messages)
    assert db.mirror_status(chat_local_id, 1, "copy")["status"] == "done"


class FlakyConnectionClient(FakeClient):
    """The connection drops mid-request: the post may or may not have landed."""

    async def send_message(self, channel, text):
        raise ConnectionResetError("connection reset by peer")


def test_ambiguous_network_failure_is_verified_not_duplicated(tmp_path):
    """A dropped connection must leave the row 'posting' so the next run checks
    the channel first, instead of blindly re-posting a duplicate."""
    from tg_archive.captions import idempotency_marker

    source = FakeEntity(1234567890, "源频道")
    client = FlakyConnectionClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)

    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine, "@src", "@arch") == 0  # not a hard failure
    assert engine.stats.failed == 0
    chat_local_id = db.get_chat(-1001234567890)["id"]
    # the text message is unknown-state; the photo was posted by the fake
    assert db.mirror_status(chat_local_id, 1, "copy")["status"] == "posting"
    assert db.mirror_status(chat_local_id, 2, "copy")["status"] == "done"
    assert [r["tg_message_id"] for r in db.pending_mirror(chat_local_id, "copy", 50)] == [1]

    # next run: the request HAD been delivered despite the connection error
    marker = idempotency_marker(-1001234567890, 1)
    client.sent_messages.append({"type": "text", "text": f"hello\n{marker}"})
    sent_before = len(client.sent_messages)

    client2 = FakeClient(_messages(), source)
    client2.sent_messages = client.sent_messages
    engine2 = MirrorEngine(client2, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    assert run(engine2, "@src", "@arch") == 0
    assert engine2.stats.recovered == 1
    assert db.mirror_status(chat_local_id, 1, "copy")["status"] == "done"
    assert len(client2.sent_messages) == sent_before  # nothing re-posted


def test_rpc_error_is_a_definite_failure():
    """Server-answered errors must stay hard failures."""
    from telethon.errors import ChatWriteForbiddenError, FloodWaitError

    from tg_archive.writer import _is_ambiguous

    assert _is_ambiguous(ChatWriteForbiddenError(request=None)) is False
    assert _is_ambiguous(FloodWaitError(request=None, capture=30)) is False
    assert _is_ambiguous(ConnectionResetError("reset")) is True
    assert _is_ambiguous(TimeoutError("timeout")) is True
    assert _is_ambiguous(RuntimeError("bug")) is False


def test_listen_registers_handlers_before_the_backfill(tmp_path):
    """Registering after posting dropped every message that arrived during a
    long backfill/post phase."""
    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, listen=True,
                          progress=lambda s: None)

    order: list[str] = []
    engine._register_listeners = lambda *a: order.append("register")  # type: ignore
    engine._await_disconnect = lambda: _record(order, "listen")       # type: ignore
    original_write = engine._write_pending

    async def spy_write(*args, **kwargs):
        order.append("write")
        return await original_write(*args, **kwargs)

    engine._write_pending = spy_write  # type: ignore
    assert run(engine, "@src", "@arch") == 0
    assert order == ["register", "write", "listen"]


async def _record(order: list[str], name: str) -> None:
    order.append(name)


def test_live_event_does_not_double_post_an_in_flight_batch_row(tmp_path):
    """A live event for a message the batch is already posting must be a no-op."""
    from tg_archive.normalizer import normalize_message

    source = FakeEntity(1234567890, "源频道")
    client = FakeClient(_messages(), source)
    cfg = _cfg(tmp_path, writer_mode="copy", protected_policy="skip")
    db = ArchiveDB(cfg.resolved_db)
    chat = ChatInfo(tg_chat_id=-1001234567890, type="channel", title="源频道")
    chat_local_id = db.upsert_chat(chat)
    raw = _messages()[0]
    nm = normalize_message(raw, chat)

    engine = MirrorEngine(client, cfg, db, dry_run=False, yes=True, progress=lambda s: None)
    engine._in_flight.add(1)
    asyncio.run(engine._mirror_one(source, chat, chat_local_id, client.channel, nm, raw))
    assert client.sent_messages == []
    # and once it is no longer in flight, it posts normally
    engine._in_flight.clear()
    asyncio.run(engine._mirror_one(source, chat, chat_local_id, client.channel, nm, raw))
    assert len(client.sent_messages) == 1
