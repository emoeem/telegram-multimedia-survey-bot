import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    const jargon = [
      "弱引用",
      "素材库",
      "管线",
      "content_rating",
      "OG",
      "幂等",
      "retention",
      // 2026-11-19 通宵批次 B4：/trial 内部术语外泄防回潮——三套旧叫法统一
      // 为「小游戏」口径后，禁止再出现在任何帮助文案里。
      "插件玩法",
      "任务包",
      "小游戏包",
    ];
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

/**
 * 接线守护（2026-11-19 工程审计缺口收口）：此前只测注册表内容，不测接线——
 * survey/showcase/gacha 三个键在注册表里齐齐整整，页面上却没有一个 ？ 按钮。
 * 这里静态读 admin/src/survey/*.tsx（顶层，不递归）双向断言：
 *  ① 注册表每个键必须在源码里有 helpKey="<key>" 渲染点（cert 除外——cert/
 *     目录是独立静态页，本轮硬约束不碰）；
 *  ② 源码里出现的每个 helpKey="<key>" 必须有注册表条目——HelpButton 对未
 *     注册键静默返回 null，拼错一个字母按钮就无声消失。
 */
describe("screen help wiring", () => {
  const surveyDir = join(process.cwd(), "admin", "src", "survey");
  const helpKeySources = readdirSync(surveyDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(join(surveyDir, name), "utf8"));

  it("wires every registry key into a real screen (cert is a static page and exempt)", () => {
    for (const key of Object.keys(SCREEN_HELP)) {
      if (key === "cert") continue;
      const wired = helpKeySources.some((source) => source.includes(`helpKey="${key}"`));
      expect(wired, `screen-help 键 ${key} 没有任何 helpKey 渲染点（admin/src/survey/*.tsx）`).toBe(true);
    }
  });

  it("never renders a help key the registry does not define (HelpButton would silently vanish)", () => {
    for (const source of helpKeySources) {
      for (const match of source.matchAll(/helpKey="([^"]+)"/g)) {
        // noUncheckedIndexedAccess 下 match[1] 是 string | undefined；正则保证
        // 捕获组存在，缺省串只会命中 SCREEN_HELP[""] = undefined 让断言失败。
        const key = match[1] ?? "";
        expect(SCREEN_HELP[key], `helpKey="${key}" 不在 SCREEN_HELP 注册表里，按钮会静默消失`).toBeDefined();
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
