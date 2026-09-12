"""FastAPI backend that exposes tg-archive functionality as HTTP endpoints.

Multi-account aware: each Telegram account gets its own session file and
Telethon client. A single ArchiveDB is shared (chats/messages/mirror_log are
scoped by account_id).
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import secrets
import sys
from pathlib import Path
from typing import Any, Optional
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import ArchiveConfig, load_config
from .db import ArchiveDB
from .mirror import MirrorEngine, MirrorStats


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"


class AppState:
    def __init__(self) -> None:
        self.cfg: Optional[ArchiveConfig] = None
        self.db: Optional[ArchiveDB] = None
        self.clients: dict[int, Any] = {}
        self.account_ids: list[int] = []
        self.default_account_id: int = 1
        self.mirror_task: Optional[asyncio.Task] = None
        self.mirror_progress: list[dict[str, Any]] = []
        self.mirror_done = asyncio.Event()
        self.mirror_stats: MirrorStats = MirrorStats()
        self.mirror_account_id: int = 0
        self.listen_task: Optional[asyncio.Task] = None
        self.listen_active = False
        self._qr_results: dict[int, dict[str, Any]] = {}
        self.token: str = ""
        self.mirror_exit_code: Optional[int] = None


state = AppState()


def _session_path(account_id: int) -> Path:
    assert state.cfg is not None
    base = state.cfg.resolved_session.parent
    if account_id == 1:
        return state.cfg.resolved_session
    return base / f"archive_{account_id}.session"


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.cfg = load_config(require_credentials=False)
    state.db = ArchiveDB(state.cfg.resolved_db)
    accounts = state.db.list_accounts()
    state.account_ids = [a["id"] for a in accounts] or [1]
    state.default_account_id = state.account_ids[0]
    state.token = os.environ.get("TG_ARCHIVE_TOKEN") or secrets.token_urlsafe(24)
    print(f"\n🔑 tg-archive access token: {state.token}")
    print(f"   浏览器访问: http://127.0.0.1:8765/?token={state.token}")

    # Auto-discover sessions already on disk but not in accounts table
    _ensure_existing_sessions()

    try:
        yield
    finally:
        state.listen_active = False
        if state.mirror_task and not state.mirror_task.done():
            state.mirror_task.cancel()
        if state.listen_task and not state.listen_task.done():
            state.listen_task.cancel()
        for client in state.clients.values():
            try:
                await client.disconnect()
            except Exception:
                pass
        state.clients.clear()
        if state.db:
            state.db.close()


def _ensure_existing_sessions() -> None:
    """Detect .session files on disk that don't yet have an accounts row and
    register their ids in the in-memory account list so they show up in
    /api/accounts and can be connected on demand."""
    assert state.cfg is not None and state.db is not None
    base = state.cfg.resolved_session.parent
    existing_ids = {a["id"] for a in state.db.list_accounts()}

    found_ids: list[int] = []
    # Default session (account_id=1)
    if state.cfg.resolved_session.exists() and 1 not in existing_ids:
        found_ids.append(1)
    # Secondary sessions archive_N.session
    for p in sorted(base.glob("archive_*.session")):
        stem = p.stem  # e.g. archive_3
        parts = stem.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            aid = int(parts[1])
            if aid not in existing_ids:
                found_ids.append(aid)

    if found_ids:
        state.account_ids = sorted(set(state.account_ids) | set(found_ids))
        print(f"📂 发现现有 session: account_ids={state.account_ids}")
        if state.default_account_id not in state.account_ids:
            state.default_account_id = state.account_ids[0]


async def _get_or_create_client(account_id: int = 1) -> Any:
    if account_id in state.clients:
        return state.clients[account_id]
    from telethon import TelegramClient

    assert state.cfg is not None
    session = _session_path(account_id)
    client = TelegramClient(
        str(session),
        state.cfg.api_id,
        state.cfg.api_hash,
    )
    await client.connect()
    state.clients[account_id] = client
    return client


async def _disconnect_account(account_id: int) -> None:
    client = state.clients.pop(account_id, None)
    if client:
        try:
            await client.disconnect()
        except Exception:
            pass


async def _authorized_client(account_id: int) -> tuple[Any, bool]:
    """Return (client, authorized). If the live connection looks dead (e.g.
    after a cancelled mirror run desynced Telethon), rebuild the client from
    the persisted session file before declaring the account unauthorized."""
    client = await _get_or_create_client(account_id)
    try:
        authorized = await client.is_user_authorized()
    except Exception:
        authorized = False
    if authorized:
        return client, True

    await _disconnect_account(account_id)
    try:
        client = await _get_or_create_client(account_id)
        authorized = await client.is_user_authorized()
    except Exception:
        authorized = False
    return client, authorized


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="tg-archive", lifespan=lifespan)

@app.exception_handler(Exception)
async def _handle_500(request: Request, exc: Exception):
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8765",
        "http://127.0.0.1:8765",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class LoginQRResponse(BaseModel):
    qr_url: str
    qr_png_base64: Optional[str] = None
    account_id: int = 1


class LoginPushRequest(BaseModel):
    phone: str
    account_id: int = 1


class LoginCodeRequest(BaseModel):
    phone: str
    code: str
    password: Optional[str] = None
    account_id: int = 1


class MirrorRequest(BaseModel):
    chat: str
    channel: Optional[str] = None
    mode: str = "copy"
    protected_policy: str = "skip"
    dry_run: bool = False
    listen: bool = False
    yes: bool = True
    max_posts: Optional[int] = None
    fetch_limit: Optional[int] = None
    post_delay: Optional[float] = None
    account_id: int = 1
    topic_id: Optional[int] = None
    include_topics: Optional[list[int]] = None
    exclude_topics: Optional[list[int]] = None


# ---------------------------------------------------------------------------
# Accounts endpoints
# ---------------------------------------------------------------------------

@app.get("/api/accounts")
async def list_accounts():
    assert state.db is not None
    db_accounts = {a["id"]: a for a in state.db.list_accounts()}
    out: list[dict[str, Any]] = []
    for aid in sorted(state.account_ids):
        a = dict(db_accounts.get(aid) or {
            "id": aid, "tg_user_id": None, "username": None,
            "phone": None, "first_name": None, "last_name": None,
            "is_active": 1,
        })
        client = state.clients.get(aid)
        a["connected"] = client is not None
        if client is not None:
            try:
                a["authorized"] = await client.is_user_authorized()
            except Exception:
                a["authorized"] = False
        else:
            a["authorized"] = _session_path(aid).exists()
        try:
            a["chat_count"] = len(state.db.list_chats(aid))
        except Exception:
            a["chat_count"] = 0
        out.append(a)
    return {"accounts": out, "default_account_id": state.default_account_id}


@app.delete("/api/accounts/{account_id}")
async def delete_account(account_id: int):
    if account_id == state.default_account_id and len(state.account_ids) == 1:
        raise HTTPException(status_code=400, detail="cannot delete last account")
    client = state.clients.get(account_id)
    if client is not None:
        try:
            if await client.is_user_authorized():
                await client.log_out()
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
        state.clients.pop(account_id, None)
    session = _session_path(account_id)
    if session.exists():
        session.unlink()
    assert state.db is not None
    state.db.conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    state.db.conn.execute(
        "DELETE FROM mirror_log WHERE chat_id IN (SELECT id FROM chats WHERE account_id = ?)",
        (account_id,),
    )
    state.db.conn.execute("DELETE FROM chats WHERE account_id = ?", (account_id,))
    state.db.conn.execute("DELETE FROM messages WHERE account_id = ?", (account_id,))
    state.db.conn.commit()
    state.account_ids = [a for a in state.account_ids if a != account_id]
    state.default_account_id = state.account_ids[0] if state.account_ids else 1
    return {"ok": True}


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.get("/api/auth/status")
async def auth_status(account_id: int = Query(1)):
    client, authorized = await _authorized_client(account_id)
    me = None
    if authorized:
        raw = await client.get_me()
        me = {
            "id": getattr(raw, "id", None),
            "username": getattr(raw, "username", None),
            "first_name": getattr(raw, "first_name", None),
        }
        if state.db and me["id"]:
            local_aid = state.db.save_account(
                tg_user_id=int(me["id"]),
                username=me.get("username"),
                first_name=me.get("first_name"),
            )
            if local_aid not in state.account_ids:
                state.account_ids.append(local_aid)
    return {"authorized": authorized, "me": me, "account_id": account_id}


@app.post("/api/auth/logout")
async def auth_logout(account_id: int = 1):
    await _disconnect_account(account_id)
    session = _session_path(account_id)
    if session.exists():
        session.unlink()
    if state.db:
        state.db.conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        state.db.conn.execute(
            "DELETE FROM mirror_log WHERE chat_id IN (SELECT id FROM chats WHERE account_id = ?)",
            (account_id,),
        )
        state.db.conn.commit()
        state.account_ids = [a for a in state.account_ids if a != account_id]
        state.default_account_id = state.account_ids[0] if state.account_ids else 1
    return {"ok": True}


@app.post("/api/auth/login-qr")
async def login_qr(account_id: int = 1):
    client = await _get_or_create_client(account_id)
    if await client.is_user_authorized():
        return {"authorized": True, "message": "already logged in", "account_id": account_id}

    qr = await client.qr_login()

    state._qr_results[account_id] = {
        "pending": True,
        "authorized": False,
        "qr_url": qr.url,
        "account_id": account_id,
    }
    task = asyncio.create_task(_wait_qr(qr, account_id))
    task.add_done_callback(lambda t, aid=account_id: _qr_done(t, aid))
    return LoginQRResponse(qr_url=qr.url, account_id=account_id)


async def _wait_qr(qr: Any, account_id: int) -> dict[str, Any]:
    """Wait for QR login; Telegram QR tokens expire after ~30s, so recreate
    the token and publish the new URL until scanned or the overall deadline
    (10 min) passes."""
    from telethon.errors import SessionPasswordNeededError

    deadline = asyncio.get_event_loop().time() + 600
    try:
        while asyncio.get_event_loop().time() < deadline:
            try:
                # wait() with no timeout raises TimeoutError when the token expires
                user = await qr.wait()
            except asyncio.TimeoutError:
                await qr.recreate()
                state._qr_results[account_id] = {
                    "pending": True,
                    "authorized": False,
                    "qr_url": qr.url,
                    "account_id": account_id,
                }
                continue
            result = {
                "authorized": True,
                "username": getattr(user, "username", None),
                "first_name": getattr(user, "first_name", None),
                "account_id": account_id,
            }
            if state.db:
                state.db.save_account(
                    tg_user_id=int(getattr(user, "id", 0)),
                    username=getattr(user, "username", None),
                    first_name=getattr(user, "first_name", None),
                )
            return result
        return {"authorized": False, "error": "timeout", "account_id": account_id}
    except SessionPasswordNeededError:
        return {"authorized": False, "error": "needs_password", "account_id": account_id}
    except Exception as exc:
        return {"authorized": False, "error": str(exc), "account_id": account_id}


def _qr_done(task: asyncio.Task, account_id: int) -> None:
    try:
        state._qr_results[account_id] = task.result()
    except Exception as exc:
        state._qr_results[account_id] = {"authorized": False, "error": str(exc)}


@app.get("/api/auth/login-qr/status")
async def login_qr_status(account_id: int = Query(1)):
    result = state._qr_results.get(account_id)
    if result is None:
        return {"pending": False, "account_id": account_id}
    return result


@app.post("/api/auth/login-push")
async def login_push(req: LoginPushRequest):
    client = await _get_or_create_client(req.account_id)
    if await client.is_user_authorized():
        return {"authorized": True}
    await client.send_code_request(req.phone)
    return {"ok": True, "message": "code sent"}


@app.post("/api/auth/login-code")
async def login_code(req: LoginCodeRequest):
    from telethon.errors import SessionPasswordNeededError

    client = await _get_or_create_client(req.account_id)
    if await client.is_user_authorized():
        return {"authorized": True}
    try:
        await client.sign_in(req.phone, req.code)
    except SessionPasswordNeededError:
        if req.password:
            await client.sign_in(password=req.password)
        else:
            return {"authorized": False, "needs_password": True}
    me = await client.get_me()
    if state.db:
        state.db.save_account(
            tg_user_id=int(getattr(me, "id", 0)),
            username=getattr(me, "username", None),
            phone=req.phone,
            first_name=getattr(me, "first_name", None),
        )
    return {
        "authorized": True,
        "id": getattr(me, "id", None),
        "username": getattr(me, "username", None),
        "account_id": req.account_id,
    }


# ---------------------------------------------------------------------------
# Chats
# ---------------------------------------------------------------------------

@app.get("/api/chats")
async def list_chats(account_id: int = Query(1)):
    client, authorized = await _authorized_client(account_id)
    if not authorized:
        raise HTTPException(
            status_code=401,
            detail="账号未登录或 session 已失效，请到「登录」页重新登录",
        )
    from .collector import Collector

    assert state.cfg is not None and state.db is not None
    collector = Collector(client, state.cfg)
    chats = await collector.dialogs()
    out = []
    for chat in chats:
        db_id = state.db.upsert_chat(chat, account_id=account_id)
        out.append({
            "local_id": db_id,
            "tg_chat_id": chat.tg_chat_id,
            "type": chat.type,
            "title": chat.title,
            "username": chat.username,
            "protected": chat.has_protected_content,
        })
    return {"chats": out, "total": len(out), "account_id": account_id}


@app.get("/api/chats/{local_id}/topics")
async def list_chat_topics(local_id: int, account_id: int = Query(1)):
    """List topics (Forum topics) in a supergroup channel."""

    assert state.db is not None
    row = state.db.conn.execute(
        "SELECT * FROM chats WHERE id = ? AND account_id = ?", (local_id, account_id)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="chat not found for this account")

    client = await _get_or_create_client(account_id)
    try:
        raw_topics = await client.get_forum_topics(int(row["tg_chat_id"]))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"no topics or error: {exc}")

    topics = []
    for t in raw_topics:
        topics.append({
            "topic_id": getattr(t, "id", None),
            "title": getattr(t, "title", ""),
            "is_my_topic": getattr(t, "is_my_topic", None),
            "count": getattr(t, "count", 0),
            "top_message": getattr(t, "top_message", None),
        })
    return {"topics": topics, "chat_id": local_id}


# ---------------------------------------------------------------------------
# Mirror
# ---------------------------------------------------------------------------

def _progress_sink(line: str) -> None:
    state.mirror_progress.append({"ts": _now(), "text": line})
    if len(state.mirror_progress) > 500:
        state.mirror_progress = state.mirror_progress[-400:]


def _now() -> str:
    from .normalizer import utc_now_iso
    return utc_now_iso()


async def _run_mirror(task_id: str, req: MirrorRequest) -> None:
    state.mirror_progress = []
    state.mirror_stats = MirrorStats()
    state.mirror_done.clear()
    state.mirror_account_id = req.account_id
    db: ArchiveDB | None = None
    try:
        client = await _get_or_create_client(req.account_id)
        assert state.cfg is not None and state.db is not None
        cfg = state.cfg.with_overrides(
            channel=req.channel,
            writer_mode=req.mode,
            protected_policy=req.protected_policy,
            max_posts=req.max_posts,
            fetch_limit=req.fetch_limit,
            post_delay_seconds=req.post_delay,
        )
        db = ArchiveDB(state.cfg.resolved_db, account_id=req.account_id)
        engine = MirrorEngine(
            client,
            cfg,
            db,
            dry_run=req.dry_run,
            yes=req.yes,
            listen=req.listen,
            progress=_progress_sink,
            account_id=req.account_id,
            topic_id=req.topic_id,
            include_topics=req.include_topics,
            exclude_topics=req.exclude_topics,
        )
        code = await engine.run(req.chat, req.channel)
        state.mirror_stats = engine.stats
        state.mirror_exit_code = code
    except asyncio.CancelledError:
        _progress_sink("⏹ mirror cancelled")
        state.mirror_exit_code = 130
    except Exception as exc:
        _progress_sink(f"❌ mirror error: {exc}")
        import traceback
        _progress_sink(traceback.format_exc()[-500:])
        state.mirror_exit_code = 1
    finally:
        if db is not None:
            db.close()
        state.mirror_done.set()
        state.listen_active = bool(req.listen and not state.mirror_exit_code)


@app.post("/api/mirror/start")
async def mirror_start(req: MirrorRequest):
    client, authorized = await _authorized_client(req.account_id)
    if not authorized:
        raise HTTPException(
            status_code=401,
            detail="账号未登录或 session 已失效，请到「登录」页重新登录",
        )
    if state.mirror_task and not state.mirror_task.done():
        raise HTTPException(status_code=409, detail="mirror already running")
    task_id = f"m_{_now()}"
    state.mirror_task = asyncio.create_task(_run_mirror(task_id, req))
    state.mirror_exit_code = None
    return {"task_id": task_id, "account_id": req.account_id}


@app.get("/api/mirror/status")
async def mirror_status():
    running = bool(state.mirror_task and not state.mirror_task.done())
    pending = not state.mirror_done.is_set() and not (state.mirror_task is None)
    return {
        "running": running and pending,
        "done": state.mirror_done.is_set() and not running,
        "listen_active": state.listen_active,
        "account_id": state.mirror_account_id,
        "stats": {
            "fetched": state.mirror_stats.fetched,
            "inserted": state.mirror_stats.inserted,
            "updated": state.mirror_stats.updated,
            "posted": state.mirror_stats.posted,
            "skipped": state.mirror_stats.skipped,
            "failed": state.mirror_stats.failed,
        },
        "exit_code": state.mirror_exit_code,
        "progress": state.mirror_progress[-80:],
    }


@app.post("/api/mirror/stop")
async def mirror_stop():
    if state.mirror_task and not state.mirror_task.done():
        task = state.mirror_task
        account_id = state.mirror_account_id
        task.cancel()
        state.listen_active = False
        try:
            await asyncio.wait_for(task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass
        # 取消可能让 Telethon 连接处于半残状态（协议错位/断连警告），
        # 丢弃该账号的 client，下次请求从 session 文件重建干净连接
        if account_id:
            await _disconnect_account(account_id)
        return {"ok": True}
    state.listen_active = False
    return {"ok": True, "note": "no task running"}


# ---------------------------------------------------------------------------
# Messages + stats
# ---------------------------------------------------------------------------

@app.get("/api/stats")
async def global_stats(account_id: int = Query(1)):
    assert state.db is not None
    s = state.db.stats(account_id)
    chats = state.db.list_chats(account_id)
    for c in chats:
        c["msg_count"] = int(
            state.db.conn.execute(
                "SELECT COUNT(*) FROM messages WHERE chat_id = ? AND account_id = ? AND deleted_at IS NULL",
                (c["id"], account_id),
            ).fetchone()[0]
        )
    return {"stats": s, "chats": chats, "account_id": account_id}


@app.get("/api/messages")
async def list_messages(
    account_id: int = Query(1),
    chat_id: Optional[int] = Query(None),
    topic_id: Optional[int] = Query(None),
    text: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    order: str = Query("new", pattern="^(new|old)$"),
):
    assert state.db is not None
    clauses = ["m.account_id = ?", "m.deleted_at IS NULL"]
    params: list[Any] = [account_id]

    if chat_id is not None:
        clauses.append("m.chat_id = ?")
        params.append(chat_id)

    if topic_id is not None:
        clauses.append("m.topic_id = ?")
        params.append(topic_id)

    if text:
        escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        clauses.append(r"m.text LIKE ? ESCAPE '\'")
        params.append(f"%{escaped}%")

    if status:
        if status == "pending":
            # 待处理：从未镜像过，或 mirror_log 里最新记录仍是 pending
            clauses.append("(l.status = 'pending' OR l.id IS NULL)")
        else:
            clauses.append("l.status = ?")
            params.append(status)

    dir_key = "DESC" if order == "new" else "ASC"

    count_row = state.db.conn.execute(
        f"""
        SELECT COUNT(*)
        FROM messages m
        LEFT JOIN mirror_log l ON l.id = (
            SELECT id FROM mirror_log
            WHERE mirror_log.chat_id = m.chat_id
              AND mirror_log.tg_message_id = m.tg_message_id
            ORDER BY COALESCE(mirrored_at, '') DESC, id DESC
            LIMIT 1
        )
        WHERE {' AND '.join(clauses)}
        """,
        params,
    ).fetchone()
    total = int(count_row[0]) if count_row else 0

    rows = state.db.conn.execute(
        f"""
        SELECT m.id, c.tg_chat_id AS src_tg_chat_id, c.title AS chat_title,
               m.tg_message_id, m.date, m.content_type, m.has_media,
               SUBSTR(m.text, 1, 200) AS text_preview, m.text AS full_text,
               m.sender_id, m.topic_id,
               l.status AS mirror_status, l.channel_message_id,
               l.skip_reason, l.last_error,
               m.chat_id AS local_chat_id
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        LEFT JOIN mirror_log l ON l.id = (
            SELECT id FROM mirror_log
            WHERE mirror_log.chat_id = m.chat_id
              AND mirror_log.tg_message_id = m.tg_message_id
            ORDER BY COALESCE(mirrored_at, '') DESC, id DESC
            LIMIT 1
        )
        WHERE {' AND '.join(clauses)}
        ORDER BY m.date {dir_key}, m.tg_message_id {dir_key}
        LIMIT ? OFFSET ?
        """,
        params + [limit, offset],
    ).fetchall()
    return {"total": total, "offset": offset, "limit": limit, "items": [dict(r) for r in rows]}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@app.get("/api/config")
async def get_config():
    assert state.cfg is not None
    return {
        "api_id": state.cfg.api_id,
        "channel": state.cfg.channel,
        "writer_mode": state.cfg.writer_mode,
        "protected_policy": state.cfg.protected_policy,
        "post_delay_seconds": state.cfg.post_delay_seconds,
        "max_posts": state.cfg.max_posts,
        "chat_tag": state.cfg.chat_tag,
        "user_tag": state.cfg.user_tag,
        "date_tag": state.cfg.date_tag,
    }


# ---------------------------------------------------------------------------
# Static + fallback
# ---------------------------------------------------------------------------

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR)), name="assets")

    @app.get("/")
    async def index():
        html_path = STATIC_DIR / "index.html"
        html = html_path.read_text()
        html = html.replace(
            "<meta name=\"viewport\"",
            f"<meta name=\"tg-archive-token\" content=\"{state.token}\">\n<meta name=\"viewport\"",
        )
        return StreamingResponse(io.BytesIO(html.encode()), media_type="text/html")


PUBLIC_PATHS = {"/", "/favicon.ico"}


@app.middleware("http")
async def _require_token(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/assets/"):
        return await call_next(request)

    provided = (
        request.query_params.get("token")
        or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        or request.headers.get("x-tg-archive-token")
    )
    if not provided or not state.token or not secrets.compare_digest(provided, state.token):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=401, content={"detail": "unauthorized"})

    return await call_next(request)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    path = STATIC_DIR / "favicon.svg"
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/svg+xml")


def run_server(host: str = "127.0.0.1", port: int = 8765) -> None:
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info")
