/**
 * 应用中心「网页导航」区的外链数据（2026-11-20 P0 加固批次 M1；打开字段
 * 2026-11-20 P0 加固批次 M4）。
 *
 * 数据接口 GET /api/web-apps 由 M2 批次落地；接口 404、返回空数据、形状对
 * 不上或网络层任何失败，一律收敛为空列表——应用中心只渲染空态，绝不能让
 * 整个屏报错或白屏。形状收敛抽成纯函数（normalizeWebAppsResponse）便于
 * 单测；fetchWebApps 只负责「失败也不抛出」这一层兜底。
 *
 * M4：openMode / allowedDomains 是打开方式与域名白名单（打开逻辑在
 * web-app-open.ts）。字段缺失（旧形状响应）时收敛为最保守默认：
 * openMode='browser'（外跳）、allowedDomains=[]（前端把空白名单视为数据
 * 异常，打开时拦截提示，见 isWebAppUrlAllowed 注释）。
 */

export type WebAppLinkOpenMode = "miniapp" | "browser";

export interface WebAppLink {
  id: number;
  name: string;
  url: string;
  description: string | null;
  /** 打开方式：miniapp=Telegram 内经 openLink 进 Mini App；browser=外跳。 */
  openMode: WebAppLinkOpenMode;
  /** 打开白名单（服务端保存时已强制非空）；空数组=数据异常，前端拦截。 */
  allowedDomains: string[];
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
    const allowedDomains = Array.isArray(record.allowedDomains)
      ? record.allowedDomains.filter((item): item is string => typeof item === "string")
      : [];
    links.push({
      id: typeof record.id === "number" ? record.id : links.length,
      name,
      url,
      description: typeof record.description === "string" ? record.description : null,
      openMode: record.openMode === "miniapp" ? "miniapp" : "browser",
      allowedDomains,
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
