import { describe, expect, it } from "vitest";

import {
  ROUTE_ALLOWLIST,
  SCREEN_HELP,
  getScreenHelp,
  validateScreenHelpEntries,
} from "../../../admin/src/survey/screen-help";
import { WELCOME_SEEN_KEY, shouldShowWelcome, shouldShowWelcomeOnPath } from "../../../admin/src/survey/welcome-guide";

describe("screen help registry", () => {
  it("covers every screen that can carry a help button", () => {
    for (const key of [
      "survey",
      "plaza",
      "showcase",
      "trial",
      "coins",
      "gacha",
      "submissions",
      "notes",
      "series",
      "me",
      "submit",
      "cert",
    ]) {
      expect(getScreenHelp(key), `缺少 ${key} 的帮助内容`).not.toBeNull();
    }
  });

  it("passes the plain-language validation (entries non-empty, hrefs on the public route allowlist)", () => {
    expect(validateScreenHelpEntries()).toEqual([]);
  });

  it("keeps every intro written in plain language: no internal jargon leaks", () => {
    // 2026-11-18 用户反馈「看不懂」的直接来源是内部词汇直接当 UI 文案。
    const jargon = ["弱引用", "素材库", "管线", "content_rating", "OG", "幂等", "retention"];
    for (const [key, help] of Object.entries(SCREEN_HELP)) {
      for (const word of jargon) {
        expect(`${key}: ${help.intro}`, `${key} 的 intro 含内部术语 ${word}`).not.toContain(word);
      }
    }
  });

  it("only links entries to public routes", () => {
    for (const help of Object.values(SCREEN_HELP)) {
      for (const entry of help.entries) {
        const href = entry.href;
        if (!href) continue;
        expect(ROUTE_ALLOWLIST.some((route) => href === route || href.startsWith(`${route}/`))).toBe(true);
      }
    }
  });
});

describe("welcome guide gating", () => {
  it("welcomes first-time visitors on community and profile screens", () => {
    for (const path of [
      "/s",
      "/plaza",
      "/trial",
      "/showcase",
      "/me",
      "/coins",
      "/gacha",
      "/submissions",
      "/notes",
      "/series",
    ]) {
      expect(shouldShowWelcome({ pathname: path, seen: false, isAutomation: false }), path).toBe(true);
    }
  });

  it("never interrupts someone filling a survey (the main Telegram-link entry)", () => {
    for (const path of ["/s/123", "/s/123/og.png", "/s/456/"]) {
      expect(shouldShowWelcome({ pathname: path, seen: false, isAutomation: false }), path).toBe(false);
    }
  });

  it("stays silent on share targets, auth and internal surfaces", () => {
    for (const path of ["/r/abc", "/u/abc", "/auth", "/cert/cert.html", "/admin", "/api/surveys"]) {
      expect(shouldShowWelcome({ pathname: path, seen: false, isAutomation: false }), path).toBe(false);
    }
  });

  it("shows once: suppressed by the seen flag and in automation (visual baselines unaffected)", () => {
    expect(shouldShowWelcome({ pathname: "/plaza", seen: true, isAutomation: false })).toBe(false);
    expect(shouldShowWelcome({ pathname: "/plaza", seen: false, isAutomation: true })).toBe(false);
    expect(WELCOME_SEEN_KEY).toBe("survey_welcome_seen_v1");
  });
});
