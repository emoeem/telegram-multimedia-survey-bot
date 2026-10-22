import { describe, expect, it } from "vitest";

import {
  HI_PERCENT,
  HI_SCORE,
  blankTheme,
  normalizeTheme,
  rankScaleHi,
  themePayload,
  validateRankRanges,
  validateThemes,
  type CertTheme,
} from "../../../admin/src/cert-content-model";

/**
 * 这批断言锁的是两条**从生成器和内置主题推出来的真实规则**，不是凭空设计的：
 *
 * 1. 等级区间的边界**允许共用**。cert/themes.js 里 8 套内置主题全部写成
 *    0–20 / 20–40 / 40–60 / 60–80 / 80–100（见本文件第一个用例）。生成器的
 *    hitRank() 用 `pct >= min && pct <= max` 且首个命中生效，所以 20 归前一档。
 *    如果按「上一档 max + 1 === 下一档 min」去校验，8 套内置主题会被全判非法。
 * 2. 区间上限不是固定 100：`metric.kind === "score"` 的主题（cert/themes-adult.js）
 *    跑到 999，档位里能看到 max: 109 这种值。
 */
const DEFAULT_RANKS = [
  { min: 0, max: 20, name: "养生达人" },
  { min: 20, max: 40, name: "轻度熬夜" },
  { min: 40, max: 60, name: "常态化修仙" },
  { min: 60, max: 80, name: "资深夜行侠" },
  { min: 80, max: 100, name: "修仙渡劫期" },
];

describe("validateRankRanges", () => {
  it("内置主题那种「边界共用」的写法是合法的", () => {
    expect(validateRankRanges(DEFAULT_RANKS, HI_PERCENT)).toEqual([]);
  });

  it("相邻两档严格相接（上一档 max + 1）同样合法", () => {
    const ranks = [
      { min: 0, max: 32, name: "青铜" },
      { min: 33, max: 65, name: "白银" },
      { min: 66, max: 100, name: "王者" },
    ];
    expect(validateRankRanges(ranks, HI_PERCENT)).toEqual([]);
  });

  it("空洞会点名缺失区间", () => {
    const ranks = [
      { min: 0, max: 33, name: "青铜" },
      { min: 43, max: 100, name: "王者" },
    ];
    const errors = validateRankRanges(ranks, HI_PERCENT);
    expect(errors).toHaveLength(1);
    // 34–42 这段没有任何一档命中；生成器会 fallback 到最后一档，用户静默拿到最高称号。
    expect(errors[0]).toContain("34–42");
    expect(errors[0]).toContain("青铜");
    expect(errors[0]).toContain("王者");
  });

  it("区间交叠会被拦下", () => {
    const ranks = [
      { min: 0, max: 50, name: "青铜" },
      { min: 40, max: 100, name: "王者" },
    ];
    expect(validateRankRanges(ranks, HI_PERCENT).some((error) => error.includes("重叠"))).toBe(true);
  });

  it("第一档不从 0 开始会被拦下（0 附近的百分比会误落到最后一档）", () => {
    const ranks = [
      { min: 10, max: 50, name: "青铜" },
      { min: 51, max: 100, name: "王者" },
    ];
    expect(validateRankRanges(ranks, HI_PERCENT).some((error) => error.includes("第一档必须从 0 开始"))).toBe(true);
  });

  it("起点大于终点、超出量表上限都会被拦下", () => {
    expect(validateRankRanges([{ min: 80, max: 20, name: "反了" }], HI_PERCENT).length).toBeGreaterThan(0);
    expect(validateRankRanges([{ min: 0, max: 120, name: "超了" }], HI_PERCENT).length).toBeGreaterThan(0);
  });

  it("分值制主题按 999 校验，109 不算越界", () => {
    const ranks = [
      { min: 0, max: 84, name: "低" },
      { min: 85, max: 109, name: "A" },
      { min: 110, max: HI_SCORE, name: "顶级" },
    ];
    expect(validateRankRanges(ranks, HI_SCORE)).toEqual([]);
    // 同一组数据按百分比量表校验就必须报错，证明量表上限是真的在起作用。
    expect(validateRankRanges(ranks, HI_PERCENT).length).toBeGreaterThan(0);
  });

  it("空数组不再是「看着像通过」", () => {
    expect(validateRankRanges([], HI_PERCENT)).toEqual(["至少需要一档等级称号"]);
  });
});

