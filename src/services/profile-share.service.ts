import { nowIso } from "../db/client";
import { HASH_SET_SQL } from "./identity-link.service";
import { listParticipantAchievements } from "../db/repositories/achievement.repository";

/**
 * 个人画像分享（Wrapped，0085）：跨问卷累计数据的可分享公开页。
 *
 * 快照字段全部是聚合数字/枚举——不含任何答案原文、报告内容或身份信息；
 * display_name 只取 TG first_name（平台昵称语义），匿名身份显示缺省称呼。
 */

export interface ProfileSnapshot {
  completedSurveys: number;
  achievements: number;
  achievementTitles: string[];
  endingsCollected: number;
  trialBestScore: number;
  trialRuns: number;
  since: string | null;
}

export interface ProfileShareRow {
  id: number;
  token: string;
  participantHash: string;
  displayName: string;
  snapshot: ProfileSnapshot;
  viewCount: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function mapRow(row: Record<string, unknown>): ProfileShareRow {
  let snapshot: ProfileSnapshot = {
    completedSurveys: 0,
    achievements: 0,
    achievementTitles: [],
    endingsCollected: 0,
    trialBestScore: 0,
    trialRuns: 0,
    since: null,
  };
  try {
    const parsed = JSON.parse(String(row.snapshot_json ?? "{}")) as Partial<ProfileSnapshot>;
    snapshot = {
      completedSurveys: Number(parsed.completedSurveys ?? 0),
      achievements: Number(parsed.achievements ?? 0),
      achievementTitles: Array.isArray(parsed.achievementTitles) ? parsed.achievementTitles.map(String) : [],
      endingsCollected: Number(parsed.endingsCollected ?? 0),
      trialBestScore: Number(parsed.trialBestScore ?? 0),
      trialRuns: Number(parsed.trialRuns ?? 0),
      since: typeof parsed.since === "string" ? parsed.since : null,
    };
  } catch {
    // 脏快照按全零处理，公开页不能 500。
  }
  return {
    id: Number(row.id),
    token: String(row.token),
    participantHash: String(row.participant_hash),
    displayName: String(row.display_name ?? ""),
    snapshot,
    viewCount: Number(row.view_count ?? 0),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 从并集读侧聚合画像快照。 */
export async function buildProfileSnapshot(db: D1Database, participantHash: string): Promise<ProfileSnapshot> {
  const hashes = participantHash.startsWith("user_")
    ? await db
        .prepare("SELECT source_hash FROM participant_hash_links WHERE canonical_hash = ?")
        .bind(participantHash)
        .all<{ source_hash: string }>()
        .then((rows) => [participantHash, ...(rows.results ?? []).map((row) => row.source_hash)])
    : [participantHash];
  const hashPlaceholders = hashes.map(() => "?").join(",");

  const [responseStats, trialStats, endingStats, sinceRow, achievements] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM survey_responses
         WHERE participant_hash IN (${hashPlaceholders}) AND status IN ('completed', 'archived')`,
      )
      .bind(...hashes)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(MAX(CASE WHEN status = 'completed' THEN score ELSE 0 END), 0) AS best
         FROM task_runs WHERE participant_hash IN (${hashPlaceholders})`,
      )
      .bind(...hashes)
      .first<{ runs: number; best: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM gacha_pulls p
         JOIN gacha_pool_items i ON i.id = p.item_id
         WHERE p.participant_hash ${HASH_SET_SQL} AND i.content_type = 'ending'`,
      )
      .bind(participantHash, participantHash)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT MIN(COALESCE(completed_at, created_at)) AS first FROM survey_responses
         WHERE participant_hash IN (${hashPlaceholders}) AND status IN ('completed', 'archived')`,
      )
      .bind(...hashes)
      .first<{ first: string | null }>(),
    listParticipantAchievements(db, participantHash),
  ]);

  return {
    completedSurveys: Number(responseStats?.n ?? 0),
    achievements: achievements.length,
    achievementTitles: achievements.slice(0, 3).map((row) => String(row.code)),
    endingsCollected: Number(endingStats?.n ?? 0),
    trialBestScore: Number(trialStats?.best ?? 0),
    trialRuns: Number(trialStats?.runs ?? 0),
    since: sinceRow?.first ?? null,
  };
}

/** 幂等创建/刷新：同一参与者只有一份画像（token 不变，快照与昵称刷新）。 */
export async function upsertProfileShare(
  db: D1Database,
  input: { participantHash: string; displayName: string },
): Promise<ProfileShareRow> {
  const snapshot = await buildProfileSnapshot(db, input.participantHash);
  const timestamp = nowIso();
  const existing = await db
    .prepare("SELECT id FROM profile_shares WHERE participant_hash = ? AND revoked_at IS NULL LIMIT 1")
    .bind(input.participantHash)
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare("UPDATE profile_shares SET snapshot_json = ?, display_name = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(snapshot), input.displayName, timestamp, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO profile_shares (token, participant_hash, display_name, snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(randomToken(), input.participantHash, input.displayName, JSON.stringify(snapshot), timestamp, timestamp)
      .run();
  }
  const row = await db
    .prepare(
      `SELECT id, token, participant_hash, display_name, snapshot_json, view_count, revoked_at, created_at, updated_at
       FROM profile_shares WHERE participant_hash = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(input.participantHash)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("profile_share_insert_failed");
  return mapRow(row);
}

export async function getActiveProfileShareByToken(db: D1Database, token: string): Promise<ProfileShareRow | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT id, token, participant_hash, display_name, snapshot_json, view_count, revoked_at, created_at, updated_at
       FROM profile_shares WHERE token = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(token)
    .first<Record<string, unknown>>();
  return row ? mapRow(row) : null;
}

export async function getActiveProfileShareFor(db: D1Database, participantHash: string): Promise<ProfileShareRow | null> {
  const row = await db
    .prepare(
      `SELECT id, token, participant_hash, display_name, snapshot_json, view_count, revoked_at, created_at, updated_at
       FROM profile_shares WHERE participant_hash = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(participantHash)
    .first<Record<string, unknown>>();
  return row ? mapRow(row) : null;
}

export async function revokeProfileShare(db: D1Database, participantHash: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE profile_shares SET revoked_at = ?, updated_at = ? WHERE participant_hash = ? AND revoked_at IS NULL")
    .bind(nowIso(), nowIso(), participantHash)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
