import type { Env } from "../index";
import { resolveParticipant, type Participant } from "../http/survey/participant";
import { fail } from "../http/api-response";
import { nowIso } from "../db/client";

/**
 * 内容分级（0080）。两档：全年龄与 r18。枚举只在应用层——未来扩展
 * （如 mature）不改表，读侧 SQL 只依赖 `content_rating = 'all'` 这一个
 * 判断，所以新增档位自动归入「受限」侧。
 */
export const CONTENT_RATINGS = ["all", "r18"] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

/** Lax 校验：数据库里只会是这两档，但 admin API 的输入要过这里。 */
export function normalizeContentRating(value: unknown): ContentRating | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (CONTENT_RATINGS as readonly string[]).includes(normalized) ? (normalized as ContentRating) : null;
}

export function isRestrictedRating(rating: string | null | undefined): boolean {
  return rating === "r18";
}

/** 未确认年龄的查看者能否看到该内容。 */
export function viewerCanSeeRating(ageVerifiedAt: string | null | undefined, rating: string | null | undefined): boolean {
  return !isRestrictedRating(rating) || Boolean(ageVerifiedAt);
}

export interface AgeAttestation {
  participantHash: string;
  ageVerifiedAt: string | null;
}

export async function getAgeAttestation(db: D1Database, participantHash: string): Promise<AgeAttestation | null> {
  return db
    .prepare("SELECT participant_hash participantHash, age_verified_at ageVerifiedAt FROM participant_preferences WHERE participant_hash = ? LIMIT 1")
    .bind(participantHash)
    .first<AgeAttestation>();
}

export async function setAgeVerified(db: D1Database, participantHash: string, verified: boolean): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO participant_preferences (participant_hash, age_verified_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(participant_hash) DO UPDATE SET
         age_verified_at = excluded.age_verified_at,
         updated_at = excluded.updated_at`,
    )
    .bind(participantHash, verified ? timestamp : null, timestamp)
    .run();
}

/**
 * Best-effort 查看者年龄确认状态：有身份头就解析并查 attestation，没有或
 * 解析失败一律视为未确认（返回 false），绝不因身份缺失抛 401——公开列表
 * 页的匿名访客走这里。
 */
export async function resolveViewerAgeVerified(request: Request, env: Env): Promise<boolean> {
  const hasIdentity =
    request.headers.get("x-telegram-init-data") ||
    request.headers.get("x-participant-token") ||
    request.headers.get("x-email-session") ||
    request.headers.get("x-participant-key");
  if (!hasIdentity) return false;
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return false;
  return isParticipantAgeVerified(env.DB, participant);
}

export async function isParticipantAgeVerified(db: D1Database, participant: Participant): Promise<boolean> {
  const attestation = await getAgeAttestation(db, participant.participantHash);
  return Boolean(attestation?.ageVerifiedAt);
}

/**
 * r18 内容的交互门：definition / 开始作答等入口在问卷为 r18 且查看者未确认
 * 年龄时返回 451（前端弹年龄确认门，确认后重试）。与访问密码、金币解锁并
 * 列的第三道入口层，但不替代它们。
 */
export async function ageGateResponse(
  env: Env,
  request: Request,
  survey: { contentRating?: string | null },
): Promise<Response | null> {
  if (!isRestrictedRating(survey.contentRating)) return null;
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) {
    // 未带身份头：无法记录 attestation，直接挡下（SPA 始终携带 key 头，
    // 走到这里的多是直链爬虫/预览器，451 + 提示是正确行为）。
    return fail(451, "age_restricted", "该内容为 18+ 内容，请先确认年龄后访问。");
  }
  if (await isParticipantAgeVerified(env.DB, participant)) return null;
  return fail(451, "age_restricted", "该内容为 18+ 内容，请先确认年龄后访问。");
}

/**
 * {@link ageGateResponse} 的已解析形态：调用方已经同时持有问卷行与参与者
 * （作答/提交/上传路径），避免二次解析身份。全年龄问卷零额外成本。
 */
export async function r18ParticipantGate(
  db: D1Database,
  survey: { contentRating?: string | null },
  participant: Participant,
): Promise<Response | null> {
  if (!isRestrictedRating(survey.contentRating)) return null;
  if (await isParticipantAgeVerified(db, participant)) return null;
  return fail(451, "age_restricted", "该内容为 18+ 内容，请先确认年龄后访问。");
}
