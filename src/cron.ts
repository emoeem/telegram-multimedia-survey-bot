import type { Env } from "./env";
import { parseAdminIds } from "./core/admin-ids";
import { notifyMaintenanceBudgetExhausted } from "./http/guard";
import { sendMessage } from "./bot/telegram";
import { migrateDataUrlCoversToKv } from "./services/cover-storage.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import { sendCustomerHeartbeat } from "./services/customer-control.service";
import { createExportJobSender } from "./services/export-job-dispatch.service";
import { runDatabaseMaintenance } from "./services/database-maintenance.service";
import { createMediaStore } from "./services/media/temporary-media-store";
import { cleanupExpiredTemporaryMedia, retainFinishedResponseMedia } from "./services/media/temporary-media.service";
import { sweepStaleStreamUploads } from "./services/media/stream.service";
import { recoverStaleImageGeneratorJobs } from "./services/image-generator-job-recovery.service";
import { recoverStaleResultVisualJobs } from "./services/result-visual-job-recovery.service";
import { retryPendingReportDeliveries } from "./services/report-delivery.service";
import { loadSystemSettings } from "./services/system-settings.service";
import { loadWeeklyDigest, renderWeeklyDigestMessage } from "./services/weekly-digest.service";

/**
 * scheduled 入口（所有 cron 触发的召回/自愈/维护任务）。原为 src/index.ts 的
 * scheduled 方法（拆分见 docs/OPTIMIZATION_BACKLOG_2026-11-14.md §D）。
 */
export async function cron(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === "30 9 * * 1") {
    // Weekly operations digest to the report archive channel.
    try {
      const settings = await loadSystemSettings(env.DB);
      const channelRaw = (settings.reportChannelId || env.REPORT_CHANNEL_ID || "").trim();
      const channelId = Number(channelRaw);
      if (!Number.isInteger(channelId) || channelId === 0) return;
      const digest = await loadWeeklyDigest(env.DB);
      await sendMessage(env.BOT_TOKEN, channelId, renderWeeklyDigestMessage(digest));
      console.info("Weekly digest sent", { started: digest.started, completed: digest.completed });
    } catch (error) {
      console.error("Weekly digest failed", error);
    }
    return;
  }
  if (event.cron === "*/30 * * * *") {
    if (env.DEPLOYMENT_ROLE === "customer") {
      try {
        await sendCustomerHeartbeat(env);
      } catch (error) {
        console.warn("Customer Worker heartbeat failed", error);
      }
    }
    // These recovery jobs touch independent queues/tables. Run them concurrently so
    // one slow renderer cannot delay the other recovery paths for a full cron tick.
    await Promise.allSettled([
      (async () => {
        try {
          const summary = await retryPendingReportDeliveries(env.DB, createExportJobSender(env));
          if (summary.terminalFailed > 0) {
            // 终态失败 = 那份答卷的归档重试已烧完次数、永久停在过去（管理端
            // 手动重投是唯一出路）。单独的 ERROR 行给告警过滤器抓，普通 info
            // 行会被 30 分钟一次的 cron 输出淹没。
            console.error(
              "report_delivery_terminal",
              JSON.stringify({ type: "report_delivery_terminal", count: summary.terminalFailed }),
            );
          }
          if (summary.requeued > 0) {
            console.info("Requeued pending report deliveries", summary);
          }
        } catch (error) {
          console.error("Report delivery retry driver failed", error);
        }
      })(),
      (async () => {
        try {
          const summary = await recoverStaleResultVisualJobs(env.DB, createExportJobSender(env), env.BOT_TOKEN);
          if (summary.requeued || summary.failed) console.warn("Recovered stale result visual jobs", summary);
        } catch (error) {
          console.error("Result visual job recovery failed", error);
        }
      })(),
      (async () => {
        try {
          const summary = await recoverStaleImageGeneratorJobs(env.DB, createExportJobSender(env), env.BOT_TOKEN);
          if (summary.requeued || summary.failed) console.warn("Recovered stale image generator jobs", summary);
        } catch (error) {
          console.error("Image generator job recovery failed", error);
        }
      })(),
      (async () => {
        try {
          const migrated = await migrateDataUrlCoversToKv(env.DB, env);
          if (migrated > 0) {
            console.info("Migrated data-URL covers into MEDIA_KV", { migrated });
          }
        } catch (error) {
          console.error("Cover KV migration failed", error);
        }
      })(),
    ]);
    return;
  }
  let maintenanceSummary: Awaited<ReturnType<typeof runDatabaseMaintenance>> | null = null;
  let mediaRetentionSummary: Awaited<ReturnType<typeof retainFinishedResponseMedia>> | null = null;
  try {
    // 传入媒体存储：孤儿清扫要在删行后回收无 TTL 的内容寻址 blob（0091）。
    maintenanceSummary = await runDatabaseMaintenance(
      env.DB,
      Date.now(),
      createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }),
    );
    if (maintenanceSummary.truncated) {
      await notifyMaintenanceBudgetExhausted(env, maintenanceSummary.rowsRead);
    }
  } catch (error) {
    console.error("Database maintenance failed", error);
  }
  try {
    // Rescue attachments of finished responses before the expiry sweep can
    // delete a blob whose previews are still expected to work.
    mediaRetentionSummary = await retainFinishedResponseMedia(
      env.DB,
      createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }),
    );
  } catch (error) {
    console.error("Response media retention sweep failed", error);
  }
  if (maintenanceSummary) {
    console.info("Database maintenance complete", {
      ...maintenanceSummary,
      mediaRetention: mediaRetentionSummary,
    });
  } else if (mediaRetentionSummary?.scanned) {
    console.info("Database maintenance media retention", { mediaRetention: mediaRetentionSummary });
  }
  try {
    const summary = await cleanupExpiredTemporaryMedia(
      env.DB,
      createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }),
    );
    if (summary.deleted > 0) {
      console.info("Expired temporary media cleaned", summary);
    }
  } catch (error) {
    console.error("Temporary media cleanup failed", error);
  }
  try {
    // Stream 直传凭证对账（Pro 部署）：未完成的凭证删对象 + 失效行。
    const streamSweep = await sweepStaleStreamUploads(env.DB, env);
    if (streamSweep.deleted > 0 || streamSweep.failed > 0) {
      console.info("Stale stream uploads swept", streamSweep);
    }
  } catch (error) {
    console.error("Stream upload sweep failed", error);
  }
  if (!env.LICENSE_ADMIN_TOKEN) return;
  const adminIds = parseAdminIds(env.ADMIN_IDS);
  try {
    await sendCreatorTrialExpiryReminders(env.DB, env.CACHE, env.BOT_TOKEN, adminIds);
  } catch (error) {
    console.error("Creator trial expiry reminders failed", error);
  }
}
