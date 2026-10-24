import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";
import { getSystemSetting, setSystemSetting } from "../../db/repositories/system-settings.repository";

/**
 * 认证卡内容包（cert content pack）。
 *
 * `/cert` 生成器页面的主题数据来自 themes.js 的内置默认；管理员在这里编辑的
 * 内容包存进 system_settings（单键 JSON），页面启动时通过公开的
 * GET /api/cert-content 拉取，取不到就退回内置默认。
 */
export const CERT_CONTENT_SETTING_KEY = "cert_content_pack";

/** 词条：中性主题是纯字符串，成人向主题带性别（u/f/m）与分值（1/2/3）。 */
export interface CertTag {
  t: string;
  s: 1 | 2 | 3;
  g: "u" | "f" | "m";
}

interface CertRank {
  min: number;
  max: number;
  name: string;
  /** 等级字母（F/E/D/C/B/A/S/SS/SSS），可空。 */
  grade?: string;
  /** 稀有度（N/R/SR/SSR/UR/EX），可空。 */
  rare?: string;
  /** 未填 name 时按性别从候选里确定性取一个。 */
  f?: string[];
  m?: string[];
  /** 称号下方的倾向叙述。 */
  say?: string[];
}

export interface CertGroup {
  name: string;
  emoji: string;
  /** 板块徽章名（选够这个板块一定比例词条后点亮）。 */
  badge?: string;
  tags: (string | CertTag)[];
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
  /** 扁平标签库：始终存在（有分组时是各分组标签的串联），保证老版本消费方可读。 */
  tags: (string | CertTag)[];
  /** 可选的分组标签库；生成器按分组展示，标签仍计入同一份百分比。 */
  groups?: CertGroup[];
  ranks: CertRank[];
  /** 强度口径：缺省按「勾选条数 ÷ 总条数」；score 按「分值累加 ÷ divisor」。 */
  metric?: { kind: "score"; divisor: number };
  /** 词条带性别时开启性别切换，只显示 u + 所选性别。 */
  genderAware?: boolean;
  /** 成人向主题：未确认 18+ 前不加载。 */
  adult?: boolean;
  /** 标题预设（按性别各一组）。 */
  titles?: { f: string[]; m: string[] };
  /** 每个板块的倾向名词（{f,m,adj,say}），生成器据此拼「反差感天花板」式的称号。 */
  sectionTypes?: Record<string, { f: string; m: string; adj: string; say: string }>;
}

export interface CertContentPack {
  version: 1;
  themes: CertTheme[];
}

/* Must match admin/src/cert-content-model.ts and cert/app.js: a 6-only
   pattern here silently replaced an 8-digit (alpha) colour with the default. */
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 强度口径是不是「分值累加」（成人向词库）：决定档位区间上限是 100 还是 999。 */
function isScore(metric: unknown): boolean {
  if (!metric || typeof metric !== "object") return false;
  return (metric as Record<string, unknown>).kind === "score";
}

