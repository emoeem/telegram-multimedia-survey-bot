import type { RenderJob, RenderJobStatus } from "../schema";

interface RenderJobRow {
  id: number;
  result_profile_id: number;
  template_id: number;
  template_version: number;
  chat_id: number | null;
  requested_by: number | null;
  status: string;
  attempts: number;
  force_regenerate: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function mapRenderJob(row: RenderJobRow): RenderJob {
  return {
    id: row.id,
    resultProfileId: row.result_profile_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    chatId: row.chat_id,
    requestedBy: row.requested_by,
    status: row.status as RenderJobStatus,
    attempts: row.attempts,
    forceRegenerate: row.force_regenerate === 1,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getRenderJobById(db: D1Database, id: number): Promise<RenderJob | null> {
  const row = await db.prepare("SELECT * FROM render_jobs WHERE id = ? LIMIT 1").bind(id).first<RenderJobRow>();
  return row ? mapRenderJob(row) : null;
}

export async function findActiveRenderJob(
  db: D1Database,
  resultProfileId: number,
  templateId: number,
  templateVersion: number,
): Promise<RenderJob | null> {
  const row = await db.prepare(
    `SELECT * FROM render_jobs
     WHERE result_profile_id = ? AND template_id = ? AND template_version = ?
       AND status IN ('queued', 'processing')
     ORDER BY id DESC LIMIT 1`,
  ).bind(resultProfileId, templateId, templateVersion).first<RenderJobRow>();
  return row ? mapRenderJob(row) : null;
}

export async function createRenderJob(
  db: D1Database,
  input: {
    resultProfileId: number;
    templateId: number;
    templateVersion: number;
    chatId: number | null;
    requestedBy: number | null;
    forceRegenerate: boolean;
  },
): Promise<RenderJob> {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO render_jobs (
      result_profile_id, template_id, template_version, chat_id, requested_by,
      status, attempts, force_regenerate, created_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).bind(
    input.resultProfileId, input.templateId, input.templateVersion, input.chatId,
    input.requestedBy, input.forceRegenerate ? 1 : 0, timestamp,
  ).run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("Failed to create render job");
  const job = await getRenderJobById(db, id);
  if (!job) throw new Error("Failed to load created render job");
  return job;
}

export async function claimRenderJob(db: D1Database, id: number): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE render_jobs
     SET status = 'processing', attempts = attempts + 1, started_at = ?,
         error_code = NULL, error_message = NULL
     WHERE id = ? AND status = 'queued'`,
  ).bind(timestamp, id).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function completeRenderJob(
  db: D1Database,
  id: number,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.prepare(
    `UPDATE render_jobs SET status = 'completed', error_code = NULL,
      error_message = NULL, completed_at = ? WHERE id = ?`,
  ).bind(timestamp, id).run();
}

export async function releaseRenderJobForRetry(
  db: D1Database,
  id: number,
  input: { code: string; message: string },
): Promise<void> {
  await db.prepare(
    `UPDATE render_jobs SET status = 'queued', error_code = ?, error_message = ?
     WHERE id = ? AND status = 'processing'`,
  ).bind(input.code.slice(0, 100), input.message.slice(0, 500), id).run();
}

export async function failRenderJob(
  db: D1Database,
  id: number,
  input: { code: string; message: string },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.prepare(
    `UPDATE render_jobs SET status = 'failed', error_code = ?, error_message = ?,
      completed_at = ? WHERE id = ?`,
  ).bind(input.code.slice(0, 100), input.message.slice(0, 500), timestamp, id).run();
}
