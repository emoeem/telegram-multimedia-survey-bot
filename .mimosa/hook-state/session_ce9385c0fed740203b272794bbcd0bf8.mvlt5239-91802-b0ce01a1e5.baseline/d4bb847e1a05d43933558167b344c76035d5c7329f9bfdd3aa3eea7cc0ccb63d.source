import {
  assignCategoryToSurveys,
  createCategory,
  deleteCategory,
  isCategoryWriteError,
  listCategories,
  updateCategory,
} from "../../services/survey-category.service";
import type { WriteContext } from "./helpers";
import { writeAudit } from "./helpers";
import type { Env } from "../../index";

/**
 * 分类的写侧（0087）。读侧在 read.ts：`GET /api/admin/survey-categories`。
 *
 * 权限：分类是全局共享的运营字典，增删改只给管理员；非管理员创作者改的
 * 是自己问卷的 `categoryId`（走 PATCH /api/admin/surveys/:id，那里已有
 * loadManageableSurvey 的归属校验）。
 */
export async function handleAdminCategoriesWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // POST /api/admin/surveys/bulk-category — 批量归类（仅管理员）。
  // 必须在数字 ID 匹配之前：bulk-category 不是数字。
  if (request.method === "POST" && url.pathname === "/api/admin/surveys/bulk-category") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可批量调整分类");
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    if (!ids.length) return fail(400, "validation_failed", "请选择至少一份问卷");
    if (ids.length > 200) return fail(400, "validation_failed", "一次最多归类 200 份");
    const rawCategoryId = body.categoryId;
    let categoryId: number | null = null;
    if (rawCategoryId !== null && rawCategoryId !== undefined && rawCategoryId !== "") {
      const parsed = Number(rawCategoryId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return fail(400, "validation_failed", "分类无效");
      }
      const known = await db
        .prepare("SELECT id FROM survey_categories WHERE id = ? LIMIT 1")
        .bind(parsed)
        .first<{ id: number }>();
      if (!known) return fail(404, "not_found", "分类不存在");
      categoryId = parsed;
    }
    const changed = await assignCategoryToSurveys(db, ids, categoryId);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.bulk_category",
      entityType: "survey",
      entityId: null,
      after: { ids, categoryId, changed },
    });
    return json({ ok: true, changed });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/survey-categories") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理分类");
    const created = await createCategory(db, body);
    if (isCategoryWriteError(created)) return fail(400, created.code, created.message);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey_category.create",
      entityType: "survey_category",
      entityId: String(created.id),
      after: created,
    });
    return json(created);
  }

  const categoryMatch = url.pathname.match(/^\/api\/admin\/survey-categories\/(\d+)$/);
  if (!categoryMatch) return null;
  if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理分类");
  const categoryId = Number(categoryMatch[1]);

  if (request.method === "PATCH" || request.method === "PUT") {
    const before = (await listCategories(db)).find((category) => category.id === categoryId) ?? null;
    const updated = await updateCategory(db, categoryId, body);
    if (isCategoryWriteError(updated)) {
      return fail(updated.code === "not_found" ? 404 : 400, updated.code, updated.message);
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey_category.update",
      entityType: "survey_category",
      entityId: String(categoryId),
      before,
      after: updated,
    });
    return json(updated);
  }

  if (request.method === "DELETE") {
    const before = (await listCategories(db)).find((category) => category.id === categoryId) ?? null;
    const deleted = await deleteCategory(db, categoryId);
    if (!deleted) return fail(404, "not_found", "分类不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey_category.delete",
      entityType: "survey_category",
      entityId: String(categoryId),
      before,
    });
    return json({ ok: true });
  }

  return null;
}
