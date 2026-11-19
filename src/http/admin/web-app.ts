import {
  createWebApp,
  deleteWebApp,
  getWebAppById,
  listWebApps,
  normalizeAllowedDomains,
  normalizeHttpsUrl,
  normalizeOpenMode,
  reorderWebApps,
  updateWebApp,
  webAppUrlHost,
  webAppUrlMatchesAllowedDomains,
  type WebAppOpenMode,
  type WebAppRecord,
} from "../../db/repositories/web-app.repository";
import type { WriteContext } from "./helpers";
import { writeAudit } from "./helpers";
import type { Env } from "../../index";

/**
 * 网页应用的写侧（0104，P0 批次 M2；打开收口 P0 批次 M4）。读侧在 read.ts：
 * `GET /api/admin/web-apps`。
 *
 * 权限：应用中心是全站运营配置，增删改只给管理员（write.ts:727 的 task-pack
 * fail 403 同款先例）。每次写操作 writeAudit（web_app.create/update/reorder/
 * delete），AuditPage 无 action 白名单、web_app.* 自动可见。
 *
 * URL 校验（M4 收口，整条入口链最后的安全敏感面——误放行=任意跳转）：
 * ① 必须能被 URL 解析且协议为 https://（normalizeHttpsUrl）；
 * ② open_mode 只接受 'miniapp'|'browser'（normalizeOpenModeSafe，非法一律 400，
 *   不静默回退——保存面宁可拒绝，读取面才宽容）；
 * ③ url 的 host 必须命中 allowed_domains（匹配策略唯一权威见仓储
 *   ALLOWED_DOMAIN_WILDCARD_PREFIX 注释：显式主机名精确匹配，`*.b` 通配任意
 *   深度子域且不含裸域）；allowed_domains 未配置/传空时**强制与 url 同域**
 *   落库（写入 [host(url)]，而不是拒绝保存——拒绝会让空配置永远不可用，
 *   同域强制让「未配置」永远安全且自洽），保存后的行永远带显式非空
 *   白名单，公开 API 与前端二次校验（admin/src/survey/web-app-open.ts）
 *   都依赖这一不变量。校验拒绝不写审计（400 发生在任何写之前，审计日志
 *   只记录真正落库的变更，与 categories.ts 先例一致）。
 */
export async function handleAdminWebAppWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // POST /api/admin/web-apps/reorder — 全量重排序。必须在数字 ID 匹配之前：
  // reorder 不是数字。
  if (request.method === "POST" && url.pathname === "/api/admin/web-apps/reorder") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理网页应用");
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    if (!ids.length) return fail(400, "validation_failed", "请提供要排序的网页应用列表");
    if (new Set(ids).size !== ids.length) return fail(400, "validation_failed", "排序列表存在重复项");
    // 每个提交的 id 都必须真实存在：列表之外的多余 id 会静默丢排序位。
    const known = await listWebApps(db);
    const knownIds = new Set(known.map((app) => app.id));
    if (ids.some((id) => !knownIds.has(id))) return fail(400, "validation_failed", "存在不存在的网页应用");
    const changed = await reorderWebApps(db, ids);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "web_app.reorder",
      entityType: "web_app",
      entityId: null,
      after: { ids, changed },
    });
    return json({ ok: true, changed });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/web-apps") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理网页应用");
    const parsed = parseWebAppBody(body);
    if ("error" in parsed) return fail(400, parsed.code, parsed.error);
    const created = await createWebApp(db, parsed.value);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "web_app.create",
      entityType: "web_app",
      entityId: String(created.id),
      after: created,
    });
    return json(created);
  }

  const webAppMatch = url.pathname.match(/^\/api\/admin\/web-apps\/(\d+)$/);
  if (!webAppMatch) return null;
  if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理网页应用");
  const webAppId = Number(webAppMatch[1]);

  if (request.method === "PATCH" || request.method === "PUT") {
    const before = await getWebAppById(db, webAppId);
    if (!before) return fail(404, "not_found", "网页应用不存在");
    const parsed = parseWebAppBody(body, { partial: true, existing: before });
    if ("error" in parsed) return fail(400, parsed.code, parsed.error);
    const updated = await updateWebApp(db, webAppId, parsed.value);
    if (!updated) return fail(404, "not_found", "网页应用不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "web_app.update",
      entityType: "web_app",
      entityId: String(webAppId),
      before,
      after: updated,
    });
    return json(updated);
  }

  if (request.method === "DELETE") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理网页应用");
    const before = await getWebAppById(db, webAppId);
    if (!before) return fail(404, "not_found", "网页应用不存在");
    // web_apps 无级联子表（0104 文件头）：硬删，痕迹留在审计。
    const deleted = await deleteWebApp(db, webAppId);
    if (!deleted) return fail(404, "not_found", "网页应用不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "web_app.delete",
      entityType: "web_app",
      entityId: String(webAppId),
      before,
    });
    return json({ ok: true, id: webAppId });
  }

  return null;
}

