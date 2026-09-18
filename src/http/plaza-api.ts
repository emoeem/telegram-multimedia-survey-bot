import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import { createPlazaPost, listPlazaPosts } from "../db/repositories/plaza-post.repository";
import { createPlazaComment, listPlazaComments } from "../db/repositories/plaza-comment.repository";
import { getTaskRunById } from "../db/repositories/task-run.repository";
import { listTaskPacks } from "../db/repositories/task-pack.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { mirrorPlazaPostToChannel } from "../services/plaza-channel.service";
import { notifyPostAuthorOfComment } from "../services/plaza-notify.service";
import { buildTrialShare } from "../services/trial-share.service";
import { checkRateLimit } from "../services/rate-limit.service";
import { loadSystemSettings } from "../services/system-settings.service";
import { resolveSubmissionBotUrl } from "../services/contact-links.service";
import {
  getPublishedGalleryMedia,
  listProfileGalleryItems,
  type ProfileGalleryItem,
} from "../services/profile-gallery.service";

/**
 * Public plaza API for the participant web app (/plaza): the published
 * the personal-profile feed, the tree-hole feed and anonymous/attributed posting.
 * Browsing is open; posting requires a Telegram identity and is rate limited.
 */

function sanitizePaging(url: URL): { limit: number; offset: number } {
  return {
    limit: Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 10)),
    offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
  };
}

