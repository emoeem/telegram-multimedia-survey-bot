import { describe, expect, it, vi } from "vitest";

import { guardApiResponse } from "../../../src/http/guard";

/**
 * 限流命中可观测性：request_metrics 只能回答「哪条路径出了 429」，归因到
 * 维度（per-email / per-ip / per-domain）靠 guard 发出的 rate_limit_hit 行。
 * KV 计数器已到上限（get 返回 "5"）是最直接的拒绝构造方式。
 */
function exhaustedKv(): KVNamespace {
  return {
    get: vi.fn(async () => "5"),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
}

function emailAuthRequest(scope: string, email: string): Request {
  return new Request(`https://example.test/api/auth/email/${scope}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ email }),
  });
}

describe("rate_limit_hit metric line", () => {
  it("attributes a 429 to the per-email dimension", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { CACHE: exhaustedKv() };

    const response = await guardApiResponse(
      emailAuthRequest("login", "attacker@example.com"),
      env as never,
      new URL("https://example.test/api/auth/email/login"),
      async () => null,
    );

    expect(response.status).toBe(429);
    const hits = warnSpy.mock.calls.filter(([label]) => label === "rate_limit_hit");
    expect(hits.length).toBe(1);
    expect(JSON.parse(hits[0]![1] as string)).toMatchObject({
      type: "rate_limit_hit",
      surface: "email-auth",
      dimension: "per-email",
      scope: "login",
    });
    // 日志纪律：限流行不落邮箱/IP 原文。
    expect(hits.map((call) => call.join(" ")).join("\n")).not.toContain("attacker@example.com");
    expect(hits.map((call) => call.join(" ")).join("\n")).not.toContain("203.0.113.9");
    warnSpy.mockRestore();
  });

  it("attributes a registration 429 to the per-domain dimension", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { CACHE: exhaustedKv() };

    const response = await guardApiResponse(
      emailAuthRequest("register", "attacker@example.com"),
      env as never,
      new URL("https://example.test/api/auth/email/register"),
      async () => null,
    );

    expect(response.status).toBe(429);
    const dimensions = warnSpy.mock.calls
      .filter(([label]) => label === "rate_limit_hit")
      .map(([, payload]) => (JSON.parse(payload as string) as { dimension: string }).dimension);
    // example.com 不在主流邮箱域名单里，register 同时烧穿 per-email 与 per-domain。
    expect(dimensions).toContain("per-domain");
    expect(dimensions).toContain("per-email");
    warnSpy.mockRestore();
  });
});
