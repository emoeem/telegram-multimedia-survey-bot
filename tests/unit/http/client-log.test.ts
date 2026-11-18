import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIENT_LOG_PATH, handleClientLogRequest } from "../../../src/http/client-log";

/**
 * 客户端日志上报端点（B3 复核修订）：screen_view 的浏览器 console 出不了
 * 用户设备，Workers Logs 只收 Worker 侧 console.*——所以页面把同一条 JSON
 * 行 POST 到这里，由 Worker 校验后再 console.info 一遍。
 */

function kvMock(getResult: string | undefined = undefined): KVNamespace {
  return {
    get: vi.fn(async () => getResult),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
}

function envWith(kv: KVNamespace): never {
  // resolveClientIdentity 只读 RELAY_SECRET（缺省 undefined 即可）；
  // createPreferredRateLimiter 无 RATE_LIMIT 绑定时回落 KV 实现。
  return { CACHE: kv } as never;
}

function postRequest(body: string): Request {
  return new Request(`https://example.test${CLIENT_LOG_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body,
  });
}

const VALID_BODY = JSON.stringify({ type: "screen_view", screen: "plaza", path: "/plaza" });

describe("client log endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("valid screen_view → 200，Worker 侧 console.info 出一条同形状 JSON 行", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await handleClientLogRequest(postRequest(VALID_BODY), envWith(kvMock()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(infoSpy.mock.calls[0]![0] as string)).toEqual({
      type: "screen_view",
      screen: "plaza",
      path: "/plaza",
    });
  });

  it("日志纪律：IP 不落日志行", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await handleClientLogRequest(postRequest(VALID_BODY), envWith(kvMock()));

    expect(infoSpy.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("203.0.113.9");
  });

  it.each([
    ["type 不是 screen_view", JSON.stringify({ type: "click", screen: "plaza", path: "/plaza" })],
    ["screen 大写", JSON.stringify({ type: "screen_view", screen: "Plaza", path: "/plaza" })],
    ["screen 带连字符", JSON.stringify({ type: "screen_view", screen: "plaza-x", path: "/plaza" })],
    ["path 没有以 / 开头", JSON.stringify({ type: "screen_view", screen: "plaza", path: "plaza" })],
    ["path 超长", JSON.stringify({ type: "screen_view", screen: "plaza", path: `/${"a".repeat(200)}` })],
    ["path 带空白", JSON.stringify({ type: "screen_view", screen: "plaza", path: "/plaza x" })],
    ["数组 body", "[]"],
    ["null body", "null"],
    ["非 JSON", "not-json"],
    ["空 body", ""],
  ])("非法形状一律 400 且不产日志：%s", async (_label, body) => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await handleClientLogRequest(postRequest(body), envWith(kvMock()));

    expect(response.status).toBe(400);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("超长 body → 413", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await handleClientLogRequest(postRequest(`{"pad":"${"a".repeat(2000)}"}`), envWith(kvMock()));

    expect(response.status).toBe(413);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("GET → 405", async () => {
    const response = await handleClientLogRequest(
      new Request(`https://example.test${CLIENT_LOG_PATH}`, { method: "GET" }),
      envWith(kvMock()),
    );
    expect(response.status).toBe(405);
  });

  it("按地址限流：KV 计数到顶 → 429 且不产日志", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    // limiter 的 key 里是地址的 SHA-256 哈希，mock 直接把计数顶满。
    const response = await handleClientLogRequest(postRequest(VALID_BODY), envWith(kvMock("120")));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("接线守护：路由分支与客户端上报是同一条路径（main.tsx 不 import Worker 模块，静态对字面量）", () => {
    const routerSource = readFileSync(join(process.cwd(), "src", "http", "router.ts"), "utf8");
    expect(routerSource).toContain("url.pathname === CLIENT_LOG_PATH");
    const mainSource = readFileSync(join(process.cwd(), "admin", "src", "survey", "main.tsx"), "utf8");
    expect(mainSource).toContain('"/api/client-log"');
    expect(CLIENT_LOG_PATH).toBe("/api/client-log");
  });
});
