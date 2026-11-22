import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubBrowser } from "../../helpers/browser-stub";

/**
 * WS 主机候选轮换（2026-11-22 中继剥 WS 升级头事故的修复）与邮箱会话
 * 滑动续期的客户端节流。候选表/轮换决策是纯函数，放 game-room-logic
 * （root tsc 的 WebWorker lib 可编译，root 单测只能导入纯逻辑模块——
 * game-room-client 持有 window/WebSocket，不进 root 工程）；URL 拼装与
 * touch 的开机挂载留在 client/SurveyApp，由 admin tsc 与结构守卫覆盖。
 */

describe("wsHostCandidateFor 主机候选", () => {
  it("候选 0 是同源（空串）", async () => {
    const { wsHostCandidateFor } = await import("../../../admin/src/survey/game-room-logic");
    expect(wsHostCandidateFor(0)).toBe("");
  });

  it("候选 1 直连 Cloudflare 自定义域（绕过剥升级头的中继）", async () => {
    const { wsHostCandidateFor } = await import("../../../admin/src/survey/game-room-logic");
    expect(wsHostCandidateFor(1)).toBe("emoe.eu.cc");
  });

  it("序号按候选数取模循环，负数也归一", async () => {
    const { wsHostCandidateFor } = await import("../../../admin/src/survey/game-room-logic");
    expect(wsHostCandidateFor(2)).toBe("");
    expect(wsHostCandidateFor(3)).toBe("emoe.eu.cc");
    expect(wsHostCandidateFor(-1)).toBe("emoe.eu.cc");
    expect(wsHostCandidateFor(-2)).toBe("");
  });
});

describe("nextWsHostIndexOnFailure 轮换决策", () => {
  it("本源从未成功：立即轮换（中继剥升级头的场景）", async () => {
    const { nextWsHostIndexOnFailure } = await import("../../../admin/src/survey/game-room-logic");
    expect(nextWsHostIndexOnFailure(0, false, 0)).toBe(1);
    expect(nextWsHostIndexOnFailure(0, false, 3)).toBe(1);
  });

  it("成功过的源粘住：偶发断线不换源", async () => {
    const { nextWsHostIndexOnFailure } = await import("../../../admin/src/survey/game-room-logic");
    expect(nextWsHostIndexOnFailure(1, true, 0)).toBe(1);
    expect(nextWsHostIndexOnFailure(1, true, 3)).toBe(1);
  });

  it("成功过的源连续 GAME_ROOM_WS_RETRY_BEFORE_SWITCH 次连不上也轮换（源下线兜底）", async () => {
    const { nextWsHostIndexOnFailure, GAME_ROOM_WS_RETRY_BEFORE_SWITCH } =
      await import("../../../admin/src/survey/game-room-logic");
    expect(nextWsHostIndexOnFailure(1, true, GAME_ROOM_WS_RETRY_BEFORE_SWITCH)).toBe(2);
  });
});

describe("touchEmailSession 滑动续期节流", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("无会话令牌时不发请求", async () => {
    const browser = stubBrowser({ url: "https://emoemok.top/me" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { touchEmailSession } = await import("../../../admin/src/survey/api");
    await touchEmailSession();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(browser.local.has("emailSessionTouchAt")).toBe(false);
  });

  it("24h 内已续签过则跳过（节流）", async () => {
    stubBrowser({
      url: "https://emoemok.top/me",
      local: { emailSessionToken: "tok", emailSessionTouchAt: String(Date.now() - 3600 * 1000) },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { touchEmailSession } = await import("../../../admin/src/survey/api");
    await touchEmailSession();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("成功续签：新令牌写回，节流标记更新", async () => {
    const browser = stubBrowser({
      url: "https://emoemok.top/me",
      local: { emailSessionToken: "old-token" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "new-token" }), { status: 200 })),
    );
    const { touchEmailSession } = await import("../../../admin/src/survey/api");
    await touchEmailSession();
    expect(browser.local.get("emailSessionToken")).toBe("new-token");
    expect(Number(browser.local.get("emailSessionTouchAt"))).toBeGreaterThan(0);
  });

  it("401 保持节流标记（会话已死，不反复空转）", async () => {
    const browser = stubBrowser({
      url: "https://emoemok.top/me",
      local: { emailSessionToken: "dead-token" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const { touchEmailSession } = await import("../../../admin/src/survey/api");
    await touchEmailSession();
    expect(browser.local.get("emailSessionToken")).toBe("dead-token");
    expect(Number(browser.local.get("emailSessionTouchAt"))).toBeGreaterThan(0);
  });

  it("网络失败撤销节流标记（下次开机重试）", async () => {
    const browser = stubBrowser({
      url: "https://emoemok.top/me",
      local: { emailSessionToken: "tok" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { touchEmailSession } = await import("../../../admin/src/survey/api");
    await touchEmailSession();
    expect(browser.local.get("emailSessionTouchAt")).toBe("0");
    expect(browser.local.get("emailSessionToken")).toBe("tok");
  });
});
