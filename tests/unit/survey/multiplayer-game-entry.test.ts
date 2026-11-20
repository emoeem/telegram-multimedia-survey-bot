import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_PAGE_META, publicPageHead } from "../../../src/http/public-page";

/**
 * 五子棋联机对战（批次 W3，/game）的接线守护。
 *
 * 与 app-center.test.ts 同一惯例：仓库没有 @testing-library，组件渲染断言
 * 降级为「静态读源码」的结构守卫；纯逻辑的真实断言在 game-room-logic.test.ts。
 */

describe("PUBLIC_PAGE_META 的 /game 条目", () => {
  it("含 /game 键，标题口径与其它公开页一致（「xx · 问卷平台」）", () => {
    const meta = PUBLIC_PAGE_META["/game"];
    expect(meta, "/game 缺 meta 条目：生产 head 注入会回退成广场那套").toBeDefined();
    expect(meta?.title).toBe("五子棋 · 联机对战 · 问卷平台");
    expect(meta?.description.trim()).not.toBe("");
  });

  it("head 注入的 canonical 指向 /game，标题/描述进了 og 与 twitter", () => {
    const { title, injectHead } = publicPageHead("https://emoemok.top", "/game");
    expect(title).toBe("五子棋 · 联机对战 · 问卷平台");
    expect(injectHead).toContain('<link rel="canonical" href="https://emoemok.top/game" />');
    expect(injectHead).toContain('<meta property="og:url" content="https://emoemok.top/game" />');
    expect(injectHead).toContain('content="五子棋 · 联机对战 · 问卷平台"');
    expect(injectHead).not.toContain("undefined");
  });
});

describe("/game 的接线（前端分发链 + Worker 静态页 + 入口卡）", () => {
  const surveyApp = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");
  const router = readFileSync(join(process.cwd(), "src", "http", "router.ts"), "utf8");
  const trialScreen = readFileSync(join(process.cwd(), "admin", "src", "survey", "TrialScreen.tsx"), "utf8");
  const appCenter = readFileSync(join(process.cwd(), "admin", "src", "survey", "AppCenterScreen.tsx"), "utf8");

  it("SurveyApp 分发链有 /game 分支且渲染懒加载的 MultiplayerGameScreen（与 /app 同款结构）", () => {
    expect(surveyApp).toContain('import("./MultiplayerGameScreen")');
    expect(surveyApp).toContain(
      'window.location.pathname === "/game" || window.location.pathname.startsWith("/game/")',
    );
    expect(surveyApp).toContain("<MultiplayerGameScreen />");
  });

  it("分发复用 LazyScreen 占位，不引入静态 import（懒加载纪律）", () => {
    const branch = surveyApp.slice(surveyApp.indexOf('pathname === "/game"'), surveyApp.indexOf("<SurveyRunner />"));
    expect(branch).toContain("<LazyScreen>");
    expect(branch).not.toMatch(/^import\s+.*MultiplayerGameScreen/m);
  });

  it("Worker 侧 /game 走 servePublicPageWithMeta（生产 assets not_found_handling=none，缺分支会真 404）", () => {
    expect(router).toContain('servePublicPageWithMeta(env, request, "/game")');
  });

  it("/trial 小游戏区有「五子棋 · 联机对战」入口卡，整页跳 /game", () => {
    expect(trialScreen).toContain('href="/game"');
    expect(trialScreen).toContain("五子棋 · 联机对战");
  });

  it("/app 应用中心小游戏区有 EntryRow 入口", () => {
    expect(appCenter).toContain('href="/game"');
    expect(appCenter).toContain("和好友实时对弈");
  });

  it("/s 与 /cert 分支未被触碰（答题流程与认证卡 DOM 不动）", () => {
    expect(surveyApp).toContain("window.location.pathname.match(/^\\/s\\/(\\d+)/)");
    expect(router).toContain('servePublicPageWithMeta(env, request, "/s")');
  });
});
