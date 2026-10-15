#!/usr/bin/env python3
"""Merge the prose-expansion modules into galgame-survey.json.

Each ``scripts/galgame/prose_NN_*.py`` module exposes ``PROSE``: a
``{node_id: description}`` mapping. Modules are discovered by glob so several
can be authored in parallel without touching each other or this file.

    python3 scripts/galgame/apply_prose.py            # report only
    python3 scripts/galgame/apply_prose.py --apply    # write + one-time backup

The report re-walks the branch graph with the *engine's* real semantics
(``src/survey/engine.ts``): an option rule jumps forward only when the chosen
option matches; otherwise flow falls through to the next question in order.
``skip_to_question_id`` is ignored for the rules array form. That is why a
"stop here" option skips the two intimacy nodes and a "closer" option walks
through them.
"""
from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
SURVEY_PATH = DIR / "galgame-survey.json"


def load_prose() -> dict[str, str]:
    merged: dict[str, str] = {}
    for path in sorted(DIR.glob("prose_*.py")):
        module = importlib.import_module(path.stem)
        prose = getattr(module, "PROSE", None)
        if not isinstance(prose, dict):
            raise SystemExit(f"{path.name}: PROSE dict missing")
        clash = set(merged) & set(prose)
        if clash:
            raise SystemExit(f"{path.name}: duplicate node ids {sorted(clash)}")
        merged.update(prose)
    return merged


def routes(questions: list[dict]) -> list[list[int]]:
    """Every route shape reachable by choosing any option at any branch node."""
    index = {q["id"]: i for i, q in enumerate(questions)}
    out: list[list[int]] = []

    def step(i: int, option_id) -> int:
        question = questions[i]
        condition = question.get("condition") or {}
        for rule in condition.get("rules", []):
            if rule["optionId"] == option_id:
                target = index[rule["targetQuestionId"]]
                if target > i:
                    return target
        return i + 1

    def dfs(i: int, path: list[int]) -> None:
        if i >= len(questions):
            out.append(list(path))
            return
        question = questions[i]
        path = path + [i]
        if question.get("condition"):
            options = question.get("options") or [None]
            for option in options:
                dfs(step(i, option["id"] if option else None), path)
        else:
            dfs(i + 1, path)

    dfs(0, [])
    shapes: dict[tuple[int, ...], list[int]] = {}
    for path in out:
        shapes.setdefault(tuple(path), path)
    return list(shapes.values())


def main() -> int:
    apply = "--apply" in sys.argv
    data = json.loads(SURVEY_PATH.read_text(encoding="utf-8"))
    questions = data["survey"]["questions"]
    by_id = {q["id"]: q for q in questions}

    prose = load_prose()
    unknown = sorted(set(prose) - set(by_id))
    if unknown:
        raise SystemExit(f"PROSE references unknown node ids: {unknown}")

    missing = [q["id"] for q in questions if q["id"] not in prose]
    print(f"prose modules supply {len(prose)}/{len(questions)} nodes")
    if missing:
        print(f"  still un-expanded ({len(missing)}): {' '.join(missing)}")

    before = {q["id"]: len(q.get("description") or "") for q in questions}
    for node_id, text in prose.items():
        by_id[node_id]["description"] = text

    print(f"\n{'route shape':>12}  {'nodes':>5}  {'before':>7}  {'after':>7}  ratio")
    worst = 10**9
    for shape in sorted(routes(questions), key=len):
        was = sum(before[questions[i]["id"]] for i in shape)
        now = sum(len(questions[i].get("description") or "") for i in shape)
        worst = min(worst, now)
        print(f"{len(shape):>12}  {len(shape):>5}  {was:>7}  {now:>7}  {now / max(was, 1):.2f}x")
    total = sum(len(q.get("description") or "") for q in questions)
    print(f"\nshortest route: {worst} chars | all nodes total: {total} chars")

    if not apply:
        print("\n[report only] pass --apply to write galgame-survey.json")
        return 0

    backup = DIR / "galgame-survey.original.json"
    if not backup.exists():
        shutil.copy(SURVEY_PATH, backup)
        print(f"backup written: {backup.name}")
    SURVEY_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"wrote {SURVEY_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
