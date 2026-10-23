/**
 * 后台的网页投稿审核接口 —— 把「管理员会话」换成「共享密钥」再转发给投稿机器人。
 *
 * 背景：网页投稿（`/submit`，不需要 Telegram 账号）原本只能在审核群里点按钮审。
 * 那条链路能用，但批量待审时得在群消息里一条条翻，而且邮箱、IP、命中的敏感词
 * 全挤在一条 4096 字的消息里。现在同一件事也能在后台做。
 *
 * 三层职责要分清，否则任何一层松动都会让整条链失效：
 *
 *   浏览器        只认本站会话（admin session cookie）。它永远拿不到
 *                 REVIEW_API_SECRET，也不需要知道投稿机器人存在。
 *   本站 Worker   `routeAdminApi` 已经解析出 `user` / `isAdmin`，这里再卡一次
 *                 isAdmin，然后带上密钥转发。
 *   投稿机器人    只认 `x-review-secret`（常量时间比较），并和转发来的调用方
 *                 一样不做任何信任假设 —— 它的 approve/reject 走的还是
 *                 `bot.approveSubmission`，和群里点按钮是同一套投稿级租约。
 *
 * 最后一点是这次合并的关键：**审核逻辑只有一份**。两边各写一遍的话，群里点
 * 通过、后台同时点通过，租约只挡得住同一侧的双击，跨端并发照样发两遍。
 */
import type { Env } from "../../index";

/** 本模块管辖的路径前缀。和 `/api/admin/submissions`（金币投稿）不冲突。 */
export const WEB_SUBMISSION_PREFIX = "/api/admin/web-submissions";

export function isWebSubmissionAdminPath(pathname: string): boolean {
  return pathname === WEB_SUBMISSION_PREFIX || pathname.startsWith(`${WEB_SUBMISSION_PREFIX}/`);
}

/** 投稿机器人源站：复用 `/api/submit/*` 那条代理的同一个配置。 */
function resolveBotOrigin(env: Env): string | null {
  const raw = (env.SUBMISSION_BOT_API_ORIGIN ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** 这些动作回二进制（附件字节），不能走下面「非 JSON 一律转错误」的分支。 */
const BINARY_ACTIONS = new Set(["/media"]);

interface UpstreamTarget {
  path: string;
  binary: boolean;
}

/** 本站路径 → 投稿机器人路径。`/list` → `/api/admin/review/list`。 */
function upstreamPath(pathname: string): UpstreamTarget | null {
  const suffix = pathname.slice(WEB_SUBMISSION_PREFIX.length);
  if (suffix === "" || suffix === "/") return null;
  /* 只放行已知动作。用白名单而不是把 suffix 直接拼过去：拼的话
   * `/api/admin/web-submissions/../../webhook/<secret>` 这种会打到别处。 */
  const allowed = new Set(["/list", "/detail", "/count", "/approve", "/reject", "/reply", "/media"]);
  if (!allowed.has(suffix)) return null;
  return { path: `/api/admin/review${suffix}`, binary: BINARY_ACTIONS.has(suffix) };
}

export interface WebSubmissionAdminContext {
  isAdmin: boolean;
  fail: (status: number, code: string, message: string) => Response;
  json: (body: unknown) => Response;
}

/**
 * 处理一次后台网页投稿审核请求。返回 null 表示「不是这条路径」。
 */
export async function handleWebSubmissionAdmin(
  request: Request,
  url: URL,
  env: Env,
  ctx: WebSubmissionAdminContext,
): Promise<Response | null> {
  if (!isWebSubmissionAdminPath(url.pathname)) return null;

  /* 这条链是管理端专用。创作者试用会话能看到 /admin，但网页投稿审核是平台级
   * 操作（会往公开频道发帖），不该下放给试用账号。 */
  if (!ctx.isAdmin) {
    return ctx.fail(403, "admin_access_denied", "只有管理员可以审核网页投稿。");
  }

  const secret = (env.WEB_REVIEW_SECRET ?? "").trim();
  if (!secret) {
    /* 没配密钥时不能退化成「不带头也能转发」—— 那等于把投稿机器人的审核接口
     * 暴露成一个只靠本站会话保护的洞。宁可让这个页面明确报错。 */
    return ctx.fail(
      503,
      "web_review_unconfigured",
      "网页投稿审核未启用：请在两边的 Worker 上各配一个相同的 WEB_REVIEW_SECRET / REVIEW_API_SECRET。",
    );
  }

  const origin = resolveBotOrigin(env);
  if (!origin) {
    return ctx.fail(503, "submission_bot_unconfigured", "投稿服务地址未配置（SUBMISSION_BOT_API_ORIGIN）。");
  }

  const target = upstreamPath(url.pathname);
  if (!target) {
    return ctx.fail(404, "unknown_review_action", "未知的审核操作。");
  }

  const headers = new Headers();
  headers.set("x-review-secret", secret);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  /* 只挑这两样过去。cookie 会把本站会话带到另一个 Worker 上，origin / host 更
   * 不该出现 —— 对方按自己的域名做任何判断都会被误导。 */
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (hasBody) init.body = request.body;

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${target.path}${url.search}`, init);
  } catch (error) {
    console.error("web submission review proxy failed", { path: target.path, error });
    return ctx.fail(502, "review_service_unreachable", "审核服务暂时连不上，请稍后再试。");
  }

  /* 附件字节：原样透传 content-type / content-length / content-disposition。
   * 不能走下面那个「非 JSON 转错误」的归一化 —— 图片本来就不是 JSON，一律转
   * 会把每一次缩略图请求都变成 502。 */
  if (target.binary) {
    if (!upstream.ok) {
      /* 上游失败时仍然是 JSON，借机把它的诊断读出来再包成结构化错误。 */
      const text = await upstream.text().catch(() => "");
      let message = "取不到这个附件。";
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
      } catch {
        /* 上游给了非 JSON 的失败体，保留默认文案 */
      }
      return ctx.fail(upstream.status === 413 ? 413 : 502, "review_media_failed", message);
    }
    const headers = new Headers();
    for (const name of ["content-type", "content-length", "content-disposition", "x-content-type-options"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    /* 转发层不能再缓存一次：上游已经声明 private，这里再加一层 public 缓存就会
     * 把审核附件泄给 CDN。 */
    headers.set("cache-control", "private, max-age=300");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  /* 原样回传状态码和 JSON：500 里带的是投稿机器人给的诊断（比如「发布失败：
   * 目标群没有权限」），在这里改写只会把有用的信息抹掉。
   *
   * 但要防一件真事：上游如果哪天挂成 HTML 错误页（Cloudflare 的 5xx 拦截页
   * 就是 HTML），前端 `response.json()` 会抛 SyntaxError，界面只剩「加载失败」。
   * 所以非 JSON 一律转成结构化的错误。 */
  const upstreamType = upstream.headers.get("content-type") ?? "";
  if (!upstreamType.includes("application/json")) {
    const text = await upstream.text().catch(() => "");
    console.error("web submission review proxy got non-json", {
      path: target.path,
      status: upstream.status,
      bodyStart: text.slice(0, 200),
    });
    return ctx.fail(502, "review_service_bad_response", "审核服务返回了非预期的内容，请稍后再试。");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
