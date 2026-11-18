import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { plazaTabFromSearch } from "../../../admin/src/survey/plaza-tab";

describe("plazaTabFromSearch", () => {
  it("默认落到树洞（B5：广场定位是匿名树洞，直开 /plaza 首屏即树洞）", () => {
    expect(plazaTabFromSearch("")).toBe("treehole");
    expect(plazaTabFromSearch("?")).toBe("treehole");
    expect(plazaTabFromSearch("?utm_source=bot")).toBe("treehole");
    expect(plazaTabFromSearch("?tab=treehole")).toBe("treehole");
  });

  it("带 tab 参数直达行为不变：完成页 ?tab=profiles 仍落到资料墙", () => {
    // SurveyApp.tsx 完成页的「查看档案」跳转就是 /plaza?tab=profiles。
    expect(plazaTabFromSearch("?tab=profiles")).toBe("profiles");
    // 历史链接里的单数形式同样按资料墙处理。
    expect(plazaTabFromSearch("?tab=profile")).toBe("profiles");
    // 机器人与更新通知用的是 ?tab=treehole。
    expect(plazaTabFromSearch("?tab=treehole")).toBe("treehole");
  });

  it("未知 tab 值跟随新默认（树洞），不再像旧逻辑那样落到资料墙", () => {
    expect(plazaTabFromSearch("?tab=posts")).toBe("treehole");
  });
});

/**
 * 命名口径守护（2026-11-19 通宵批次 B5「五名合一」）：答卷公开档案在 /me、
 * /plaza、/showcase 的文案层只允许叫「答卷档案」（展示入口叫「展示区」、
 * 通知分组叫「动态与通知」）。这里静态读源码，旧叫法一旦回流（哪怕只在
 * 注释里）就让测试红——与 screen-help.test.ts 的接线守护同一套路。
 */
describe("profile naming unification guard", () => {
  const surveyDir = join(process.cwd(), "admin", "src", "survey");
  const legacyTerms = ["个人画像", "资料卡", "个人资料", "个人画廊", "展示页", "创作者"];

  for (const file of ["MyScreen.tsx", "PlazaScreen.tsx", "ShowcaseScreen.tsx", "ShowcaseSheet.tsx", "screen-help.ts"]) {
    it(`keeps ${file} free of legacy profile naming`, () => {
      const source = readFileSync(join(surveyDir, file), "utf8");
      for (const term of legacyTerms) {
        expect(source, `${file} 里出现了旧叫法「${term}」（答卷公开档案统一叫「答卷档案」）`).not.toContain(term);
      }
    });
  }
});
