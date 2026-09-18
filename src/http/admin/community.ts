import { setPlazaCommentStatus } from "../../db/repositories/plaza-comment.repository";
import { setPlazaPostStatus } from "../../db/repositories/plaza-post.repository";
import { loadSystemSettings } from "../../services/system-settings.service";
import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";
import { publishProfileResponse, unpublishProfileResponse } from "../../services/profile-gallery.service";

export async function handleAdminCommunityWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  if (request.method === "POST" && url.pathname === "/api/admin/profile-gallery/publish") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理个人画廊");
    const responseId = Number(body.id);
    const published = body.published === true;
    const coverMediaId = typeof body.coverMediaId === "number" ? body.coverMediaId : undefined;
    const visibleQuestionIds = Array.isArray(body.visibleQuestionIds)
      ? body.visibleQuestionIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)
      : undefined;
    if (!Number.isInteger(responseId) || responseId <= 0) {
      return fail(400, "validation_failed", "无效的答卷编号");
    }
    const responseRow = await db
      .prepare("SELECT id, survey_id surveyId, status FROM survey_responses WHERE id = ? LIMIT 1")
      .bind(responseId)
      .first<{ id: number; surveyId: number; status: string }>();
    if (!responseRow) return fail(404, "not_found", "答卷不存在");
    if (responseRow.status !== "completed") {
      return fail(409, "response_not_completed", "只有已提交的答卷可以进入个人画廊");
    }
    const system = await loadSystemSettings(db);
    if (Number(system.profileGallerySurveyId) !== responseRow.surveyId) {
      return fail(400, "profile_gallery_not_configured", "该问卷未启用个人画廊");
    }
    if (published) {
      await publishProfileResponse({ DB: db, MEDIA_KV: env.MEDIA_KV }, responseId, {
        ...(coverMediaId !== undefined ? { coverMediaId } : {}),
        ...(visibleQuestionIds ? { visibleQuestionIds } : {}),
      });
    } else {
      await unpublishProfileResponse(db, responseId);
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: published ? "profile_gallery.publish" : "profile_gallery.unpublish",
      entityType: "survey_response",
      entityId: String(responseId),
      after: { published },
    });
    return json({ ok: true, id: responseId, published });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/plaza/posts/status") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理树洞内容");
    const postId = Number(body.id);
    const status = body.status === "removed" ? "removed" : "published";
    if (!Number.isInteger(postId) || postId <= 0) return fail(400, "validation_failed", "无效的树洞内容编号");
    const updated = await setPlazaPostStatus(env.DB, postId, status);
    if (!updated) return fail(404, "not_found", "树洞内容不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: status === "removed" ? "plaza_post.remove" : "plaza_post.restore",
      entityType: "plaza_post",
      entityId: String(postId),
      after: { status },
    });
    return json({ ok: true, post: { id: updated.id, status: updated.status } });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/plaza/comments/status") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理树洞评论");
    const commentId = Number(body.id);
    const status = body.status === "removed" ? "removed" : "published";
    if (!Number.isInteger(commentId) || commentId <= 0) return fail(400, "validation_failed", "无效的评论编号");
    const updated = await setPlazaCommentStatus(db, commentId, status);
    if (!updated) return fail(404, "not_found", "评论不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: status === "removed" ? "plaza_comment.remove" : "plaza_comment.restore",
      entityType: "plaza_comment",
      entityId: String(commentId),
      after: { status },
    });
    return json({ ok: true, comment: { id: updated.id, postId: updated.postId, status: updated.status } });
  }

  return null;
}
