import type { Env } from "../env";
import { rateLimitIpSubject, resolveClientIdentity } from "../services/client-identity.service";
import { createPreferredRateLimiter } from "../services/rate-limit.service";

/**
 * 客户端结构化日志上报（2026-11-19 通宵批次 B3 复核修订）。
 *
 * 背景：screen_view（admin/src/survey/screen-view.ts + main.tsx）在浏览器
 * console.info 出来，而浏览器 console 出不了用户设备——Workers Logs
 * （wrangler.toml [observability]）只收 Worker 侧的 console.*。没有这条
 * 上报管道，埋点在生产一条数据也收不到。链路：页面 keepalive fetch →
 * 本端点校验后由 Worker 再 console.info 一条同形状 JSON 行 → Workers Logs。
 *
 * 纪律（与 guard.ts 的 rate_limit_hit、request_metrics 同一条）：
 *  - 只收钉死的 screen_view 形状，screen/path 按白名单字符集校验——公开
 *    端点回显任意文本等于给 Workers Logs 开注入口子；
 *  - 日志行只有 type/screen/path 三个字段，不落 IP/UA 等来源信息
 *    （限流在服务端做，不进日志）；
 *  - 按地址限流复用公共 API 限流器；地址解析不出时跳过这一道并留 warn，
 *    绝不共用 "unknown" 桶（见 client-identity.service 的 rateLimitIpSubject）。
 */

/** 客户端（admin/src/survey/main.tsx）与路由分支共用这一条路径常量。 */
export const CLIENT_LOG_PATH = "/api/client-log";

/** 单条日志体积上限：埋点行 <200B，1KB 余量足够挡住凑体积的滥用。 */
const MAX_BODY_BYTES = 1024;

/** 每地址每小时允许上报的条数：真实用户一次浏览也就十几屏，余量给足。 */
const RATE_LIMIT_PER_HOUR = 120;

/** screen 名：小写字母开头的短标识（与 screen-view.ts 的 ScreenViewName 同形状）。 */
const SCREEN_NAME_PATTERN = /^[a-z][a-z_]{0,31}$/;

/** path：以 / 开头的 URL path 字符集（RFC 3986 pchar + /），封顶 200 字符。 */
const PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%-]{0,199}$/;

const JSON_HEADERS = { "Cache-Control": "no-store" };

function jsonError(code: string, status: number): Response {
  return Response.json({ ok: false, code }, { status, headers: JSON_HEADERS });
}

export async function handleClientLogRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }

  const raw = await request.text().catch(() => "");
  if (raw.length === 0) return jsonError("empty_body", 400);
  if (raw.length > MAX_BODY_BYTES) return jsonError("payload_too_large", 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return jsonError("invalid_body", 400);
  }
  const body = parsed as Record<string, unknown>;
  const screen = body.screen;
  const path = body.path;
  if (
    body.type !== "screen_view" ||
    typeof screen !== "string" ||
    !SCREEN_NAME_PATTERN.test(screen) ||
    typeof path !== "string" ||
    !PATH_PATTERN.test(path)
  ) {
    return jsonError("invalid_body", 400);
  }

  // 限流放在校验之后：垃圾 body 不烧 KV/DO 配额，也不占真实用户的额度。
  const limiter = createPreferredRateLimiter(env);
  const clientIp = rateLimitIpSubject(resolveClientIdentity(request, env));
  if (!clientIp) {
    console.warn("client-log 限流已跳过：无法确定调用方地址");
  } else if (!(await limiter.allow(`client-log-ip|${clientIp}`, RATE_LIMIT_PER_HOUR, 3600))) {
    return jsonError("rate_limited", 429);
  }

  // Workers Logs 的检索行：整行就是一个 JSON 对象，与浏览器侧那条同形状。
  console.info(JSON.stringify({ type: "screen_view", screen, path }));
  return Response.json({ ok: true }, { headers: JSON_HEADERS });
}
