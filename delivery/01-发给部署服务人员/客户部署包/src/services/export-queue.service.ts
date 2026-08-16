import { createExportJob } from "../db/repositories/export.repository";
import type { BotContext } from "../bot/types";

export type SurveyExportFormat = "csv" | "xlsx" | "zip";

export interface SurveyExportJobMessage {
  jobId: number;
  surveyId: number;
  chatId: number;
  format: SurveyExportFormat;
}

export async function enqueueExportJob(
  ctx: BotContext,
  input: {
    surveyId: number;
    userId: number | null;
    chatId: number;
    format: SurveyExportFormat;
  },
): Promise<number> {
  const job = await createExportJob(ctx.db, {
    surveyId: input.surveyId,
    requestedBy: input.userId,
    format: input.format,
  });

  const message: SurveyExportJobMessage = {
    jobId: job.id,
    surveyId: input.surveyId,
    chatId: input.chatId,
    format: input.format,
  };
  await ctx.exportQueue.send(message);

  return job.id;
}
