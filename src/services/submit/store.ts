/**
 * 免登录投稿的 D1 数据访问 —— 从 submission-bot 的 store.js 移植网页侧真正
 * 用到的子集。表结构见 migration 0088(web_submissions / web_submission_threads
 * / web_submission_comments / web_rate_limits)。
 *
 * 与旧库的语义差异都集中在一处:data JSON 里的 __viewer / __email / __ip /
 * __seenAt 提升成了列(viewer_token / email / ip)和 threads 的 seen_by_author,
 * 查询从 json_extract 变成普通列。列表/计数走索引而不是全表 json_extract。
 */

import type { WebSubmitAttachment } from "./form-config";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type WebSubmissionStatus =
  "pending" | "publishing" | "published" | "rejected" | "failed" | "recalled" | "deleted";

export interface WebSubmissionRow {
  id: number;
  viewerToken: string | null;
  email: string | null;
  nickname: string | null;
  ip: string | null;
  templateId: string;
  data: Record<string, unknown>;
  status: WebSubmissionStatus;
  flags: string[];
  contentHash: string | null;
  publishChatId: string | null;
  publishMessageId: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

function safeParse(text: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(text ?? "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function hydrate(row: Record<string, unknown> | undefined): WebSubmissionRow | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    viewerToken: (row.viewer_token as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    nickname: (row.nickname as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    templateId: String(row.template_id ?? "default"),
    data: safeParse(row.data),
    status: String(row.status ?? "pending") as WebSubmissionStatus,
    flags: row.flags ? String(row.flags).split(",").filter(Boolean) : [],
    contentHash: (row.content_hash as string | null) ?? null,
    publishChatId: (row.publish_chat_id as string | null) ?? null,
    publishMessageId: row.publish_message_id == null ? null : Number(row.publish_message_id),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    publishedAt: row.published_at == null ? null : Number(row.published_at),
  };
}

export interface CreateWebSubmissionInput {
  viewerToken: string | null;
  email: string | null;
  nickname: string;
  ip: string | null;
  templateId: string;
  data: Record<string, unknown>;
  flags: string[];
  contentHash: string | null;
}

export class WebSubmitStore {
  constructor(private readonly db: D1Database) {}