export async function handlePlazaApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/plaza/")) return null;

  if (request.method === "GET" && url.pathname === "/api/plaza/posts") {
    const { limit, offset } = sanitizePaging(url);
    const { items, total } = await listPlazaPosts(env.DB, { limit, offset, view: "published" });
    return json({
      items: items.map((item) => ({
        id: item.id,
        content: item.content,
        kind: item.kind,
        payload: item.payload,
        anonymous: item.anonymous,
        status: item.status,
        createdAt: item.createdAt,
        commentCount: item.commentCount,
        owner: item.anonymous ? null : item.owner,
      })),
      total,
      limit,
      offset,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/plaza/profiles") {
    const { limit, offset } = sanitizePaging(url);
    const system = await loadSystemSettings(env.DB);
    const surveyId = Number(system.profileGallerySurveyId);
    if (!Number.isInteger(surveyId) || surveyId <= 0) {
      return json({
        items: [],
        total: 0,
        limit,
        offset,
        surveyId: null,
        communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
        submissionBotUrl: resolveSubmissionBotUrl(env),
      });
    }
    const { items, total } = await listProfileGalleryItems(env.DB, {
      surveyId,
      publishedOnly: true,
      limit,
      offset,
    });
    return json({
      items: items.map(profileToPublicItem),
      total,
      limit,
      offset,
      surveyId,
      communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
      submissionBotUrl: resolveSubmissionBotUrl(env),
    });
  }

  const profileMediaMatch = url.pathname.match(/^\/api\/plaza\/profiles\/(\d+)\/media\/(\d+)$/);
  if (request.method === "GET" && profileMediaMatch) {
    const responseId = Number(profileMediaMatch[1]);
    const mediaAssetId = Number(profileMediaMatch[2]);
    const visible = await getPublishedGalleryMedia(env.DB, responseId, mediaAssetId);
    if (!visible) return fail(404, "not_found", "个人资料图片不存在");
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset) return fail(404, "not_found", "个人资料图片不存在");
    const response = await buildMediaResponse(env, asset);
    if (!response) return fail(410, "gone", "个人资料图片已被清理");
    response.headers.set("Cache-Control", "public, max-age=600");
    return response;
  }

  if (request.method === "POST" && url.pathname === "/api/plaza/posts") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (participant.kind !== "telegram" || !participant.dbUserId) {
      return fail(403, "identity_required", "请从 Telegram 机器人打开广场后再投稿");
    }
    const body = (await request.json().catch(() => null)) as { content?: unknown; anonymous?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (content.length < 5 || content.length > 500) {
      return fail(400, "invalid_content", "树洞内容需要 5-500 个字");
    }
    if (!env.CACHE) return fail(503, "unavailable", "当前部署未启用投稿功能");
    const limit = await checkRateLimit(env.CACHE, "plaza-post", String(participant.dbUserId), 5, 3600);
    if (!limit.allowed) {
      return Response.json(
        { code: "rate_limited", message: `发言太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const post = await createPlazaPost(env.DB, {
      userId: participant.dbUserId,
      content,
      anonymous: body?.anonymous !== false,
    });
    let authorLabel: string | null = null;
    if (!post.anonymous) {
      const owner = await env.DB.prepare("SELECT username, first_name FROM users WHERE id = ? LIMIT 1")
        .bind(participant.dbUserId)
        .first<{ username: string | null; first_name: string | null }>();
      authorLabel = owner?.username ? `@${owner.username}` : (owner?.first_name ?? null);
    }
    await mirrorPlazaPostToChannel(env, content, authorLabel);
    return json({ post: { id: post.id, createdAt: post.createdAt } }, 201);
  }

  const commentsMatch = url.pathname.match(/^\/api\/plaza\/posts\/(\d+)\/comments$/);
  if (request.method === "GET" && commentsMatch) {
    const postId = Number(commentsMatch[1]);
    const { limit, offset } = sanitizePaging(url);
    const { items, total } = await listPlazaComments(env.DB, postId, { limit, offset, view: "published" });
    return json({
      items: items.map((comment) => ({
        id: comment.id,
        postId: comment.postId,
        content: comment.content,
        createdAt: comment.createdAt,
        owner: comment.owner,
      })),
      total,
      limit,
      offset,
    });
  }

  if (request.method === "POST" && commentsMatch) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (participant.kind !== "telegram" || !participant.dbUserId) {
      return fail(403, "identity_required", "请从 Telegram 机器人打开广场后再评论");
    }
    const postId = Number(commentsMatch[1]);
    const post = await env.DB.prepare(
      "SELECT id, user_id authorUserId FROM plaza_posts WHERE id = ? AND status = 'published' LIMIT 1",
    )
      .bind(postId)
      .first<{ id: number; authorUserId: number }>();
    if (!post) return fail(404, "not_found", "树洞内容不存在");
    const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (content.length < 1 || content.length > 300) {
      return fail(400, "invalid_content", "评论需要 1-300 个字");
    }
    if (!env.CACHE) return fail(503, "unavailable", "当前部署未启用评论功能");
    const limit = await checkRateLimit(env.CACHE, "plaza-comment", String(participant.dbUserId), 20, 3600);
    if (!limit.allowed) {
      return Response.json(
        { code: "rate_limited", message: `评论太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const comment = await createPlazaComment(env.DB, {
      postId,
      userId: participant.dbUserId,
      content,
    });
    const author = await env.DB.prepare(
      "SELECT id, telegram_user_id, username, first_name FROM users WHERE id = ? LIMIT 1",
    )
      .bind(post.authorUserId)
      .first<{ id: number; telegram_user_id: number; username: string | null; first_name: string | null }>();
    if (author) {
      await notifyPostAuthorOfComment(env, {
        postId,
        authorUserId: author.id,
        authorTelegramUserId: Number(author.telegram_user_id),
        commenterTelegramUserId: participant.telegramUserId ?? 0,
        commentContent: content,
        origin: url.origin,
      });
    }
    return json(
      {
        comment: {
          id: comment.id,
          postId: comment.postId,
          content: comment.content,
          createdAt: comment.createdAt,
          owner: participant.telegramUserId
            ? {
                telegramUserId: participant.telegramUserId,
                username: null,
                firstName: null,
              }
            : null,
        },
      },
      201,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/plaza/trial-shares") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (participant.kind !== "telegram" || !participant.dbUserId) {
      return fail(403, "identity_required", "请从 Telegram 机器人打开后再晒进度（也可以直接复制结局文字）");
    }
    const body = (await request.json().catch(() => null)) as { runId?: unknown; anonymous?: unknown } | null;
    const runId = Number(body?.runId);
    if (!Number.isInteger(runId) || runId <= 0) return fail(400, "validation_failed", "无效的挑战记录");
    const run = await getTaskRunById(env.DB, runId);
    if (!run || run.participantHash !== participant.participantHash) {
      return fail(404, "not_found", "挑战记录不存在");
    }
    if (run.status !== "completed") {
      return fail(409, "not_completed", "只有通关（或护盾结算）的挑战可以晒进度");
    }
    const packs = await listTaskPacks(env.DB, {});
    const pack = packs.find((item) => item.id === run.packId);
    if (!pack) return fail(404, "not_found", "任务包不存在");
    const share = buildTrialShare({
      runId: run.id,
      packId: run.packId,
      packName: pack.name,
      persona: run.persona,
      mode: run.mode,
      startingFloor: run.startingFloor,
      maxFloor: run.maxFloor,
      score: run.score,
      completedTasks: run.completedTasks,
      skippedTasks: run.skippedTasks,
      maxScore: run.state.maxScore,
    });
    if (!env.CACHE) return fail(503, "unavailable", "当前部署未启用分享功能");
    const limit = await checkRateLimit(env.CACHE, "trial-share", String(participant.dbUserId), 3, 3600);
    if (!limit.allowed) {
      return Response.json(
        { code: "rate_limited", message: `分享太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const post = await createPlazaPost(env.DB, {
      userId: participant.dbUserId,
      content: share.content,
      anonymous: body?.anonymous !== false,
      kind: "trial",
      payload: share.payload as unknown as Record<string, unknown>,
    });
    await mirrorPlazaPostToChannel(env, share.content, null);
    return json({ post: { id: post.id, kind: post.kind, createdAt: post.createdAt } }, 201);
  }

  return fail(404, "not_found", "接口不存在");
}

function profileToPublicItem(item: ProfileGalleryItem) {
  return {
    id: item.responseId,
    surveyId: item.surveyId,
    owner: item.owner && item.showUsername ? { username: item.owner.username, firstName: item.owner.firstName } : null,
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    images: item.images.map((image) => ({
      mediaAssetId: image.mediaAssetId,
      url: `/api/plaza/profiles/${item.responseId}/media/${image.mediaAssetId}`,
    })),
    fields: item.fields,
  };
}