/**
 * 写请求体归一化 + M4 白名单收口：name/url 必填（https 强校验）；open_mode
 * 枚举校验（非法一律 400，不回退）；allowedDomains 收字符串数组。partial=true
 * 时（PATCH/PUT）全部字段可选、未传字段不覆盖——但 url/allowedDomains 的
 * 白名单校验按「本次保存后的最终形态」合成执行（见函数尾部的收口块），
 * existing 传 PATCH 前的存量行。
 */
function parseWebAppBody(
  body: Record<string, unknown>,
  options: { partial?: boolean; existing?: WebAppRecord | null } = {},
): { error: string; code: string } | { value: Parameters<typeof createWebApp>[1] } {
  const partial = options.partial ?? false;
  const partialValue = partial
    ? ({} as Partial<Parameters<typeof createWebApp>[1]> & { allowedDomains?: string[] | null })
    : ({ allowedDomains: null } as Parameters<typeof createWebApp>[1]);
  const value = partialValue as Parameters<typeof createWebApp>[1];

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { code: "validation_failed", error: "网页应用名称不能为空" };
    value.name = name.slice(0, 60);
  }
  if (body.url !== undefined || !partial) {
    const normalizedUrl = normalizeHttpsUrl(body.url);
    if (!normalizedUrl) return { code: "validation_failed", error: "链接必须是以 https:// 开头的合法网址" };
    value.url = normalizedUrl;
  }
  if (body.description !== undefined) {
    const description = typeof body.description === "string" ? body.description.trim() : "";
    value.description = description ? description.slice(0, 300) : null;
  }
  if (body.iconUrl !== undefined) {
    // 图标是可选的展示资源：非空时同样必须 https（公开页面会直接 <img> 引用）。
    const rawIcon = typeof body.iconUrl === "string" ? body.iconUrl.trim() : "";
    if (!rawIcon) {
      value.iconUrl = null;
    } else {
      const normalizedIcon = normalizeHttpsUrl(rawIcon);
      if (!normalizedIcon) return { code: "validation_failed", error: "图标地址必须是以 https:// 开头的合法网址" };
      value.iconUrl = normalizedIcon;
    }
  }
  if (body.category !== undefined) {
    const category = typeof body.category === "string" ? body.category.trim() : "";
    value.category = category ? category.slice(0, 30) : null;
  }
  if (body.enabled !== undefined) {
    value.enabled = body.enabled !== false;
  }
  if (body.openMode !== undefined) {
    const openMode: WebAppOpenMode | null = normalizeOpenModeSafe(body.openMode);
    if (!openMode) return { code: "validation_failed", error: "打开方式只能是 miniapp 或 browser" };
    value.openMode = openMode;
  }
  if (body.allowedDomains !== undefined) {
    const domains = body.allowedDomains;
    if (!Array.isArray(domains) || domains.some((item) => typeof item !== "string")) {
      return { code: "validation_failed", error: "域名白名单必须是字符串数组" };
    }
    // 空数组与 null 同义（清空 → 下方收口块强制与 url 同域）；非法主机名
    // 条目由仓储归一化丢弃。
    value.allowedDomains = domains.filter((item) => typeof item === "string") as string[];
  }

  // —— M4 打开收口（安全敏感面，唯一放行点）——
  // PATCH 下 url 与 allowedDomains 可能只传一个：先合成「本次保存后的最终
  // 形态」再校验，校验不过整单 400（不会出现「url 换域了、白名单还在原地」
  // 或反之的中间态落库）。
  const effectiveUrl = value.url ?? options.existing?.url;
  if (!effectiveUrl) return { code: "validation_failed", error: "链接必须是以 https:// 开头的合法网址" };
  const urlHost = webAppUrlHost(effectiveUrl);
  if (!urlHost) return { code: "validation_failed", error: "无法解析链接的主机名" };
  // 显式传入（含传空数组=清空）→ 用归一化后的传入值；未传 → 沿用存量；
  // 都没有（首次保存且未配置）→ 强制与 url 同域（策略见文件头注释 ③）。
  const effectiveDomains =
    body.allowedDomains !== undefined
      ? normalizeAllowedDomains(value.allowedDomains)
      : (options.existing?.allowedDomains ?? null);
  // 强制同域落库：保存后的行永远带显式非空白名单，公开 API 与前端二次
  // 校验（admin/src/survey/web-app-open.ts）都依赖这一不变量。
  const enforcedDomains = effectiveDomains ?? [urlHost];
  if (!webAppUrlMatchesAllowedDomains(effectiveUrl, enforcedDomains)) {
    return {
      code: "validation_failed",
      error: "链接域名不在白名单内：host 必须命中 allowed_domains（显式主机名或 *.通配子域）",
    };
  }
  value.allowedDomains = enforcedDomains;
  return { value };
}

/** open_mode 的严格入口归一化（管理端写路径）：只认 'miniapp'|'browser'，否则 null。 */
function normalizeOpenModeSafe(value: unknown): WebAppOpenMode | null {
  if (value === "miniapp" || value === "browser") return value;
  return null;
}
