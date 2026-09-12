"""Tests for the FastAPI web server (server.py)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tg_archive import server
from tg_archive.db import ArchiveDB
from tg_archive.model import ChatInfo, NormalizedMessage

TOKEN = "test-token-123"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    """TestClient with an isolated config/db under tmp_path."""
    from tg_archive.config import ArchiveConfig

    cfg = ArchiveConfig(api_id=1, api_hash="x", root_dir=tmp_path)
    monkeypatch.setattr(server, "load_config", lambda **kw: cfg)
    monkeypatch.setenv("TG_ARCHIVE_TOKEN", TOKEN)
    # forget any accounts from a previous test on the shared module state
    monkeypatch.setattr(server.state, "account_ids", [1])
    monkeypatch.setattr(server.state, "clients", {})
    monkeypatch.setattr(server.state, "default_account_id", 1)

    with TestClient(server.app) as client:
        yield client, server.state


def _auth(**params):
    p = {"token": TOKEN}
    p.update(params)
    return p


def _chat(tg_id: int = -100123, title: str = "源频道") -> ChatInfo:
    return ChatInfo(
        tg_chat_id=tg_id,
        type="channel",
        title=title,
        has_protected_content=False,
    )


def _msg(tg_id: int, text: str) -> NormalizedMessage:
    return NormalizedMessage(
        tg_chat_id=-100123,
        tg_message_id=tg_id,
        date="2026-09-01T00:00:00+00:00",
        content_type="text",
        text=text,
    )


def test_api_requires_token(api):
    client, _ = api
    assert client.get("/api/stats").status_code == 401
    assert client.get("/api/stats", params={"token": "wrong"}).status_code == 401
    r = client.get("/api/stats", params=_auth())
    assert r.status_code == 200


def test_token_endpoint_removed(api):
    client, _ = api
    # /api/token must not be public nor exist: it leaked the access token
    assert client.get("/api/token").status_code == 401
    assert client.get("/api/token", params=_auth()).status_code == 404


def test_index_is_public_and_injects_token(api):
    client, state = api
    r = client.get("/")
    assert r.status_code == 200
    assert f'content="{TOKEN}"' in r.text


def test_favicon_public(api):
    client, _ = api
    r = client.get("/favicon.ico")
    assert r.status_code == 200
    assert "svg" in r.headers["content-type"]


def test_delete_account_cleans_mirror_log(api, tmp_path):
    client, state = api
    db = ArchiveDB(tmp_path / "a.sqlite3", check_same_thread=False)
    c1 = db.upsert_chat(_chat(), account_id=1)
    c2 = db.upsert_chat(_chat(tg_id=-100456, title="二号"), account_id=2)
    db.upsert_messages(c1, [_msg(1, "keep")])
    db.upsert_messages(c2, [_msg(1, "drop")])
    db.mark_mirrored(c1, 1, "copy", -100999, 11)
    db.mark_mirrored(c2, 1, "copy", -100999, 22)
    state.db = db
    state.account_ids = [1, 2]

    r = client.delete("/api/accounts/2", params=_auth())
    assert r.status_code == 200

    left = db.conn.execute("SELECT chat_id FROM mirror_log").fetchall()
    assert [row["chat_id"] for row in left] == [c1]
    assert db.conn.execute(
        "SELECT COUNT(*) FROM chats WHERE account_id = 2"
    ).fetchone()[0] == 0


def test_messages_search_escapes_wildcards(api, tmp_path):
    client, state = api
    db = ArchiveDB(tmp_path / "b.sqlite3", check_same_thread=False)
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(chat_id, [_msg(1, "满100减20"), _msg(2, "完成度100%的项目")])
    state.db = db

    r = client.get("/api/messages", params=_auth(text="100%"))
    items = r.json()["items"]
    assert len(items) == 1
    assert "100%" in items[0]["full_text"]

    r = client.get("/api/messages", params=_auth(text="100_"))
    assert r.json()["total"] == 0


def test_messages_pending_status_filter(api, tmp_path):
    client, state = api
    db = ArchiveDB(tmp_path / "c.sqlite3", check_same_thread=False)
    chat_id = db.upsert_chat(_chat())
    db.upsert_messages(chat_id, [_msg(1, "done"), _msg(2, "untouched")])
    db.mark_mirrored(chat_id, 1, "copy", -100999, 11)
    state.db = db

    r = client.get("/api/messages", params=_auth(status="pending"))
    items = r.json()["items"]
    assert [i["tg_message_id"] for i in items] == [2]

    r = client.get("/api/messages", params=_auth(status="done"))
    assert [i["tg_message_id"] for i in r.json()["items"]] == [1]


def test_wait_qr_recreates_expired_token(monkeypatch, tmp_path):
    """_wait_qr should call recreate() and publish the new URL when the
    token expires, then return success once scanned."""
    import asyncio
    from tg_archive import server as srv

    class FakeQR:
        def __init__(self):
            self.calls = 0

        @property
        def url(self):
            return f"tg://login?token=round{self.calls}"

        async def wait(self):
            self.calls += 1
            if self.calls <= 2:
                raise asyncio.TimeoutError
            return type("User", (), {"id": 42, "username": "alice", "first_name": "A"})()

        async def recreate(self):
            pass

    db = ArchiveDB(tmp_path / "qr.sqlite3")
    monkeypatch.setattr(srv.state, "db", db)
    qr = FakeQR()
    result = asyncio.run(srv._wait_qr(qr, 1))

    assert result["authorized"] is True
    assert result["username"] == "alice"
    # the last published pending result carries the recreated URL
    assert srv.state._qr_results[1]["qr_url"] == "tg://login?token=round2"
    db.close()


def test_authorized_client_recovers_after_reset(monkeypatch):
    """A client that reports unauthorized (broken connection) should be
    dropped and rebuilt from the session before giving up."""
    import asyncio
    from tg_archive import server as srv

    class FakeClient:
        def __init__(self, ok):
            self.ok = ok

        async def is_user_authorized(self):
            return self.ok

    broken, fresh = FakeClient(False), FakeClient(True)
    events = []

    async def fake_get(aid=1):
        events.append("get")
        return broken if srv.state.clients.get(aid) is broken else fresh

    async def fake_disconnect(aid):
        events.append("disconnect")
        srv.state.clients.pop(aid, None)

    monkeypatch.setattr(srv.state, "clients", {1: broken})
    monkeypatch.setattr(srv, "_get_or_create_client", fake_get)
    monkeypatch.setattr(srv, "_disconnect_account", fake_disconnect)

    client, ok = asyncio.run(srv._authorized_client(1))
    assert ok is True and client is fresh
    assert events == ["get", "disconnect", "get"]

    # already-authorized shortcut: single check, no reset
    events.clear()
    monkeypatch.setattr(srv.state, "clients", {1: fresh})
    _, ok = asyncio.run(srv._authorized_client(1))
    assert ok is True
    assert events == ["get"]
