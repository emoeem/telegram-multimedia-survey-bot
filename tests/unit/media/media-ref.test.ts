import { describe, expect, it } from "vitest";
import { parseMediaRef, resolveMediaRef } from "../../../src/survey/media-ref";

/**
 * 阶段 D 读侧适配层：字符串（现状数据）原样返回保证视觉逐像素一致；
 * 结构化 {assetId}（写入侧切换后的形态）经 toUrl 派生 URL。
 * parseMediaRef 的字符串解析兼容绝对端点与相对 media/<id> 两种拼写。
 */
describe("parseMediaRef（双读）", () => {
  it("number 直读；非正整数/非整数拒绝", () => {
    expect(parseMediaRef(12)).toBe(12);
    expect(parseMediaRef(0)).toBeNull();
    expect(parseMediaRef(-3)).toBeNull();
    expect(parseMediaRef(1.5)).toBeNull();
  });

  it("字符串：绝对端点与相对拼写都能取到 id；外链/空串/data: 拒绝", () => {
    expect(parseMediaRef("/api/survey/media/12")).toBe(12);
    expect(parseMediaRef("media/7")).toBe(7);
    expect(parseMediaRef("  /api/survey/media/99  ")).toBe(99);
    expect(parseMediaRef("")).toBeNull();
    expect(parseMediaRef("https://example.com/cat.png")).toBeNull();
    expect(parseMediaRef("data:image/png;base64,AAA")).toBeNull();
    expect(parseMediaRef("media/")).toBeNull();
  });

  it("对象 {assetId} 直读（目标结构化形态）；数字字符串也接受", () => {
    expect(parseMediaRef({ assetId: 31 })).toBe(31);
    expect(parseMediaRef({ assetId: "31" })).toBe(31);
    expect(parseMediaRef({ assetId: 0 })).toBeNull();
    expect(parseMediaRef({ url: "/api/survey/media/5" })).toBeNull();
    expect(parseMediaRef([12])).toBeNull();
    expect(parseMediaRef(null)).toBeNull();
  });
});

describe("resolveMediaRef（双读派生）", () => {
  const toUrl = (assetId: number) => ["/api/survey/media/", String(assetId)].join("");

  it("字符串原样返回（视觉逐像素一致），空串/空值返回 undefined", () => {
    expect(resolveMediaRef("/api/survey/media/12", toUrl)).toBe("/api/survey/media/12");
    expect(resolveMediaRef("https://example.com/cat.png", toUrl)).toBe("https://example.com/cat.png");
    expect(resolveMediaRef("", toUrl)).toBeUndefined();
    expect(resolveMediaRef(null, toUrl)).toBeUndefined();
    expect(resolveMediaRef(undefined, toUrl)).toBeUndefined();
  });

  it("结构化 {assetId} 派生 URL，拼写与既有端点逐字节一致", () => {
    expect(resolveMediaRef({ assetId: 12 }, toUrl)).toBe("/api/survey/media/12");
    expect(resolveMediaRef(12, toUrl)).toBe("/api/survey/media/12");
    expect(resolveMediaRef({ assetId: null }, toUrl)).toBeUndefined();
  });
});

describe("backfill-media-refs（逐条遍历版）", () => {
  it("脚本含递归 CTE 游标推进与既有守卫（文本断言，与运维执行的 SQL 同源）", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "scripts", "backfill-media-refs.mjs"), "utf8");
    expect(source).toContain("WITH RECURSIVE scan");
    // 游标推进：每步吃掉一个 media/ 前缀，恒前进（终止条件 rel > 0）。
    expect(source).toContain("cursor + INSTR(SUBSTR(settings_json, cursor)");
    expect(source).toContain("DELETE FROM media_refs WHERE ref_type = 'survey_settings'");
    expect(source).toContain("INSERT OR IGNORE INTO media_refs");
    expect(source).toContain("EXISTS (SELECT 1 FROM media_assets m WHERE m.id = asset_id)");
  });
});
