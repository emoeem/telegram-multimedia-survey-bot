import { sendMessage, sendPhoto } from "../bot/telegram";
import { renderIdentityCardPng } from "../bot/identity-card-handler";
import { getIdentityProfileById } from "../db/repositories/identity-card.repository";

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
}

export function isIdentityCardJobMessage(value: unknown): value is IdentityCardJobMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.kind === "identity_card"
    && Number.isSafeInteger(message.jobId)
    && Number(message.jobId) > 0;
}

export async function processIdentityCardMessage(
  env: IdentityCardWorkerEnvironment,
  body: unknown,
): Promise<void> {
  if (!isIdentityCardJobMessage(body)) {
    console.error("Invalid identity card queue message", body);
    return;
  }

  const job = await env.DB.prepare(
    `SELECT id, identity_profile_id, chat_id
     FROM identity_card_jobs WHERE id = ? LIMIT 1`,
  ).bind(body.jobId).first<IdentityCardJobRow>();
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
  ).bind(
    new Date().toISOString(),
    job.id,
    new Date(Date.now() - 2 * 60_000).toISOString(),
  ).run();
  if (!(claim.meta?.changes)) return;

  const identity = await getIdentityProfileById(env.DB, job.identity_profile_id);
  if (!identity) throw new Error("identity profile not found");
  const png = await renderIdentityCardPng(env.DB, env.BOT_TOKEN, identity);
  await sendPhoto(env.BOT_TOKEN, job.chat_id, png, "🎨 你的自定义身份卡已生成");
  await env.DB.prepare(
    "UPDATE identity_card_jobs SET status = 'completed', completed_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), job.id).run();
}

export async function retryIdentityCardJob(
  db: D1Database,
  jobId: number,
  error: string,
  terminal: boolean,
): Promise<void> {
  await db.prepare(
    `UPDATE identity_card_jobs
     SET status = ?, error_message = ?, completed_at = ?, processing_started_at = NULL
     WHERE id = ?`,
  ).bind(
    terminal ? "failed" : "queued",
    error.slice(0, 500),
    terminal ? new Date().toISOString() : null,
    jobId,
  ).run();
}

export async function notifyIdentityCardFailure(
  env: IdentityCardWorkerEnvironment,
  jobId: number,
): Promise<void> {
  const job = await env.DB.prepare(
    "SELECT chat_id FROM identity_card_jobs WHERE id = ? LIMIT 1",
  ).bind(jobId).first<{ chat_id: number }>();
  if (!job) return;
  try {
    await sendMessage(
      env.BOT_TOKEN,
      job.chat_id,
      "❌ 身份卡生成失败，请稍后重新制作。",
    );
  } catch (error) {
    console.error("Failed to notify identity card requester", jobId, error);
  }
}