describe("validateThemes", () => {
  it("空白主题开箱即合法（否则新建主题就报错）", () => {
    expect(validateThemes([blankTheme()])).toEqual([]);
  });

  it("主题 ID 不合法时把问题定位到 id 字段，并回显坏值", () => {
    const theme: CertTheme = { ...blankTheme(), id: "主题一" };
    const issues = validateThemes([theme]);
    const idIssue = issues.find((issue) => issue.field === "id");
    expect(idIssue).toBeDefined();
    expect(idIssue?.themeIndex).toBe(0);
    expect(idIssue?.message).toContain("主题一");
  });

  it("两套主题同 id 时点名后半套（旧实现会「改一个连带改另一个」）", () => {
    const a: CertTheme = { ...blankTheme(), id: "same", name: "甲" };
    const b: CertTheme = { ...blankTheme(), id: "same", name: "乙" };
    const issues = validateThemes([a, b]);
    const duplicate = issues.find((issue) => issue.message.includes("duplicate") || issue.message.includes("重复"));
    expect(duplicate?.themeIndex).toBe(1);
    expect(duplicate?.message).toContain("第 1 套");
  });

  it("没有标签时提前拦下（服务端 asTheme 返回 null 只会回一句模糊话）", () => {
    const theme: CertTheme = { ...blankTheme(), groups: [{ name: "空", emoji: "🏷️", tags: [] }] };
    const issues = validateThemes([theme]);
    expect(issues.some((issue) => issue.field === "tags")).toBe(true);
  });

  it("等级区间的问题会带上主题序号", () => {
    const theme: CertTheme = {
      ...blankTheme(),
      name: "打工人",
      ranks: [
        { min: 0, max: 33, name: "青铜" },
        { min: 43, max: 100, name: "王者" },
      ],
    };
    const issues = validateThemes([blankTheme(), theme]);
    const rankIssue = issues.find((issue) => issue.field === "ranks");
    expect(rankIssue?.themeIndex).toBe(1);
    expect(rankIssue?.message).toContain("第 2 套");
    expect(rankIssue?.message).toContain("34–42");
  });
});

describe("normalizeTheme 保真", () => {
  /** 截取自 cert/themes-adult.js 的真实形状：分值制 + 成人向 + 每档候选称号。 */
  const adultRaw = {
    id: "jiyu-adult",
    name: "成人向 · 骚货认证局",
    adult: true,
    genderAware: true,
    metric: { kind: "score", divisor: 60 },
    cardLabel: "骚货认证",
    issuer: "骚货认证局",
    subtitle: "SAOHUO CREDENTIAL BUREAU",
    sealText: "骚货认证局 · 持证上岗 · ",
    palette: {
      primary: "#e11d48",
      primary2: "#f43f5e",
      accent: "#be123c",
      ink: "#2a0b16",
      muted: "#9f7484",
      paper: "#fff5f7",
    },
    titles: { f: ["母狗认证", "骚货认证"], m: ["公狗认证", "贱狗认证"] },
    tags: [{ t: "听音声", s: 2, g: "u" }],
    groups: [{ name: "音声", emoji: "🎧", tags: [{ t: "听音声", s: 2, g: "u" }] }],
    ranks: [
      { min: 0, max: 9, grade: "F", rare: "N", f: ["纯情小白兔"], m: ["纯情老实人"], say: ["骚度尚浅。"] },
      { min: 85, max: 109, grade: "A", rare: "SSR", f: ["资深小母狗"], m: ["资深小贱狗"], say: ["骚气外溢。"] },
    ],
  };

  it("metric / adult / genderAware / titles 不再被静默丢掉", () => {
    const theme = normalizeTheme(adultRaw);
    expect(theme.metric).toEqual({ kind: "score", divisor: 60 });
    expect(theme.adult).toBe(true);
    expect(theme.genderAware).toBe(true);
    expect(theme.titles).toEqual({ f: ["母狗认证", "骚货认证"], m: ["公狗认证", "贱狗认证"] });
    expect(rankScaleHi(theme)).toBe(HI_SCORE);
  });

  it("分值制的 109 不会被压成 100", () => {
    const theme = normalizeTheme(adultRaw);
    expect(theme.ranks.map((rank) => [rank.min, rank.max])).toEqual([
      [0, 9],
      [85, 109],
    ]);
  });

  it("每档的 grade / rare / f / m / say 原样保留", () => {
    const theme = normalizeTheme(adultRaw);
    expect(theme.ranks[1]).toMatchObject({
      grade: "A",
      rare: "SSR",
      f: ["资深小母狗"],
      m: ["资深小贱狗"],
      say: ["骚气外溢。"],
    });
  });

  it("百分制主题仍然按 100 截断", () => {
    const theme = normalizeTheme({ ...adultRaw, metric: undefined, ranks: [{ min: 0, max: 999, name: "满" }] });
    expect(theme.ranks[0]?.max).toBe(HI_PERCENT);
  });
});

