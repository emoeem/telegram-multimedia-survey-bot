/**
 * 认证卡内容包的纯数据层：类型、归一化、校验、提交形状。
 *
 * 这一层从 CertContentPage.tsx 里抽出来有两个原因：
 *  1. 校验规则要能被单测覆盖 —— 页面里内联的校验只能靠截图“看着对”；
 *  2. 服务端 src/http/admin/cert-content.ts 的 asTheme() 是唯一契约，
 *     这里的规则逐条对齐它，避免“前端放行、后端 400 报一句模糊话”。
 *
 * 两条容易被忽略的约束，都是从服务端和生成器的实际行为推出来的，不是拍的：
 *
 * - 等级区间**不要求** `上一档.max + 1 === 下一档.min`。
 *   内置主题 cert/themes.js 里 8 套主题全部写成 0–20 / 20–40 / 40–60 …
 *   边界是**共用**的（hitRank 用 `pct >= min && pct <= max` 且首个命中生效，
 *   所以 20 归前一档）。若按“+1 连续”校验，8 套内置主题会被全判为非法。
 *   真正的错误只有两种：**空洞**（某段百分比没有任何一档命中 → 生成器会
 *   fallback 到最后一档，用户拿到最高称号且不报错）和**区间交叠**。
 *
 * - 区间上限不是固定的 100。`metric.kind === "score"` 的主题（成人向词库，
 *   见 cert/themes-adult.js）按累积分值算，上限是 999。旧编辑器把 rank 一律
 *   clamp 到 0–100，于是 109 被压成 100 —— 保存一次就把这套主题毁了。
 */

export interface CertRank {
  min: number;
  max: number;
  name: string;
  /** 成人向档位的角标与候选称号（服务端 asTheme 会原样透传）。 */
  grade?: string;
  rare?: string;
  f?: string[];
  m?: string[];
  say?: string[];
}

export interface CertGroup {
  name: string;
  emoji: string;
  tags: string[];
}

export interface CertTheme {
  id: string;
  name: string;
  cardLabel: string;
  issuer: string;
  subtitle: string;
  sealText: string;
  palette: {
    primary: string;
    primary2: string;
    accent: string;
    ink: string;
    muted: string;
    paper: string;
  };
  tags: string[];
  groups: CertGroup[];
  ranks: CertRank[];
  /** 强度口径：缺省按「勾选条数 ÷ 总条数」；score 按「分值累加 ÷ divisor」。 */
  metric?: { kind: "score"; divisor: number };
  genderAware?: boolean;
  adult?: boolean;
  titles?: { f: string[]; m: string[] };
  sectionTypes?: Record<string, { f: string; adj: string; say: string; m: string }>;
}

export interface CertContentPack {
  version: 1;
  themes: CertTheme[];
}

/** 与服务端 asTheme() 的正则逐字一致。 */
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export const HI_PERCENT = 100;
export const HI_SCORE = 999;
export const MAX_THEMES = 40;

/* 6-digit RGB or 8-digit RGBA. The editor lets an admin set alpha
   (`#ffffff80`); a 6-only pattern here silently rewrote those back to the
   default colour on save. */
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 这套主题的区间上限：分值制 999，百分比制 100。 */
export function rankScaleHi(theme: Pick<CertTheme, "metric">): number {
  return theme.metric?.kind === "score" ? HI_SCORE : HI_PERCENT;
}

const newUid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export function blankTheme(): CertTheme {
  const uid = newUid();
  return {
    id: `theme-${uid}`,
    name: "新主题",
    cardLabel: "认证卡",
    issuer: "趣味认证中心",
    subtitle: "FUN CERTIFICATE",
    sealText: "趣味认证专用章",
    palette: {
      primary: "#1e3a8a",
      primary2: "#2563eb",
      accent: "#f59e0b",
      ink: "#0f172a",
      muted: "#64748b",
      paper: "#f7f9fc",
    },
    tags: ["示例标签一", "示例标签二", "示例标签三"],
    groups: [{ name: "日常", emoji: "🏷️", tags: ["示例标签一", "示例标签二", "示例标签三"] }],
    ranks: [
      { min: 0, max: 33, name: "青铜" },
      { min: 34, max: 66, name: "白银" },
      { min: 67, max: 100, name: "王者" },
    ],
  };
}

const parseTags = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

/** 旧格式只有扁平 tags：包成一个「全部」分组，编辑器里可以再拆。 */
function normalizeGroups(raw: unknown, tags: string[]): CertGroup[] {
  if (Array.isArray(raw)) {
    const groups = raw
      .map((g) => {
        const row = (g ?? {}) as Record<string, unknown>;
        return {
          name: String(row.name ?? "").trim() || "标签",
          emoji: String(row.emoji ?? "").trim() || "🏷️",
          tags: parseTags(row.tags),
        };
      })
      .filter((g) => g.tags.length);
    if (groups.length) return groups;
  }
  return tags.length ? [{ name: "全部", emoji: "🏷️", tags }] : [];
}

