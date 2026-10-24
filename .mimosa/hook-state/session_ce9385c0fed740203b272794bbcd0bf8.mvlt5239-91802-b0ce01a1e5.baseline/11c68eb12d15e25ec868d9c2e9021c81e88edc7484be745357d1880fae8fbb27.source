import { getResponseById } from "../db/repositories/response.repository";
import { BotContext, TelegramCallbackQuery } from "./types";
import { answerCallbackQuery, sendMessage } from "./telegram";
import {
  assertResponseAccess,
  sendResponseReportExport,
  sendSurveyExport,
  sendSurveyJsonExport,
  sendSurveySummaryPdf,
  showManagedResponseReportTemplates,
  showResponseDetail,
  showSurveyResponses,
} from "./survey-report";
import { requestConfiguredResultVisual } from "../services/result-visual.service";

export async function handleReportCallbacks(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
  chatId: number,
  userId: number,
  dbUserId: number,
  data: string,
): Promise<boolean> {
  if (data.startsWith("owner:response_export:")) {
    const [, , format, surveyIdRaw, responseIdRaw, responseNumberRaw] = data.split(":");
    if (format !== "pdf" && format !== "png" && format !== "pdf_private" && format !== "png_private") {
      await answerCallbackQuery(ctx.botToken, callback.id, "导出格式无效");
      return true;
    }
    await answerCallbackQuery(
      ctx.botToken,
      callback.id,
      format.startsWith("png") ? "正在生成手机版报告" : "正在生成高清 PDF",
    );
    try {
      if (format.startsWith("png")) {
        await assertResponseAccess(ctx, userId, Number(surveyIdRaw));
        await ctx.exportQueue.send({
          kind: "response_report",
          chatId,
          userId,
          surveyId: Number(surveyIdRaw),
          responseId: Number(responseIdRaw),
          responseNumber: Number(responseNumberRaw),
          format: "png",
          anonymize: format.endsWith("_private"),
        });
        await sendMessage(ctx.botToken, chatId, "📱 手机版报告已加入后台生成队列，完成后会发送到当前会话。");
        return true;
      }
      await sendResponseReportExport(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(responseIdRaw),
        Number(responseNumberRaw),
        format.startsWith("pdf") ? "pdf" : "png",
        format.endsWith("_private"),
      );
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "答卷导出失败。");
    }
    return true;
  }

  if (data.startsWith("owner:response_report_generate:")) {
    const [, , surveyIdRaw, responseIdRaw, templateIdRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    const responseId = Number(responseIdRaw);
    const templateId = Number(templateIdRaw);
    try {
      await assertResponseAccess(ctx, userId, surveyId);
      const response = await getResponseById(ctx.db, responseId);
      if (!response || response.surveyId !== surveyId || response.status !== "completed") {
        throw new Error("找不到可生成报告的已完成答卷");
      }
      const result = await requestConfiguredResultVisual(ctx.db, ctx.exportQueue, {
        responseId,
        chatId,
        requestedBy: dbUserId,
        templateId,
        forceRegenerate: true,
      });
      if (!result) throw new Error("所选报告模板不可用");
      await answerCallbackQuery(ctx.botToken, callback.id, "已开始生成");
      await sendMessage(ctx.botToken, chatId, "🎨 正在为这份答卷生成分析报告，完成后会发送到当前会话。");
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法生成分析报告");
    }
    return true;
  }

  if (data.startsWith("owner:response_report:")) {
    const [, , surveyIdRaw, responseIdRaw] = data.split(":");
    try {
      await showManagedResponseReportTemplates(ctx, chatId, userId, Number(surveyIdRaw), Number(responseIdRaw));
      await answerCallbackQuery(ctx.botToken, callback.id);
    } catch (error) {
      await answerCallbackQuery(ctx.botToken, callback.id, error instanceof Error ? error.message : "无法打开报告模板");
    }
    return true;
  }

  if (data.startsWith("owner:responses:")) {
    const [, , surveyIdRaw, offsetRaw] = data.split(":");
    await answerCallbackQuery(ctx.botToken, callback.id, "正在读取答卷");
    try {
      await showSurveyResponses(ctx, chatId, userId, Number(surveyIdRaw), Number(offsetRaw ?? 0));
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取答卷失败。");
    }
    return true;
  }

  if (data.startsWith("owner:response:")) {
    const [, , surveyIdRaw, responseIdRaw, responseNumberRaw, returnOffsetRaw] = data.split(":");
    await answerCallbackQuery(ctx.botToken, callback.id, "正在读取答卷");
    try {
      await showResponseDetail(
        ctx,
        chatId,
        userId,
        Number(surveyIdRaw),
        Number(responseIdRaw),
        Number(responseNumberRaw),
        Number(returnOffsetRaw ?? 0),
      );
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "读取答卷失败。");
    }
    return true;
  }

  if (data.startsWith("owner:export_json:")) {
    const surveyId = Number(data.slice("owner:export_json:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在导出 JSON");
    try {
      await sendSurveyJsonExport(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "导出失败。");
    }
    return true;
  }

  if (data.startsWith("owner:export:")) {
    const [, , formatRaw, surveyIdRaw] = data.split(":");
    const surveyId = Number(surveyIdRaw);
    if (formatRaw !== "csv" && formatRaw !== "zip") {
      await answerCallbackQuery(ctx.botToken, callback.id, "导出格式无效");
      return true;
    }
    await answerCallbackQuery(ctx.botToken, callback.id, "正在创建导出任务");
    try {
      await sendSurveyExport(ctx, chatId, userId, surveyId, formatRaw);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "导出失败。");
    }
    return true;
  }

  if (data.startsWith("owner:export_summary_pdf:")) {
    const surveyId = Number(data.slice("owner:export_summary_pdf:".length));
    await answerCallbackQuery(ctx.botToken, callback.id, "正在生成统计 PDF");
    try {
      await sendSurveySummaryPdf(ctx, chatId, userId, surveyId);
    } catch (error) {
      await sendMessage(ctx.botToken, chatId, error instanceof Error ? error.message : "统计 PDF 导出失败。");
    }
    return true;
  }

  return false;
}
