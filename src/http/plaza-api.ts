import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import {
  createPlazaPost,
  isPublishedPlazaImage,
  listPlazaPosts,
  listPlazaTopics,
} from "../db/repositories/plaza-post.repository";
import { createPlazaComment, listPlazaComments } from "../db/repositories/plaza-comment.repository";
import { getTaskRunById } from "../db/repositories/task-run.repository";
import { listTaskPacks } from "../db/repositories/task-pack.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { mirrorPlazaPostToChannel } from "../services/plaza-channel.service";
import { notifyPostAuthorOfComment } from "../services/plaza-notify.service";
import { buildTrialShare } from "../services/trial-share.service";
import { isPlazaImageAsset, plazaImageUrl, storePlazaPostImage } from "../services/plaza-media.service";
import { PLAZA_TOPIC_MAX_LENGTH, resolvePlazaTopic } from "../services/plaza-topic.service";
import { checkRateLimit } from "../services/rate-limit.service";
import { evaluateAchievements, serializeUnlockedAchievements } from "../services/achievement.service";
import { loadSystemSettings } from "../services/system-settings.service";
import { resolveSubmissionBotUrl } from "../services/contact-links.service";
import {
  getPublishedGalleryMedia,
  listProfileGalleryItems,
  getPublishedGalleryProfile,
  type ProfileGalleryItem,
} from "../services/profile-gallery.service";

/**
 * Public plaza API for the participant web app (/plaza): the published
 * the personal-profile feed, the tree-hole feed and anonymous/attributed posting.
 * Browsing is open; posting requires a Telegram identity and is rate limited.
 */

function sanitizePaging(url: URL): { limit: number; offset: number } {
  const rawOffset = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(30, Math.max(1, Math.floor(rawLimit))) : 10;
  return { limit, offset: Math.min(offset, 10_000) };
}

