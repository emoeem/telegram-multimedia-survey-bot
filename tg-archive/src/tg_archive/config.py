"""Configuration loading.

Settings come from a .env file (default: ./tg-archive/.env) plus environment
variables. CLI flags take precedence and are merged in cli.py.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Optional


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _as_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None


def _as_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None


@dataclass(frozen=True)
class ArchiveConfig:
    """Runtime configuration for tg-archive."""

    api_id: int
    api_hash: str
    phone: Optional[str] = None

    session_path: Path = Path("data/archive.session")
    db_path: Path = Path("data/archive.sqlite3")
    media_cache: Path = Path("data/media")

    channel: Optional[str] = None  # "-100...", "@username", or display name
    writer_mode: str = "copy"  # copy | forward
    protected_policy: str = "skip"  # skip | text_only (media is never copied)
    post_delay_seconds: float = 0.8

    # filters
    since: Optional[str] = None  # ISO date "YYYY-MM-DD"
    until: Optional[str] = None
    media_only: bool = False
    max_posts: int = 500  # per run
    fetch_limit: Optional[int] = None  # max messages fetched per run

    # caption options
    chat_tag: bool = True
    user_tag: bool = True
    date_tag: bool = True
    include_link: bool = False

    root_dir: Path = field(default=Path("."))

    @property
    def resolved_session(self) -> Path:
        return self._resolve(self.session_path)

    @property
    def resolved_db(self) -> Path:
        return self._resolve(self.db_path)

    @property
    def resolved_media_cache(self) -> Path:
        return self._resolve(self.media_cache)

    def _resolve(self, path: Path) -> Path:
        if path.is_absolute():
            return path
        return self.root_dir / path

    def with_overrides(self, **kwargs: object) -> "ArchiveConfig":
        clean = {k: v for k, v in kwargs.items() if v is not None}
        return replace(self, **clean)


def default_root() -> Path:
    """Project root for tg-archive (directory containing pyproject.toml)."""
    here = Path(__file__).resolve()
    for parent in (here, *here.parents):
        if (parent / "pyproject.toml").exists():
            return parent
    return Path.cwd()


def load_config(
    env_file: Optional[Path] = None,
    root: Optional[Path] = None,
    *,
    require_credentials: bool = True,
) -> ArchiveConfig:
    root = root or default_root()
    env_path = env_file or root / ".env"
    _load_dotenv(env_path)

    api_id_raw = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH", "")
    if require_credentials and (not api_id_raw or not api_hash):
        raise ValueError(
            "TG_API_ID and TG_API_HASH are required. "
            "Create them at https://my.telegram.org and put them in tg-archive/.env "
            "(see .env.example)."
        )

    mode = os.environ.get("WRITER_MODE", "copy").strip().lower()
    if mode not in {"copy", "forward"}:
        raise ValueError("WRITER_MODE must be copy or forward")
    policy = os.environ.get("PROTECTED_POLICY", "skip").strip().lower()
    if policy not in {"skip", "text_only", "allow_media"}:
        raise ValueError(
            "PROTECTED_POLICY must be one of: skip, text_only, allow_media"
        )

    return ArchiveConfig(
        api_id=_as_int("TG_API_ID", 0),
        api_hash=api_hash,
        phone=os.environ.get("TG_PHONE") or None,
        session_path=Path(os.environ.get("TG_SESSION", "data/archive.session")),
        db_path=Path(os.environ.get("TG_ARCHIVE_DB", "data/archive.sqlite3")),
        media_cache=Path(os.environ.get("TG_MEDIA_CACHE", "data/media")),
        channel=os.environ.get("TG_ARCHIVE_CHANNEL") or None,
        writer_mode=mode,
        protected_policy=policy,
        post_delay_seconds=_as_float("POST_DELAY_SECONDS", 0.8),
        root_dir=root,
    )
