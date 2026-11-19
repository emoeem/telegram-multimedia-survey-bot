import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildScreenViewLine, resolveScreenViewName } from "../../../admin/src/survey/screen-view";

describe("screen_view screen 名映射", () => {
  it("十四屏各归各屏：分发链每个分支都有对应的 screen 名", () => {
    const expected: Array<[string, string]> = [
      ["/series", "series"],
      ["/plaza", "plaza"],
      ["/me", "me"],
      ["/coins", "coins"],
      ["/notes", "notes"],
      ["/gacha", "gacha"],
      ["/submissions", "submissions"],
      ["/showcase", "showcase"],
      ["/trial", "trial"],
      ["/submit/inbox", "submit"],
      ["/submit", "submit"],
      ["/auth", "auth"],
      ["/help", "help"],
      ["/app", "app"],
    ];
    for (const [path, screen] of expected) {
      expect(resolveScreenViewName(path), path).toBe(screen);
      // 子路径同样命中（分发链用 startsWith("/x/") 放行深层路由）。
      expect(resolveScreenViewName(`${path}/`), `${path}/`).toBe(screen);
    }
  });

  it("带深层参数的子路径也归对屏（/s/:id 答题屏、系列详情）", () => {
    expect(resolveScreenViewName("/s/123")).toBe("survey");
    expect(resolveScreenViewName("/s/123/og.png")).toBe("survey");
    expect(resolveScreenViewName("/series/42/chapter/3")).toBe("series");
    expect(resolveScreenViewName("/plaza/profile/9")).toBe("plaza");
  });

  it("前缀不串台：/submissions 不算 /submit，其余剩余路径统一兜底 survey", () => {
    // "submissions" 不以 "/submit/" 开头、也不等于 "/submit"——但这条边界
    // 值得钉住：写错一个 startsWith 就会把投稿中心的流量记成投稿入口。
    expect(resolveScreenViewName("/submissions")).toBe("submissions");
    expect(resolveScreenViewName("/submission")).toBe("survey");
    expect(resolveScreenViewName("/")).toBe("survey");
    expect(resolveScreenViewName("/admin")).toBe("survey");
    expect(resolveScreenViewName("/cert/cert.html")).toBe("survey");
  });

  /**
   * 接线守护：screen 名映射的口径是「与 SurveyApp 分发链逐条对齐」。这里
   * 静态读 SurveyApp.tsx（顶层，不递归）里的 `window.location.pathname === …`
   * 字面量做双向断言——分发链加了分支而映射没跟上（新屏会静默记成 survey）、
   * 或映射表里留着已删除的分支，都会在这条测试上爆出来。
   */
  it("分发链的每个分支字面量都有映射（静态读 SurveyApp.tsx 源码）", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");
    const dispatchLiterals = [...source.matchAll(/window\.location\.pathname === "(\/[^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(dispatchLiterals.length, "SurveyApp.tsx 的分发分支字面量应有 14 条").toBe(14);
    for (const literal of dispatchLiterals) {
      const screen = resolveScreenViewName(literal);
      // 映射必须给出一个「非兜底」的名字：新增分支忘了同步映射时，这里会
      // 落到 survey 兜底——对大厅以外的屏这就是口径错误。
      expect(screen, `分发分支 ${literal} 在 screen-view.ts 里没有独立映射（兜底成了 ${screen}）`).not.toBe("survey");
    }
    expect(dispatchLiterals).toContain("/help");
  });

  it("survey 的兜底口径只属于答题入口路径", () => {
    expect(resolveScreenViewName("/s")).toBe("survey");
    expect(resolveScreenViewName("/survey/1")).toBe("survey");
  });
});

describe("screen_view 输出行", () => {
  it("JSON 形状与键序钉死为 {type,screen,path}（检索端按整行匹配）", () => {
    const line = buildScreenViewLine("/s/123", { webdriver: false });
    expect(line).toBe('{"type":"screen_view","screen":"survey","path":"/s/123"}');
    expect(JSON.parse(line ?? "{}")).toEqual({ type: "screen_view", screen: "survey", path: "/s/123" });
  });

  it("path 记录整页路由原文（含答题 id），screen 记录映射名", () => {
    expect(JSON.parse(buildScreenViewLine("/plaza/profile/9", {}) ?? "{}")).toEqual({
      type: "screen_view",
      screen: "plaza",
      path: "/plaza/profile/9",
    });
    expect(JSON.parse(buildScreenViewLine("/help", {}) ?? "{}")).toMatchObject({ screen: "help", path: "/help" });
  });

  it("自动化环境（navigator.webdriver === true）不输出——机器人流量不进行为数据", () => {
    expect(buildScreenViewLine("/plaza", { webdriver: true })).toBeNull();
    // webdriver === false / 缺字段（node 单测环境没有 navigator）都按真实用户处理。
    expect(buildScreenViewLine("/plaza", { webdriver: false })).not.toBeNull();
    expect(buildScreenViewLine("/plaza", undefined)).not.toBeNull();
  });
});
