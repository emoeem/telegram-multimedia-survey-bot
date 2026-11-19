/**
 * web_apps 仓储（0104，P0 批次 M2）：应用中心「网页导航」区的外链数据。
 *
 * 形态参照 task-pack.repository.ts：列常量 + 行映射 + 输入归一化。与
 * task_packs 的差异：web_apps 无级联子表（0104 文件头），删除是硬删，
 * 没有软删墓碑列——deleteWebApp 直接 DELETE，操作痕迹由管理端审计
 * （web_app.delete）保留。
 *
 * URL/白名单的语义校验在 HTTP 层（src/http/admin/web-app.ts：必须 https://，
 * M4 再收口白名单）；这里只做存储形态的宽容归一化（坏 JSON、越界值回退
 * 默认，不抛错），保证任何脏行都不会把公开列表打挂。
 */

export type WebAppOpenMode = "miniapp" | "browser";

export interface WebAppRecord {
  id: number;
  name: string;
  description: string | null;
  url: string;
  iconUrl: string | null;
  category: string | null;
  sortOrder: number;
  enabled: boolean;
  /** 打开方式：miniapp=内嵌（M4 按白名单域校验），browser=外跳浏览器。 */
  openMode: WebAppOpenMode;
  /** M4 打开白名单（小写主机名）；null = 未配置。 */
  allowedDomains: string[] | null;
  createdAt: string;
  updatedAt: string;
}

const WEB_APP_COLUMNS = `id, name, description, url, icon_url, category, sort_order, enabled, open_mode, allowed_domains, created_at, updated_at`;

/** allowed_domains 单条上限（主机名段），条数上限见 normalizeAllowedDomains。 */
const ALLOWED_DOMAIN_MAX_LENGTH = 253;
const ALLOWED_DOMAIN_MAX_COUNT = 32;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback;
}

/**
 * URL 合法性 + https 强制（管理端写路径的唯一校验点）：`new URL` 解析失败、
 * 协议非 https: 一律拒绝。返回 null 表示拒绝，调用方转 400。
 */
export function normalizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * allowed_domains 归一化（宽容）：接受字符串数组或 JSON 文本，过滤出
 * 形似主机名的条目（无协议/路径/空格，点分域名段）。空结果返回 null
 * （= 未配置），条目与长度都有上限防脏数据撑表。
 */
export function normalizeAllowedDomains(raw: unknown): string[] | null {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const domains: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    // 主机名形态：字母/数字/连字符/点，无协议、无路径、无空格；末尾空主机
    // 名段（如 "a..b"）由逐段非空校验拒绝。
    const domain = item.trim().toLowerCase().replace(/\.$/, "");
    if (
      !domain ||
      domain.length > ALLOWED_DOMAIN_MAX_LENGTH ||
      !/^[a-z0-9.-]+$/.test(domain) ||
      domain.split(".").some((part) => part.length === 0)
    ) {
      continue;
    }
    if (!domains.includes(domain)) domains.push(domain);
    if (domains.length >= ALLOWED_DOMAIN_MAX_COUNT) break;
  }
  return domains.length > 0 ? domains : null;
}

/** open_mode 归一化：非法值一律回退 browser（最保守的外跳）。 */
export function normalizeOpenMode(value: unknown): WebAppOpenMode {
  return value === "miniapp" ? "miniapp" : "browser";
}

function parseAllowedDomainsColumn(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return normalizeAllowedDomains(raw);
}

function mapWebApp(row: Record<string, unknown>): WebAppRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : null,
    url: String(row.url),
    iconUrl: typeof row.icon_url === "string" && row.icon_url ? row.icon_url : null,
    category: typeof row.category === "string" && row.category ? row.category : null,
    sortOrder: Number(row.sort_order ?? 0),
    enabled: Number(row.enabled ?? 1) === 1,
    openMode: normalizeOpenMode(row.open_mode),
    allowedDomains: parseAllowedDomainsColumn(row.allowed_domains),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 列网页应用。enabledOnly=true 供公开只读 API（GET /api/web-apps）与管理端
 * 「玩家视角」预览；管理端列表传默认值取全量（含停用项），按 sort_order, id
 * 稳定排序。
 */
export async function listWebApps(db: D1Database, options: { enabledOnly?: boolean } = {}): Promise<WebAppRecord[]> {
  const where = options.enabledOnly ? "WHERE enabled = 1" : "";
  const { results } = await db
    .prepare(`SELECT ${WEB_APP_COLUMNS} FROM web_apps ${where} ORDER BY sort_order ASC, id ASC`)
    .all();
  return (results ?? []).map((row) => mapWebApp(row as Record<string, unknown>));
}

