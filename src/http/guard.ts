import type { Env } from "../env";
import { sendMessage } from "../bot/telegram";
import { parseAdminIds } from "../core/admin-ids";
import { describePublicDatabaseError, isDatabaseCapacityError, isKeyValueCapacityError } from "../db/errors";
import { rateLimitIpSubject, resolveClientIdentity } from "../services/client-identity.service";
import { emailDomainOf, isAggregateProviderDomain } from "../services/disposable-email.service";
import { createPreferredRateLimiter } from "../services/rate-limit.service";

/**
 * A maintenance run that stops at its read budget means the account's daily D1
 * quota is at risk again — the failure mode that took the bot and every survey
 * down for a full day on 2026-09-14. The admins should hear it from the bot
 * rather than from users.
 */
export async function notifyMaintenanceBudgetExhausted(env: Env, rowsRead: number): Promise<void> {
  try {
    const message =
      `⚠️ 数据库维护任务读取了 ${rowsRead.toLocaleString("en-US")} 行，已提前停止本次清理。\n` +
      `常见原因是新加的清理查询缺少索引。请先确认再让它继续跑，避免再次耗尽当天 D1 额度。`;
    await Promise.all(parseAdminIds(env.ADMIN_IDS).map((chatId) => sendMessage(env.BOT_TOKEN, chatId, message)));
  } catch (error) {
    console.warn("Maintenance budget notice failed", error);
  }
}

/**
 * 结构化限流命中行。request_metrics 只能回答「哪个路径出了 429」，回答不了
 * 「是哪个维度挡的」——per-email / per-ip / per-domain 三道限制的命中占比才是
 * 判断攻击形态的依据（比如 per-domain 突增 = 新的一次性邮箱域在批量注册）。
 * 与 request_metrics 同一条纪律：不落邮箱/IP 原文，只落维度名与路径。
 */
function logRateLimitHit(
  url: URL,
  dimension: "per-email" | "per-ip" | "per-domain",
  extra: Record<string, unknown> = {},
): void {
  console.warn(
    "rate_limit_hit",
    JSON.stringify({ type: "rate_limit_hit", surface: "email-auth", dimension, path: url.pathname, ...extra }),
  );
}

/**
 * Single boundary for the public JSON APIs.
 *
 * An unhandled throw used to leave the Worker's own 500 page in the body, which
 * the survey/trial/plaza SPAs can only render as a bare "请求失败" — that is how
 * the 2026-09-14 quota exhaustion looked like a broken survey to users. Every
 * API failure now returns JSON the client can explain, with 503 for a database
 * capacity problem so retrying clients back off differently than on a bug.
 */
async function applyPublicApiRateLimit(request: Request, env: Env, url: URL): Promise<Response | null> {
  const limiter = createPreferredRateLimiter(env);
  // 地址未知时**不**把所有人塞进 "unknown" 桶（见 rateLimitIpSubject）：那会把
  // 「每个地址 20 次/小时」变成「全站 20 次/小时」，20 个人就能把登录打停。
  // 这一维度直接跳过并留日志；按邮箱的那一道限制照常生效。
  const identity = resolveClientIdentity(request, env);
  const clientIp = rateLimitIpSubject(identity);

  if (request.method === "POST" && url.pathname.startsWith("/api/auth/email/")) {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email) {
      let scope = url.pathname.slice("/api/auth/email/".length);
      if (scope === "request-code") scope = body?.purpose === "reset" ? "reset" : "register";
      if (scope === "register" || scope === "login" || scope === "reset") {
        // 域名维度只打非主流域：fldubai.com 这类新型一次性域（还没进黑名单时）
        // 被压到 5 个注册/小时/域，而 gmail.com 等共享域的聚合注册量是正常业务，
        // 绝不能套这个限。
        const domain = emailDomainOf(email);
        const throttleDomain = domain !== null && !isAggregateProviderDomain(domain);
        const [perEmail, perIp, perDomain] = await Promise.all([
          limiter.allow(`${scope}|${email}`, 5, 3600),
          clientIp ? limiter.allow(`email-auth-ip|${clientIp}`, 20, 3600) : Promise.resolve(true),
          scope === "register" && throttleDomain
            ? limiter.allow(`register-domain|${domain}`, 5, 3600)
            : Promise.resolve(true),
        ]);
        if (!clientIp) {
          console.warn("邮件登录按地址限流已跳过：无法确定调用方地址", { scope, path: url.pathname });
        }
        if (!perDomain) {
          logRateLimitHit(url, "per-domain", { scope, domain });
        }
        if (!perEmail || !perIp || !perDomain) {
          // per-email / per-ip 命中此前完全没有日志（只有 request_metrics 的 429
          // 状态），运维无法把 429 归因到维度；这两道各补一条结构化行。
          if (!perEmail) logRateLimitHit(url, "per-email", { scope });
          if (!perIp) logRateLimitHit(url, "per-ip", { scope });
          return Response.json(
            { ok: false, code: "rate_limited", message: "请求过于频繁，请稍后再试" },
            { status: 429, headers: { "Cache-Control": "no-store" } },
          );
        }
      }
    }
  }

  // Answer saves are damped inside their own handler instead
  // (src/http/survey/handler.ts): its limiter is a row in the same D1 batch as
  // the response read, which keeps the endpoint free of a KV round trip on the
  // one interaction a respondent repeats for every question.

  return null;
}

export async function guardApiResponse(
  request: Request,
  env: Env,
  url: URL,
  run: () => Promise<Response | null>,
): Promise<Response> {
  try {
    const rateLimitResponse = await applyPublicApiRateLimit(request, env, url);
    if (rateLimitResponse) return rateLimitResponse;
    // Same JSON error shape as every other API failure: the SPAs parse a body
    // and fall back to a bare "请求失败（HTTP 404）" for anything else.
    return (
      (await run()) ??
      Response.json(
        { ok: false, code: "not_found", message: "接口不存在" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      )
    );
  } catch (error) {
    console.error("API request failed", error);
    return Response.json(
      {
        ok: false,
        code: isDatabaseCapacityError(error)
          ? "database_capacity"
          : isKeyValueCapacityError(error)
            ? "kv_capacity"
            : "internal_error",
        message: describePublicDatabaseError(error),
      },
      {
        // 两种容量错误都是"等一会儿/改天再来"，不是服务端 bug，用 503 让
        // 前端和监控都按可重试对待；其余仍是 500。
        status: isDatabaseCapacityError(error) || isKeyValueCapacityError(error) ? 503 : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
