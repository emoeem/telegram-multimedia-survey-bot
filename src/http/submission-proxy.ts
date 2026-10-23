/**
 * 网页投稿（免登录投稿）后端的反向代理。
 *
 * 背景：那套表单不属于本 Worker —— 它是独立部署的 submission-bot Worker
 * （`/api/submit/form`、`/api/submit/inbox`、`/api/submit/reply` …）。合并投稿
 * 中心之前，这些接口只在国内中继域名 `emoemok.top` 上被转发过（见
 * cn-relay/vercel.json 的前两条 routes），所以：
 *
 *   https://emoemok.top/submit        ✅ 表单能加载
 *   https://emoe.eu.cc/submit         ❌ fetch("/api/submit/form") 回落成 SPA 的
 *                                        index.html，前端报 "Unexpected token '<'"
 *
 * 这就解释了「为什么看起来有两个投稿中心」：免登录那半只在其中一个域名上
 * 真的能用。合并到一个页面之后，同一页的第二个页签在 emoe.eu.cc 上必然打不
 * 开，除非把这条链路补上 —— 也就是这个模块。
 *
 * 代理保持同源：浏览器只认本站，不需要 CORS，也不需要把 submission-bot 的
 * 域名暴露给前端。
 */
import type { Env } from "../index";

/** 投稿机器人接口的路径前缀。 */
export const SUBMISSION_API_PREFIX = "/api/submit";

/** 是否归这个代理管。
 *
 * 精确匹配 `/api/submit` 本身（中继的 vercel.json 里 `"/api/submit$"` 就是这条
 * 规则），以及它下面所有子路径。不能写成 `startsWith("/api/submit")` —— 那样
 * `/api/submissions`（金币投稿，属于本站）会被一起吞掉，账号投稿页直接 404。
 */
export function isSubmissionBotApiPath(pathname: string): boolean {
  return pathname === SUBMISSION_API_PREFIX || pathname.startsWith(`${SUBMISSION_API_PREFIX}/`);
}

/** 从配置里取投稿机器人源站；未配置返回 null。 */
export function resolveSubmissionBotOrigin(env: Pick<Env, "SUBMISSION_BOT_API_ORIGIN">): string | null {
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

/**
 * 转发一次投稿机器人请求。
 *
 * 只挑三样东西过去：方法、Content-Type、访客 IP。其余请求头一律不透传 ——
 * `cookie` 会把本站会话带到另一个 Worker，`origin` 会让对方按错误的来源做
 * 校验，`host` 更是不该出现。响应侧同理，只回 Content-Type，让浏览器用本域
 * 的规则处理。
 */
export async function handleSubmissionBotProxy(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = resolveSubmissionBotOrigin(env);
  if (!origin) {
    return Response.json(
      { ok: false, code: "submission_bot_unconfigured", error: "免登录投稿暂不可用" },
      { status: 503 },
    );
  }

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  /* 投稿机器人按来源 IP 限流。本站 Worker 如果什么都不带，所有请求在它眼里
   * 都来自同一台 Cloudflare 边缘节点，一个用户刷屏会把所有人一起限掉。 */
  const clientIp = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  const country = request.headers.get("cf-ipcountry");
  if (country) headers.set("x-relay-country", country);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  /* exactOptionalPropertyTypes 下不能把 `body: undefined` 塞进 init —— 那会被
   * 判成「显式设了 undefined」而不是「没设」。所以只在真有 body 时才赋值。 */
  if (hasBody) init.body = request.body;

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${url.pathname}${url.search}`, init);
  } catch (error) {
    console.error("submission bot proxy failed", { path: url.pathname, error });
    return Response.json(
      { ok: false, code: "submission_bot_unreachable", error: "投稿服务暂时连不上，请稍后再试" },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) responseHeaders.set("content-type", upstreamType);
  /* 投稿接口全是「提交后立刻要看到结果」的读写混合，缓存住任何一个都会让
   * 收件箱看不到新状态。 */
  responseHeaders.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
