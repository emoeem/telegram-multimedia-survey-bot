import { nowIso } from "../db/client";
import {
  createReportDelivery,
  getReportDeliveryByDeliveryId,
  getReportDeliveryByResponseId,
} from "../db/repositories/report-delivery.repository";
import type { ReportDelivery } from "../db/schema";

export const REPORT_DELIVERY_MAX_ATTEMPTS = 5;

/** KV key where the admin-configured report archive channel id is cached. */
export const REPORT_CHANNEL_CACHE_KEY = "report-channel:v1";

export function reportChannelPendingKey(userId: number): string {
  return `report-channel-pending:${userId}`;
}

export function reportDeliveryId(responseId: number, reportVersion: number): string {
  return `response_${responseId}_v${reportVersion}`;
}

/** Exponential backoff for delivery retries: 1m / 5m / 15m / 1h cap. */
export function nextReportRetryAt(attempts: number, now = new Date()): string | null {
  if (attempts >= REPORT_DELIVERY_MAX_ATTEMPTS) return null;
  const delaysMinutes = [1, 5, 15, 60];
  const delayMinutes = delaysMinutes[Math.min(Math.max(0, attempts - 1), delaysMinutes.length - 1)] ?? 60;
  return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
}

export interface EnqueueReportDeliveryResult {
  delivery: ReportDelivery;
  queued: boolean;
}

/**
 * Creates (or reopens) the delivery row and enqueues the archive job.
 * response_id is UNIQUE, so concurrent submissions collapse to one row; the
 * queue message is only sent for newly created rows or explicit retries.
 */
export async function enqueueReportDelivery(
  db: D1Database,
  queue: Queue,
  input: {
    responseId: number;
    reportVersion?: number;
    force?: boolean;
  },
): Promise<EnqueueReportDeliveryResult> {
  const reportVersion = input.reportVersion ?? 1;
  const deliveryId = reportDeliveryId(input.responseId, reportVersion);
  let delivery = await getReportDeliveryByResponseId(db, input.responseId);
  if (!delivery) {
    try {
      delivery = await createReportDelivery(db, {
        responseId: input.responseId,
        reportVersion,
        deliveryId,
      });
    } catch {
      // Race: another submit created the row first.
      delivery = (await getReportDeliveryByDeliveryId(db, deliveryId)) ??
        (await getReportDeliveryByResponseId(db, input.responseId));
      if (!delivery) throw new Error("Failed to create report delivery");
    }
  }

  const shouldQueue =
    input.force === true ||
    delivery.status === "pending" ||
    delivery.status === "failed";
  if (!shouldQueue) {
    return { delivery, queued: false };
  }

  await queue.send({ kind: "report_delivery", deliveryId } satisfies ReportDeliveryMessage);
  return { delivery, queued: true };
}

export interface ReportDeliveryMessage {
  kind: "report_delivery";
  deliveryId: string;
}

export function isReportDeliveryMessage(value: unknown): value is ReportDeliveryMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "report_delivery" && typeof message.deliveryId === "string";
}

export function reportDeliveryStatusTimestamp(): string {
  return nowIso();
}

/**
 * Cron driver for report delivery retries: re-enqueues pending deliveries
 * whose backoff window has elapsed. Attempts past the cap are marked failed.
 */
export async function retryPendingReportDeliveries(
  db: D1Database,
  queue: Queue,
  now = new Date(),
): Promise<{ requeued: number }> {
  const timestamp = now.toISOString();
  await db
    .prepare(
      `UPDATE report_deliveries
       SET status = 'failed', updated_at = ?
       WHERE status = 'pending'
         AND attempts >= ?
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= ?`,
    )
    .bind(timestamp, REPORT_DELIVERY_MAX_ATTEMPTS, timestamp)
    .run();

  const rows = await db
    .prepare(
      `SELECT delivery_id deliveryId
       FROM report_deliveries
       WHERE status = 'pending'
         AND attempts < ?
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT 100`,
    )
    .bind(REPORT_DELIVERY_MAX_ATTEMPTS, timestamp)
    .all<{ deliveryId: string }>();
  const deliveries = rows.results ?? [];
  for (const row of deliveries) {
    await queue.send({ kind: "report_delivery", deliveryId: row.deliveryId } satisfies ReportDeliveryMessage);
  }
  return { requeued: deliveries.length };
}
