import { nowIso } from "../db/client";

/**
 * 问卷分类（0087）。
 *
 * 一份问卷最多属于一个分类：外键可空，空 = 未分类。分类是运营数据而不是
 * 代码枚举，所以可改名、可调序、可增删；删分类不删问卷（ON DELETE SET NULL
 * 之外这里再显式解绑一次，因为 D1 的 foreign_keys 行为不该被当作保证）。
 */

export const SURVEY_CATEGORY_NAME_MAX = 20;
export const SURVEY_CATEGORY_DESCRIPTION_MAX = 120;

export interface SurveyCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  /** 该分类下的问卷数（公开面只统计已发布且未删除的）。 */
  count: number;
}

export interface CategoryInput {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  sortOrder?: unknown;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * slug 只接受 ASCII 小写：它是 URL/筛选参数的一部分，中文名走 name。
 * 调用方没给就用 `c<base36 时间戳>`——不猜拼音，猜错了比不好看更麻烦。
 */
export function normalizeCategorySlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return SLUG_PATTERN.test(trimmed) ? trimmed : null;
}

export function deriveCategorySlug(): string {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function normalizeCategoryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SURVEY_CATEGORY_NAME_MAX) return null;
  return trimmed;
}

export function normalizeCategoryDescription(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > SURVEY_CATEGORY_DESCRIPTION_MAX ? null : trimmed;
}

/**
 * 管理端列表：全部分类 + 各分类下的问卷数（含草稿，管理员要看得到
 * 「这个分类还没建内容」）。
 */
