import { createExportJob } from "../db/repositories/export.repository";
import type { BotContext } from "../bot/types";

export async function enqueueExportJob(
  ctx: BotContext,
  input: {
    surveyId: number;
    userId: number | null;
    format: "csv" | "xlsx" | "zip";
  },
): Promise<number> {
  const job = await createExportJob(ctx.db, {
    surveyId: input.surveyId,
    requestedBy: input.userId,
    format: input.format,
  });

  await ctx.exportQueue.send({
    jobId: job.id,
    surveyId: input.surveyId,
    format: input.format,
  });

  return job.id;
}
