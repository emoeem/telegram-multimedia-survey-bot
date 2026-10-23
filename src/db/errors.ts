/**
 * D1 stops answering every query once an account-level limit is hit (for
 * example the free-tier 5,000,000 rows-read-per-day budget). Cloudflare
 * surfaces that as a query error instead of an HTTP error, so a Worker without
 * explicit handling just returns 500 and looks "broken" to users while the
 * real cause is a quota reset at midnight UTC.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
}

export function isDatabaseCapacityError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /exceeded d1/i.test(message) ||
    /daily row (read|write) limit/i.test(message) ||
    /code:\s*7500/i.test(message)
  );
}

/**
 * KV 的每日额度（免费版 10 万读 / 1,000 写）打满时，`put`/`get` 会直接抛错，
 * 而这条错误既不是 D1 的 7500 也不含 "exceeded d1"。识别不出来就会被兜底成
 * 「服务暂时不可用，请稍后重试」——用户以为站点挂了，实际只是 KV 写满了，
 * 而且换 Telegram 入口立刻就能用。所以单独识别、单独给建议。
 */
export function isKeyValueCapacityError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /kv (put|get|delete|list) failed/i.test(message) ||
    /exceeded.*\bkv\b/i.test(message) ||
    /\bkv\b.*(limit|quota|exceeded)/i.test(message)
  );
}

export function describeDatabaseError(error: unknown): string {
  if (isDatabaseCapacityError(error)) {
    return "数据库今日查询额度已用尽，功能暂时不可用，请稍后重试（如频繁出现需升级 Cloudflare 套餐）。";
  }
  if (isKeyValueCapacityError(error)) {
    return "KV 今日写入额度已用尽，缓存与限流暂时不可用，请稍后重试（免费版 1,000 写/天，如频繁出现需升级 Workers 付费计划）。";
  }
  return "服务器暂时无法处理请求，请稍后重试。";
}

/**
 * Variant for people using the product rather than running it: no plan
 * upgrade advice, but a concrete "when does it come back" answer, because the
 * quota resets on a fixed daily boundary.
 */
export function describePublicDatabaseError(error: unknown): string {
  if (isDatabaseCapacityError(error)) {
    return "数据库今日查询额度已用尽，服务暂时不可用，请在明天早上之后重试。";
  }
  if (isKeyValueCapacityError(error)) {
    // 不告诉用户"额度"，因为他们无能为力；只告诉他现在还能怎么用。
    return "验证码与登录暂时不可用，请稍后重试；也可以直接用 Telegram 打开平台（免注册）。";
  }
  return "服务暂时不可用，请稍后重试。";
}