export async function getWebAppById(db: D1Database, id: number): Promise<WebAppRecord | null> {
  const row = await db.prepare(`SELECT ${WEB_APP_COLUMNS} FROM web_apps WHERE id = ? LIMIT 1`).bind(id).first();
  return row ? mapWebApp(row as Record<string, unknown>) : null;
}

export interface WebAppCreateInput {
  name: string;
  /** 调用方需先用 normalizeHttpsUrl 校验；这里只负责落库。 */
  url: string;
  description?: string | null;
  iconUrl?: string | null;
  category?: string | null;
  enabled?: boolean;
  openMode?: WebAppOpenMode;
  allowedDomains?: string[] | null;
}

/**
 * 新建网页应用。sort_order 不收输入：固定 append 到当前末尾（MAX+1），
 * 与 createTaskPack 的先例一致——定位交给 updateWebApp / reorderWebApps。
 */
export async function createWebApp(db: D1Database, input: WebAppCreateInput): Promise<WebAppRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO web_apps (name, description, url, icon_url, category, sort_order, enabled, open_mode, allowed_domains, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM web_apps), ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.name.slice(0, 60),
      input.description?.slice(0, 300) ?? null,
      input.url,
      input.iconUrl?.slice(0, 500) ?? null,
      input.category?.slice(0, 30) ?? null,
      (input.enabled ?? true) ? 1 : 0,
      normalizeOpenMode(input.openMode),
      input.allowedDomains ? JSON.stringify(normalizeAllowedDomains(input.allowedDomains) ?? []) : null,
      now,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法保存网页应用");
  const created = await getWebAppById(db, id);
  if (!created) throw new Error("无法保存网页应用");
  return created;
}

export interface WebAppUpdateInput {
  name?: string;
  description?: string | null;
  /** 调用方需先用 normalizeHttpsUrl 校验。 */
  url?: string;
  iconUrl?: string | null;
  category?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  openMode?: WebAppOpenMode;
  allowedDomains?: string[] | null;
}

export async function updateWebApp(db: D1Database, id: number, input: WebAppUpdateInput): Promise<WebAppRecord | null> {
  const existing = await getWebAppById(db, id);
  if (!existing) return null;
  const allowedDomains =
    input.allowedDomains !== undefined
      ? input.allowedDomains
        ? JSON.stringify(normalizeAllowedDomains(input.allowedDomains) ?? [])
        : null
      : existing.allowedDomains
        ? JSON.stringify(existing.allowedDomains)
        : null;
  await db
    .prepare(
      `UPDATE web_apps SET name = ?, description = ?, url = ?, icon_url = ?, category = ?, sort_order = ?, enabled = ?, open_mode = ?, allowed_domains = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      (input.name ?? existing.name).slice(0, 60),
      (input.description !== undefined ? input.description : existing.description)?.slice(0, 300) ?? null,
      input.url ?? existing.url,
      (input.iconUrl !== undefined ? input.iconUrl : existing.iconUrl)?.slice(0, 500) ?? null,
      (input.category !== undefined ? input.category : existing.category)?.slice(0, 30) ?? null,
      clampInt(input.sortOrder ?? existing.sortOrder, 0, 9999, existing.sortOrder),
      (input.enabled ?? existing.enabled) ? 1 : 0,
      normalizeOpenMode(input.openMode ?? existing.openMode),
      allowedDomains,
      new Date().toISOString(),
      id,
    )
    .run();
  return getWebAppById(db, id);
}

/**
 * 按给定 id 顺序重排 sort_order（1 起）。数组里缺失的行不动——前端只发当前
 * 列表的全量 id 序列；返回实际重排的行数。
 *
 * 每条 batch 项独立 prepare：D1 的 bind() 返回新语句、复用同一 statement
 * 对象在 shim/客户端实现下会让全部条目共享最后一次绑定的参数
 * （task-pack.repository.ts:265 insertTaskItems 的共享写法在仓库测试里被
 * 「行数相同」掩盖，这里不复刻）。
 */
export async function reorderWebApps(db: D1Database, ids: number[]): Promise<number> {
  const clean = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (clean.length === 0) return 0;
  const now = new Date().toISOString();
  const batch = clean.map((id, index) =>
    db.prepare("UPDATE web_apps SET sort_order = ?, updated_at = ? WHERE id = ?").bind(index + 1, now, id),
  );
  await db.batch(batch);
  return clean.length;
}

/** 硬删（web_apps 无级联子表，0104 文件头）；返回行是否存在并被删除。 */
export async function deleteWebApp(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM web_apps WHERE id = ?").bind(id).run();
  return Boolean(result.meta?.changes);
}
