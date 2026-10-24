/**
 * #话题# 解析（0068）。
 *
 * 规则刻意做得很窄，因为话题会出现在公开流的筛选条上：
 * - 客户端可以显式传 topic（优先），服务端只做规范化与长度校验；
 * - 否则从正文里取第一个 #话题#（两枚 # 包裹，中间不含空白与 #）；
 * - 空白、超长（>20 字）或只有 # 的值一律视为「没有话题」，不报错。
 */
export const PLAZA_TOPIC_MAX_LENGTH = 20;

export function normalizePlazaTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^#+/, "").replace(/#+$/, "").trim();
  if (!trimmed || trimmed.length > PLAZA_TOPIC_MAX_LENGTH) return null;
  if (/[\s#]/.test(trimmed)) return null;
  return trimmed;
}

/** 从正文里解析 #话题#；没有则返回 null。 */
export function extractPlazaTopic(content: string): string | null {
  const match = content.match(/#([^#\s]{1,20})#/);
  if (!match) return null;
  return normalizePlazaTopic(match[1]);
}

/** 显式 topic 优先，其次正文里的 #话题#。 */
export function resolvePlazaTopic(content: string, explicit: unknown): string | null {
  const normalized = normalizePlazaTopic(explicit);
  if (normalized) return normalized;
  return extractPlazaTopic(content);
}
