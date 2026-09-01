import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import { getIdentityProfileOwners, listIdentityProfiles } from "../db/repositories/identity-card.repository";
import { createPlazaPost, listPlazaPosts } from "../db/repositories/plaza-post.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { mirrorPlazaPostToChannel } from "../services/plaza-channel.service";
import { checkRateLimit } from "../services/rate-limit.service";

/**
 * Public plaza API for the participant web app (/plaza): the published
 * identity-card feed, the tree-hole feed and anonymous/attributed posting.
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

  if (request.method === "GET" && url.pathname === "/api/plaza/cards") {
    const { limit, offset } = sanitizePaging(url);
    const { items, total } = await listIdentityProfiles(env.DB, { limit, offset, view: "published" });
    const owners = await getIdentityProfileOwners(
      env.DB,
      items.map((item) => item.userId),
    );
    return json({
      items: items.map((item) => {
        const owner = owners.get(item.userId);
        return {
          id: item.id,
          name: item.name,
          identityLabel: item.identityLabel,
          nickname: item.nickname,
          imageUrl: `/api/plaza/cards/${item.id}/image`,
          publishedAt: item.galleryPublishedAt ?? item.createdAt,
          owner: owner ? { username: owner.username, firstName: owner.firstName } : null,
        };
      }),
      total,
      limit,
      offset,
    });
  }

  const cardImageMatch = url.pathname.match(/^\/api\/plaza\/cards\/(\d+)\/image$/);
  if (request.method === "GET" && cardImageMatch) {
    const row = await env.DB.prepare(
      `SELECT card_asset_id FROM identity_profiles WHERE id = ? AND gallery_published = 1 LIMIT 1`,
    )
      .bind(Number(cardImageMatch[1]))
      .first<{ card_asset_id: number | null }>();
    if (!row?.card_asset_id) return fail(404, "not_found", "卡片不存在或未发布");
    const asset = await getMediaAssetById(env.DB, row.card_asset_id);
    if (!asset) return fail(404, "not_found", "卡片图片不存在");
    const response = await buildMediaResponse(env, asset);
    if (!response) return fail(410, "gone", "卡片图片已被清理");
    response.headers.set("Cache-Control", "public, max-age=600");
    return response;
  }

  if (request.method === "GET" && url.pathname === "/api/plaza/posts") {
    const { limit, offset } = sanitizePaging(url);
    const { items, total } = await listPlazaPosts(env.DB, { limit, offset, view: "published" });
    return json({ items, total, limit, offset });
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

  return fail(404, "not_found", "接口不存在");
}
