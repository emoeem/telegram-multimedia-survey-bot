#!/usr/bin/env python3
"""CLI: import a survey from a Microsoft document / Forms URL.

Usage:
    uv run python scripts/import_survey_from_url.py "URL" [--output out.json]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from survey_import.url_importer import run_cli  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(run_cli())
