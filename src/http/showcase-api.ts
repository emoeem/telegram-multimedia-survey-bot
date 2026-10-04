import type { Env } from "../index";
import { fail, json } from "./survey-api";
import {
  getPublishedShowcaseItemById,
  getPublishedShowcasePersonIdForAsset,
  listShowcasePersons,
} from "../db/repositories/showcase.repository";
import { toPublicShowcaseItem, toPublicShowcasePerson } from "../services/showcase.service";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";

/**
 * Reads an integer query param; returns null when absent, blank or non-numeric
 * so callers can distinguish "not provided" (apply the default) from a value.
 */
function readIntParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

/**
 * Public showcase API (/api/showcase) powering the immersive mobile gallery.
 *
 * Reading is open — it is a public exhibition page. Nothing here exposes owner
 * identities: the public serialization drops owner/audit fields, and artwork is
 * served only while a PUBLISHED person references it, so unpublishing withdraws
 * the images without deleting them.
 */
export async function handleShowcaseApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/showcase" && !url.pathname.startsWith("/api/showcase/")) return null;

  if (request.method === "GET" && url.pathname === "/api/showcase") {
    // searchParams.get() returns null when the param is absent, and Number(null)
    // is 0 — without the explicit null check the default page size collapses to 1.
    const rawLimit = readIntParam(url, "limit");
    const rawOffset = readIntParam(url, "offset");
    const limit = rawLimit !== null ? Math.min(200, Math.max(1, rawLimit)) : 100;
    const offset = rawOffset !== null ? Math.max(0, rawOffset) : 0;
    const { persons, total } = await listShowcasePersons(env.DB, { publishedOnly: true, limit, offset });
    return json({ items: persons.map((person) => toPublicShowcasePerson(person)), total, limit, offset });
  }

  // 阅读全文：feed 只带预览，文字作品（文章/小说）在这里取完整正文。
  const itemMatch = url.pathname.match(/^\/api\/showcase\/items\/(\d+)$/);
  if (request.method === "GET" && itemMatch) {
    const itemId = Number(itemMatch[1]);
    const found = await getPublishedShowcaseItemById(env.DB, itemId);
    if (!found) return fail(404, "not_found", "作品不存在");
    return json({ item: { ...toPublicShowcaseItem(found.item, { full: true }), personId: found.personId } });
  }

  const mediaMatch = url.pathname.match(/^\/api\/showcase\/media\/(\d+)$/);
  if (request.method === "GET" && mediaMatch) {
    const mediaAssetId = Number(mediaMatch[1]);
    const ownerPersonId = await getPublishedShowcasePersonIdForAsset(env.DB, mediaAssetId);
    if (ownerPersonId === null) return fail(404, "not_found", "展示图片不存在");
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset) return fail(404, "not_found", "展示图片不存在");
    const response = await buildMediaResponse(env, asset);
    if (!response) return fail(410, "gone", "展示图片已被清理");
    // Artwork is immutable per media asset, and the visibility check already
    // ran: a short public cache keeps a swipe-heavy gallery off KV.
    response.headers.set("Cache-Control", "public, max-age=3600");
    return response;
  }

  return fail(404, "not_found", "接口不存在");
}
