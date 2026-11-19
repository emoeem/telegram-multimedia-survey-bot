import { readFileSync, readdirSync } from "node:fs";
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

describe("网页导航区（M2 数据面 + M4 打开字段）", () => {
  it("空数据 / 坏形状 / 非 JSON 收敛为空列表，不抛错", () => {
    for (const payload of [null, undefined, "nope", 42, {}, { items: null }, []]) {
      expect(normalizeWebAppsResponse(payload), String(payload)).toEqual([]);
    }
  });

  it("放行带 name+url 的条目，缺 name/url 的脏数据整条丢掉", () => {
    expect(
      normalizeWebAppsResponse({
        items: [
          {
            id: 7,
            name: "示例站",
            url: "https://example.com",
            description: "介绍",
            openMode: "miniapp",
            allowedDomains: ["example.com"],
          },
        ],
      }),
    ).toEqual([
      {
        id: 7,
        name: "示例站",
        url: "https://example.com",
        description: "介绍",
        openMode: "miniapp",
        allowedDomains: ["example.com"],
      },
    ]);
    /* 数组形状（不带 items 包装）同样放行：M2 的响应形状未定型，两种都接。 */
    expect(normalizeWebAppsResponse([{ name: "示例站", url: "https://example.com" }])).toEqual([
      {
        id: 0,
        name: "示例站",
        url: "https://example.com",
        description: null,
        /* 旧形状缺打开字段 → 收敛为最保守默认：browser + 空白名单（打开时拦截）。 */
        openMode: "browser",
        allowedDomains: [],
      },
    ]);
    /* openMode 非法值同样回退 browser（打开分支只在确认值上分叉）。 */
    expect(normalizeWebAppsResponse([{ name: "x", url: "https://example.com", openMode: "popup" }])[0]?.openMode).toBe(
      "browser",
    );
    /* allowedDomains 混入非字符串项：过滤脏项，不整条丢弃。 */
    expect(
      normalizeWebAppsResponse([{ name: "x", url: "https://example.com", allowedDomains: ["a.com", 42, null] }])[0]
        ?.allowedDomains,
    ).toEqual(["a.com"]);
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

describe("网页导航打开收口（M4）", () => {
  const appCenterSource = readFileSync(join(process.cwd(), "admin", "src", "survey", "AppCenterScreen.tsx"), "utf8");
  const surveyDir = join(process.cwd(), "admin", "src", "survey");

  it("外链行是点击回调打开（不再是裸 <a href>），先白名单二次校验再走三分支", () => {
    // 打开统一走 openWebAppLink（web-app-open.ts 的三分支 + 纵深防御），
    // 且 Telegram 桥经 currentWebApp 注入。
    expect(appCenterSource).toContain("openWebAppLink(app");
    expect(appCenterSource).toContain("currentWebApp()");
    // 不再渲染裸外链锚点（中键/新标签会绕过校验）。
    expect(appCenterSource).not.toContain("<a href={app.url}");
    // 打开只在点击回调里发生：handleOpen 由 onClick 触发，无 useEffect 自动调用。
    expect(appCenterSource).toContain("onClick={() => handleOpen(app)}");
    const effectBodies = appCenterSource
      .split("useEffect(")
      .slice(1)
      .map((chunk) => chunk.split("}, []")[0] ?? "");
    for (const body of effectBodies) {
      expect(body.includes("openWebAppLink"), "useEffect 里不允许出现打开调用（自动弹窗）").toBe(false);
    }
    // 拦截提示：白名单不过时给一句话，不静默失败也不盲目打开。
    expect(appCenterSource).toContain("未通过域名白名单校验");
    expect(appCenterSource).toContain('role="alert"');
  });

  it("网页导航组件零 iframe：第三方站点绝不进内嵌框（只查 <iframe 元素，注释提及不算）", () => {
    for (const name of readdirSync(surveyDir)) {
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      const source = readFileSync(join(surveyDir, name), "utf8");
      expect(source.toLowerCase().includes("<iframe"), `${name} 出现 iframe 元素`).toBe(false);
    }
    expect(appCenterSource.toLowerCase().includes("<iframe")).toBe(false);
  });
});
