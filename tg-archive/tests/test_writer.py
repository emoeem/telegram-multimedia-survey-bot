"""Tests for ChannelWriter.resolve_channel, especially title-based lookup."""

from __future__ import annotations

import pytest
from telethon.tl.types import Channel

from tg_archive.config import ArchiveConfig
from tg_archive.writer import ChannelWriter


class FakeClient:
    """get_entity always fails (unknown username), dialogs are searchable."""

    def __init__(self, dialogs):
        self._dialogs = dialogs

    async def get_entity(self, _):
        raise ValueError('Cannot find any entity corresponding to "?"')

    def iter_dialogs(self):
        async def _gen():
            for d in self._dialogs:
                yield d
        return _gen()


class FakeDialog:
    def __init__(self, name, entity):
        self.name = name
        self.entity = entity


def _channel(title: str, chat_id: int = -100123, megagroup: bool = False) -> Channel:
    return Channel(
        id=chat_id,
        title=title,
        photo=None,
        date=None,
        access_hash=123,
        broadcast=not megagroup,
        megagroup=megagroup,
    )


def _writer(dialogs) -> ChannelWriter:
    cfg = ArchiveConfig(api_id=1, api_hash="x")
    return ChannelWriter(FakeClient(dialogs), cfg)


@pytest.mark.asyncio
async def test_resolve_channel_by_title():
    writer = _writer([FakeDialog("随机群", _channel("随机群", megagroup=True)),
                      FakeDialog("色色资料卡", _channel("色色资料卡"))])
    entity = await writer.resolve_channel("色色资料卡")
    assert entity.title == "色色资料卡"


@pytest.mark.asyncio
async def test_resolve_channel_by_title_ambiguous():
    writer = _writer([
        FakeDialog("同名", _channel("同名", chat_id=-1001)),
        FakeDialog("同名", _channel("同名", chat_id=-1002)),
    ])
    with pytest.raises(ValueError, match="同名"):
        await writer.resolve_channel("同名")


@pytest.mark.asyncio
async def test_resolve_channel_not_found_anywhere():
    writer = _writer([])
    with pytest.raises(ValueError, match="无法解析归档频道"):
        await writer.resolve_channel("不存在")
