import type { User } from "../schema";

export interface CreatorTrialGrant {
  id: number;
  userId: number;
  grantedBy: number | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface CreatorTrialGrantRow {
  id: number;
  user_id: number;
  granted_by: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function mapGrant(row: CreatorTrialGrantRow): CreatorTrialGrant {
  return {
    id: row.id,
    userId: row.user_id,
    grantedBy: row.granted_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function hasActiveCreatorTrial(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM creator_trial_grants WHERE user_id = ? AND expires_at > ? LIMIT 1",
    )
    .bind(userId, new Date().toISOString())
    .first<{ id: number }>();
  return Boolean(row);
}

export async function grantCreatorTrial(
  db: D1Database,
  input: { userId: number; grantedBy: number; days: number },
): Promise<CreatorTrialGrant> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.days * 86_400_000).toISOString();
  const timestamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO creator_trial_grants (user_id, granted_by, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         granted_by = excluded.granted_by,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(input.userId, input.grantedBy, expiresAt, timestamp, timestamp)
    .run();
  const row = await db
    .prepare("SELECT * FROM creator_trial_grants WHERE user_id = ? LIMIT 1")
    .bind(input.userId)
    .first<CreatorTrialGrantRow>();
  if (!row) throw new Error("体验创作者授权保存失败");
  return mapGrant(row);
}

export async function revokeCreatorTrial(
  db: D1Database,
  userId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM creator_trial_grants WHERE user_id = ?")
    .bind(userId)
    .run();
}

export async function listActiveCreatorTrials(
  db: D1Database,
  limit = 30,
): Promise<Array<CreatorTrialGrant & { user: User }>> {
  const result = await db
    .prepare(
      `SELECT t.*, u.telegram_user_id, u.username, u.first_name, u.last_name,
              u.language_code, u.system_role, u.bot_started_at, u.created_at AS user_created_at,
              u.updated_at AS user_updated_at
       FROM creator_trial_grants t
       JOIN users u ON u.id = t.user_id
       WHERE t.expires_at > ?
       ORDER BY t.expires_at ASC
       LIMIT ?`,
    )
    .bind(new Date().toISOString(), limit)
    .all<CreatorTrialGrantRow & {
      telegram_user_id: number;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      language_code: string | null;
      system_role: User["systemRole"];
      bot_started_at: string | null;
      user_created_at: string;
      user_updated_at: string;
    }>();
  return (result.results ?? []).map((row) => ({
    ...mapGrant(row),
    user: {
      id: row.user_id,
      telegramUserId: row.telegram_user_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      languageCode: row.language_code,
      systemRole: row.system_role,
      botStartedAt: row.bot_started_at,
      bannedAt: null,
      bannedBy: null,
      banReason: null,
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at,
    },
  }));
}

export async function listCreatorTrialsExpiringBefore(
  db: D1Database,
  expiresBefore: string,
): Promise<Array<CreatorTrialGrant & { user: User }>> {
  const result = await db.prepare(
    `SELECT t.*, u.telegram_user_id, u.username, u.first_name, u.last_name,
            u.language_code, u.system_role, u.bot_started_at, u.created_at AS user_created_at,
            u.updated_at AS user_updated_at
     FROM creator_trial_grants t JOIN users u ON u.id = t.user_id
     WHERE t.expires_at > ? AND t.expires_at <= ? ORDER BY t.expires_at ASC`,
  ).bind(new Date().toISOString(), expiresBefore).all<CreatorTrialGrantRow & {
    telegram_user_id: number; username: string | null; first_name: string | null;
    last_name: string | null; language_code: string | null; system_role: User["systemRole"];
    bot_started_at: string | null;
    user_created_at: string; user_updated_at: string;
  }>();
  return (result.results ?? []).map((row) => ({
    ...mapGrant(row),
    user: {
      id: row.user_id, telegramUserId: row.telegram_user_id, username: row.username,
      firstName: row.first_name, lastName: row.last_name, languageCode: row.language_code,
      systemRole: row.system_role, botStartedAt: row.bot_started_at, bannedAt: null, bannedBy: null, banReason: null, createdAt: row.user_created_at, updatedAt: row.user_updated_at,
    },
  }));
}
