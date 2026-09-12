"""Command line entry point for tg-archive.

Commands:
  login   create/refresh the MTProto session (interactive)
  chats   list dialogs the account can see, with protection flags
  mirror  collect + write messages into your archive channel
  status  local database summary
  verify  check connection / channel
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from pathlib import Path
from typing import Any, Optional

from .config import ArchiveConfig, load_config
from .db import ArchiveDB

COMPLIANCE_NOTE = (
    "⚠️  重要提示：tg-archive 以你的普通账号作为非官方客户端登录 "
    "(Telegram 会把它列为独立设备并可能观察账号)。只归档你有权访问、"
    "且允许这样使用的聊天；受保护内容默认不写入频道。"
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tg-archive",
        description="把你有权访问的 Telegram 聊天镜像到自己的私有频道（MVP）。",
    )
    parser.add_argument("--env-file", type=Path, default=None, help=".env 文件路径")
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", help="登录并保存 session（交互式）")
    p_login.add_argument("--phone", default=None, help="E.164 手机号，缺省时询问")
    p_login.add_argument("--code", default=None, help="登录验证码（不推荐显式传入）")
    p_login.add_argument(
        "--qr",
        action="store_true",
        help="用手机 Telegram 扫描二维码登录（替代短信验证码）",
    )

    p_chats = sub.add_parser("chats", help="列出账号可见的会话")

    p_mirror = sub.add_parser(
        "mirror",
        help="同步聊天并把新消息写入归档频道",
    )
    p_mirror.add_argument("chat", help="源聊天：@username、id 或显示名")
    p_mirror.add_argument("--channel", default=None, help="归档频道 @username / id")
    p_mirror.add_argument(
        "--mode",
        choices=["copy", "forward"],
        default=None,
        help="copy=带 #标签重发（默认）；forward=原样转发（无附加标签）",
    )
    p_mirror.add_argument(
        "--protected",
        choices=["skip", "text_only", "allow_media"],
        default=None,
        help=(
            "受保护聊天策略：skip（默认）| text_only（仅文字，高级）"
            " | allow_media（含媒体，绕过保存限制，高风险，仅在确认有权时用）"
        ),
    )
    p_mirror.add_argument("--dry-run", action="store_true", help="只同步和列计划，不发送")
    p_mirror.add_argument("--yes", action="store_true", help="跳过发送前确认")
    p_mirror.add_argument("--listen", action="store_true", help="同步后保持监听增量")
    p_mirror.add_argument("--media-only", action="store_true")
    p_mirror.add_argument("--since", default=None, help="只镜像该日期之后 (YYYY-MM-DD)")
    p_mirror.add_argument("--until", default=None, help="只镜像该日期之前 (YYYY-MM-DD)")
    p_mirror.add_argument("--max-posts", type=int, default=None)
    p_mirror.add_argument("--fetch-limit", type=int, default=None)
    p_mirror.add_argument("--post-delay", type=float, default=None)
    p_mirror.add_argument("--no-chat-tag", action="store_true")
    p_mirror.add_argument("--no-user-tag", action="store_true")
    p_mirror.add_argument("--no-date-tag", action="store_true")
    p_mirror.add_argument("--include-link", action="store_true")

    sub.add_parser("status", help="本地索引统计")

    p_verify = sub.add_parser("verify", help="检查连接与归档频道")
    p_verify.add_argument("--channel", default=None)

    p_web = sub.add_parser("web", help="启动本地 Web 界面（浏览器打开 http://localhost:8765）")
    p_web.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1，外网访问改 0.0.0.0）")
    p_web.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    try:
        needs_api = args.command not in ("status", "web")
        cfg = load_config(
            env_file=args.env_file,
            require_credentials=needs_api,
        ).with_overrides(
            channel=getattr(args, "channel", None),
            writer_mode=getattr(args, "mode", None),
            protected_policy=getattr(args, "protected", None),
            media_only=getattr(args, "media_only", False) or None,
            since=getattr(args, "since", None),
            until=getattr(args, "until", None),
            max_posts=getattr(args, "max_posts", None),
            fetch_limit=getattr(args, "fetch_limit", None),
            post_delay_seconds=getattr(args, "post_delay", None),
            chat_tag=None if getattr(args, "no_chat_tag", False) else True,
            user_tag=None if getattr(args, "no_user_tag", False) else True,
            date_tag=None if getattr(args, "no_date_tag", False) else True,
            include_link=getattr(args, "include_link", False) or None,
        )
    except ValueError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        print(
            "提示：在 tg-archive/ 下创建 .env（参考 .env.example），"
            "或运行 TG_API_ID=... TG_API_HASH=... tg-archive login",
            file=sys.stderr,
        )
        sys.exit(2)

    commands = {
        "login": lambda: asyncio.run(_cmd_login(cfg, args)),
        "chats": lambda: asyncio.run(_cmd_chats(cfg)),
        "mirror": lambda: asyncio.run(_cmd_mirror(cfg, args)),
        "status": lambda: _cmd_status(cfg),
        "verify": lambda: asyncio.run(_cmd_verify(cfg, args)),
        "web": lambda: _cmd_web(args),
    }
    sys.exit(commands[args.command]())


async def _open_client(cfg: ArchiveConfig):
    from telethon import TelegramClient

    client = TelegramClient(str(cfg.resolved_session), cfg.api_id, cfg.api_hash)
    await client.connect()
    return client


async def _cmd_login(cfg: ArchiveConfig, args: argparse.Namespace) -> int:
    print(COMPLIANCE_NOTE)
    client = await _open_client(cfg)
    try:
        if not await client.is_user_authorized():
            if args.qr:
                await _qr_login(client, cfg)
            else:
                phone = args.phone or cfg.phone
                if not phone:
                    phone = input("手机号（E.164，如 +8613800138000）: ").strip()
                await client.send_code_request(phone)
                code = args.code or input("验证码: ").strip()
                await _sign_in(client, phone, code)
        me = await client.get_me()
        print(f"✅ 已登录为 @{getattr(me, 'username', '') or me.id}（session 保存在 {cfg.resolved_session}）")
    except KeyboardInterrupt:
        print("\n已取消登录。")
        await client.disconnect()
        return 130
    except Exception as exc:  # noqa: BLE001 - friendly message for login errors
        print(f"登录失败：{exc}", file=sys.stderr)
        await client.disconnect()
        return 1
    await client.disconnect()
    return 0


async def _qr_login(client: Any, cfg: ArchiveConfig) -> None:
    """Scan-to-login: show QR, wait, and recreate on expiry."""

    print("📱 请用手机 Telegram 的「设置 → 设备 → 扫码登录」扫描二维码；")
    print("   二维码 3~5 分钟内有效，过期会自动重新生成。")
    while True:
        qr = await client.qr_login()
        png_path = _show_qr(qr.url, cfg.root_dir / "data" / "login_qr.png")
        if png_path:
            print(f"   二维码图片也保存在：{png_path}（可直接打开后扫码）")
        try:
            user = await qr.wait()
            print(f"✅ 扫码成功：{getattr(user, 'first_name', '')} @{getattr(user, 'username', '') or user.id}")
            return
        except asyncio.TimeoutError:
            print("   二维码已过期，正在重新生成…")
            continue
        except Exception as exc:  # noqa: BLE001
            from telethon.errors import SessionPasswordNeededError

            if isinstance(exc, SessionPasswordNeededError):
                password = getpass.getpass("两步验证密码: ")
                await client.sign_in(password=password)
                return
            raise


def _show_qr(url: str, png_path: Path) -> Optional[Path]:
    """Render QR to the terminal (block chars) and save a PNG copy.

    Returns the PNG path when qrcode is installed, otherwise None.
    """

    try:
        import qrcode
    except ImportError:
        print(f"   未安装 qrcode 渲染库，可直接在手机浏览器打开链接登录：{url}")
        return None

    code = qrcode.QRCode(border=1)
    code.add_data(url)
    code.make(fit=True)
    try:
        code.print_ascii()
    except Exception:  # noqa: BLE001 - terminal rendering is best-effort
        print(f"   二维码链接：{url}")
    try:
        png_path.parent.mkdir(parents=True, exist_ok=True)
        code.make_image(fill_color="black", back_color="white").save(png_path)
        return png_path
    except Exception:  # noqa: BLE001 - PNG is optional
        return None


async def _sign_in(client: Any, phone: str, code: str) -> None:
    from telethon.errors import SessionPasswordNeededError

    try:
        await client.sign_in(phone, code)
    except SessionPasswordNeededError:
        password = getpass.getpass("两步验证密码: ")
        await client.sign_in(password=password)


async def _cmd_chats(cfg: ArchiveConfig) -> int:
    print(COMPLIANCE_NOTE)
    client = await _open_client(cfg)
    if not await client.is_user_authorized():
        print("未登录。先运行: python -m tg_archive login", file=sys.stderr)
        await client.disconnect()
        return 1
    from .collector import Collector

    db = ArchiveDB(cfg.resolved_db)
    collector = Collector(client, cfg)
    chats = await collector.dialogs()
    print(f"{'ID':<18} {'类型':<10} {'保护':<4} 标题")
    for chat in chats:
        db.upsert_chat(chat)
        print(
            f"{chat.tg_chat_id:<18} {chat.type:<10} "
            f"{'🛡️' if chat.has_protected_content else '—':<4} {chat.title}"
        )
    db.close()
    await client.disconnect()
    return 0


async def _cmd_mirror(cfg: ArchiveConfig, args: argparse.Namespace) -> int:
    print(COMPLIANCE_NOTE)
    client = await _open_client(cfg)
    if not await client.is_user_authorized():
        print("未登录。先运行: python -m tg_archive login", file=sys.stderr)
        await client.disconnect()
        return 1

    from .mirror import MirrorEngine

    db = ArchiveDB(cfg.resolved_db)
    engine = MirrorEngine(
        client,
        cfg,
        db,
        dry_run=args.dry_run,
        yes=args.yes,
        listen=args.listen,
    )
    try:
        code = await engine.run(args.chat, args.channel)
    except KeyboardInterrupt:
        print("\n已中断。")
        code = 130
    finally:
        await client.disconnect()
        db.close()
    return code


def _cmd_status(cfg: ArchiveConfig) -> int:
    db = ArchiveDB(cfg.resolved_db)
    stats = db.stats()
    print(
        f"聊天 {stats['chats']} | 消息 {stats['messages']} | "
        f"已镜像 {stats['mirrored']} | 待处理 {stats['pending']} | "
        f"失败 {stats['failed']} | 事件 {stats['events']}"
    )
    rows = db.conn.execute(
        """
        SELECT c.tg_chat_id, c.title, c.type, c.has_protected_content,
               c.last_sync_message_id,
               (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS msgs
        FROM chats c ORDER BY c.updated_at DESC
        """
    ).fetchall()
    for row in rows:
        print(
            f"  {row['tg_chat_id']:<16} {row['title'][:40]:<40} "
            f"msg={row['msgs']:<6} last={row['last_sync_message_id']}"
            f"{' 🛡️' if row['has_protected_content'] else ''}"
        )
    db.close()
    return 0


async def _cmd_verify(cfg: ArchiveConfig, args: argparse.Namespace) -> int:
    client = await _open_client(cfg)
    if not await client.is_user_authorized():
        print("未登录。先运行: python -m tg_archive login", file=sys.stderr)
        await client.disconnect()
        return 1
    me = await client.get_me()
    print(f"✅ 已连接：@{getattr(me, 'username', '') or me.id}")
    channel = args.channel or cfg.channel
    if channel:
        from .writer import ChannelWriter

        writer = ChannelWriter(client, cfg)
        entity = await writer.resolve_channel(channel)
        print(f"✅ 频道可用：{getattr(entity, 'title', channel)} ({channel})")
    else:
        print("ℹ️  未配置频道（--channel 或 TG_ARCHIVE_CHANNEL）。")
    await client.disconnect()
    return 0


def _cmd_web(args: argparse.Namespace) -> int:
    print(f"🌐 tg-archive Web 界面启动中…")
    print(f"   浏览器打开 http://{args.host}:{args.port}")
    try:
        from .server import run_server
        run_server(host=args.host, port=args.port)
    except KeyboardInterrupt:
        print("\n已停止。")
        return 130
    return 0
