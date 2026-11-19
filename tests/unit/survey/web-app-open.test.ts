import { afterEach, describe, expect, it, vi } from "vitest";

import { isWebAppUrlAllowed, openWebAppLink } from "../../../admin/src/survey/web-app-open";

/**
 * 网页导航打开逻辑（2026-11-20 P0 加固批次 M4，安全敏感面）：
 *
 * - 三分支：Telegram+miniapp / Telegram+browser 都走 Telegram.WebApp.openLink
 *   （WebView 里 window.open 不可靠，客户端文档要求外链一律 openLink），
 *   普通浏览器走 window.open(url, '_blank', 'noopener,noreferrer')；
 * - 纵深防御：打开前按公开 API 下发的 allowed_domains 二次校验目标 host
 *   （服务端同策略镜像），被篡改的 url / 空白名单一律拦截；
 * - 零网络副作用：打开动作本身不发任何请求（点击前无预加载/ping）；
 * - 所有分支只应由用户点击回调触发，这里直接以纯函数方式驱动。
 */

function makeBridge() {
  return { openLink: vi.fn() };
}

function makeWindowOpen() {
  return vi.fn<(url: string, target: string, features: string) => null>(() => null);
}

const GOOD_APP = {
  url: "https://good.example.com/page",
  allowedDomains: ["good.example.com"],
};

describe("openWebAppLink 三分支", () => {
  it("Telegram + miniapp：经 openLink 打开，不碰 window.open", () => {
    const bridge = makeBridge();
    const windowOpen = makeWindowOpen();
    const outcome = openWebAppLink({ ...GOOD_APP, openMode: "miniapp" }, { telegramWebApp: bridge, windowOpen });
    expect(outcome).toBe("opened:telegram-miniapp");
    expect(bridge.openLink).toHaveBeenCalledTimes(1);
    expect(bridge.openLink).toHaveBeenCalledWith("https://good.example.com/page");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("Telegram + browser：同样经 openLink 打开（Telegram 交给系统浏览器）", () => {
    const bridge = makeBridge();
    const windowOpen = makeWindowOpen();
    const outcome = openWebAppLink({ ...GOOD_APP, openMode: "browser" }, { telegramWebApp: bridge, windowOpen });
    expect(outcome).toBe("opened:telegram-link");
    expect(bridge.openLink).toHaveBeenCalledTimes(1);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("普通浏览器：window.open(url, '_blank', 'noopener,noreferrer')，不走 Telegram 桥", () => {
    const bridge = makeBridge();
    const windowOpen = makeWindowOpen();
    const outcome = openWebAppLink({ ...GOOD_APP, openMode: "browser" }, { telegramWebApp: null, windowOpen });
    expect(outcome).toBe("opened:browser-tab");
    expect(windowOpen).toHaveBeenCalledTimes(1);
    expect(windowOpen).toHaveBeenCalledWith("https://good.example.com/page", "_blank", "noopener,noreferrer");
    expect(bridge.openLink).not.toHaveBeenCalled();
    // open_mode=miniapp 在普通浏览器同样落新标签分支（不存在内嵌 WebView）。
    expect(openWebAppLink({ ...GOOD_APP, openMode: "miniapp" }, { telegramWebApp: null, windowOpen })).toBe(
      "opened:browser-tab",
    );
  });

  it("桥未就绪（openLink 缺失）回退普通浏览器分支；连 window.open 都没有则拦截", () => {
    const windowOpen = makeWindowOpen();
    expect(openWebAppLink(GOOD_APP, { telegramWebApp: {}, windowOpen })).toBe("opened:browser-tab");
    expect(openWebAppLink(GOOD_APP, { telegramWebApp: null })).toBe("blocked:not-allowed");
  });
});

describe("isWebAppUrlAllowed 纵深防御（服务端白名单策略镜像）", () => {
  it("显式主机名精确命中；被篡改的 url（host 不在白名单）不命中", () => {
    expect(isWebAppUrlAllowed("https://good.example.com/x", ["good.example.com"])).toBe(true);
    expect(isWebAppUrlAllowed("https://evil.example.com", ["good.example.com"])).toBe(false);
    expect(isWebAppUrlAllowed("https://sub.good.example.com", ["good.example.com"])).toBe(false);
  });

  it("通配 *.b 命中任意深度子域但不含裸域；坏 url / 空白名单一律 false", () => {
    expect(isWebAppUrlAllowed("https://a.b.example.com", ["*.example.com"])).toBe(true);
    expect(isWebAppUrlAllowed("https://a.b.c.example.com", ["*.example.com"])).toBe(true);
    expect(isWebAppUrlAllowed("https://example.com", ["*.example.com"])).toBe(false);
    expect(isWebAppUrlAllowed("not a url", ["*.example.com"])).toBe(false);
    expect(isWebAppUrlAllowed("https://good.example.com", [])).toBe(false);
    expect(isWebAppUrlAllowed("https://good.example.com", null)).toBe(false);
  });
});

describe("openWebAppLink 拦截路径", () => {
  it("被篡改的返回数据（url 换域）触发拦截：不打开、零网络副作用", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const bridge = makeBridge();
    const windowOpen = makeWindowOpen();
    // 管理端数据被篡改：url 指向 evil.example.com，白名单仍是 good.example.com。
    const outcome = openWebAppLink(
      { url: "https://evil.example.com/page", allowedDomains: ["good.example.com"], openMode: "miniapp" },
      { telegramWebApp: bridge, windowOpen },
    );
    expect(outcome).toBe("blocked:not-allowed");
    expect(bridge.openLink).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    // 打开动作本身（三个分支一起跑）不发任何网络请求。
    openWebAppLink({ ...GOOD_APP, openMode: "miniapp" }, { telegramWebApp: bridge, windowOpen });
    openWebAppLink({ ...GOOD_APP, openMode: "browser" }, { telegramWebApp: bridge, windowOpen });
    openWebAppLink(GOOD_APP, { telegramWebApp: null, windowOpen });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("空白名单（数据异常/被篡改）拦截并提示路径可达；白名单内 URL 正常打开", () => {
    const windowOpen = makeWindowOpen();
    expect(openWebAppLink({ url: "https://good.example.com", allowedDomains: [] }, { windowOpen })).toBe(
      "blocked:not-allowed",
    );
    expect(openWebAppLink({ url: "https://good.example.com" }, { windowOpen })).toBe("blocked:not-allowed");
    expect(openWebAppLink(GOOD_APP, { windowOpen })).toBe("opened:browser-tab");
    expect(openWebAppLink({ url: "https://a.b.example.com", allowedDomains: ["*.example.com"] }, { windowOpen })).toBe(
      "opened:browser-tab",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