describe("themePayload", () => {
  it("tags 由 groups 拍平（与服务端口径一致），并在保存里保留扩展字段", () => {
    const theme = normalizeTheme({
      id: "x",
      name: "X",
      adult: true,
      metric: { kind: "score", divisor: 30 },
      tags: ["a"],
      groups: [
        { name: "一", emoji: "1️⃣", tags: ["a", "b"] },
        { name: "二", emoji: "2️⃣", tags: ["c"] },
      ],
      ranks: [{ min: 0, max: 999, name: "满" }],
    });
    const payload = themePayload(theme);
    expect(payload.tags).toEqual(["a", "b", "c"]);
    expect(payload.adult).toBe(true);
    expect(payload.metric).toEqual({ kind: "score", divisor: 30 });
    expect(payload.ranks).toEqual([{ min: 0, max: 999, name: "满" }]);
  });

  it("导出再导入是稳定的（同一份数据两次归一化结果一致）", () => {
    const once = normalizeTheme({ id: "x", name: "X", tags: ["a"], ranks: [{ min: 0, max: 100, name: "满" }] });
    const twice = normalizeTheme(themePayload(once));
    expect(themePayload(twice)).toEqual(themePayload(once));
  });
  /**
   * 配色里的 alpha。
   *
   * 三处正则必须同时放宽（admin 模型 / worker 校验 / 生成器 normalizePackTheme），
   * 只放宽一处就会出现「编辑器里改好了，保存后被静默换回默认色」——这正是这个
   * 仓库已经踩过一次的错误类型（旧 normalizeTheme 丢掉 metric/adult 字段）。
   */
  it("8 位 HEX（带 alpha）原样保留，不被重置成默认色", () => {
    const theme = normalizeTheme({
      id: "x",
      name: "X",
      tags: ["a"],
      palette: { paper: "#ffffff80", primary: "#1e3a8a" },
      ranks: [{ min: 0, max: 100, name: "满" }],
    });
    expect(theme.palette.paper).toBe("#ffffff80");
    const payload = themePayload(theme).palette as Record<string, unknown>;
    expect(payload.paper).toBe("#ffffff80");
  });

  it("非法色值回退到默认色，而不是带着脏数据保存", () => {
    const fallback = blankTheme().palette.paper;
    const theme = normalizeTheme({
      id: "x",
      name: "X",
      tags: ["a"],
      palette: { paper: "#fff", primary: "red" },
      ranks: [{ min: 0, max: 100, name: "满" }],
    });
    // 3 位缩写由编辑器补全后再写入；模型本身只接受 6/8 位。
    expect(theme.palette.paper).toBe(fallback);
    expect(theme.palette.primary).toBe(blankTheme().palette.primary);
  });
});
