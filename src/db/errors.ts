/**
 * D1 stops answering every query once an account-level limit is hit (for
 * example the free-tier 5,000,000 rows-read-per-day budget). Cloudflare
 * surfaces that as a query error instead of an HTTP error, so a Worker without
 * explicit handling just returns 500 and looks "broken" to users while the
 * real cause is a quota reset at midnight UTC.
 */
export function isDatabaseCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return (
    /exceeded d1/i.test(message) ||
    /daily row (read|write) limit/i.test(message) ||
    /code:\s*7500/i.test(message) ||
    /D1_ERROR/i.test(message)
  );
}

export function describeDatabaseError(error: unknown): string {
  return isDatabaseCapacityError(error)
    ? "数据库今日查询额度已用尽，功能暂时不可用，请稍后重试（如频繁出现需升级 Cloudflare 套餐）。"
    : "服务器暂时无法处理请求，请稍后重试。";
}

/**
 * Variant for people using the product rather than running it: no plan
 * upgrade advice, but a concrete "when does it come back" answer, because the
 * quota resets on a fixed daily boundary.
 */
export function describePublicDatabaseError(error: unknown): string {
  return isDatabaseCapacityError(error)
    ? "数据库今日查询额度已用尽，服务暂时不可用，请在明天早上之后重试。"
    : "服务暂时不可用，请稍后重试。";
}
