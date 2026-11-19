import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_PAGE_META, publicPageHead } from "../../../src/http/public-page";
import { normalizeWebAppsResponse, fetchWebApps } from "../../../admin/src/survey/web-apps";

/**
 * 应用中心（/app，2026-11-20 P0 加固批次 M1）。
 *
 * 仓库没有 @testing-library（见 note-chat-actions.test.ts 的约定），组件渲染
 * 断言按既有惯例降级为「静态读源码」的结构守卫；纯逻辑（meta 键、响应形状
 * 收敛、404 兜底）保持真实断言。
 */

describe("PUBLIC_PAGE_META 的 /app 条目", () => {
  it("含 /app 键，标题口径与其它公开页一致（「xx · 问卷平台」）", () => {
    const meta = PUBLIC_PAGE_META["/app"];
    expect(meta, "/app 缺 meta 条目：生产 head 注入会回退成广场那套").toBeDefined();
    expect(meta?.title).toBe("应用中心 · 问卷平台");
    expect(meta?.description.trim()).not.toBe("");
  });

  it("head 注入的 canonical 指向 /app，标题/描述进了 og 与 twitter", () => {
    const { title, injectHead } = publicPageHead("https://emoemok.top", "/app");
    expect(title).toBe("应用中心 · 问卷平台");
    expect(injectHead).toContain('<link rel="canonical" href="https://emoemok.top/app" />');
    expect(injectHead).toContain('<meta property="og:url" content="https://emoemok.top/app" />');
    expect(injectHead).toContain('content="应用中心 · 问卷平台"');
    expect(injectHead).not.toContain("undefined");
  });
});

describe("SurveyApp 按路径分派到 AppCenterScreen", () => {
  const surveyApp = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");

  it("/app 分支存在且渲染懒加载的 AppCenterScreen（与 /help 同款结构）", () => {
    expect(surveyApp).toContain('import("./AppCenterScreen")');
    expect(surveyApp).toContain('window.location.pathname === "/app" || window.location.pathname.startsWith("/app/")');
    expect(surveyApp).toContain("<AppCenterScreen />");
  });

  it("分派复用 LazyScreen 占位，不引入静态 import（懒加载纪律）", () => {
    const branch = surveyApp.slice(surveyApp.indexOf('pathname === "/app"'), surveyApp.indexOf("<SurveyRunner />"));
    expect(branch).toContain("<LazyScreen>");
    expect(branch).not.toMatch(/^import\s+.*AppCenterScreen/m);
  });
});

describe("网页导航区（M2 落地前的空态）", () => {
  it("空数据 / 坏形状 / 非 JSON 收敛为空列表，不抛错", () => {
    for (const payload of [null, undefined, "nope", 42, {}, { items: null }, []]) {
      expect(normalizeWebAppsResponse(payload), String(payload)).toEqual([]);
    }
  });

  it("放行带 name+url 的条目，缺 name/url 的脏数据整条丢掉", () => {
    expect(
      normalizeWebAppsResponse({ items: [{ id: 7, name: "示例站", url: "https://example.com", description: "介绍" }] }),
    ).toEqual([{ id: 7, name: "示例站", url: "https://example.com", description: "介绍" }]);
    /* 数组形状（不带 items 包装）同样放行：M2 的响应形状未定型，两种都接。 */
    expect(normalizeWebAppsResponse([{ name: "示例站", url: "https://example.com" }])).toEqual([
      { id: 0, name: "示例站", url: "https://example.com", description: null },
    ]);
    /* name/url 空缺、trim 后为空、条目不是对象：都不进列表。 */
    expect(
      normalizeWebAppsResponse([{ url: "https://example.com" }, { name: "x" }, "junk", { name: "  ", url: "/" }]),
    ).toEqual([]);
  });

  it("fetchWebApps 对非 2xx（M2 前的 404）返回空数组，绝不抛出", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await expect(fetchWebApps()).resolves.toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchWebApps()).resolves.toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>不是 JSON</html>", { status: 200 })),
    );
    await expect(fetchWebApps()).resolves.toEqual([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AppCenterScreen 渲染四区，网页导航区带空态文案（静态源码守卫）", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "AppCenterScreen.tsx"), "utf8");
    // 四功能区一个不少。
    expect(source).toContain('href="/s"');
    expect(source).toContain('href="/trial"');
    expect(source).toContain('href="/plaza"');
    expect(source).toContain('href="/notes"');
    // 空态：apps 为 null（加载）/ []（404·空数据）时都有话可说，不报错不白屏。
    expect(source).toContain("网页导航还在筹备中");
    expect(source).toContain("apps.length === 0");
  });
});
