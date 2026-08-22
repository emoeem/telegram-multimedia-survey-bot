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

export interface UserDirectoryRow {
  id: number;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  system_role: string;
  banned_at: string | null;
  created_at: string;
  updated_at: string;
  completed_count: number;
  tags_json: string;
}

export interface UserDirectoryEntry {
  id: number;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  systemRole: string;
  bannedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedResponses: number;
  tags: string[];
}

function mapDirectoryRow(row: UserDirectoryRow): UserDirectoryEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json) as unknown;
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    systemRole: row.system_role,
    bannedAt: row.banned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedResponses: Number(row.completed_count ?? 0),
    tags,
  };
}

/** Admin user directory with tag/name search, for the Web Admin. */
export async function listUserDirectory(
  db: D1Database,
  input: {
    search?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: UserDirectoryEntry[]; total: number }> {
  const search = input.search?.trim() ?? "";
  const tag = input.tag?.trim() ?? "";
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const offset = Math.max(0, input.offset ?? 0);
  const searchPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (search) {
    where.push(
      "(u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR u.last_name LIKE ? ESCAPE '\\' OR CAST(u.telegram_user_id AS TEXT) LIKE ? ESCAPE '\\')",
    );
    binds.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM user_tags t WHERE t.user_id = u.id AND t.tag = ?)");
    binds.push(tag);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [itemsResult, countResult] = (await db.batch([
    db
      .prepare(
        `SELECT u.id, u.telegram_user_id, u.username, u.first_name, u.last_name,
                u.system_role, u.banned_at, u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM survey_responses r
                 WHERE r.user_id = u.id AND r.status = 'completed') AS completed_count,
                COALESCE((SELECT json_group_array(tag) FROM user_tags t
                          WHERE t.user_id = u.id), '[]') AS tags_json
         FROM users u
         ${whereSql}
         ORDER BY u.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset),
    db
      .prepare(`SELECT COUNT(*) AS count FROM users u ${whereSql}`)
      .bind(...binds),
  ])) as [
    D1Result<UserDirectoryRow>,
    D1Result<{ count: number }>,
  ];
  return {
    items: (itemsResult.results ?? []).map(mapDirectoryRow),
    total: Number(countResult.results?.[0]?.count ?? 0),
  };
}

export async function listUserTags(
  db: D1Database,
  userId: number,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT tag FROM user_tags WHERE user_id = ? ORDER BY id ASC`,
    )
    .bind(userId)
    .all<{ tag: string }>();
  return (result.results ?? []).map((row) => row.tag);
}

export async function addUserTag(
  db: D1Database,
  input: {
    userId: number;
    tag: string;
    createdBy: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_tags (user_id, tag, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, tag) DO NOTHING`,
    )
    .bind(input.userId, input.tag, input.createdBy, nowIso())
    .run();
}

export async function removeUserTag(
  db: D1Database,
  userId: number,
  tag: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM user_tags WHERE user_id = ? AND tag = ?`)
    .bind(userId, tag)
    .run();
}

export interface UserContentSummary {
  responseId: number;
  surveyId: number;
  surveyTitle: string;
  status: string;
  completedAt: string | null;
}

export async function listUserResponses(
  db: D1Database,
  userId: number,
  limit = 20,
): Promise<UserContentSummary[]> {
  const result = await db
    .prepare(
      `SELECT r.id AS responseId, r.survey_id AS surveyId, s.title AS surveyTitle,
              r.status, r.completed_at AS completedAt
       FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id
       WHERE r.user_id = ?
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<UserContentSummary>();
  return result.results ?? [];
}
