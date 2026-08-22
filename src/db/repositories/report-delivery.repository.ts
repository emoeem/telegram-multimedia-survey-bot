import type { ReportDelivery, ReportDeliveryStatus } from "../schema";
import { nowIso } from "../client";

interface ReportDeliveryRow {
  id: number;
  response_id: number;
  report_version: number;
  delivery_id: string;
  telegram_chat_id: number | null;
  pdf_message_id: number | null;
  image_message_ids_json: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ReportDeliveryRow): ReportDelivery {
  return {
    id: row.id,
    responseId: row.response_id,
    reportVersion: row.report_version,
    deliveryId: row.delivery_id,
    telegramChatId: row.telegram_chat_id,
    pdfMessageId: row.pdf_message_id,
    imageMessageIdsJson: row.image_message_ids_json,
    status: row.status as ReportDeliveryStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    nextRetryAt: row.next_retry_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createReportDelivery(
  db: D1Database,
  input: {
    responseId: number;
    reportVersion: number;
    deliveryId: string;
  },
): Promise<ReportDelivery> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO report_deliveries (
        response_id, report_version, delivery_id, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(input.responseId, input.reportVersion, input.deliveryId, timestamp, timestamp)
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create report delivery");
  }
  const delivery = await getReportDeliveryById(db, id);
  if (!delivery) {
    throw new Error("Failed to load created report delivery");
  }
  return delivery;
}

export async function getReportDeliveryById(
  db: D1Database,
  id: number,
): Promise<ReportDelivery | null> {
  const row = await db
    .prepare("SELECT * FROM report_deliveries WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ReportDeliveryRow>();
  return row ? mapRow(row) : null;
}

export async function getReportDeliveryByResponseId(
  db: D1Database,
  responseId: number,
): Promise<ReportDelivery | null> {
  const row = await db
    .prepare("SELECT * FROM report_deliveries WHERE response_id = ? LIMIT 1")
    .bind(responseId)
    .first<ReportDeliveryRow>();
  return row ? mapRow(row) : null;
}

export async function getReportDeliveryByDeliveryId(
  db: D1Database,
  deliveryId: string,
): Promise<ReportDelivery | null> {
  const row = await db
    .prepare("SELECT * FROM report_deliveries WHERE delivery_id = ? LIMIT 1")
    .bind(deliveryId)
    .first<ReportDeliveryRow>();
  return row ? mapRow(row) : null;
}

/**
 * Atomically claims a delivery for processing. Only one worker can win per
 * delivery; retries respect the backoff window stored in next_retry_at.
 */
export async function claimReportDelivery(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `UPDATE report_deliveries
       SET status = 'delivering', attempts = attempts + 1, updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
    )
    .bind(timestamp, id, timestamp)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function completeReportDelivery(
  db: D1Database,
  id: number,
  input: {
    telegramChatId: number;
    pdfMessageId: number;
    imageMessageIds: number[];
  },
): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `UPDATE report_deliveries
       SET status = 'delivered',
           telegram_chat_id = ?,
           pdf_message_id = ?,
           image_message_ids_json = ?,
           last_error = NULL,
           next_retry_at = NULL,
           delivered_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.telegramChatId,
      input.pdfMessageId,
      JSON.stringify(input.imageMessageIds),
      timestamp,
      timestamp,
      id,
    )
    .run();
}

export async function failReportDelivery(
  db: D1Database,
  id: number,
  input: {
    error: string;
    retryable: boolean;
    nextRetryAt: string | null;
  },
): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `UPDATE report_deliveries
       SET status = ?,
           last_error = ?,
           next_retry_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.retryable ? "pending" : "failed",
      input.error.slice(0, 2000),
      input.nextRetryAt,
      timestamp,
      id,
    )
    .run();
}

export interface ReportDeliveryRowWithSurvey {
  id: number;
  deliveryId: string;
  responseId: number;
  surveyId: number;
  surveyTitle: string;
  status: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

export async function listReportDeliveries(
  db: D1Database,
  input: {
    status?: string;
    ownerId?: number | null;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: ReportDeliveryRowWithSurvey[]; total: number }> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const offset = Math.max(0, input.offset ?? 0);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("rd.status = ?");
    binds.push(input.status);
  }
  if (input.ownerId !== null && input.ownerId !== undefined) {
    where.push("s.owner_id = ?");
    binds.push(input.ownerId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [items, count] = (await db.batch([
    db
      .prepare(
        `SELECT rd.id, rd.delivery_id deliveryId, rd.response_id responseId,
                s.id surveyId, s.title surveyTitle, rd.status, rd.attempts,
                rd.last_error lastError, rd.delivered_at deliveredAt,
                rd.updated_at updatedAt
         FROM report_deliveries rd
         JOIN survey_responses r ON r.id = rd.response_id
         JOIN surveys s ON s.id = r.survey_id
         ${whereSql}
         ORDER BY rd.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM report_deliveries rd
         JOIN survey_responses r ON r.id = rd.response_id
         JOIN surveys s ON s.id = r.survey_id
         ${whereSql}`,
      )
      .bind(...binds),
  ])) as [
    D1Result<ReportDeliveryRowWithSurvey>,
    D1Result<{ count: number }>,
  ];
  return {
    items: items.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
  };
}