/**
 * 把服务端返回的内容包归一化成编辑器模型。
 *
 * 关键点：**不丢字段**。旧实现只挑 id/name/palette/tags/groups/ranks 六组，
 * metric / genderAware / adult / titles / sectionTypes 以及每档的
 * grade / rare / f / m / say 全部被丢掉，于是「打开 → 保存」一次就把成人向
 * 主题降级成普通主题，而且没有任何报错。这里逐条保留。
 */
export function normalizeTheme(raw: unknown): CertTheme {
  const t = blankTheme();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    return s || fallback;
  };
  const pal = (r.palette ?? {}) as Record<string, unknown>;
  const color = (v: unknown, fallback: string) => (HEX.test(String(v ?? "")) ? String(v) : fallback);

  const metricRaw = r.metric as Record<string, unknown> | undefined;
  const metric =
    metricRaw && metricRaw.kind === "score"
      ? { kind: "score" as const, divisor: Math.max(1, Math.min(999, Math.round(Number(metricRaw.divisor) || 60))) }
      : undefined;
  const hi = metric ? HI_SCORE : HI_PERCENT;
  const clamp = (v: unknown) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));

  const tags = parseTags(r.tags).length ? parseTags(r.tags) : t.tags;

  const theme: CertTheme = {
    id: str(r.id, t.id),
    name: str(r.name, t.name),
    cardLabel: str(r.cardLabel, t.cardLabel),
    issuer: str(r.issuer, t.issuer),
    subtitle: str(r.subtitle, t.subtitle),
    sealText: str(r.sealText, t.sealText),
    palette: {
      primary: color(pal.primary, t.palette.primary),
      primary2: color(pal.primary2, t.palette.primary2),
      accent: color(pal.accent, t.palette.accent),
      ink: color(pal.ink, t.palette.ink),
      muted: color(pal.muted, t.palette.muted),
      paper: color(pal.paper, t.palette.paper),
    },
    tags,
    groups: normalizeGroups(r.groups, tags),
    ranks: Array.isArray(r.ranks)
      ? r.ranks
          .map((row) => {
            const item = (row ?? {}) as Record<string, unknown>;
            return {
              min: clamp(item.min ?? 0),
              max: clamp(item.max ?? hi),
              name: String(item.name ?? "").trim(),
              ...optionalRankFields(item),
            };
          })
          /* 成人向档位不带 name，靠 f/m 候选取名，所以不能用 name 做唯一条件 */
          .filter((row) => row.name || row.f?.length || row.m?.length || row.say?.length)
      : t.ranks,
  };

  if (metric) theme.metric = metric;
  if (r.genderAware === true) theme.genderAware = true;
  if (r.adult === true) theme.adult = true;
  if (r.titles && typeof r.titles === "object") {
    const titles = r.titles as Record<string, unknown>;
    const f = strList(titles.f);
    const m = strList(titles.m);
    if (f.length || m.length) theme.titles = { f, m };
  }
  if (r.sectionTypes && typeof r.sectionTypes === "object") {
    const out: Record<string, { f: string; adj: string; say: string; m: string }> = {};
    for (const [key, value] of Object.entries(r.sectionTypes as Record<string, unknown>)) {
      const row = (value ?? {}) as Record<string, unknown>;
      const f = String(row.f ?? "").trim();
      const m = String(row.m ?? "").trim();
      const adj = String(row.adj ?? "").trim();
      const say = String(row.say ?? "").trim();
      if (!f && !m && !say) continue;
      out[key] = { f: f || m, m: m || f, adj, say };
    }
    if (Object.keys(out).length) theme.sectionTypes = out;
  }

  return theme;
}

function optionalRankFields(item: Record<string, unknown>): Partial<CertRank> {
  const out: Partial<CertRank> = {};
  const grade = String(item.grade ?? "").trim();
  const rare = String(item.rare ?? "").trim();
  if (grade) out.grade = grade;
  if (rare) out.rare = rare;
  const f = strList(item.f);
  const m = strList(item.m);
  const say = strList(item.say);
  if (f.length) out.f = f;
  if (m.length) out.m = m;
  if (say.length) out.say = say;
  return out;
}

/** 提交给 PUT /api/admin/cert-content 的单个主题形状（tags 由 groups 拍平，与服务端口径一致）。 */
export function themePayload(theme: CertTheme): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: theme.id.trim(),
    name: theme.name.trim(),
    cardLabel: theme.cardLabel,
    issuer: theme.issuer,
    subtitle: theme.subtitle,
    sealText: theme.sealText,
    palette: { ...theme.palette },
    tags: theme.groups.flatMap((g) => g.tags),
    groups: theme.groups.map((g) => ({ name: g.name, emoji: g.emoji, tags: [...g.tags] })),
    ranks: theme.ranks.map((r) => ({ ...r })),
  };
  if (theme.metric) payload.metric = { ...theme.metric };
  if (theme.genderAware) payload.genderAware = true;
  if (theme.adult) payload.adult = true;
  if (theme.titles) payload.titles = { f: [...theme.titles.f], m: [...theme.titles.m] };
  if (theme.sectionTypes) payload.sectionTypes = theme.sectionTypes;
  return payload;
}

