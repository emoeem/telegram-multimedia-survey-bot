import type { BrowserWorker } from "@cloudflare/puppeteer";
import { sendMessage, sendPhoto } from "../bot/telegram";
import { renderIdentityCardReportPng, storeIdentityCardPng } from "./identity-card-report.service";
import { getIdentityProfileById, setIdentityProfileCardAsset } from "../db/repositories/identity-card.repository";
import { mirrorIdentityCardToChannel } from "./plaza-channel.service";

export interface IdentityCardJobMessage {
  kind: "identity_card";
  jobId: number;
}

interface IdentityCardJobRow {
  id: number;
  identity_profile_id: number;
  chat_id: number;
}

export interface IdentityCardWorkerEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
  MEDIA_KV?: KVNamespace;
  MEDIA?: R2Bucket;
  PLAZA_CHANNEL_ID?: string;
}

export function isIdentityCardJobMessage(value: unknown): value is IdentityCardJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "identity_card" && Number.isSafeInteger(message.jobId) && Number(message.jobId) > 0;
}

export async function processIdentityCardMessage(env: IdentityCardWorkerEnvironment, body: unknown): Promise<void> {
  if (!isIdentityCardJobMessage(body)) {
    console.error("Invalid identity card queue message", body);
    return;
  }

  const job = await env.DB.prepare(
    `SELECT id, identity_profile_id, chat_id
     FROM identity_card_jobs WHERE id = ? LIMIT 1`,
  )
    .bind(body.jobId)
    .first<IdentityCardJobRow>();
  if (!job) return;

  const claim = await env.DB.prepare(
    `UPDATE identity_card_jobs
     SET status = 'processing', attempts = attempts + 1, error_message = NULL,
         processing_started_at = ?
     WHERE id = ? AND (
       status = 'queued' OR (
         status = 'processing' AND COALESCE(processing_started_at, created_at) < ?
       )
     )`,
  )
    .bind(new Date().toISOString(), job.id, new Date(Date.now() - 2 * 60_000).toISOString())
    .run();
  if (!claim.meta?.changes) return;

  const identity = await getIdentityProfileById(env.DB, job.identity_profile_id);
  if (!identity) throw new Error("identity profile not found");
  if (!env.BROWSER) throw new Error("BROWSER 未配置，无法渲染资料卡");
  const png = await renderIdentityCardReportPng({ ...env, BROWSER: env.BROWSER }, identity);
  const assetId = await storeIdentityCardPng(env, identity.id, png);
  if (assetId !== null) {
    await setIdentityProfileCardAsset(env.DB, identity.id, assetId);
  }
  const caption = identity.galleryPublished
    ? "🎨 你的资料卡已生成，并已发布到资料卡画廊。"
    : "🎨 你的资料卡已生成（仅自己可见）。";
  await sendPhoto(env.BOT_TOKEN, job.chat_id, png, caption);
  if (identity.galleryPublished) {
    await mirrorIdentityCardToChannel(env, identity, png);
  }
  await env.DB.prepare("UPDATE identity_card_jobs SET status = 'completed', completed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), job.id)
    .run();
}

export async function retryIdentityCardJob(
  db: D1Database,
  jobId: number,
  error: string,
  terminal: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE identity_card_jobs
     SET status = ?, error_message = ?, completed_at = ?, processing_started_at = NULL
     WHERE id = ?`,
    )
    .bind(terminal ? "failed" : "queued", error.slice(0, 500), terminal ? new Date().toISOString() : null, jobId)
    .run();
}

export async function notifyIdentityCardFailure(env: IdentityCardWorkerEnvironment, jobId: number): Promise<void> {
  const job = await env.DB.prepare("SELECT chat_id FROM identity_card_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<{ chat_id: number }>();
  if (!job) return;
  try {
    await sendMessage(env.BOT_TOKEN, job.chat_id, "❌ 资料卡生成失败，请稍后重新制作。");
  } catch (error) {
    console.error("Failed to notify identity card requester", jobId, error);
  }
}
