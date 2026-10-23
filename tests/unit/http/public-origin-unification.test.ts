import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 统一域名护栏：所有「用户可见的绝对 URL」必须落在 PUBLIC_ORIGIN（emoemok.top）上。
 *
 * 背景：同一个 Worker 有两个入口 ——
 *   emoe.eu.cc    Cloudflare custom domain，国内 SNI 阻断，只作为中继的上游存在
 *   emoemok.top   Vercel 中继，国内可达，是唯一对外域名
 *
 * 中继会把 Host 改写成 emoe.eu.cc 再打进来，所以 `new URL(request.url).origin`
 * 描述的是「这次请求怎么来的」，不是「用户该去哪」。凡是拿它拼链接给用户的地方，
 * 都要过 `resolvePublicOrigin(env, ...)`。
 *
 * 这里钉两件事：
 *   1. 行为：报告 PDF 在无浏览器绑定时回退到 302，Location 必须是 PUBLIC_ORIGIN
 *   2. 源码：share-api / report-api / control-api 里不存在未包装的 url.origin
 */

const mocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  getMediaAssetById: vi.fn(),
  getMediaAssetsByIds: vi.fn(),
  prepareResultProfileForResponse: vi.fn(),
  deserializeResultProfile: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: mocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: mocks.getMediaAssetById,
  getMediaAssetsByIds: mocks.getMediaAssetsByIds,
}));

vi.mock("../../../src/services/result-visual.service", () => ({
  prepareResultProfileForResponse: mocks.prepareResultProfileForResponse,
}));

vi.mock("../../../src/services/result-engine.service", () => ({
  deserializeResultProfile: mocks.deserializeResultProfile,
}));

import { handleReportRequest } from "../../../src/http/report-api";
import { createReportAccessToken } from "../../../src/services/report-access-token.service";
import type { Env } from "../../../src/index";

/** 源站域名：用户永远不该在链接里看到它。 */
const UPSTREAM_ORIGIN = "https://emoe.eu.cc";
/** 对外域名：所有用户可见链接都应该用它。 */
const PUBLIC_ORIGIN = "https://emoemok.top";

function makeDb(): D1Database {
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async (): Promise<unknown> => {
          if (sql.includes("FROM survey_responses")) {
            return { id: 42, surveyId: 1, status: "completed", completedAt: "2026-08-22T08:00:00.000Z" };
          }
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      };
      return statement;
    }),
    // 限流走 batch；给一个「未超限」的桩，让流程走到 PDF 回退分支
    batch: vi.fn(async () => [{ results: [{ count: 1 }] }, { results: [{ count: 1 }] }]),
  } as unknown as D1Database;
  return db;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: "secret",
    PUBLIC_ORIGIN,
    MEDIA_KV: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
  } as unknown as Env;
}

describe("用户可见绝对 URL 统一到 PUBLIC_ORIGIN", () => {
  it("报告 PDF 回退重定向不指向源站域名", async () => {
    mocks.getSurveyById.mockResolvedValue({ id: 1, title: "问卷标题" });
    mocks.getMediaAssetsByIds.mockResolvedValue(new Map());

    const token = await createReportAccessToken("secret", 42);
    const url = new URL(`${UPSTREAM_ORIGIN}/report/42.pdf?t=${token}`);
    const response = await handleReportRequest(new Request(url.toString()), makeEnv(makeDb()), url);

    expect(response).not.toBeNull();
    // 无 BROWSER 绑定 → htmlFallback() → 302 回到报告页
    expect(response?.status).toBe(302);
    const location = response?.headers.get("Location") ?? "";
    expect(location).toContain("emoemok.top");
    expect(location).not.toContain("emoe.eu.cc");
    expect(location).not.toContain("worker.test");
  });

  it("PUBLIC_ORIGIN 未配置时才回落到请求 origin（本地开发形态）", async () => {
    mocks.getSurveyById.mockResolvedValue({ id: 1, title: "问卷标题" });
    mocks.getMediaAssetsByIds.mockResolvedValue(new Map());

    const token = await createReportAccessToken("secret", 42);
    const url = new URL(`https://local.test/report/42.pdf?t=${token}`);
    const env = { ...makeEnv(makeDb()), PUBLIC_ORIGIN: undefined } as unknown as Env;
    const response = await handleReportRequest(new Request(url.toString()), env, url);

    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location") ?? "").toContain("https://local.test/report/42");
  });
});

describe("源码护栏：不存在未包装的 url.origin", () => {
  /**
   * 把 `resolvePublicOrigin(...)` 整体抹掉后，剩下的部分不该再出现 url.origin。
   * 反过来说：每一处取 origin 都必须在 resolvePublicOrigin 的括号里。
   */
  function unguardedOriginUses(relativePath: string): string[] {
    const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
    const stripped = source.replace(/resolvePublicOrigin\([^)]*\)/g, "GUARDED");
    const offenders: string[] = [];
    const lines = stripped.split("\n");
    lines.forEach((line, index) => {
      // 注释里提到域名不算问题，只看代码行
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/\burl\.origin\b/.test(code) || /new URL\(request\.url\)\.origin/.test(code)) {
        offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
    return offenders;
  }

  it("share-api.ts 的 og:image 与分享页 origin 都走 PUBLIC_ORIGIN", () => {
    expect(unguardedOriginUses("src/http/share-api.ts")).toEqual([]);
  });

  it("report-api.ts 的报告页链接走 PUBLIC_ORIGIN", () => {
    expect(unguardedOriginUses("src/http/report-api.ts")).toEqual([]);
  });

  it("control-api.ts 下发给客户的 licenseServerUrl 走 PUBLIC_ORIGIN", () => {
    expect(unguardedOriginUses("src/http/control-api.ts")).toEqual([]);
  });
});