export async function listCategories(
  db: D1Database,
  options: { publishedOnly?: boolean } = {},
): Promise<SurveyCategory[]> {
  const countCondition = options.publishedOnly
    ? "s.status = 'published' AND s.deleted_at IS NULL"
    : "s.deleted_at IS NULL";
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.sort_order sortOrder,
              (SELECT COUNT(*) FROM surveys s WHERE s.category_id = c.id AND ${countCondition}) count
         FROM survey_categories c
        ORDER BY c.sort_order ASC, c.id ASC`,
    )
    .all<{ id: number; name: string; slug: string; description: string; sortOrder: number; count: number }>();
  return (rows.results ?? []).map((row) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    sortOrder: Number(row.sortOrder ?? 0),
    count: Number(row.count ?? 0),
  }));
}

/** 公开面只给「至少有一份已发布问卷」的分类，空分类不占筛选条的位置。 */
export async function listPublishedCategories(db: D1Database): Promise<SurveyCategory[]> {
  const all = await listCategories(db, { publishedOnly: true });
  return all.filter((category) => category.count > 0);
}

export async function getCategoryById(db: D1Database, id: number): Promise<SurveyCategory | null> {
  const all = await listCategories(db);
  return all.find((category) => category.id === id) ?? null;
}

/**
 * slug 冲突时顺延 `-2`、`-3`…（最多 20 次，之后报错）。不静默覆盖已有分类：
 * 两个同 slug 的分类会让筛选参数指向不确定的一行。
 */
async function uniqueSlug(db: D1Database, base: string, excludeId: number | null): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const row = await db
      .prepare("SELECT id FROM survey_categories WHERE slug = ? LIMIT 1")
      .bind(candidate)
      .first<{ id: number }>();
    if (!row || (excludeId !== null && Number(row.id) === excludeId)) return candidate;
  }
  return null;
}

export type CategoryWriteError =
  | { code: "invalid_name"; message: string }
  | { code: "invalid_slug"; message: string }
  | { code: "invalid_description"; message: string }
  | { code: "slug_conflict"; message: string }
  | { code: "not_found"; message: string };

export async function createCategory(
  db: D1Database,
  input: CategoryInput,
): Promise<SurveyCategory | CategoryWriteError> {
  const name = normalizeCategoryName(input.name);
  if (!name) return { code: "invalid_name", message: `分类名需要 1-${SURVEY_CATEGORY_NAME_MAX} 个字符` };
  const description = normalizeCategoryDescription(input.description);
  if (description === null) {
    return { code: "invalid_description", message: `分类说明最多 ${SURVEY_CATEGORY_DESCRIPTION_MAX} 个字符` };
  }
  const requestedSlug = input.slug === undefined || input.slug === null || input.slug === "" ? null : input.slug;
  let slug: string | null;
  if (requestedSlug === null) {
    slug = await uniqueSlug(db, deriveCategorySlug(), null);
  } else {
    const normalized = normalizeCategorySlug(requestedSlug);
    if (!normalized) return { code: "invalid_slug", message: "slug 只能是小写字母、数字和连字符" };
    slug = await uniqueSlug(db, normalized, null);
  }
  if (!slug) return { code: "slug_conflict", message: "slug 已被占用" };
  const sortOrder = input.sortOrder === undefined || input.sortOrder === null ? 0 : Number(input.sortOrder);
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO survey_categories (name, slug, description, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(name, slug, description, Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 0, timestamp, timestamp)
    .run();
  const id = Number(result.meta?.last_row_id ?? 0);
  if (!id) return { code: "not_found", message: "分类创建失败" };
  return { id, name, slug, description, sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 0, count: 0 };
}

export async function updateCategory(
  db: D1Database,
  id: number,
  input: CategoryInput,
): Promise<SurveyCategory | CategoryWriteError> {
  const existing = await db
    .prepare("SELECT id, name, slug, description, sort_order sortOrder FROM survey_categories WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string; slug: string; description: string; sortOrder: number }>();
  if (!existing) return { code: "not_found", message: "分类不存在" };

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) {
    const name = normalizeCategoryName(input.name);
    if (!name) return { code: "invalid_name", message: `分类名需要 1-${SURVEY_CATEGORY_NAME_MAX} 个字符` };
    updates.push("name = ?");
    binds.push(name);
  }
  if (input.slug !== undefined && input.slug !== null) {
    const normalized = normalizeCategorySlug(input.slug);
    if (!normalized) return { code: "invalid_slug", message: "slug 只能是小写字母、数字和连字符" };
    const slug = await uniqueSlug(db, normalized, id);
    if (!slug) return { code: "slug_conflict", message: "slug 已被占用" };
    updates.push("slug = ?");
    binds.push(slug);
  }
  if (input.description !== undefined) {
    const description = normalizeCategoryDescription(input.description);
    if (description === null) {
      return { code: "invalid_description", message: `分类说明最多 ${SURVEY_CATEGORY_DESCRIPTION_MAX} 个字符` };
    }
    updates.push("description = ?");
    binds.push(description);
  }
  if (input.sortOrder !== undefined) {
    const sortOrder = Number(input.sortOrder);
    if (!Number.isFinite(sortOrder)) return { code: "invalid_name", message: "排序值必须是数字" };
    updates.push("sort_order = ?");
    binds.push(Math.trunc(sortOrder));
  }
  if (!updates.length) {
    const current = await getCategoryById(db, id);
    return current ?? { code: "not_found", message: "分类不存在" };
  }
  updates.push("updated_at = ?");
  binds.push(nowIso(), id);
  await db
    .prepare(`UPDATE survey_categories SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  const updated = await getCategoryById(db, id);
  return updated ?? { code: "not_found", message: "分类不存在" };
}

/**
 * 删分类：先把问卷解绑（含软删除的行），再删分类行。问卷本身不动——
 * 运营在回收站里恢复一份旧问卷时，不该发现它带着一个不存在的分类 id。
 */
export async function deleteCategory(db: D1Database, id: number): Promise<boolean> {
  const existing = await db
    .prepare("SELECT id FROM survey_categories WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ id: number }>();
  if (!existing) return false;
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE surveys SET category_id = NULL, updated_at = ? WHERE category_id = ?").bind(timestamp, id),
    db.prepare("DELETE FROM survey_categories WHERE id = ?").bind(id),
  ]);
  return true;
}

/**
 * 批量归类。categoryId = null 表示清空（回到未分类）。
 * 一次最多 200 份，与批量分级的上限保持一致。
 */
export async function assignCategoryToSurveys(
  db: D1Database,
  surveyIds: number[],
  categoryId: number | null,
): Promise<number> {
  if (!surveyIds.length) return 0;
  const placeholders = surveyIds.map(() => "?").join(",");
  const result = await db
    .prepare(`UPDATE surveys SET category_id = ?, updated_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
    .bind(categoryId, nowIso(), ...surveyIds)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export function isCategoryWriteError(value: SurveyCategory | CategoryWriteError): value is CategoryWriteError {
  return typeof (value as CategoryWriteError).code === "string";
}
