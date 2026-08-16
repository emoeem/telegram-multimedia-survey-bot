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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
