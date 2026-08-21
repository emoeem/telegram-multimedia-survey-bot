import {
  createRenderJob,
  failRenderJob,
  findActiveRenderJob,
} from "../db/repositories/result-visual.repository";
import type { RenderJob } from "../db/schema";

export interface ResultVisualJobMessage {
  kind: "result_visual";
  jobId: number;
}

export type ResultVisualEnqueueResult =
  | { status: "queued"; job: RenderJob }
  | { status: "processing"; job: RenderJob };

export function isResultVisualJobMessage(value: unknown): value is ResultVisualJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "result_visual" && Number.isInteger(message.jobId) && Number(message.jobId) > 0;
}

export async function enqueueResultVisualJob(
  db: D1Database,
  queue: Queue,
  input: {
    resultProfileId: number;
    templateId: number;
    templateVersion: number;
    chatId: number | null;
    requestedBy: number | null;
    forceRegenerate?: boolean;
  },
): Promise<ResultVisualEnqueueResult> {
  const forceRegenerate = input.forceRegenerate === true;
  const activeJob = await findActiveRenderJob(
    db,
    input.resultProfileId,
    input.templateId,
    input.templateVersion,
  );
  if (activeJob) {
    return activeJob.status === "processing"
      ? { status: "processing", job: activeJob }
      : { status: "queued", job: activeJob };
  }

  const job = await createRenderJob(db, {
    ...input,
    forceRegenerate,
  });
  try {
    await queue.send({ kind: "result_visual", jobId: job.id } satisfies ResultVisualJobMessage);
  } catch (error) {
    await failRenderJob(db, job.id, {
      code: "queue_enqueue_failed",
      message: error instanceof Error ? error.message : "Unable to enqueue result visual job",
    });
    throw error;
  }
  return { status: "queued", job };
}
