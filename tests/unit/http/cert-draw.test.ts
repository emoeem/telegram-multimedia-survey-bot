import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getTaskPackById: vi.fn() }));

vi.mock("../../../src/db/repositories/task-pack.repository", () => ({ getTaskPackById: mocks.getTaskPackById }));

import { handleCertDraw } from "../../../src/http/cert-draw";

/**
 * 认证卡抽取端点的错误边界（通宵批次 B7）：此前 drawTaskItems 的 D1 异常
 * 会冒泡成 Worker 的非 JSON 500 页，cert 生成器前端只能显示成「请求失败」。
 * 现在统一回可解释 JSON（对齐 guard.ts 的公开 API 错误边界约定）：
 * 容量类错误（D1/KV 额度）503 让前端按可重试对待，其余 500。
 * /cert 页面本身是纯静态目录，本批零改动——只动 Worker 侧。
 */

function drawRequest(ack = true): Request {
  return new Request(`https://example.test/api/cert/draw?packId=7${ack ? "&ack=adult18" : ""}`, { method: "GET" });
}

async function readError(response: Response): Promise<{ ok: boolean; code: string; message: string }> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as { ok: boolean; code: string; message: string };
}

describe("cert-draw 错误边界", () => {
  beforeEach(() => {
    mocks.getTaskPackById.mockReset();
  });

  it("D1 容量异常 → 503 JSON database_capacity（而非非 JSON 的 Worker 500）", async () => {
    mocks.getTaskPackById.mockRejectedValue(new Error("exceeded D1 daily row read limit"));
    const response = await handleCertDraw(drawRequest(), { DB: {} as unknown as D1Database }, { clientKey: "ip-1" });
    expect(response.status).toBe(503);
    expect(await readError(response)).toMatchObject({ ok: false, code: "database_capacity" });
  });

  it("普通 D1 异常 → 500 JSON internal_error", async () => {
    mocks.getTaskPackById.mockRejectedValue(new Error("boom"));
    const response = await handleCertDraw(drawRequest(), { DB: {} as unknown as D1Database }, { clientKey: "ip-1" });
    expect(response.status).toBe(500);
    expect(await readError(response)).toMatchObject({ ok: false, code: "internal_error" });
  });

  it("既有语义不回归：缺 18+ ack → 403 adult_gate；包不存在 → 404 not_found", async () => {
    const gated = await handleCertDraw(drawRequest(false), { DB: {} as unknown as D1Database }, { clientKey: "ip-1" });
    expect(gated.status).toBe(403);
    expect(await readError(gated)).toMatchObject({ ok: false, code: "adult_gate" });

    // 包不存在是 drawTaskItems 的 null 返回（不抛错），走既有 404 分支。
    mocks.getTaskPackById.mockResolvedValue(null);
    const missing = await handleCertDraw(drawRequest(), { DB: {} as unknown as D1Database }, { clientKey: "ip-1" });
    expect(missing.status).toBe(404);
    expect(await readError(missing)).toMatchObject({ ok: false, code: "not_found" });
  });
});
