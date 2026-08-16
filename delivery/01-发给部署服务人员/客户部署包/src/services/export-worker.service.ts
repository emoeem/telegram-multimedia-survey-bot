import {
  getExportJobById,
  updateExportJob,
} from "../db/repositories/export.repository";
import {
  buildCsv,
  serializeExport,
} from "./export.service";
import type { SurveyExportJobMessage } from "./export-queue.service";
import { getExportRows } from "./export.service";
import { sendDocument, sendMessage } from "../bot/telegram";

interface ExportWorkerEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
}

function isExportJobMessage(value: unknown): value is SurveyExportJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    Number.isInteger(message.jobId) &&
    Number(message.jobId) > 0 &&
    Number.isInteger(message.surveyId) &&
    Number(message.surveyId) > 0 &&
    Number.isInteger(message.chatId) &&
    typeof message.format === "string" &&
    ["csv", "xlsx", "zip"].includes(message.format)
  );
}

function exportFileMetadata(
  surveyId: number,
  format: SurveyExportJobMessage["format"],
): { fileName: string; contentType: string } {
  if (format === "xlsx") {
    return {
      fileName: `survey-${surveyId}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (format === "zip") {
    return { fileName: `survey-${surveyId}.zip`, contentType: "application/zip" };
  }
  return { fileName: `survey-${surveyId}.csv`, contentType: "text/csv" };
}

async function processExportMessage(
  env: ExportWorkerEnvironment,
  body: unknown,
): Promise<void> {
  if (!isExportJobMessage(body)) {
    console.error("Invalid export queue message", body);
    return;
  }

  const job = await getExportJobById(env.DB, body.jobId);
  if (!job || job.status !== "pending") return;

  await updateExportJob(env.DB, job.id, { status: "running" });
  try {
    const { rows } = await getExportRows(env.DB, body.surveyId);
    const csv = buildCsv(rows);
    const content = serializeExport(body.format, csv, rows);
    const metadata = exportFileMetadata(body.surveyId, body.format);
    await sendDocument(
      env.BOT_TOKEN,
      body.chatId,
      metadata.fileName,
      content,
      metadata.contentType,
    );
    await updateExportJob(env.DB, job.id, { status: "completed" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "导出文件生成失败";
    console.error("Survey export job failed", job.id, error);
    await updateExportJob(env.DB, job.id, {
      status: "failed",
      errorMessage: errorMessage.slice(0, 500),
    });
    try {
      await sendMessage(env.BOT_TOKEN, body.chatId, "导出失败，请稍后重新发起导出。");
    } catch (notificationError) {
      console.error("Failed to notify export requester", job.id, notificationError);
    }
  }
}

export async function handleExportQueue(
  batch: MessageBatch<unknown>,
  env: ExportWorkerEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    await processExportMessage(env, message.body);
    message.ack();
  }
}
