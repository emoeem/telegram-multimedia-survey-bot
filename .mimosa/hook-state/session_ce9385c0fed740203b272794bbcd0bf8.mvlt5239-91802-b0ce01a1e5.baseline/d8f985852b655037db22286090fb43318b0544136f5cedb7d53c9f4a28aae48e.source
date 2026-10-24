"""Config validation: every construction path must reject unsafe values.

load_config() always checked the .env values, but with_overrides() (used by the
HTTP API and the CLI) did not -- so {"protected_policy": "text-only"} reached
MirrorEngine, whose policy check treated anything unrecognised as "allowed"
and uploaded media from protected chats.
"""

import pytest

from tg_archive.config import ArchiveConfig


def _cfg(**kwargs) -> ArchiveConfig:
    base = dict(api_id=1, api_hash="x")
    base.update(kwargs)
    return ArchiveConfig(**base)


@pytest.mark.parametrize("policy", ["text-only", "ALLOW_MEDIA", "", "yes", "text"])
def test_unknown_protected_policy_is_rejected(policy):
    with pytest.raises(ValueError):
        _cfg(protected_policy=policy)


@pytest.mark.parametrize("mode", ["Copy", "repost", ""])
def test_unknown_writer_mode_is_rejected(mode):
    with pytest.raises(ValueError):
        _cfg(writer_mode=mode)


@pytest.mark.parametrize("field,value", [("max_posts", -1), ("max_posts", 0),
                                         ("fetch_limit", 0), ("post_delay_seconds", -1)])
def test_invalid_limits_are_rejected(field, value):
    with pytest.raises(ValueError):
        _cfg(**{field: value})


def test_with_overrides_validates_too():
    cfg = _cfg()
    with pytest.raises(ValueError):
        cfg.with_overrides(protected_policy="text-only")
    with pytest.raises(ValueError):
        cfg.with_overrides(max_posts=-1)


def test_valid_values_still_pass():
    cfg = _cfg().with_overrides(
        protected_policy="allow_media", writer_mode="forward", max_posts=5
    )
    assert cfg.protected_policy == "allow_media"
    assert cfg.writer_mode == "forward"
    assert cfg.max_posts == 5
