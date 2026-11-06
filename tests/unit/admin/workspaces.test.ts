import { describe, expect, it } from "vitest";

import { WORKSPACES, WORKSPACES_BY_ORDER, buildFeatureMap, tabNumberOf } from "../../../admin/src/workspaces";

/**
 * 工作区信息架构的唯一数据源（admin/src/workspaces.ts）：Layout 的图标轨 /
 * tab 条与 Dashboard 功能地图共用。这里锁的是结构不变量——坏了的形态只有两种：
 *   1. 编号漂移：tab 编号若取自渲染位置，角色过滤后「1.4」就换了页面，
 *      口头指路与功能地图全部失真；
 *   2. 路径冲突：workspaceIdOf 按首个匹配的工作区归属，路径重复会把
 *      用户送进错误的工作区（界面整个变掉，却看起来"正常"）。
 */
describe("workspaces 信息架构数据", () => {
  it("四个工作区按 1-4 编号、id 唯一，BY_ORDER 是按序号的防御式排序", () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual(["surveys", "content", "community", "system"]);
    expect(WORKSPACES.map((w) => w.order)).toEqual([1, 2, 3, 4]);
    expect(WORKSPACES_BY_ORDER.map((w) => w.id)).toEqual(WORKSPACES.map((w) => w.id));
    // 防御式排序不得改写原数组
    expect(WORKSPACES_BY_ORDER).not.toBe(WORKSPACES);
  });

  it("每个工作区的 entry 落在自身 tabs 内（图标轨点击后 tab 条仍然在场）", () => {
    for (const workspace of WORKSPACES) {
      expect(workspace.tabs.some((tab) => tab.to === workspace.entry)).toBe(true);
    }
  });

  it("tab 路径全局唯一：workspaceIdOf 按首个匹配归属，重复会串工作区", () => {
    const paths = WORKSPACES.flatMap((w) => w.tabs.map((tab) => tab.to));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("tab 的 order 在工作区内从 1 连续递增（编号紧凑无跳号）", () => {
    for (const workspace of WORKSPACES) {
      expect(workspace.tabs.map((tab) => tab.order)).toEqual(workspace.tabs.map((_, index) => index + 1));
    }
  });

  it("tabNumberOf 只由显式 order 决定：Layout 的角色过滤后编号不漂移", () => {
    const beforeByPath = new Map(
      WORKSPACES.map((w) => [w.id, new Map(w.tabs.map((tab) => [tab.to, tabNumberOf(w, tab)]))] as const),
    );

    // 复刻 Layout 的两条角色过滤：creator 隐藏导入/分类；未接授权中心隐藏授权/控制中心
    const creatorTabs = (WORKSPACES.find((w) => w.id === "surveys") ?? WORKSPACES[0])!.tabs.filter(
      (tab) => tab.to !== "/imports" && tab.to !== "/categories",
    );
    const noLicenseTabs = (WORKSPACES.find((w) => w.id === "system") ?? WORKSPACES[0])!.tabs.filter(
      (tab) => tab.to !== "/licenses" && tab.to !== "/control",
    );

    const surveys = WORKSPACES.find((w) => w.id === "surveys")!;
    const system = WORKSPACES.find((w) => w.id === "system")!;
    // 过滤后幸存的每个 tab，编号都与过滤前一致
    expect(creatorTabs.map((tab) => tabNumberOf(surveys, tab))).toEqual(
      creatorTabs.map((tab) => beforeByPath.get("surveys")!.get(tab.to)),
    );
    expect(noLicenseTabs.map((tab) => tabNumberOf(system, tab))).toEqual(
      noLicenseTabs.map((tab) => beforeByPath.get("system")!.get(tab.to)),
    );
    // 「报告」永远是 1.5，即便 creator 看不到 1.2/1.3
    const report = surveys.tabs.find((tab) => tab.to === "/reports")!;
    expect(tabNumberOf(surveys, report)).toBe("1.5");
  });

  it("每个工作区与每个 tab 都有一句话说明", () => {
    for (const workspace of WORKSPACES) {
      expect(workspace.hint.trim()).not.toBe("");
      for (const tab of workspace.tabs) {
        expect(tab.hint.trim()).not.toBe("");
      }
    }
  });
});

describe("buildFeatureMap 功能地图模型", () => {
  const map = buildFeatureMap({ surveys: 12, publishedSurveys: 5 });

  it("按工作区序号输出卡片，编号与标签取自同一份数据", () => {
    expect(map.map((w) => w.number)).toEqual(["1", "2", "3", "4"]);
    expect(map.map((w) => w.label)).toEqual(WORKSPACES.map((w) => w.label));
    expect(map.map((w) => w.entry)).toEqual(WORKSPACES.map((w) => w.entry));
  });

  it("徽章只标在有可靠数据的工作区：问卷=总数+已发布，其余宁缺毋滥", () => {
    const surveys = map.find((w) => w.id === "surveys");
    expect(surveys?.badges).toEqual([
      { label: "问卷", value: 12 },
      { label: "已发布", value: 5 },
    ]);
    // 其余工作区在 /api/admin/dashboard 里没有对应字段，不猜语义
    for (const workspace of map) {
      if (workspace.id !== "surveys") expect(workspace.badges).toEqual([]);
    }
  });

  it("counts 为 0 时徽章仍显示 0 值（缺席会被误读成没有数据）", () => {
    const empty = buildFeatureMap({ surveys: 0, publishedSurveys: 0 });
    expect(empty.find((w) => w.id === "surveys")?.badges).toEqual([
      { label: "问卷", value: 0 },
      { label: "已发布", value: 0 },
    ]);
  });

  it("tab 芯片带稳定编号、路径与一句话 hint，与数据一一对应", () => {
    const surveys = map.find((w) => w.id === "surveys")!;
    expect(surveys.tabs).toEqual([
      { number: "1.1", label: "问卷列表", to: "/surveys", hint: "全部问卷的列表、筛选与状态操作" },
      { number: "1.2", label: "分类", to: "/categories", hint: "问卷分组与排序管理" },
      { number: "1.3", label: "导入", to: "/imports", hint: "从 Word / 网页导入问卷" },
      { number: "1.4", label: "答卷动态", to: "/responses", hint: "实时查看各问卷的新答卷" },
      { number: "1.5", label: "报告", to: "/reports", hint: "报告生成与归档记录" },
    ]);
    // 每张卡的芯片数与该工作区的 tab 数一致
    for (const workspace of map) {
      const data = WORKSPACES.find((w) => w.id === workspace.id)!;
      expect(workspace.tabs).toHaveLength(data.tabs.length);
    }
  });
});
