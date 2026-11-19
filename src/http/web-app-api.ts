import type { Env } from "../index";
import { fail, json } from "./api-response";
import { listWebApps } from "../db/repositories/web-app.repository";

/**
 * 应用中心「网页导航」的公开只读 API（0104，P0 批次 M2）。
 *
 * 端点只有一个：GET /api/web-apps——启用项按 sort_order 升序返回，形状
 * (name/description/iconUrl/category/openMode/allowedDomains) 打开规则本就
 * 公开，随列表下发。消费方：M1 的应用中心屏（admin/src/survey/web-apps.ts
 * 对 404/坏形状收敛为空态，所以这里的形状演进向后兼容即可）与 M3/M4。
 *
 * 只读是刻意的：没有任何写端点，写入只走管理端 /api/admin/web-apps*
 * （src/http/admin/web-app.ts，鉴权 + 审计）。非 GET 在这里显式 405，
 * 不落回后续路由兜底。
 */
export async function handleWebAppApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/web-apps") return null;

  if (request.method !== "GET") {
    return fail(405, "method_not_allowed", "该接口只读，仅支持 GET");
  }

  const apps = await listWebApps(env.DB, { enabledOnly: true });
  return json({
    items: apps.map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      url: app.url,
      iconUrl: app.iconUrl,
      category: app.category,
      openMode: app.openMode,
      allowedDomains: app.allowedDomains ?? [],
    })),
  });
}
