import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GLOBAL_SEARCH_LIMIT_PER_GROUP,
  GLOBAL_SEARCH_LISTBOX_ID,
  GLOBAL_SEARCH_LISTBOX_LABEL,
  GLOBAL_SEARCH_POPULAR_TERMS,
  globalSearchOptionId,
  normalizeSearchText,
  searchGlobalSearch,
  type GlobalSearchSources,
} from "../../../admin/src/global-search";

/**
 * 顶栏 ⌘K 全局搜索的纯逻辑（admin/src/global-search.ts）。
 *
 * 这里锁三类不变量：
 *  1. 规范化口径：查询与索引两侧同走小写 + 全半角折叠，输入法差异不漏召回；
 *  2. 分组与排序：组序固定（问卷→模板→素材）、无命中的组不出现、组内
 *     前缀命中优先且同秩保持数据原序——键盘 ↓ 的顺序 = hits 扁平顺序，
 *     漂移会把用户送进不是高亮的那条；
 *  3. 空态：空查询返回空结果（空态交给 UI 渲染热门词 chips），热门词是
 *     静态功能入口文案、路由必须指向真实存在的管理页。
 */

const emptySources: GlobalSearchSources = { surveys: [], templates: [], media: [] };

describe("normalizeSearchText 输入规范化", () => {
  it("小写化 + 全半角折叠：全角字母、全角标点与半角等价", () => {
    expect(normalizeSearchText("BGM")).toBe("bgm");
    expect(normalizeSearchText("ＢＧＭ")).toBe("bgm");
    expect(normalizeSearchText("问卷（2026）")).toBe("问卷(2026)");
    expect(normalizeSearchText("！！")).toBe("!!");
  });

  it("全角空格与连续空白折叠成单个空格", () => {
    expect(normalizeSearchText("问　卷")).toBe("问 卷");
    expect(normalizeSearchText("  a   b  ")).toBe("a b");
  });

  it("中文与已有半角文本保持原样", () => {
    expect(normalizeSearchText("树洞问卷")).toBe("树洞问卷");
    expect(normalizeSearchText("bgm-test_1")).toBe("bgm-test_1");
  });
});

describe("searchGlobalSearch 分组与排序", () => {
  it("组序固定为 问卷→模板→素材，无命中的组不出现", () => {
    const result = searchGlobalSearch(
      {
        surveys: [{ id: 1, title: "问卷甲" }],
        templates: [{ id: "classic", name: "乙模板" }],
        media: [{ id: 9, fileName: "丙.png" }],
      },
      "乙",
    );
    expect(result.groups.map((group) => group.group)).toEqual(["templates"]);
    expect(result.groups[0]?.label).toBe("报告模板");
    expect(result.hits).toHaveLength(1);
  });

  it("三组同时命中时按固定顺序全部返回，hits 与 groups 串联一致", () => {
    const result = searchGlobalSearch(
      {
        surveys: [{ id: 1, title: "示例·旅行" }],
        templates: [{ id: "travel", name: "旅行模板" }],
        media: [{ id: 5, fileName: "旅行.jpg" }],
      },
      "旅行",
    );
    expect(result.groups.map((group) => group.group)).toEqual(["surveys", "templates", "media"]);
    expect(result.hits.map((hit) => hit.group)).toEqual(["surveys", "templates", "media"]);
    expect(result.hits).toEqual(result.groups.flatMap((group) => group.hits));
  });

  it("组内前缀命中排在包含命中之前（与数据原序无关）", () => {
    const result = searchGlobalSearch(
      {
        surveys: [
          { id: 1, title: "问卷旅行团" },
          { id: 2, title: "旅行问卷" },
        ],
      },
      "旅行",
    );
    expect(result.hits.map((hit) => hit.to)).toEqual(["/surveys/2", "/surveys/1"]);
  });

  it("同秩命中保持数据原有顺序（稳定排序）", () => {
    const result = searchGlobalSearch(
      {
        surveys: [
          { id: 1, title: "旅行 A" },
          { id: 2, title: "旅行 B" },
        ],
      },
      "旅行",
    );
    expect(result.hits.map((hit) => hit.to)).toEqual(["/surveys/1", "/surveys/2"]);
  });

  it("多词查询要求全部命中（AND），空白折叠后按词拆分", () => {
    const result = searchGlobalSearch(
      {
        surveys: [
          { id: 1, title: "苹果上海问卷" },
          { id: 2, title: "苹果问卷" },
          { id: 3, title: "上海问卷" },
        ],
      },
      "苹果 上海",
    );
    expect(result.hits.map((hit) => hit.to)).toEqual(["/surveys/1"]);
  });

  it("查询与索引两侧都做全半角折叠：全角查询命中半角数据，反之亦然", () => {
    const result = searchGlobalSearch({ surveys: [{ id: 1, title: "BGM 问卷" }] }, "ｂｇｍ");
    expect(result.hits).toHaveLength(1);
    const reverse = searchGlobalSearch({ surveys: [{ id: 1, title: "ＢＧＭ问卷" }] }, "bgm");
    expect(reverse.hits).toHaveLength(1);
  });

  it("默认每组最多 5 条，截断时前缀命中优先保留", () => {
    const surveys = [
      { id: 1, title: "环游旅行记一" }, // 包含命中
      { id: 2, title: "环游旅行记二" }, // 包含命中
      { id: 3, title: "环游旅行记三" }, // 包含命中
      { id: 4, title: "旅行问卷" }, // 前缀命中
      { id: 5, title: "环游旅行记四" }, // 包含命中
      { id: 6, title: "环游旅行记五" }, // 包含命中
    ];
    const result = searchGlobalSearch({ surveys }, "旅行");
    expect(result.hits).toHaveLength(GLOBAL_SEARCH_LIMIT_PER_GROUP);
    // 前缀命中的「旅行问卷」必须挤进前 5，且排在最前。
    expect(result.hits[0]?.to).toBe("/surveys/4");
    // 全量放宽到 10 条后全部出现，前缀命中仍排第一。
    const expanded = searchGlobalSearch({ surveys }, "旅行", { limitPerGroup: 10 });
    expect(expanded.hits).toHaveLength(6);
    expect(expanded.hits[0]?.to).toBe("/surveys/4");
  });

  it("问卷命中带状态徽标 meta，未提供状态则不携带 meta 字段", () => {
    const result = searchGlobalSearch(
      {
        surveys: [
          { id: 7, title: "旅行问卷", statusLabel: "已发布" },
          { id: 8, title: "旅行笔记" },
        ],
      },
      "旅行",
    );
    expect(result.hits.find((hit) => hit.to === "/surveys/7")?.meta).toBe("已发布");
    const noStatus = result.hits.find((hit) => hit.to === "/surveys/8");
    expect(noStatus).toBeDefined();
    expect("meta" in noStatus!).toBe(false);
  });

  it("模板命中跳转模板页并区分 自定义/内置 来源", () => {
    const result = searchGlobalSearch(
      {
        templates: [
          { id: "mine", name: "旅行模板", isCustom: true },
          { id: "classic", name: "旅行经典" },
        ],
      },
      "旅行",
    );
    expect(result.hits.map((hit) => hit.meta)).toEqual(["自定义", "内置"]);
    for (const hit of result.hits) expect(hit.to).toBe("/templates");
  });

  it("素材按文件名匹配，无文件名的素材跳过；命中跳素材库", () => {
    const result = searchGlobalSearch(
      {
        media: [
          { id: 1, fileName: "旅行bgm.mp3" },
          { id: 2, fileName: null },
        ],
      },
      "bgm",
    );
    expect(result.hits.map((hit) => hit.to)).toEqual(["/media-library"]);
    expect(result.hits[0]?.title).toBe("旅行bgm.mp3");
  });

  it("空源与缺省源返回空结果而不是抛错", () => {
    expect(searchGlobalSearch(emptySources, "旅行")).toEqual({
      query: "旅行",
      groups: [],
      hits: [],
    });
    expect(searchGlobalSearch({}, "旅行").hits).toEqual([]);
  });
});

