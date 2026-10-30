import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * cert/render.js 是一个浏览器端 IIFE（`window.CERT_RENDER = (function(){...})()`），
 * 不参与 tsc 的类型检查，也没有 import 入口。它最容易坏的地方不是算法，而是**注册表**：
 * 加版式时漏写 render、两个版式撞同一个 id、成人向漏打标记 —— 这些错误页面打开就白屏，
 * 但没有任何构建会拦住。
 *
 * 所以这里用一个假的 window 把文件跑一遍，断言注册表本身。渲染函数体不执行
 * （只在注册时保存引用），因此不需要 canvas / qrcode。
 */

type StyleEntry = {
  id: string;
  name: string;
  group?: string;
  adult?: boolean;
  render: unknown;
};

type Registry = {
  STYLES: StyleEntry[];
  RATIOS: { id: string; name: string; w: number; h: number }[];
  findStyle: (id: string) => StyleEntry;
  findRatio: (id: string) => { id: string };
};

function loadRegistry(): Registry {
  const src = readFileSync(join(process.cwd(), "cert", "render.js"), "utf8");
  const fakeWindow: { CERT_RENDER?: Registry } = {};
  const run = new Function("window", src) as (w: unknown) => void;
  run(fakeWindow);
  if (!fakeWindow.CERT_RENDER) throw new Error("render.js 没有挂 window.CERT_RENDER");
  return fakeWindow.CERT_RENDER;
}

const registry = loadRegistry();

describe("认证卡版式注册表", () => {
  it("版式 id 唯一", () => {
    const ids = registry.STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个版式都有名字和渲染函数", () => {
    for (const style of registry.STYLES) {
      expect(style.id, "id 不能为空").toBeTruthy();
      expect(style.name, `${style.id} 缺名字`).toBeTruthy();
      expect(typeof style.render, `${style.id} 的 render 不是函数`).toBe("function");
    }
  });

  it("分组只有 doc / fun 两种，证件族齐全", () => {
    const groups = new Set(registry.STYLES.map((s) => s.group));
    expect([...groups].sort()).toEqual(["doc", "fun"]);
    const docIds = registry.STYLES.filter((s) => s.group === "doc").map((s) => s.id);
    // 用户要的就是「身份证、学生证这种」，这 10 个是拟真证件的下限
    for (const id of [
      "doc_id",
      "doc_student",
      "doc_work",
      "doc_driver",
      "doc_marriage",
      "doc_medical",
      "doc_member",
      "doc_admit",
      "doc_pet",
      "doc_honor",
    ]) {
      expect(docIds, `缺证件样式 ${id}`).toContain(id);
    }
  });

  it("成人向版式都打了 adult 标记，且都属于证件族", () => {
    const adult = registry.STYLES.filter((s) => s.adult);
    expect(adult.length).toBeGreaterThan(0);
    for (const style of adult) {
      expect(style.group, `${style.id} 是成人向但不在 doc 组`).toBe("doc");
    }
    // 未打标记的版式一个都不能出现在成人向组里 —— app.js 就是按 adult 过滤的
    const nonAdultDoc = registry.STYLES.filter((s) => s.group === "doc" && !s.adult);
    expect(nonAdultDoc.length).toBe(registry.STYLES.filter((s) => s.group === "doc").length - adult.length);
  });

  it("默认版式是拟真证件（第一个非成人向的就是用户一进来看到的）", () => {
    const first = registry.STYLES[0];
    if (!first) throw new Error("STYLES 不能为空");
    expect(first.adult).toBeFalsy();
    expect(first.id).toBe("doc_id");
  });

  it("findStyle 对未知 id 回落到第一个", () => {
    const first = registry.STYLES[0];
    if (!first) throw new Error("STYLES 不能为空");
    expect(registry.findStyle("不存在的版式").id).toBe(first.id);
    for (const style of registry.STYLES) {
      expect(registry.findStyle(style.id).id).toBe(style.id);
    }
  });

  it("五种画幅都在，长图是 1080×2700", () => {
    expect(registry.RATIOS.map((r) => r.id)).toEqual(["1:1", "4:5", "3:4", "9:16", "long"]);
    const long = registry.RATIOS.find((r) => r.id === "long");
    expect([long?.w, long?.h]).toEqual([1080, 2700]);
    expect(registry.findRatio("nope").id).toBe("1:1");
  });
});

describe("盖章锚点（2026-10-31 盖章强化）", () => {
  type WithStamp = Registry & {
    drawSeal: unknown;
    stampAnchor: (position: string, W: number, H: number) => { cx: number; cy: number; r: number; angle: number };
    STAMP_POSITIONS: Record<string, number>;
  };
  const withStamp = registry as WithStamp;

  it("drawSeal 与 stampAnchor 已导出（app.js 预览/烧录共用）", () => {
    expect(typeof withStamp.drawSeal).toBe("function");
    expect(typeof withStamp.stampAnchor).toBe("function");
  });

  it("五预设都在卡面内、半径一致（DOM 预览与导出烧录共用同一几何）", () => {
    const W = 1080;
    const H = 1920;
    for (const position of ["tl", "tr", "bl", "br", "center"]) {
      const a = withStamp.stampAnchor(position, W, H);
      expect(a.cx).toBeGreaterThan(0);
      expect(a.cx).toBeLessThan(W);
      expect(a.cy).toBeGreaterThan(0);
      expect(a.cy).toBeLessThan(H);
      // 整章（含半径）不越界
      expect(a.cx - a.r).toBeGreaterThanOrEqual(0);
      expect(a.cx + a.r).toBeLessThanOrEqual(W);
      expect(a.cy - a.r).toBeGreaterThanOrEqual(0);
      expect(a.cy + a.r).toBeLessThanOrEqual(H);
    }
    // 四角半径一致（同一张卡上盖多枚不会大小不一）
    const r = withStamp.stampAnchor("tl", W, H).r;
    for (const position of ["tr", "bl", "br", "center"]) {
      expect(withStamp.stampAnchor(position, W, H).r).toBe(r);
    }
  });

  it("未知位置回退到右上（与 app.js 缺省一致），长图与方形都能用", () => {
    const fallback = withStamp.stampAnchor("mystery", 1080, 1920);
    expect(fallback.cx).toBe(withStamp.stampAnchor("tr", 1080, 1920).cx);
    expect(() => withStamp.stampAnchor("center", 1080, 1080)).not.toThrow();
  });
});