/**
 * 等级区间校验。返回人类可读的错误列表，空数组表示通过。
 *
 * 只拦两类会被生成器“静默吞掉”的错误：
 *  - 空洞：`cur.min > prev.max + 1` → hitRank 落空 → fallback 到最后一档；
 *  - 交叠：`cur.min < prev.max` → 同一段百分比命中两档，首个生效。
 * 边界相接（`cur.min === prev.max`）放行，因为 8 套内置主题就是这么写的。
 */
export function validateRankRanges(ranks: CertRank[], hi: number): string[] {
  const errors: string[] = [];
  if (!ranks.length) return ["至少需要一档等级称号"];

  ranks.forEach((rank, index) => {
    const label = rank.name.trim() ? `「${rank.name.trim()}」` : `第 ${index + 1} 档`;
    if (!rank.name.trim()) errors.push(`${label}缺少称号名称`);
    if (!Number.isFinite(rank.min) || !Number.isFinite(rank.max)) {
      errors.push(`${label}的区间不是有效数字`);
      return;
    }
    if (rank.min > rank.max) errors.push(`${label}的起点 ${rank.min} 大于终点 ${rank.max}`);
    if (rank.min < 0 || rank.max > hi) errors.push(`${label}的区间应在 0–${hi} 之间（当前 ${rank.min}–${rank.max}）`);
  });

  const sorted = [...ranks].sort((a, b) => a.min - b.min || a.max - b.max);
  const first = sorted[0];
  if (first && first.min > 0) errors.push(`0–${first.min - 1} 之间没有等级归属，第一档必须从 0 开始`);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    if (cur.min < prev.max) {
      errors.push(
        `「${prev.name || `第 ${i} 档`}」(${prev.min}–${prev.max}) 与「${cur.name || `第 ${i + 1} 档`}」(${cur.min}–${cur.max}) 区间重叠`,
      );
      continue;
    }
    if (cur.min > prev.max + 1) {
      errors.push(
        `${prev.max + 1}–${cur.min - 1} 之间没有等级归属，请检查「${prev.name || `第 ${i} 档`}」与「${cur.name || `第 ${i + 1} 档`}」`,
      );
    }
  }

  return errors;
}

/** 一条校验问题；带主题下标与字段名，页面据此做行内定位。 */
export interface CertContentIssue {
  /** 0 基主题下标；与具体主题无关的问题为 null。 */
  themeIndex: number | null;
  /** 出问题的字段。目前只有 `id` 需要「改完即标红 + 禁保存」。 */
  field?: "id" | "name" | "tags" | "ranks";
  message: string;
}

/**
 * 整套内容包校验。规则逐条对齐服务端 asTheme()/validateCertContentPack()，
 * 但给出**指到第几套、哪一档**的具体消息 —— 服务端只会回一句
 * 「存在不合法的主题（检查 id / 名称 / 标签 / 等级区间）」，40 套里全靠人翻。
 */
export function validateThemes(themes: CertTheme[]): CertContentIssue[] {
  const issues: CertContentIssue[] = [];
  if (!themes.length) return [{ themeIndex: null, message: "至少需要一套主题" }];
  if (themes.length > MAX_THEMES) {
    issues.push({ themeIndex: null, message: `主题数量上限 ${MAX_THEMES} 套（当前 ${themes.length}）` });
  }

  const seen = new Map<string, number>();
  themes.forEach((theme, index) => {
    const name = theme.name.trim();
    const label = `第 ${index + 1} 套${name ? `「${name}」` : ""}`;
    const id = theme.id.trim();

    if (!THEME_ID_PATTERN.test(id)) {
      issues.push({
        themeIndex: index,
        field: "id",
        message: id
          ? `${label}的主题 ID 不合法：「${id}」只能用字母/数字/下划线/连字符，且必须以字母或数字开头，最长 40 字符`
          : `${label}的主题 ID 不能为空`,
      });
    }
    const duplicate = seen.get(id);
    if (duplicate !== undefined) {
      issues.push({
        themeIndex: index,
        field: "id",
        message: `${label}的主题 ID「${id}」与第 ${duplicate + 1} 套重复`,
      });
    } else {
      seen.set(id, index);
    }

    if (!name) issues.push({ themeIndex: index, field: "name", message: `${label}缺少主题名称` });
    if (!theme.groups.some((g) => g.tags.length)) {
      issues.push({ themeIndex: index, field: "tags", message: `${label}没有任何标签，生成器算不出强度` });
    }

    const hi = rankScaleHi(theme);
    for (const message of validateRankRanges(theme.ranks, hi)) {
      issues.push({ themeIndex: index, field: "ranks", message: `${label}：${message}` });
    }
  });

  return issues;
}
