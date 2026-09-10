from pathlib import Path

import pytest

qrcode = pytest.importorskip("qrcode")

from tg_archive.cli import _show_qr  # noqa: E402


def test_show_qr_writes_png(tmp_path):
    target = tmp_path / "qr.png"
    path = _show_qr("tg://login?token=dGVzdA", target)
    assert path == target
    assert target.exists()
    assert target.stat().st_size > 100