  async createSubmission(input: CreateWebSubmissionInput): Promise<number> {
    const now = nowSeconds();
    const result = await this.db
      .prepare(
        `INSERT INTO web_submissions
           (viewer_token, email, nickname, ip, template_id, data, status, flags, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(
        input.viewerToken,
        input.email,
        input.nickname,
        input.ip,
        input.templateId,
        JSON.stringify(input.data),
        input.flags.length > 0 ? input.flags.join(",") : null,
        input.contentHash,
        now,
        now,
      )
      .run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  async getSubmission(id: number): Promise<WebSubmissionRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM web_submissions WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    return hydrate(row ?? undefined);
  }

  /** 同一内容的时间窗去重(同一浏览器令牌内)。 */
  async countSameContent(viewerToken: string, contentHash: string, windowSeconds: number): Promise<number> {
    if (!contentHash) return 0;
    const since = windowSeconds > 0 ? nowSeconds() - windowSeconds : 0;
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM web_submissions
          WHERE viewer_token = ? AND content_hash = ? AND created_at >= ? AND status != 'deleted'`,
      )
      .bind(viewerToken, contentHash, since)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** CAS 状态迁移;to_published 时同时盖 published_at。防止并发双击发两遍。 */
  async setStatus(id: number, status: WebSubmissionStatus, guardStatuses: WebSubmissionStatus[]): Promise<boolean> {
    if (guardStatuses.length === 0) return false;
    const placeholders = guardStatuses.map(() => "?").join(", ");
    const result =
      status === "published"
        ? await this.db
            .prepare(
              `UPDATE web_submissions SET status = ?, updated_at = ?, published_at = ?
                WHERE id = ? AND status IN (${placeholders})`,
            )
            .bind(status, nowSeconds(), nowSeconds(), id, ...guardStatuses)
            .run()
        : await this.db
            .prepare(
              `UPDATE web_submissions SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
            )
            .bind(status, nowSeconds(), id, ...guardStatuses)
            .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // ---------- 收件箱 ----------

  async listByViewer(viewerToken: string, limit = 20): Promise<WebSubmissionRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM web_submissions WHERE viewer_token = ? AND status != 'deleted' ORDER BY id DESC LIMIT ?")
      .bind(viewerToken, limit)
      .all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => hydrate(row)!).filter(Boolean);
  }

  async listThreads(
    submissionId: number,
    limit = 50,
  ): Promise<Array<{ direction: string; text: string; createdAt: number }>> {
    const result = await this.db
      .prepare(
        "SELECT direction, text, created_at FROM web_submission_threads WHERE submission_id = ? ORDER BY id ASC LIMIT ?",
      )
      .bind(submissionId, limit)
      .all<{ direction: string; text: string; created_at: number }>();
    return (result.results ?? []).map((row) => ({
      direction: row.direction,
      text: row.text,
      createdAt: Number(row.created_at),
    }));
  }

  async addThreadMessage(submissionId: number, direction: "to_author" | "to_admin", text: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO web_submission_threads (submission_id, direction, text, seen_by_author, created_at) VALUES (?, ?, ?, 0, ?)",
      )
      .bind(submissionId, direction, text, nowSeconds())
      .run();
  }

  async countUnreadThread(submissionId: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM web_submission_threads WHERE submission_id = ? AND direction = 'to_author' AND seen_by_author = 0",
      )
      .bind(submissionId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async markThreadSeen(submissionId: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE web_submission_threads SET seen_by_author = 1 WHERE submission_id = ? AND direction = 'to_author'",
      )
      .bind(submissionId)
      .run();
  }

  async listComments(
    submissionId: number,
    limit = 20,
  ): Promise<
    Array<{
      id: number;
      telegramChatId: string | null;
      telegramMessageId: number | null;
      authorName: string | null;
      text: string | null;
      kind: string;
      parentAuthor: string | null;
      createdAt: number;
    }>
  > {
    const result = await this.db
      .prepare(
        `SELECT id, telegram_chat_id, telegram_message_id, author_name, text, kind, parent_author, created_at
           FROM web_submission_comments WHERE submission_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(submissionId, limit)
      .all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: Number(row.id),
      telegramChatId: (row.telegram_chat_id as string | null) ?? null,
      telegramMessageId: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
      authorName: (row.author_name as string | null) ?? null,
      text: (row.text as string | null) ?? null,
      kind: String(row.kind ?? "user"),
      parentAuthor: (row.parent_author as string | null) ?? null,
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  async getComment(
    submissionId: number,
    commentKey: number,
  ): Promise<{
    id: number;
    telegramChatId: string | null;
    telegramMessageId: number | null;
    kind: string;
  } | null> {
    // commentKey 兼容旧前端发的 Telegram message_id(迁移数据)与新表的 id:
    // 先按 telegram_message_id 找,再按主键找。
    const byTelegram = await this.db
      .prepare(
        "SELECT id, telegram_chat_id, telegram_message_id, kind FROM web_submission_comments WHERE submission_id = ? AND telegram_message_id = ?",
      )
      .bind(submissionId, commentKey)
      .first<Record<string, unknown>>();
    const row =
      byTelegram ??
      (await this.db
        .prepare(
          "SELECT id, telegram_chat_id, telegram_message_id, kind FROM web_submission_comments WHERE submission_id = ? AND id = ?",
        )
        .bind(submissionId, commentKey)
        .first<Record<string, unknown>>());
    if (!row) return null;
    return {
      id: Number(row.id),
      telegramChatId: (row.telegram_chat_id as string | null) ?? null,
      telegramMessageId: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
      kind: String(row.kind ?? "user"),
    };
  }

  // ---------- 管理端审核 ----------

  /** 仅网页投稿进这个面板;本表整体就是网页投稿,不需要旧库的 json_extract 过滤。 */
  async listForReview(options: {
    status?: WebSubmissionStatus | null;
    limit: number;
    offset: number;
  }): Promise<WebSubmissionRow[]> {
    const params: unknown[] = [];
    let where = "";
    if (options.status) {
      where = " WHERE status = ?";
      params.push(options.status);
    }
    const result = await this.db
      .prepare(`SELECT * FROM web_submissions${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...params, options.limit, options.offset)
      .all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => hydrate(row)!).filter(Boolean);
  }

  async countForReview(status?: WebSubmissionStatus | null): Promise<number> {
    const row = status
      ? await this.db
          .prepare("SELECT COUNT(*) AS n FROM web_submissions WHERE status = ?")
          .bind(status)
          .first<{ n: number }>()
      : await this.db.prepare("SELECT COUNT(*) AS n FROM web_submissions").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  // ---------- 限流 ----------

  async getRateLimit(key: string): Promise<number> {
    try {
      const row = await this.db
        .prepare("SELECT count FROM web_rate_limits WHERE key = ?")
        .bind(key)
        .first<{ count: number }>();
      return Number(row?.count ?? 0);
    } catch {
      // 表还没建(迁移未跑)时降级为不限流,而不是把投稿整个打挂。
      return 0;
    }
  }

  /** 原子累加一个限流桶并返回累加后的计数。 */
  async bumpRateLimit(key: string, windowStart: number): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO web_rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN web_rate_limits.window_start = excluded.window_start THEN web_rate_limits.count + 1 ELSE 1 END,
           window_start = excluded.window_start`,
      )
      .bind(key, windowStart)
      .run();
    const row = await this.db
      .prepare("SELECT count FROM web_rate_limits WHERE key = ?")
      .bind(key)
      .first<{ count: number }>();
    return Number(row?.count ?? 1);
  }

  async pruneRateLimits(olderThanSeconds = 86400): Promise<void> {
    await this.db
      .prepare("DELETE FROM web_rate_limits WHERE window_start < ?")
      .bind(nowSeconds() - olderThanSeconds)
      .run();
  }
}

/** 新投稿的附件存本站媒体库;这里只负责把引用写进 data JSON。 */
export function withAttachments(
  data: Record<string, unknown>,
  mediaStepId: string | null,
  attachments: WebSubmitAttachment[],
): Record<string, unknown> {
  if (!mediaStepId) return data;
  return { ...data, [mediaStepId]: attachments };
}
