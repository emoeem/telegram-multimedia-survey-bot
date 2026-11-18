import { describe, expect, it } from "vitest";

import { getScreenHelp, SCREEN_HELP, validateScreenHelpEntries } from "../../../admin/src/survey/screen-help";
import { groupScreenHelp, HELP_SCREEN_TITLES } from "../../../admin/src/survey/help-center";

describe("help center 注册表 → 分组", () => {
  it("覆盖注册表全部键（含未接线 ? 按钮的键），顺序与注册表一致", () => {
    const groups = groupScreenHelp();
    expect(groups.map((group) => group.key)).toEqual(Object.keys(SCREEN_HELP));
    for (const group of groups) {
      expect(group.help, group.key).toBe(getScreenHelp(group.key));
    }
    // 未接线键也在场：cert 是独立静态页没有 ？ 按钮，但整页帮助不该漏屏。
    expect(groups.find((group) => group.key === "cert")?.help.intro).toBeTruthy();
  });

  it("每个键都有中文分组标题，不回退到英文键名", () => {
    for (const group of groupScreenHelp()) {
      expect(HELP_SCREEN_TITLES[group.key], `${group.key} 缺中文标题`).toBeDefined();
      expect(group.title, group.key).not.toBe(group.key);
    }
  });

  it("分组标题与各屏 PageHeader 同口径（抽查在页面上写死的称呼）", () => {
    expect(HELP_SCREEN_TITLES.survey).toBe("问卷大厅");
    expect(HELP_SCREEN_TITLES.coins).toBe("我的金币");
    expect(HELP_SCREEN_TITLES.gacha).toBe("抽奖中心");
    expect(HELP_SCREEN_TITLES.submissions).toBe("投稿中心");
    expect(HELP_SCREEN_TITLES.series).toBe("系列书架");
  });

  it("每组的 intro 与动作示例非空（帮助中心整页复用同一份数据，不另建内容源）", () => {
    for (const group of groupScreenHelp()) {
      expect(group.help.intro.trim(), group.key).not.toBe("");
      expect(group.help.entries.length, group.key).toBeGreaterThan(0);
    }
  });

  it("注册表仍通过外行话与路由白名单校验（两个渲染面共享同一校验口径）", () => {
    expect(validateScreenHelpEntries()).toEqual([]);
  });
});