describe("空态与热门词", () => {
  it("空查询 / 全空白查询返回空结果，由 UI 渲染热门词空态", () => {
    for (const query of ["", "   ", "　"]) {
      const result = searchGlobalSearch({ surveys: [{ id: 1, title: "旅行问卷" }] }, query);
      expect(result.query).toBe("");
      expect(result.groups).toEqual([]);
      expect(result.hits).toEqual([]);
    }
  });

  it("热门词是四个静态功能入口，路由指向真实管理页且互不重复", () => {
    expect(GLOBAL_SEARCH_POPULAR_TERMS.map((term) => term.label)).toEqual([
      "问卷模板",
      "批量导出",
      "用户标签",
      "小游戏",
    ]);
    const routes = GLOBAL_SEARCH_POPULAR_TERMS.map((term) => term.to);
    expect(new Set(routes).size).toBe(routes.length);
    for (const term of GLOBAL_SEARCH_POPULAR_TERMS) {
      expect(term.to).toMatch(/^\//);
      expect(term.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("读屏语义锚点（G6，批三报告已知问题 #4）", () => {
  it("listbox 容器的 id 与 aria-label 是稳定非空字符串", () => {
    expect(GLOBAL_SEARCH_LISTBOX_ID.length).toBeGreaterThan(0);
    expect(GLOBAL_SEARCH_LISTBOX_LABEL.length).toBeGreaterThan(0);
  });

  it("option id 按扁平 hits 下标生成且互不重复：aria-activedescendant 指到哪条，读屏就读哪条", () => {
    const ids = [0, 1, 2, 7].map(globalSearchOptionId);
    expect(new Set(ids).size).toBe(ids.length);
    // 键盘高亮第 3 条（下标 2）时，容器的 aria-activedescendant 与该选项 id 同源
    expect(globalSearchOptionId(2)).toBe(ids[2]);
  });

  it("面板接线（Layout.tsx 源码，同 lazy-routes 的静态锚点惯例）：容器 listbox + 选项 option + activedescendant 跟随键盘高亮", () => {
    const layout = readFileSync(join(process.cwd(), "admin", "src", "components", "Layout.tsx"), "utf8");
    // 命中容器挂 listbox 语义，aria-label 来自纯模块常量
    expect(layout).toContain('role={hasHits ? "listbox" : undefined}');
    expect(layout).toContain("aria-label={hasHits ? GLOBAL_SEARCH_LISTBOX_LABEL : undefined}");
    // 容器与聚焦的输入框（combobox 模式）都指向当前高亮项
    expect(layout.match(/aria-activedescendant=\{activeDescendant\}/g)?.length).toBe(2);
    // 每个命中项是 option，选中态跟随 activeIndexSafe
    expect(layout).toContain('role="option"');
    expect(layout).toContain("aria-selected={active}");
    expect(layout).toContain("id={globalSearchOptionId(index)}");
    // 输入框经 aria-controls 关联 listbox，高亮随键盘（ArrowUp/Down → activeIndexSafe）移动
    expect(layout).toContain("aria-controls={GLOBAL_SEARCH_LISTBOX_ID}");
    expect(layout).toContain("const activeDescendant = hasHits ? globalSearchOptionId(activeIndexSafe) : undefined;");
  });
});
