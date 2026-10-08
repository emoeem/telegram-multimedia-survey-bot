import type { Env } from "../../index";
import {
  createShowcaseItem,
  createShowcasePerson,
  softDeleteShowcaseItem,
  softDeleteShowcasePerson,
  getShowcaseItemById,
  getShowcasePersonById,
  listShowcasePersons,
  reorderShowcasePersons,
  updateShowcaseItem,
  updateShowcasePerson,
} from "../../db/repositories/showcase.repository";
import {
  normalizeShowcaseItemInput,
  normalizeShowcasePersonInput,
  toAdminShowcasePerson,
} from "../../services/showcase.service";
import { countShowcasePersons } from "../../db/repositories/showcase.repository";
import { storeSurveyAdminMedia } from "./helpers";
import { ReadContext, WriteContext, writeAudit } from "./helpers";

/**
 * Admin CRUD for the Showcase (展示区).
 *
 * Every mutation is audited with the same action naming as the rest of the
 * panel (showcase.*), so the audit page answers "who published that page".
 */

/** 作品文件也走这一条上传（图片/音频/视频），上限与后台其它素材一致。 */
const SHOWCASE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Referenced media must exist, or the public page would render a broken image. */
async function mediaAssetsExist(env: Env, ids: Array<number | null | undefined>): Promise<boolean> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === "number" && id > 0))];
  if (unique.length === 0) return true;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM media_assets WHERE id IN (${unique.map(() => "?").join(", ")})`,
  )
    .bind(...unique)
    .first<{ count: number }>();
  return Number(row?.count ?? 0) === unique.length;
}

async function surveyExists(env: Env, surveyId: number | null | undefined): Promise<boolean> {
  if (typeof surveyId !== "number" || surveyId <= 0) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM surveys WHERE id = ? LIMIT 1").bind(surveyId).first();
  return row !== null;
}

export async function handleAdminShowcaseRead(url: URL, env: Env, ctx: ReadContext): Promise<Response | null> {
  if (url.pathname !== "/api/admin/showcase") return null;
  const { isAdmin, fail, json } = ctx;
  if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理展示区");
  const { persons, total } = await listShowcasePersons(env.DB, { limit: 200 });
  const counts = await countShowcasePersons(env.DB);
  return json({
    persons: persons.map((person) => toAdminShowcasePerson(person)),
    total,
    publishedTotal: counts.published,
    limit: 200,
  });
}

export async function handleAdminShowcaseWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/admin/showcase")) return null;
  const { user, isAdmin, fail, json } = ctx;
  if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理展示区");
  const db = env.DB;

  // ---- 图片上传（立绘 / 背景 / 头像 / 作品封面） --------------------------
  if (request.method === "POST" && url.pathname === "/api/admin/showcase/media") {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return fail(400, "invalid_upload", "请选择要上传的图片");
    // 图片 / 音频 / 视频都可以是作品本体；文档类仍然拒绝（前台没有查看器）。
    if (!/^(image|audio|video)\//.test(file.type.toLowerCase())) {
      return fail(
        400,
        "invalid_upload",
        "展示区支持图片、音频或视频文件（PNG/JPG/WebP/GIF、MP3/M4A/WAV、MP4/WebM/MOV）",
      );
    }
    if (file.size > SHOWCASE_UPLOAD_MAX_BYTES) {
      return fail(413, "upload_too_large", `单张图片不能超过 ${SHOWCASE_UPLOAD_MAX_BYTES / 1024 / 1024}MB`);
    }
    let asset;
    try {
      asset = await storeSurveyAdminMedia(db, env.MEDIA_KV, file);
    } catch (error) {
      return fail(400, "invalid_upload", error instanceof Error ? error.message : "上传失败，请重试");
    }
    return Response.json(
      {
        mediaAssetId: asset.id,
        url: `/api/admin/media/${asset.id}/image`,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  // ---- 人物 ------------------------------------------------------------
  if (request.method === "POST" && url.pathname === "/api/admin/showcase/persons") {
    const parsed = normalizeShowcasePersonInput(body, { creating: true });
    if ("error" in parsed) return fail(400, "validation_failed", parsed.error);
    const value = parsed.value;
    if (!(await mediaAssetsExist(env, [value.backgroundMediaId, value.illustrationMediaId, value.avatarMediaId]))) {
      return fail(400, "validation_failed", "引用的图片不存在，请重新上传");
    }
    if (!(await surveyExists(env, value.surveyId))) {
      return fail(400, "validation_failed", "引用的问卷不存在");
    }
    const id = await createShowcasePerson(db, {
      ...value,
      name: value.name!,
      createdBy: user.id,
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "showcase.person.create",
      entityType: "showcase_person",
      entityId: String(id),
      after: { name: value.name, published: value.published ?? false },
    });
    const person = await getShowcasePersonById(db, id);
    return Response.json(
      { ok: true, person: person ? toAdminShowcasePerson(person) : null },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/admin/showcase/persons/reorder" && Array.isArray(body.ids)) {
    const ids = body.ids.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
    if (ids.length === 0) return fail(400, "validation_failed", "缺少要排序的人物编号");
    await reorderShowcasePersons(db, ids);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "showcase.person.reorder",
      entityType: "showcase_person",
      after: { ids },
    });
    return json({ ok: true, ids });
  }

  const personMatch = url.pathname.match(/^\/api\/admin\/showcase\/persons\/(\d+)$/);
  if (personMatch) {
    const personId = Number(personMatch[1]);
    const person = await getShowcasePersonById(db, personId);
    if (!person) return fail(404, "not_found", "展示人物不存在");
    if (request.method === "PATCH" || request.method === "POST") {
      const parsed = normalizeShowcasePersonInput(body, { creating: false });
      if ("error" in parsed) return fail(400, "validation_failed", parsed.error);
      const value = parsed.value;
      if (!(await mediaAssetsExist(env, [value.backgroundMediaId, value.illustrationMediaId, value.avatarMediaId]))) {
        return fail(400, "validation_failed", "引用的图片不存在，请重新上传");
      }
      if (!(await surveyExists(env, value.surveyId))) {
        return fail(400, "validation_failed", "引用的问卷不存在");
      }
      await updateShowcasePerson(db, personId, value);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "showcase.person.update",
        entityType: "showcase_person",
        entityId: String(personId),
        after: { fields: Object.keys(value) },
      });
      const updated = await getShowcasePersonById(db, personId);
      return json({ ok: true, person: updated ? toAdminShowcasePerson(updated) : null });
    }
    if (request.method === "DELETE") {
      await softDeleteShowcasePerson(db, personId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "showcase.person.delete",
        entityType: "showcase_person",
        entityId: String(personId),
        before: { name: person.name },
      });
      return json({ ok: true, id: personId });
    }
  }

  // ---- 作品 ------------------------------------------------------------
  const personItemsMatch = url.pathname.match(/^\/api\/admin\/showcase\/persons\/(\d+)\/items$/);
  if (request.method === "POST" && personItemsMatch) {
    const personId = Number(personItemsMatch[1]);
    const person = await getShowcasePersonById(db, personId);
    if (!person) return fail(404, "not_found", "展示人物不存在");
    if (person.items.length >= 24) return fail(400, "validation_failed", "每个人物最多 24 个作品");
    const parsed = normalizeShowcaseItemInput(body, { creating: true });
    if ("error" in parsed) return fail(400, "validation_failed", parsed.error);
    const value = parsed.value;
    if (!(await mediaAssetsExist(env, [value.coverMediaId, value.mediaAssetId]))) {
      return fail(400, "validation_failed", "引用的封面图或作品文件不存在，请重新上传");
    }
    const id = await createShowcaseItem(db, {
      personId,
      title: value.title!,
      description: value.description ?? null,
      kind: value.kind ?? "other",
      coverMediaId: value.coverMediaId ?? null,
      coverUrl: value.coverUrl ?? null,
      mediaAssetId: value.mediaAssetId ?? null,
      url: value.url ?? null,
      featured: value.featured ?? false,
      sortOrder: value.sortOrder ?? person.items.length,
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "showcase.item.create",
      entityType: "showcase_item",
      entityId: String(id),
      after: { personId, title: value.title },
    });
    const updated = await getShowcasePersonById(db, personId);
    return Response.json(
      { ok: true, person: updated ? toAdminShowcasePerson(updated) : null },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const itemMatch = url.pathname.match(/^\/api\/admin\/showcase\/items\/(\d+)$/);
  if (itemMatch) {
    const itemId = Number(itemMatch[1]);
    const item = await getShowcaseItemById(db, itemId);
    if (!item) return fail(404, "not_found", "作品不存在");
    if (request.method === "PATCH" || request.method === "POST") {
      const parsed = normalizeShowcaseItemInput(body, { creating: false });
      if ("error" in parsed) return fail(400, "validation_failed", parsed.error);
      const value = parsed.value;
      if (!(await mediaAssetsExist(env, [value.coverMediaId, value.mediaAssetId]))) {
        return fail(400, "validation_failed", "引用的封面图或作品文件不存在，请重新上传");
      }
      await updateShowcaseItem(db, itemId, value);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "showcase.item.update",
        entityType: "showcase_item",
        entityId: String(itemId),
        after: { fields: Object.keys(value) },
      });
      const person = await getShowcasePersonById(db, item.personId);
      return json({ ok: true, person: person ? toAdminShowcasePerson(person) : null });
    }
    if (request.method === "DELETE") {
      await softDeleteShowcaseItem(db, itemId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "showcase.item.delete",
        entityType: "showcase_item",
        entityId: String(itemId),
        before: { title: item.title },
      });
      const person = await getShowcasePersonById(db, item.personId);
      return json({ ok: true, person: person ? toAdminShowcasePerson(person) : null });
    }
  }

  return null;
}
