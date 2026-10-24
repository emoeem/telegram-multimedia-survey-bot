import { sendMessage } from "../bot/telegram";
import type { ResultVisualJobMessage } from "./result-visual-queue.service";

interface StaleRenderJob {
  id: number;
  chat_id: number | null;
  attempts: number;
}

// How long a render may stay `processing` before the recovery sweep reclaims
// it. This must comfortably exceed the worst legitimate render: multi-page
// HTML reports render up to 20 pages with up to 3 attempts each, and image
// resolution downloads Telegram files sequentially (20s timeout each). The old
// 2-minute cutoff reclaimed *live* jobs, let a second consumer claim the same
// job, and delivered the report twice to the user. 30 minutes matches the
// `*/30` cron interval and is far above any healthy render while still
// recovering a genuinely hung worker within one or two ticks.
const staleProcessingMs = 30 * 60_000;

export async function recoverStaleResultVisualJobs(
  db: D1Database,
  queue: Queue,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now - staleProcessingMs).toISOString();
  const result = await db
    .prepare(
      `SELECT id, chat_id, attempts FROM render_jobs
     WHERE status = 'processing' AND COALESCE(started_at, created_at) < ?
     ORDER BY id ASC LIMIT 20`,
    )
    .bind(cutoff)
    .all<StaleRenderJob>();

  let requeued = 0;
  let failed = 0;
  for (const job of result.results ?? []) {
    const terminal = job.attempts >= 3;
    const update = await db
      .prepare(
        `UPDATE render_jobs SET status = ?, error_code = ?, error_message = ?,
         completed_at = ?
       WHERE id = ? AND status = 'processing'
         AND COALESCE(started_at, created_at) < ?`,
      )
      .bind(
        terminal ? "failed" : "queued",
        terminal ? "render_timeout" : null,
        terminal ? "结果报告生成超时" : null,
        terminal ? new Date(now).toISOString() : null,
        job.id,
        cutoff,
      )
      .run();
    if (!update.meta?.changes) continue;
    if (terminal) {
      failed += 1;
      if (job.chat_id !== null) {
        try {
          await sendMessage(botToken, job.chat_id, "❌ 结果报告生成超时，请回到问卷完成界面重新选择模板。");
        } catch (error) {
          console.error("Failed to notify stale result visual job", job.id, error);
        }
      }
    } else {
      requeued += 1;
      await queue.send({ kind: "result_visual", jobId: job.id } satisfies ResultVisualJobMessage);
    }
  }
  return { requeued, failed };
}
