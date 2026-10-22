import { describe, expect, it } from "vitest";

import {
  CERT_CONTENT_SETTING_KEY,
  validateCertContentPack,
} from "../../../src/http/admin/cert-content";

const PALETTE = {
  primary: "#c2185b",
  primary2: "#e91e63",
  accent: "#ffb300",
  ink: "#1f2937",
  muted: "#94a3b8",
  paper: "#fff5f7",
};

/** 一套最小的中性主题：能过校验。 */
function neutralTheme(overrides: Record<string, unknown> = {}) {
  return {
    id: "demo",
    name: "演示主题",
    palette: PALETTE,
    tags: ["标签一", "标签二"],
    ranks: [{ min: 0, max: 49, name: "新手" }, { min: 50, max: 100, name: "老手" }],
    ...overrides,
  };
}

describe("validateCertContentPack", () => {
  it("setting key 固定为 cert_content_pack", () => {
    expect(CERT_CONTENT_SETTING_KEY).toBe("cert_content_pack");
  });

  it("接受中性主题并补齐默认字段", () => {
    const result = validateCertContentPack({ themes: [neutralTheme()] });
    expect("pack" in result).toBe(true);
    if (!("pack" in result)) return;
    const theme = result.pack.themes[0]!;
    expect(theme.id).toBe("demo");
    expect(theme.cardLabel).toBe("认证卡");
    expect(theme.issuer).toBe("演示主题");
    expect(theme.palette.paper).toBe("#fff5f7");
    expect(theme.metric).toBeUndefined();
    expect(theme.adult).toBeUndefined();
  });

  it("成人向主题：保存 19 个分区、每分区 80 条、超过 100 的档位", () => {
    const groups = Array.from({ length: 19 }, (_, i) => ({
      name: "分区" + i,
      emoji: "🔥",
      badge: "分区徽章" + i,
      tags: Array.from({ length: 80 }, (_, j) => ({ t: `词条${i}-${j}`, s: ((j % 3) + 1) as 1 | 2 | 3, g: j % 2 ? "f" : "u" })),
    }));
    const ranks = [
      { min: 0, max: 9, grade: "F", rare: "N", f: ["母狗"], m: ["公狗"], say: ["还行"] },
      { min: 250, max: 999, grade: "SSS", rare: "EX", f: ["宇宙第一骚狗"], m: ["宇宙第一骚狗"], say: ["溢出了"] },
    ];
    const result = validateCertContentPack({
      themes: [
        neutralTheme({
          metric: { kind: "score", divisor: 60 },
          genderAware: true,
          adult: true,
          groups,
          ranks,
          titles: { f: ["骚货认证"], m: ["公狗认证"] },
          sectionTypes: { fa: { f: "发情母狗", m: "发情公狗", adj: "随时发情的", say: "荷尔蒙超标" } },
        }),
      ],
    });
    expect("pack" in result).toBe(true);
    if (!("pack" in result)) return;
    const theme = result.pack.themes[0]!;
    expect(theme.groups).toHaveLength(19);
    expect(theme.groups?.[0]!.tags).toHaveLength(80);
    expect(theme.groups?.[0]!.badge).toBe("分区徽章0");
    expect(theme.metric).toEqual({ kind: "score", divisor: 60 });
    expect(theme.genderAware).toBe(true);
    expect(theme.adult).toBe(true);
    expect(theme.titles).toEqual({ f: ["骚货认证"], m: ["公狗认证"] });
    expect(theme.sectionTypes?.fa?.f).toBe("发情母狗");
    /* 成人档位不带 name，靠 f/m 候选命名，不能被过滤掉；min 也不该被 100 夹住 */
    expect(theme.ranks).toHaveLength(2);
    expect(theme.ranks[1]!.min).toBe(250);
    expect(theme.ranks[1]!.grade).toBe("SSS");
    /* 有分组时扁平库是各分组串联，不再截成 120 条 */
    expect(theme.tags).toHaveLength(19 * 80);
  });

  it("清掉非法词条、非法性别与越界分值", () => {
    const result = validateCertContentPack({
      themes: [
        neutralTheme({
          groups: [
            {
              name: "分区",
              emoji: "🔥",
              tags: [{ t: "" }, { s: 2 }, { t: "有效词", s: 9, g: "x" }, "字符串词条"],
            },
          ],
        }),
      ],
    });
    if (!("pack" in result)) throw new Error("应当通过校验");
    const tags = result.pack.themes[0]!.groups?.[0]!.tags ?? [];
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ t: "有效词", s: 1, g: "u" });
    expect(tags[1]).toBe("字符串词条");
  });

  it("divisor 越界时夹到 1..999", () => {
    const low = validateCertContentPack({ themes: [neutralTheme({ metric: { kind: "score", divisor: 0 } })] });
    if (!("pack" in low)) throw new Error("应当通过校验");
    expect(low.pack.themes[0]!.metric?.divisor).toBe(60);

    const high = validateCertContentPack({ themes: [neutralTheme({ metric: { kind: "score", divisor: 5000 } })] });
    if (!("pack" in high)) throw new Error("应当通过校验");
    expect(high.pack.themes[0]!.metric?.divisor).toBe(999);
  });

  it("分区上限 24 组，每组标签上限 200 条", () => {
    const groups = Array.from({ length: 30 }, (_, i) => ({
      name: "组" + i,
      emoji: "🏷️",
      tags: Array.from({ length: 250 }, (_, j) => `t${j}`),
    }));
    const result = validateCertContentPack({ themes: [neutralTheme({ groups })] });
    if (!("pack" in result)) throw new Error("应当通过校验");
    expect(result.pack.themes[0]!.groups).toHaveLength(24);
    expect(result.pack.themes[0]!.groups?.[0]!.tags).toHaveLength(200);
  });

  it("缺主题、主题过多、id 重复、缺分区与等级都会被拒", () => {
    expect(validateCertContentPack({ themes: [] })).toEqual({ error: "至少需要一套主题" });
    expect(validateCertContentPack({ themes: "x" })).toEqual({ error: "至少需要一套主题" });
    expect(validateCertContentPack({})).toEqual({ error: "至少需要一套主题" });
    expect(validateCertContentPack(null)).toEqual({ error: "内容包格式不正确" });

    const many = Array.from({ length: 41 }, (_, i) => neutralTheme({ id: "t" + i }));
    expect(validateCertContentPack({ themes: many })).toEqual({ error: "主题数量过多（上限 40 套）" });

    expect(validateCertContentPack({ themes: [neutralTheme(), neutralTheme()] })).toEqual({
      error: "主题 id 重复：demo",
    });

    expect("error" in validateCertContentPack({ themes: [neutralTheme({ tags: [] })] })).toBe(true);
    expect("error" in validateCertContentPack({ themes: [neutralTheme({ ranks: [] })] })).toBe(true);
    expect("error" in validateCertContentPack({ themes: [neutralTheme({ id: "大写 空格" })] })).toBe(true);
  });
});
