import { sendMessage } from "../bot/telegram";
import type { ImageGeneratorJobMessage } from "./image-generator-worker.service";

interface StaleImageGeneratorJob {
  id: number;
  chat_id: number | null;
  attempts: number;
}

// `image_generator_jobs` has no started_at, so age is measured from created_at.
// Image generation is a fast WASM render, so anything still `processing` half
// an hour after creation is a dead invocation rather than a slow one.
const staleProcessingMs = 30 * 60_000;

/**
 * Recovers image generator jobs left in `processing` by a Worker that died
 * mid-render. The worker's claim only accepts `status='queued'`, and a
 * redelivered message whose claim fails is acked, so without this sweep such a
 * job stays `processing` forever (no retry, no notification, and maintenance
 * only deletes `completed`/`failed` rows).
 */
export async function recoverStaleImageGeneratorJobs(
  db: D1Database,
  queue: Queue,
  botToken: string,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now - staleProcessingMs).toISOString();
  const result = await db
    .prepare(
      `SELECT id, chat_id, attempts FROM image_generator_jobs
       WHERE status = 'processing' AND created_at < ?
       ORDER BY id ASC LIMIT 20`,
    )
    .bind(cutoff)
    .all<StaleImageGeneratorJob>();

  let requeued = 0;
  let failed = 0;
  for (const job of result.results ?? []) {
    const terminal = job.attempts >= 3;
    const update = await db
      .prepare(
        `UPDATE image_generator_jobs
         SET status = ?, error_message = ?, completed_at = ?
         WHERE id = ? AND status = 'processing' AND created_at < ?`,
      )
      .bind(
        terminal ? "failed" : "queued",
        terminal ? "图像生成超时" : null,
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
          await sendMessage(botToken, job.chat_id, "❌ 图像生成超时，请稍后重新生成。");
        } catch (error) {
          console.error("Failed to notify stale image generator job", job.id, error);
        }
      }
    } else {
      requeued += 1;
      await queue.send({ kind: "image_generator", jobId: job.id } satisfies ImageGeneratorJobMessage);
    }
  }
  return { requeued, failed };
}
