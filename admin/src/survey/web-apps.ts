/**
 * 应用中心「网页导航」区的外链数据（2026-11-20 P0 加固批次 M1）。
 *
 * 数据接口 GET /api/web-apps 由 M2 批次落地；在此之前接口 404、返回空数据、
 * 形状对不上或网络层任何失败，一律收敛为空列表——应用中心只渲染空态，
 * 绝不能让整个屏报错或白屏。形状收敛抽成纯函数（normalizeWebAppsResponse）
 * 便于单测；fetchWebApps 只负责「失败也不抛出」这一层兜底。
 */

export interface WebAppLink {
  id: number;
  name: string;
  url: string;
  description: string | null;
}

/** 纯函数：把 M2 未定型的响应形状收敛成合法外链列表，只放行带 name+url 的条目。 */
export function normalizeWebAppsResponse(payload: unknown): WebAppLink[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : [];
  const links: WebAppLink[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    // 缺 name 或 url 的脏数据整条丢掉：宁可少一条，不能撑破整屏。
    if (!name || !url) continue;
    links.push({
      id: typeof record.id === "number" ? record.id : links.length,
      name,
      url,
      description: typeof record.description === "string" ? record.description : null,
    });
  }
  return links;
}

/** GET /api/web-apps：非 2xx（含 M2 落地前的 404）、坏 JSON、网络错误一律返回 []（空态）。 */
export async function fetchWebApps(): Promise<WebAppLink[]> {
  try {
    const response = await fetch("/api/web-apps");
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as unknown;
    return normalizeWebAppsResponse(body);
  } catch {
    return [];
  }
}