export async function handlePlazaApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/plaza/")) return null;

  if (request.method === "GET" && url.pathname === "/api/plaza/posts") {
    const { limit, offset } = sanitizePaging(url);
    // 话题筛选：非法/超长的值当作「没有筛选」，而不是报错——筛选条是公开 UI。
    const topic = resolvePlazaTopic("", url.searchParams.get("topic"));
    const { items, total } = await listPlazaPosts(env.DB, { limit, offset, view: "published", topic });
    return json({
      items: items.map((item) => ({
        id: item.id,
        content: item.content,
        kind: item.kind,
        payload: item.payload,
        imageUrl: plazaImageUrl(item.imageAssetId),
        topic: item.topic,
        anonymous: item.anonymous,
        status: item.status,
        createdAt: item.createdAt,
        commentCount: item.commentCount,
        // The public feed exposes a display name only: the numeric Telegram id
        // is an internal identifier and has no business on a public page.
        owner:
          item.anonymous || !item.owner
            ? null
            : {
                username: item.owner.username,
                firstName: item.owner.firstName,
              },
      })),
      total,
      limit,
      offset,
      topic,
    });
  }

  // 公开流的话题筛选条。
  if (request.method === "GET" && url.pathname === "/api/plaza/topics") {
    const topics = await listPlazaTopics(env.DB);
    return json({ topics });
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

  // Single profile detail for /plaza/profile/:id deep links. Published-only,
  // and restricted to the configured gallery survey like the feed is.
  const profileDetailMatch = url.pathname.match(/^\/api\/plaza\/profiles\/(\d+)$/);
  if (request.method === "GET" && profileDetailMatch) {
    const responseId = Number(profileDetailMatch[1]);
    const system = await loadSystemSettings(env.DB);
    const surveyId = Number(system.profileGallerySurveyId);
    if (!Number.isInteger(surveyId) || surveyId <= 0) return fail(404, "not_found", "个人资料不存在");
    const item = await getPublishedGalleryProfile(env.DB, responseId);
    if (!item || item.surveyId !== surveyId) return fail(404, "not_found", "个人资料不存在");
    return json({ profile: profileToPublicItem(item) });
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
    const body = (await request.json().catch(() => null)) as {
      content?: unknown;
      anonymous?: unknown;
      imageAssetId?: unknown;
      topic?: unknown;
    } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    const imageAssetId =
      typeof body?.imageAssetId === "number" && Number.isInteger(body.imageAssetId) && body.imageAssetId > 0
        ? body.imageAssetId
        : null;
    if (imageAssetId !== null) {
      // 图片必须是「刚上传、还没被任何帖子用掉」的树洞图：否则一个已知的 asset id
      // 就能被挂到别人的帖子上（media_assets 没有上传者列，这是能做到的最强校验）。
      // 树洞图 = response scope + media:plaza: 前缀（见 plaza-media.service.ts：
      // D1 上没法重建 media_assets 来加新 scope）。
      const usable = await env.DB.prepare(
        `SELECT 1 AS found FROM media_assets m
          WHERE m.id = ? AND m.asset_scope = 'response' AND m.storage_key LIKE 'media:plaza:%'
            AND NOT EXISTS (SELECT 1 FROM plaza_posts p WHERE p.image_asset_id = m.id)
          LIMIT 1`,
      )
        .bind(imageAssetId)
        .first<{ found: number }>();
      if (!usable) return fail(400, "invalid_image", "配图无效，请重新上传");
    }
    // 带图时允许纯图片（0 字），不带图仍然要求 5-500 字正文。
    if (imageAssetId === null && (content.length < 5 || content.length > 500)) {
      return fail(400, "invalid_content", "树洞内容需要 5-500 个字");
    }
    if (content.length > 500) {
      return fail(400, "invalid_content", "树洞内容不能超过 500 个字");
    }
    const topic = resolvePlazaTopic(content, body?.topic);
    if (topic && topic.length > PLAZA_TOPIC_MAX_LENGTH) {
      return fail(400, "invalid_topic", `话题不能超过 ${PLAZA_TOPIC_MAX_LENGTH} 个字`);
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
      imageAssetId,
      topic,
    });
    let authorLabel: string | null = null;
    if (!post.anonymous) {
      const owner = await env.DB.prepare("SELECT username, first_name FROM users WHERE id = ? LIMIT 1")
        .bind(participant.dbUserId)
        .first<{ username: string | null; first_name: string | null }>();
      authorLabel = owner?.username ? `@${owner.username}` : (owner?.first_name ?? null);
    }
    // 纯图片帖没有正文：频道镜像给一句占位，否则会推一条空消息。
    await mirrorPlazaPostToChannel(env, content || "🖼 （图片投稿）", authorLabel);
    const newAchievements = serializeUnlockedAchievements(
      await evaluateAchievements(env.DB, {
        participantHash: participant.participantHash,
        userId: participant.dbUserId ?? null,
      }),
    );
    return json(
      {
        post: {
          id: post.id,
          createdAt: post.createdAt,
          imageUrl: plazaImageUrl(post.imageAssetId),
          topic: post.topic,
        },
        newAchievements,
      },
      201,
    );
  }

  // 树洞配图上传（0068）：只有 Telegram 身份能传，限频与发帖分开计算。
  if (request.method === "POST" && url.pathname === "/api/plaza/posts/media") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (participant.kind !== "telegram" || !participant.dbUserId) {
      return fail(403, "identity_required", "请从 Telegram 机器人打开广场后再上传图片");
    }
    if (!env.CACHE) return fail(503, "unavailable", "当前部署未启用图片投稿");
    const limit = await checkRateLimit(env.CACHE, "plaza-media", String(participant.dbUserId), 15, 3600);
    if (!limit.allowed) {
      return Response.json(
        { code: "rate_limited", message: `上传太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return fail(400, "invalid_upload", "缺少 file 字段");
    const stored = await storePlazaPostImage({ DB: env.DB, MEDIA_KV: env.MEDIA_KV }, file);
    if ("error" in stored) return fail(400, "invalid_upload", stored.error);
    return json(
      {
        mediaAssetId: stored.asset.id,
        url: plazaImageUrl(stored.asset.id),
      },
      201,
    );
  }

  // 树洞配图读取：只认发布中的帖子上的图片，下架即 404（与资料卡图片同一授权边界）。
  const plazaMediaMatch = url.pathname.match(/^\/api\/plaza\/media\/(\d+)$/);
  if (request.method === "GET" && plazaMediaMatch) {
    const mediaAssetId = Number(plazaMediaMatch[1]);
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset || !isPlazaImageAsset(asset)) return fail(404, "not_found", "图片不存在");
    if (!(await isPublishedPlazaImage(env.DB, mediaAssetId))) return fail(404, "not_found", "图片不存在");
    const response = await buildMediaResponse(env, asset);
    if (!response) return fail(410, "gone", "图片已被清理");
    response.headers.set("Cache-Control", "public, max-age=600");
    return response;
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
        // Anonymous comments carry no owner at all; attributed ones still only
        // expose the display name the UI renders.
        owner:
          comment.anonymous || !comment.owner
            ? null
            : { username: comment.owner.username, firstName: comment.owner.firstName },
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
      "SELECT id, user_id authorUserId FROM plaza_posts WHERE id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1",
    )
      .bind(postId)
      .first<{ id: number; authorUserId: number }>();
    if (!post) return fail(404, "not_found", "树洞内容不存在");
    const body = (await request.json().catch(() => null)) as { content?: unknown; anonymous?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (content.length < 1 || content.length > 300) {
      return fail(400, "invalid_content", "评论需要 1-300 个字");
    }
    // Anonymous by default: the plaza promises it, and the composer toggle can
    // only opt in to attribution explicitly.
    const commentAnonymous = body?.anonymous !== false;
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
      anonymous: commentAnonymous,
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
    // The optimistic UI appends this payload verbatim: an attributed comment
    // must carry the commenter's real display name, not a placeholder.
    let commentOwner: { username: string | null; firstName: string | null } | null = null;
    if (!commentAnonymous && participant.dbUserId) {
      const commenter = await env.DB.prepare("SELECT username, first_name FROM users WHERE id = ? LIMIT 1")
        .bind(participant.dbUserId)
        .first<{ username: string | null; first_name: string | null }>();
      commentOwner = commenter ? { username: commenter.username, firstName: commenter.first_name } : null;
    }
    const newAchievements = serializeUnlockedAchievements(
      await evaluateAchievements(env.DB, {
        participantHash: participant.participantHash,
        userId: participant.dbUserId ?? null,
      }),
    );
    return json(
      {
        comment: {
          id: comment.id,
          postId: comment.postId,
          content: comment.content,
          createdAt: comment.createdAt,
          owner: commentAnonymous || !commentOwner ? null : commentOwner,
        },
        newAchievements,
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
