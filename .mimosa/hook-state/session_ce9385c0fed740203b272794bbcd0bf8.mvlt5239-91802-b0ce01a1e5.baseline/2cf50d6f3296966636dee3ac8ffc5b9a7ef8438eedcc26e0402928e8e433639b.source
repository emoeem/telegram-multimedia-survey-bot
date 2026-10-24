import { nowIso } from "../db/client";

/**
 * 报告分享卡（0081）。参与者把某份已完成的答卷主动分享为一张公开「结局卡」。
 *
 * 与 30 天过期的私有报告 token（report-access-token.service，无状态 HMAC）
 * 语义相反：分享是持久且可撤销的公开内容，所以 token 是 DB 随机串——可撤销
 * （revoked_at）、可审计、可计数。
 *
 * 安全边界在消费侧（src/http/share-api.ts 的白名单投影）：公开页只出现
 * 结局名/卷名/tags/日期，任何答案原文、长文本与 stats 数值都不出口。
 * result_type/result_title/survey_title/content_rating 是创建时刻的冗余
 * 快照，作者日后改掉结果规则或标题时，已分享出去的卡片语义不漂移。
 */

const SHARE_TOKEN_BYTES = 16;

function randomToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface ReportShareRow {
  id: number;
  token: string;
  responseId: number;
  participantHash: string;
  surveyId: number;
  resultType: string | null;
  resultTitle: string | null;
  surveyTitle: string | null;
  contentRating: string;
  viewCount: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapShare(row: Record<string, unknown>): ReportShareRow {
  return {
    id: Number(row.id),
    token: String(row.token),
    responseId: Number(row.response_id),
    participantHash: String(row.participant_hash),
    surveyId: Number(row.survey_id),
    resultType: row.result_type === null || row.result_type === undefined ? null : String(row.result_type),
    resultTitle: row.result_title === null || row.result_title === undefined ? null : String(row.result_title),
    surveyTitle: row.survey_title === null || row.survey_title === undefined ? null : String(row.survey_title),
    contentRating: String(row.content_rating ?? "all"),
    viewCount: Number(row.view_count ?? 0),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const SHARE_COLUMNS =
  "id, token, response_id, participant_hash, survey_id, result_type, result_title, survey_title, content_rating, view_count, revoked_at, created_at, updated_at";

export interface CreateReportShareInput {
  responseId: number;
  participantHash: string;
  surveyId: number;
  surveyTitle: string | null;
  resultType: string | null;
  resultTitle: string | null;
  contentRating: "all" | "r18";
}

/**
 * 创建（或复用）一份分享。幂等：未撤销的既有分享原样返回；撤销过的分享在
 * 显式重新创建时换新 token 复活（旧链接立即失效，传播中的旧卡不会指向新卡）。
 */
export async function upsertReportShare(db: D1Database, input: CreateReportShareInput): Promise<ReportShareRow> {
  const existing = await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM report_shares WHERE response_id = ? LIMIT 1`)
    .bind(input.responseId)
    .first<Record<string, unknown>>();
  const timestamp = nowIso();
  if (existing) {
    const row = mapShare(existing);
    if (!row.revokedAt) return row;
    await db
      .prepare(
        `UPDATE report_shares SET token = ?, revoked_at = NULL, result_type = ?, result_title = ?,
                survey_title = ?, content_rating = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        randomToken(),
        input.resultType,
        input.resultTitle,
        input.surveyTitle,
        input.contentRating,
        timestamp,
        row.id,
      )
      .run();
    return getShareByResponse(db, input.responseId) as Promise<ReportShareRow>;
  }
  await db
    .prepare(
      `INSERT INTO report_shares
         (token, response_id, participant_hash, survey_id, result_type, result_title, survey_title, content_rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      randomToken(),
      input.responseId,
      input.participantHash,
      input.surveyId,
      input.resultType,
      input.resultTitle,
      input.surveyTitle,
      input.contentRating,
      timestamp,
      timestamp,
    )
    .run();
  const created = await getShareByResponse(db, input.responseId);
  if (!created) throw new Error("report_share_insert_failed");
  return created;
}

export async function getShareByResponse(db: D1Database, responseId: number): Promise<ReportShareRow | null> {
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM report_shares WHERE response_id = ? LIMIT 1`)
    .bind(responseId)
    .first<Record<string, unknown>>();
  return row ? mapShare(row) : null;
}

export async function getActiveShareByToken(db: D1Database, token: string): Promise<ReportShareRow | null> {
  if (!token) return null;
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM report_shares WHERE token = ? AND revoked_at IS NULL LIMIT 1`)
    .bind(token)
    .first<Record<string, unknown>>();
  return row ? mapShare(row) : null;
}

export async function revokeReportShare(db: D1Database, responseId: number, participantHash: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE report_shares SET revoked_at = ?, updated_at = ?
       WHERE response_id = ? AND participant_hash = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), nowIso(), responseId, participantHash)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
