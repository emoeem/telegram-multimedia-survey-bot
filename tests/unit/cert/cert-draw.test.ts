import { describe, expect, it, vi } from "vitest";

const { drawTaskItems } = vi.hoisted(() => ({ drawTaskItems: vi.fn() }));
vi.mock("../../../src/services/game-draw.service", () => ({ drawTaskItems }));

import { handleCertDraw } from "../../../src/http/cert-draw";
import { validateCertContentPack } from "../../../src/http/admin/cert-content";

function makeUrl(query: string): URL {
  return new URL(`http://localhost/api/cert/draw?${query}`);
}

const env = { DB: {} as D1Database, CACHE: null };

describe("GET /api/cert/draw", () => {
  it("缺 18+ ack 一律 403，且不触库", async () => {
    const response = await handleCertDraw(new Request(makeUrl("packId=1")), env, { clientKey: "ip" });
    expect(response.status).toBe(403);
    expect(drawTaskItems).not.toHaveBeenCalled();
  });

  it("ack 不正确同样拒绝", async () => {
    const response = await handleCertDraw(new Request(makeUrl("packId=1&ack=yes")), env, { clientKey: "ip" });
    expect(response.status).toBe(403);
  });

  it("packId 非法返回 400", async () => {
    const response = await handleCertDraw(new Request(makeUrl("packId=x&ack=adult18")), env, { clientKey: "ip" });
    expect(response.status).toBe(400);
  });

  it("合法请求抽取并透传 persona/count", async () => {
    drawTaskItems.mockResolvedValueOnce([{ id: 1, title: "T", description: "D", warning: "", score: 3 }]);
    const response = await handleCertDraw(new Request(makeUrl("packId=7&ack=adult18&persona=female&count=9")), env, {
      clientKey: "ip",
    });
    expect(response.status).toBe(200);
    expect(drawTaskItems).toHaveBeenCalledWith({}, 7, { persona: "female", count: 5 });
    const body = (await response.json()) as { ok: boolean; items: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it("包不存在返回 404", async () => {
    drawTaskItems.mockResolvedValueOnce(null);
    const response = await handleCertDraw(new Request(makeUrl("packId=99&ack=adult18")), env, { clientKey: "ip" });
    expect(response.status).toBe(404);
  });
});

describe("cert 内容包 draw 字段校验", () => {
  const baseTheme = {
    id: "drawn",
    name: "抽取主题",
    tags: ["标签一", "标签二"],
    ranks: [
      { min: 0, max: 50, name: "低" },
      { min: 50, max: 100, name: "高" },
    ],
  };

  it("合法 draw 段保留 packId/count/label", () => {
    const result = validateCertContentPack({
      themes: [{ ...baseTheme, draw: { packId: 3, count: 9, label: "抽一个" } }],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.pack.themes[0]?.draw).toEqual({ packId: 3, count: 5, label: "抽一个" });
    }
  });

  it("无 draw 段或非法 packId 时字段被丢弃，老内容包不受影响", () => {
    for (const draw of [undefined, {}, { packId: 0 }, { packId: "x" }]) {
      const result = validateCertContentPack({ themes: [{ ...baseTheme, ...(draw ? { draw } : {}) }] });
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.pack.themes[0]?.draw).toBeUndefined();
      }
    }
  });
});
