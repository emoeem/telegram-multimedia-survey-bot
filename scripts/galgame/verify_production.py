#!/usr/bin/env python3
"""Verify the LIVE production survey 118 and refresh the Playwright fixture.

Runs against `https://emoe.eu.cc/api/survey/118` (real D1 + real KV), so it
proves what a participant actually receives — not what our local JSON says.

The live payload exposes numeric database ids, so every structural check here is
keyed off `order` (1..58), which is stable across re-imports.

Checks:
  1. structure  — 58 nodes, orders 1..58 contiguous, valid page refs
  2. branches   — every rule targets a *later* node, no unreachable node
  3. routes     — the 8 real shapes (4 gates x continue/stop) stay inside their
                  own route family (shared prologue + epilogue excepted) and
                  read 15-25 minutes of prose
  4. endings    — four distinct ending nodes, on four different pages
  5. BGM        — audio.url + 7 byPage + 16 byQuestion, each question-level cue
                  genuinely different from its own page's track
  6. SFX        — the 5 UI cues, all resolved to real media
  7. sprites    — 11 expression WebPs, 7 page defaults + 38 node overrides, and
                  a resolvable expression for every one of the 58 nodes
  8. media      — every referenced URL answers 200 with the right MIME type

Usage:
    python3 scripts/galgame/verify_production.py                  # verify only
    python3 scripts/galgame/verify_production.py --write-fixture   # + refresh fixture
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = ROOT / "qa" / "fixtures" / "galgame-118.json"
ORIGIN = "https://emoe.eu.cc"
API = f"{ORIGIN}/api/survey/118"
CHARS_PER_MINUTE = 250
# Cloudflare answers the default `Python-urllib/x.y` agent with 403, so both
# request paths must present a normal browser UA.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

# route family -> (first order, last order) of its exclusive node range
ROUTE_RANGES = {"d": (9, 20), "a": (21, 32), "b": (33, 44), "c": (45, 56)}
# route family -> order of its consent gate ("stop here" skips the intimate pair)
CONSENT_ORDER = {"d": 14, "a": 26, "b": 38, "c": 50}
# prologue (1..8) and epilogue (57..58) are shared by every route
SHARED_ORDERS = set(range(1, 9)) | {57, 58}
ENDING_ORDERS = (19, 31, 43, 55)
EXPECTED_BY_QUESTION = {
    "8", "17", "18", "19", "26", "27", "29", "30",
    "31", "38", "41", "42", "43", "53", "54", "55",
}
EXPECTED_SFX_CUES = {"select", "confirm", "cancel", "page", "transition"}
EXPECTED_EXPRESSIONS = 11
EXPECTED_SPRITE_BY_QUESTION = 38

failures: list[str] = []


def check(condition: object, message: str) -> bool:
    if not condition:
        failures.append(message)
    return bool(condition)


def fetch_definition() -> dict:
    request = urllib.request.Request(API, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def head(url: str) -> tuple[int, str]:
    request = urllib.request.Request(
        url, method="GET", headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.status, (response.headers.get("content-type") or "").split(";")[0].strip()


def walk(questions, index_of, answers):
    """Replay the client engine on one answer set; return (visited, completed)."""
    visited: list[dict] = []
    i = 0
    while i < len(questions):
        q = questions[i]
        visited.append(q)
        if i == len(questions) - 1:
            return visited, True
        nxt = i + 1
        selected = answers.get(q["id"])
        rule = next(
            (r for r in (q.get("condition") or {}).get("rules") or [] if r["optionId"] == selected),
            None,
        )
        if rule is not None:
            target = index_of.get(rule["targetQuestionId"])
            if target is not None and target > i:
                nxt = target
        i = nxt
    return visited, False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-fixture", action="store_true", help="把线上定义写入 qa/fixtures/galgame-118.json")
    args = parser.parse_args()

    definition = fetch_definition()
    if "questions" not in definition:
        print(f"FAIL: /api/survey/118 未返回 questions，实际键 {sorted(definition)}")
        return 1
    questions = definition["questions"]
    pages = definition["pages"]
    theme_audio = (definition.get("theme") or {}).get("audio") or {}
    print(f"live 《{definition['title']}》 · {len(questions)} 节点 / {len(pages)} 页")

    index_of = {q["id"]: i for i, q in enumerate(questions)}
    order_of = {q["id"]: q["order"] for q in questions}
    by_order = {q["order"]: q for q in questions}

    # 1. structure ---------------------------------------------------------
    check(len(questions) == 58, f"节点数应为 58，实际 {len(questions)}")
    check([q["order"] for q in questions] == list(range(1, 59)), "order 必须是 1..58 连续")
    page_ids = {p["id"] for p in pages}
    for q in questions:
        check(q.get("pageId") in page_ids, f"order {q['order']} 的 pageId 无效")

    # 2. branches ----------------------------------------------------------
    for i, q in enumerate(questions):
        for rule in (q.get("condition") or {}).get("rules") or []:
            target = index_of.get(rule["targetQuestionId"])
            check(target is not None, f"order {q['order']} 的 rule 目标不存在")
            if target is not None:
                check(target > i, f"order {q['order']} 的 rule 目标没有向前")
        for rule in (q.get("condition") or {}).get("answerRules") or []:
            target = index_of.get(rule["targetQuestionId"])
            if target is not None:
                check(target > i, f"order {q['order']} 的 answerRule 目标没有向前")

    reachable: set[int] = set()
    queue = [0]
    while queue:
        i = queue.pop(0)
        if i in reachable or i >= len(questions):
            continue
        reachable.add(i)
        queue.append(i + 1)
        for rule in (questions[i].get("condition") or {}).get("rules") or []:
            target = index_of.get(rule["targetQuestionId"])
            if target is not None:
                queue.append(target)
    unreachable = [questions[i]["order"] for i in range(len(questions)) if i not in reachable]
    check(not unreachable, f"有 {len(unreachable)} 个节点不可达：order {unreachable}")

    # 3. the 8 route shapes ------------------------------------------------
    gate = by_order.get(8)
    check(gate is not None and gate.get("options"), "order 8 的 gate 题不存在或没有选项")
    gate_rules = {r["optionId"]: r["targetQuestionId"] for r in (gate.get("condition") or {}).get("rules") or []}
    rows = []
    for route, (first_order, last_order) in ROUTE_RANGES.items():
        owned = set(range(first_order, last_order + 1))
        gate_option = next(
            (o["id"] for o in gate["options"] if order_of.get(gate_rules.get(o["id"])) == first_order),
            None,
        )
        if gate_option is None:
            untethered = [o for o in gate["options"] if o["id"] not in gate_rules]
            check(len(untethered) == 1, f"{route} 线应有唯一的默认（无 rule）gate 选项，实际 {len(untethered)}")
            gate_option = untethered[0]["id"] if untethered else None
        for mode in ("continue", "stop"):
            answers: dict[int, int] = {gate["id"]: gate_option}
            expected_skip: set[int] = set()
            if mode == "stop":
                consent = by_order[CONSENT_ORDER[route]]
                consent_rules = {
                    r["optionId"]: r["targetQuestionId"]
                    for r in (consent.get("condition") or {}).get("rules") or []
                }
                # The "stop here" option is the one whose rule skips *past* the
                # linear successor. Its wording differs per route ("停在这里" /
                # "到这里就好" / "不了，今晚到此为止"), so match on the rule,
                # never on the label.
                stop = next(
                    (o for o in consent["options"]
                     if order_of.get(consent_rules.get(o["id"]), 0) > CONSENT_ORDER[route] + 1),
                    None,
                )
                check(stop is not None,
                      f"{route} 线（order {CONSENT_ORDER[route]}）没有能跳过亲密章节的选项")
                if stop:
                    answers[consent["id"]] = stop["id"]
                    target_order = order_of[consent_rules[stop["id"]]]
                    expected_skip = set(range(CONSENT_ORDER[route] + 1, target_order))
            for q in questions:
                if q["id"] in answers or not q.get("options"):
                    continue
                jumping = {r["optionId"] for r in (q.get("condition") or {}).get("rules") or []}
                linear = next((o for o in q["options"] if o["id"] not in jumping), None)
                answers[q["id"]] = (linear or q["options"][0])["id"]

            visited, completed = walk(questions, index_of, answers)
            visited_orders = {q["order"] for q in visited}
            label = f"{route}/{'继续' if mode == 'continue' else '打住'}"
            check(completed, f"{label} 没走到结尾（停在 order {visited[-1]['order']}）")
            check(visited[-1]["order"] == 58, f"{label} 最后停的是 order {visited[-1]['order']}，不是 58")
            foreign = [
                q["order"] for q in visited
                if q["order"] not in owned and q["order"] not in SHARED_ORDERS
            ]
            check(not foreign, f"{label} 串线到别条线族：order {foreign}")
            if mode == "stop":
                skipped = owned - visited_orders
                check(skipped == expected_skip,
                      f"{label} 跳过的节点 order {sorted(skipped)} 与预期 {sorted(expected_skip)} 不符")
            else:
                check(owned <= visited_orders,
                      f"{label} 没有走完整条线族，缺 order {sorted(owned - visited_orders)}")
            chars = sum(len(q.get("description") or "") for q in visited)
            minutes = chars / CHARS_PER_MINUTE
            rows.append((label, len(visited), chars, minutes))
            check(15 <= minutes <= 25,
                  f"{label} 时长 {minutes:.1f} 分钟（节点 {len(visited)}、{chars} 字）不在 15–25 分钟")

    print("  路线形状（250 字/分钟）:")
    for label, nodes, chars, minutes in rows:
        print(f"    {label:16s} 节点 {nodes:2d} · {chars} 字 · ≈{minutes:.1f} 分钟")

    # 4. four distinct endings --------------------------------------------
    endings = [by_order.get(o) for o in ENDING_ORDERS]
    check(all(endings), f"缺少结局节点：{[o for o, e in zip(ENDING_ORDERS, endings) if not e]}")
    if all(endings):
        check(len({q["pageId"] for q in endings}) == 4, "四个结局应在四个不同的页上")

    # 5. BGM ---------------------------------------------------------------
    by_page = theme_audio.get("byPage") or {}
    by_question = theme_audio.get("byQuestion") or {}
    check(isinstance(theme_audio.get("url"), str) and theme_audio["url"], "缺少 audio.url")
    check(set(by_page) == {str(i) for i in range(7)}, f"byPage 键应为 0..6，实际 {sorted(by_page)}")
    check(set(by_question) == EXPECTED_BY_QUESTION,
          f"byQuestion 键集合不符：多 {sorted(set(by_question) - EXPECTED_BY_QUESTION)} "
          f"缺 {sorted(EXPECTED_BY_QUESTION - set(by_question))}")
    page_pos = {p["id"]: i for i, p in enumerate(pages)}
    for key, track in by_question.items():
        q = by_order.get(int(key)) if key.isdigit() else None
        check(q is not None, f"byQuestion 键 {key} 不是真实 order")
        if q:
            check(track != by_page.get(str(page_pos.get(q["pageId"]))),
                  f"order {key} 的节点级曲目与所在页页级曲目相同，等于死配置")
    finale = by_question.get("19")
    check(finale is not None and all(by_question.get(str(o)) == finale for o in ENDING_ORDERS),
          "四个结局应共用同一首收束曲")
    distinct = len({theme_audio.get("url"), *by_page.values(), *by_question.values()})
    print(f"  BGM: url + {len(by_page)} 页级 + {len(by_question)} 节点级（{distinct} 首不同曲目）")

    # 6. UI sound effects --------------------------------------------------
    # The cue names are the contract with `src/survey/theme.ts`; a cue the front
    # end does not know is dead config, and one it expects but that is missing
    # simply stays silent.
    sfx = theme_audio.get("sfx") or {}
    check(set(sfx) == EXPECTED_SFX_CUES,
          f"sfx cue 集合不符：多 {sorted(set(sfx) - EXPECTED_SFX_CUES)} "
          f"缺 {sorted(EXPECTED_SFX_CUES - set(sfx))}")
    for cue, url in sfx.items():
        check(isinstance(url, str) and url.startswith("/api/survey/media/"),
              f"sfx {cue} 的 URL 未解析到媒体：{url}")
    if set(sfx) == EXPECTED_SFX_CUES:
        print(f"  SFX: {len(sfx)} 条界面音效（{', '.join(sorted(sfx))}）")

    # 7. character sprites -------------------------------------------------
    theme_sprite = (definition.get("theme") or {}).get("sprite") or {}
    expressions = theme_sprite.get("expressions") or {}
    sprite_by_page = theme_sprite.get("byPage") or {}
    sprite_by_question = theme_sprite.get("byQuestion") or {}
    check(bool(theme_sprite.get("name")), "立绘缺少角色名")
    check(len(expressions) == EXPECTED_EXPRESSIONS,
          f"立绘表情应为 {EXPECTED_EXPRESSIONS} 个，实际 {len(expressions)}")
    for key, url in expressions.items():
        check(isinstance(url, str) and url.startswith("/api/survey/media/"),
              f"立绘表情 {key} 的 URL 未解析到媒体：{url}")
    check(theme_sprite.get("default") in expressions,
          f"立绘 default={theme_sprite.get('default')} 不在表情表内")
    check(set(sprite_by_page) == {str(i) for i in range(len(pages))},
          f"立绘 byPage 键应为 0..{len(pages) - 1}，实际 {sorted(sprite_by_page)}")
    check(len(sprite_by_question) == EXPECTED_SPRITE_BY_QUESTION,
          f"立绘 byQuestion 应为 {EXPECTED_SPRITE_BY_QUESTION} 条，实际 {len(sprite_by_question)}")

    # Every node must resolve to an expression that actually has artwork: the
    # runtime falls back rather than breaking, but a node with no reachable
    # expression would silently drop the character from the scene.
    unresolved: list[int] = []
    for key, expression in sprite_by_question.items():
        q = by_order.get(int(key)) if key.isdigit() else None
        check(q is not None, f"立绘 byQuestion 键 {key} 不是真实 order")
        check(expression in expressions, f"立绘 order {key} 的表情 {expression} 没有素材")
        if q and expression not in expressions:
            unresolved.append(q["order"])
        if q:
            page_default = sprite_by_page.get(str(page_pos[q["pageId"]]))
            check(expression != page_default,
                  f"立绘 order {key} 的表情与所在页默认相同，等于死配置")
    for q in questions:
        if q["order"] in {int(k) for k in sprite_by_question if k.isdigit()}:
            continue
        resolved = sprite_by_page.get(str(page_pos[q["pageId"]])) or theme_sprite.get("default")
        check(resolved in expressions, f"立绘 order {q['order']} 无可用表情（解析为 {resolved}）")
    check(not unresolved, f"这些节点解析不到有素材的表情：order {unresolved}")
    if len(expressions) == EXPECTED_EXPRESSIONS:
        print(f"  立绘: {len(expressions)} 个表情 / {len(sprite_by_page)} 条页级 / "
              f"{len(sprite_by_question)} 条节点级")

    # 8. media -------------------------------------------------------------
    sfx_urls = list(sfx.values())
    sprite_urls = list(expressions.values())
    audio_urls: list[str] = [theme_audio["url"]]
    for source in (by_page, by_question):
        for url in source.values():
            if url not in audio_urls:
                audio_urls.append(url)
    image_urls: list[str] = []
    background = ((definition.get("theme") or {}).get("background") or {}).get("image")
    if isinstance(background, str):
        image_urls.append(background)
    for q in questions:
        for entry in q.get("media") or []:
            if entry.get("url") and entry["url"] not in image_urls:
                image_urls.append(entry["url"])

    for url in audio_urls + sfx_urls:
        status, mime = head(f"{ORIGIN}{url}")
        check(status == 200, f"音频 {url} 返回 {status}")
        check(mime == "audio/mpeg", f"音频 {url} MIME 异常 {mime}")
    for url in image_urls:
        status, mime = head(f"{ORIGIN}{url}")
        check(status == 200, f"图片 {url} 返回 {status}")
        check(mime.startswith("image/"), f"图片 {url} MIME 异常 {mime}")
    for url in sprite_urls:
        status, mime = head(f"{ORIGIN}{url}")
        check(status == 200, f"立绘 {url} 返回 {status}")
        check(mime == "image/webp", f"立绘 {url} MIME 应为 image/webp，实际 {mime}")

    # 9. alt 文本 ----------------------------------------------------------
    # 插画不能只有 URL：每个 media 条目都要带非空 alt（无障碍 + 破图时的语义）。
    media_entries = [e for q in questions for e in (q.get("media") or [])]
    missing_alt = [e.get("url") for e in media_entries if not (e.get("alt") or "").strip()]
    check(not missing_alt, f"这些插画缺 alt：{missing_alt}")
    check(len(media_entries) == 16, f"题内插画应为 16 张，实际 {len(media_entries)}")
    check(len(image_urls) == 17, f"插画总数（含封面）应为 17 张，实际 {len(image_urls)}")
    if not missing_alt:
        avg = sum(len(e["alt"]) for e in media_entries) // len(media_entries)
        print(f"  alt: {len(media_entries)} 张题内插画全部有 alt（平均 {avg} 字）")

    print(f"  媒体: {len(audio_urls)} 个 BGM + {len(sfx_urls)} 个音效 + "
          f"{len(image_urls)} 张插画 + {len(sprite_urls)} 张立绘，全部 200 + MIME 正确")

    if args.write_fixture:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(definition, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  已刷新 fixture: {FIXTURE.relative_to(ROOT)}")

    if failures:
        print(f"\nFAIL ({len(failures)})")
        for item in failures:
            print(f"  x {item}")
        return 1
    print("\nPASS: 生产问卷 118 结构、分支、时长与素材全部校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