function asTheme(raw: unknown): CertTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const id = String(t.id ?? "").trim();
  const name = String(t.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) || !name) return null;
  const str = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    return s || fallback;
  };
  const palRaw = (t.palette ?? {}) as Record<string, unknown>;
  const color = (v: unknown, fallback: string) => (HEX.test(String(v ?? "")) ? String(v) : fallback);
  const score = isScore(t.metric);
  const hi = score ? 999 : 100;

  /** 词条：字符串原样保留；对象需要 t，s 取 1-3，g 取 u/f/m。 */
  const asTag = (x: unknown): string | CertTag | null => {
    if (typeof x === "string") {
      const v = x.trim();
      return v ? v.slice(0, 40) : null;
    }
    if (!x || typeof x !== "object") return null;
    const row = x as Record<string, unknown>;
    const text = String(row.t ?? "").trim();
    if (!text) return null;
    const sc = Math.round(Number(row.s ?? 1));
    const sex = String(row.g ?? "u");
    return {
      t: text.slice(0, 40),
      s: (sc >= 1 && sc <= 3 ? sc : 1) as 1 | 2 | 3,
      g: (sex === "f" || sex === "m" ? sex : "u") as "u" | "f" | "m",
    };
  };
  const asTagList = (list: unknown, max: number) =>
    (Array.isArray(list) ? list : [])
      .map(asTag)
      .filter((v): v is string | CertTag => v !== null)
      .slice(0, max);

  const tags = asTagList(t.tags, 300);
  const groups = Array.isArray(t.groups)
    ? t.groups
        .map((g) => {
          const row = (g ?? {}) as Record<string, unknown>;
          const badge = String(row.badge ?? "").trim();
          const out: CertGroup = {
            name: String(row.name ?? "")
              .trim()
              .slice(0, 12),
            emoji: String(row.emoji ?? "")
              .trim()
              .slice(0, 4),
            tags: asTagList(row.tags, 200),
          };
          if (badge) out.badge = badge.slice(0, 30);
          return out;
        })
        .filter((g) => g.name && g.tags.length)
        .slice(0, 24)
    : [];
  /* 有分组时扁平库是各分组的串联：生成器只需要它给老数据兜底，这里不再截断成 120 条 */
  const flatTags = groups.length ? groups.flatMap((g) => g.tags).slice(0, 4000) : tags;

  const strList = (v: unknown, max: number, width: number) =>
    (Array.isArray(v) ? v : [])
      .map((x) =>
        String(x ?? "")
          .trim()
          .slice(0, width),
      )
      .filter(Boolean)
      .slice(0, max);

  const ranks = Array.isArray(t.ranks)
    ? t.ranks
        .map((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          const out: CertRank = {
            min: Math.max(0, Math.min(hi, Math.round(Number(row.min ?? 0)) || 0)),
            max: Math.max(0, Math.min(hi, Math.round(Number(row.max ?? hi)) || 0)),
            name: String(row.name ?? "")
              .trim()
              .slice(0, 40),
          };
          const grade = String(row.grade ?? "").trim();
          const rare = String(row.rare ?? "").trim();
          if (grade) out.grade = grade.slice(0, 6);
          if (rare) out.rare = rare.slice(0, 6);
          const f = strList(row.f, 24, 40);
          const m = strList(row.m, 24, 40);
          const say = strList(row.say, 24, 60);
          if (f.length) out.f = f;
          if (m.length) out.m = m;
          if (say.length) out.say = say;
          return out;
        })
        /* 成人向档位不带 name，靠 f/m 候选取名，所以不能用 name 做唯一条件 */
        .filter((r) => r.name || (r.f && r.f.length) || (r.m && r.m.length))
        .sort((a, b) => a.min - b.min)
        .slice(0, 24)
    : [];
  if (!flatTags.length || !ranks.length) return null;

  const theme: CertTheme = {
    id,
    name,
    cardLabel: str(t.cardLabel, "认证卡"),
    issuer: str(t.issuer, name),
    subtitle: str(t.subtitle, "CERTIFICATE"),
    sealText: str(t.sealText, `${name}专用章`),
    palette: {
      primary: color(palRaw.primary, "#1e3a8a"),
      primary2: color(palRaw.primary2, "#2563eb"),
      accent: color(palRaw.accent, "#f59e0b"),
      ink: color(palRaw.ink, "#0f172a"),
      muted: color(palRaw.muted, "#64748b"),
      paper: color(palRaw.paper, "#f7f9fc"),
    },
    tags: flatTags,
    ranks,
  };
  if (groups.length) theme.groups = groups;
  if (score) {
    theme.metric = {
      kind: "score",
      divisor: Math.max(1, Math.min(999, Math.round(Number((t.metric as Record<string, unknown>).divisor) || 60))),
    };
  }
  if (t.genderAware === true) theme.genderAware = true;
  if (t.adult === true) theme.adult = true;
  if (t.titles && typeof t.titles === "object") {
    const titles = t.titles as Record<string, unknown>;
    const f = strList(titles.f, 24, 20);
    const m = strList(titles.m, 24, 20);
    if (f.length || m.length) theme.titles = { f, m };
  }
  if (t.sectionTypes && typeof t.sectionTypes === "object") {
    const raw3 = t.sectionTypes as Record<string, unknown>;
    const out: Record<string, { f: string; m: string; adj: string; say: string }> = {};
    for (const key of Object.keys(raw3).slice(0, 40)) {
      const row = (raw3[key] ?? {}) as Record<string, unknown>;
      const f = String(row.f ?? "")
        .trim()
        .slice(0, 20);
      const m = String(row.m ?? "")
        .trim()
        .slice(0, 20);
      const adj = String(row.adj ?? "")
        .trim()
        .slice(0, 20);
      const say = String(row.say ?? "")
        .trim()
        .slice(0, 80);
      if (!f && !m && !say) continue;
      out[key.slice(0, 12)] = { f: f || m, m: m || f, adj, say };
    }
    if (Object.keys(out).length) theme.sectionTypes = out;
  }
  return theme;
}

export function validateCertContentPack(body: unknown): { pack: CertContentPack } | { error: string } {
  if (!body || typeof body !== "object") return { error: "内容包格式不正确" };
  const raw = body as Record<string, unknown>;
  const themesRaw = raw.themes;
  if (!Array.isArray(themesRaw) || !themesRaw.length) return { error: "至少需要一套主题" };
  if (themesRaw.length > 40) return { error: "主题数量过多（上限 40 套）" };
  const themes: CertTheme[] = [];
  const seen = new Set<string>();
  for (const item of themesRaw) {
    const theme = asTheme(item);
    if (!theme) return { error: "存在不合法的主题（检查 id / 名称 / 标签 / 等级区间）" };
    if (seen.has(theme.id)) return { error: `主题 id 重复：${theme.id}` };
    seen.add(theme.id);
    themes.push(theme);
  }
  return { pack: { version: 1, themes } };
}

export async function handleCertContentAdmin(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;

  if (url.pathname === "/api/admin/cert-content" && request.method === "GET") {
    const raw = await getSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY);
    if (!raw) return json({ ok: true, pack: null });
    try {
      return json({ ok: true, pack: JSON.parse(raw) });
    } catch {
      return json({ ok: true, pack: null });
    }
  }

  if (url.pathname === "/api/admin/cert-content" && request.method === "PUT") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理认证卡内容");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, "invalid_json", "请求体不是合法 JSON");
    }
    const result = validateCertContentPack(body);
    if ("error" in result) return fail(400, "validation_failed", result.error);
    const before = await getSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY);
    await setSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY, JSON.stringify(result.pack), user?.id ?? null);
    await writeAudit(env.DB, {
      actorUserId: user?.id ?? null,
      action: "cert_content.save",
      entityType: "cert_content",
      entityId: CERT_CONTENT_SETTING_KEY,
      before: before ? JSON.parse(before) : null,
      after: result.pack,
    });
    return json({ ok: true, pack: result.pack });
  }

  if (url.pathname === "/api/admin/cert-content" && request.method === "DELETE") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理认证卡内容");
    const before = await getSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY);
    await env.DB.prepare("DELETE FROM system_settings WHERE key = ?").bind(CERT_CONTENT_SETTING_KEY).run();
    if (before) {
      await writeAudit(env.DB, {
        actorUserId: user?.id ?? null,
        action: "cert_content.reset",
        entityType: "cert_content",
        entityId: CERT_CONTENT_SETTING_KEY,
        before: JSON.parse(before),
      });
    }
    return json({ ok: true });
  }

  return null;
}
