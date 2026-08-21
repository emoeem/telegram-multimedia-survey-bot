import { sendMessage } from "../bot/telegram";

interface StaleIdentityCardJob {
  id: number;
  chat_id: number;
  attempts: number;
}

const staleProcessingMs = 2 * 60_000;

export async function recoverStaleIdentityCardJobs(
  db: D1Database,
  queue: Queue,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now - staleProcessingMs).toISOString();
  const stale = await db.prepare(
    `SELECT id, chat_id, attempts
     FROM identity_card_jobs
     WHERE status = 'processing'
       AND COALESCE(processing_started_at, created_at) < ?
     ORDER BY id ASC
     LIMIT 20`,
  ).bind(cutoff).all<StaleIdentityCardJob>();
  const jobs = stale.results ?? [];
  let requeued = 0;
  let failed = 0;

  for (const job of jobs) {
    const terminal = job.attempts >= 3;
    const result = await db.prepare(
      `UPDATE identity_card_jobs
       SET status = ?, processing_started_at = NULL,
           error_message = ?, completed_at = ?
       WHERE id = ? AND status = 'processing'
         AND COALESCE(processing_started_at, created_at) < ?`,
    ).bind(
      terminal ? "failed" : "queued",
      terminal ? "任务多次超时" : "任务超时，已自动重试",
      terminal ? new Date(now).toISOString() : null,
      job.id,
      cutoff,
    ).run();
    if (!(result.meta?.changes)) continue;
    if (terminal) {
      failed += 1;
      try {
        await sendMessage(botToken, job.chat_id, "❌ 身份卡生成多次超时，请重新制作或更换较小的图片。");
      } catch (error) {
        console.error("Failed to notify stale identity card job", job.id, error);
      }
    } else {
      requeued += 1;
      await queue.send({ kind: "identity_card", jobId: job.id });
    }
  }

  return { requeued, failed };
}
