import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubBrowser, makeParticipantToken } from "../../helpers/browser-stub";

/**
 * participant-token 模块持有「每次页面加载只捕获一次」的模块级状态，每个用例
 * 都要重置模块注册表后重新 import。
 */
async function loadModule() {
  return await import("../../../admin/src/survey/participant-token");
}

const SESSION_KEY = "webSurveyParticipantToken";

describe("sessionParticipantToken", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("URL 里的 pt 被采用：写进会话存储、清掉旧持久化 token、并把参数从地址栏抹掉", async () => {
    const token = makeParticipantToken(Math.floor(Date.now() / 1000) + 3600);
    const { replaceState, local, session } = stubBrowser({
      url: `https://survey.example/s/9?v=3&pt=${token}`,
      // 旧版本把 token 持久化在 localStorage——迁移逻辑应无条件清除。
      local: { [SESSION_KEY]: makeParticipantToken(Math.floor(Date.now() / 1000) - 7200) },
      session: { [SESSION_KEY]: "stale-from-earlier-tab" },
      historyState: { idx: 4 },
    });

    const { sessionParticipantToken } = await loadModule();
    expect(sessionParticipantToken()).toBe(token);
    // 捕获只发生一次，重复调用（每个 API 请求一次）返回同一身份。
    expect(sessionParticipantToken()).toBe(token);
    expect(session.get(SESSION_KEY)).toBe(token);
    expect(local.has(SESSION_KEY)).toBe(false);
    // 地址栏不再携带身份参数，其余 query 保留；history state 原样透传给 replaceState。
    expect(replaceState).toHaveBeenCalledTimes(1);
    const call = replaceState.mock.calls[0] as unknown[] | undefined;
    expect(call?.[0]).toEqual({ idx: 4 });
    expect(call?.[2]).toBe("https://survey.example/s/9?v=3");
  });

  it("同标签页刷新（URL 已无 pt）从 sessionStorage 续用身份，且不再改地址栏", async () => {
    const token = makeParticipantToken(Math.floor(Date.now() / 1000) + 3600);
    const { replaceState, session } = stubBrowser({
      url: "https://survey.example/s/9",
      session: { [SESSION_KEY]: token },
    });

    const { sessionParticipantToken } = await loadModule();
    expect(sessionParticipantToken()).toBe(token);
    expect(replaceState).not.toHaveBeenCalled();
    expect(session.get(SESSION_KEY)).toBe(token);
  });

  it("过期或非法的 pt 被拒用并清出会话存储，而不是让每个请求 401", async () => {
    const expired = makeParticipantToken(Math.floor(Date.now() / 1000) - 10);
    const { session } = stubBrowser({
      url: `https://survey.example/s/9?pt=${expired}`,
      session: { [SESSION_KEY]: expired },
    });

    const { sessionParticipantToken } = await loadModule();
    expect(sessionParticipantToken()).toBeNull();
    expect(session.has(SESSION_KEY)).toBe(false);
  });

  it("无 URL pt、无会话存储时返回 null（含仅剩旧 localStorage token 的情况）", async () => {
    const { local } = stubBrowser({
      url: "https://survey.example/s",
      local: { [SESSION_KEY]: makeParticipantToken(Math.floor(Date.now() / 1000) + 3600) },
    });

    const { sessionParticipantToken } = await loadModule();
    expect(sessionParticipantToken()).toBeNull();
    // 旧持久化 token 即使还有效也不再被采用：持久化的 bearer 凭证正是跨人
    // 串身份的根源。
    expect(local.has(SESSION_KEY)).toBe(false);
  });

  it("旧版本（v1，无 v 字段）的 token 被拒用——版本号提升即全量吊销", async () => {
    const json = JSON.stringify({ u: 7, exp: Math.floor(Date.now() / 1000) + 3600, p: "participant" });
    const v1Payload = btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const legacy = `${v1Payload}.c2ln`;
    const { session } = stubBrowser({
      url: `https://survey.example/s/9?pt=${legacy}`,
    });

    const { sessionParticipantToken } = await loadModule();
    expect(sessionParticipantToken()).toBeNull();
    expect(session.has(SESSION_KEY)).toBe(false);
  });
});

describe("sessionParticipantIdentity 与放弃身份", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("解码会话 token 的 Telegram 资料供身份提示条展示；匿名时返回 null", async () => {
    const token = makeParticipantToken(Math.floor(Date.now() / 1000) + 3600, {
      username: "hhbtfhgtfh",
      firstName: "阿嘞",
    });
    const { replaceState, session } = stubBrowser({ url: `https://survey.example/s/9?pt=${token}` });

    const mod = await loadModule();
    expect(mod.sessionParticipantIdentity()).toEqual({
      telegramUserId: 7,
      username: "hhbtfhgtfh",
      firstName: "阿嘞",
    });

    // 放弃身份：会话存储清空、后续请求回落匿名 key，同页再问也是 null。
    mod.abandonSessionParticipantToken();
    expect(mod.sessionParticipantIdentity()).toBeNull();
    expect(mod.sessionParticipantToken()).toBeNull();
    expect(session.has(SESSION_KEY)).toBe(false);
    // URL 已在捕获时被剥离，刷新后不会重新捕获到身份。
    expect(replaceState.mock.calls[0]?.[2]).toBe("https://survey.example/s/9");
  });

  it("无 token 的页面身份为 null，放弃身份是无害的空操作", async () => {
    stubBrowser({ url: "https://survey.example/s/9" });

    const mod = await loadModule();
    expect(mod.sessionParticipantIdentity()).toBeNull();
    mod.abandonSessionParticipantToken();
    expect(mod.sessionParticipantToken()).toBeNull();
  });
});
