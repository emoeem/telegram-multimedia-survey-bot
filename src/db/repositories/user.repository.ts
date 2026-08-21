import type { User, UserSystemRole } from "../schema";
import { nowIso, toBoolean } from "../client";

interface UserRow {
  id: number;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  system_role: string;
  bot_started_at?: string | null;
  banned_at?: string | null;
  banned_by?: number | null;
  ban_reason?: string | null;
  created_at: string;
  updated_at: string;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    languageCode: row.language_code,
    systemRole: row.system_role as UserSystemRole,
    botStartedAt: row.bot_started_at ?? null,
    bannedAt: row.banned_at ?? null,
    bannedBy: row.banned_by ?? null,
    banReason: row.ban_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface BotUserDirectoryPage {
  users: User[];
  total: number;
}

export async function getUserById(db: D1Database, id: number): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").bind(id).first<UserRow>();
  return row ? mapUser(row) : null;
}

export async function setUserBan(
  db: D1Database,
  userId: number,
  input: { banned: boolean; bannedBy: number | null; reason?: string | null },
): Promise<void> {
  await db.prepare(
    `UPDATE users SET banned_at = ?, banned_by = ?, ban_reason = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    input.banned ? nowIso() : null,
    input.banned ? input.bannedBy : null,
    input.banned ? input.reason?.trim().slice(0, 240) || null : null,
    nowIso(),
    userId,
  ).run();
}

export async function cancelActiveResponsesForUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare(
    `UPDATE survey_responses SET status = 'cancelled', updated_at = ?
     WHERE user_id = ? AND status = 'in_progress'`,
  ).bind(nowIso(), userId).run();
}

export async function markBotStarted(
  db: D1Database,
  telegramUserId: number,
): Promise<void> {
  const timestamp = nowIso();
  await db.prepare(
    "UPDATE users SET bot_started_at = COALESCE(bot_started_at, ?), updated_at = ? WHERE telegram_user_id = ?",
  ).bind(timestamp, timestamp, telegramUserId).run();
}

export async function listBotUsers(
  db: D1Database,
  limit = 8,
  offset = 0,
  search = "",
): Promise<BotUserDirectoryPage> {
  const safeLimit = Math.min(Math.max(limit, 1), 30);
  const safeOffset = Math.max(offset, 0);
  const normalizedSearch = search.trim().slice(0, 80);
  const numericId = /^\d+$/.test(normalizedSearch) ? Number(normalizedSearch) : null;
  const like = `%${normalizedSearch.toLowerCase()}%`;
  const where = normalizedSearch
    ? `bot_started_at IS NOT NULL AND (
         telegram_user_id = ? OR CAST(id AS TEXT) = ? OR lower(COALESCE(username, '')) LIKE ?
         OR lower(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?
       )`
    : "bot_started_at IS NOT NULL";
  const bindings = normalizedSearch ? [numericId ?? -1, normalizedSearch, like, like] : [];
  const [items, count] = await db.batch([
    db.prepare(
      `SELECT * FROM users WHERE ${where}
       ORDER BY bot_started_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, safeLimit, safeOffset),
    db.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${where}`).bind(...bindings),
  ]);
  return {
    users: ((items?.results ?? []) as UserRow[]).map(mapUser),
    total: Number((count?.results?.[0] as { count?: number } | undefined)?.count ?? 0),
  };
}

export async function getUserByTelegramId(
  db: D1Database,
  telegramUserId: number,
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE telegram_user_id = ? LIMIT 1")
    .bind(telegramUserId)
    .first<UserRow>();

  return row ? mapUser(row) : null;
}

export async function upsertUser(
  db: D1Database,
  input: {
    telegramUserId: number;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    languageCode?: string | null;
    systemRole?: UserSystemRole;
  },
): Promise<User> {
  const existing = await getUserByTelegramId(db, input.telegramUserId);
  const timestamp = nowIso();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO users (
          telegram_user_id, username, first_name, last_name,
          language_code, system_role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.telegramUserId,
        input.username ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        input.languageCode ?? null,
        input.systemRole ?? "participant",
        timestamp,
        timestamp,
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE users SET
          username = ?,
          first_name = ?,
          last_name = ?,
          language_code = ?,
          system_role = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .bind(
        input.username ?? existing.username,
        input.firstName ?? existing.firstName,
        input.lastName ?? existing.lastName,
        input.languageCode ?? existing.languageCode,
        input.systemRole ?? existing.systemRole,
        timestamp,
        existing.id,
      )
      .run();
  }

  const user = await getUserByTelegramId(db, input.telegramUserId);
  if (!user) {
    throw new Error("Failed to upsert user");
  }

  return user;
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const result = await db
    .prepare("SELECT * FROM users ORDER BY id ASC")
    .all<UserRow>();

  return (result.results ?? []).map(mapUser);
}
