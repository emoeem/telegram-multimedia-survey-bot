export interface PlazaPostRecord {
  id: number;
  userId: number;
  content: string;
  /** Anonymous posts hide the author in the public feed. */
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
  } | null;
}

const POST_COLUMNS = `p.id, p.user_id, p.content, p.anonymous, p.status, p.created_at,
    u.telegram_user_id AS owner_telegram_user_id, u.username AS owner_username, u.first_name AS owner_first_name`;

type PlazaPostRow = Record<string, unknown>;

function mapPlazaPostRow(row: PlazaPostRow): PlazaPostRecord {
  const ownerTelegramUserId = row.owner_telegram_user_id;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    content: String(row.content),
    anonymous: Number(row.anonymous ?? 1) === 1,
    status: row.status === "removed" ? "removed" : "published",
    createdAt: String(row.created_at),
    owner:
      ownerTelegramUserId === null || ownerTelegramUserId === undefined
        ? null
        : {
            telegramUserId: Number(ownerTelegramUserId),
            username: typeof row.owner_username === "string" ? row.owner_username : null,
            firstName: typeof row.owner_first_name === "string" ? row.owner_first_name : null,
          },
  };
}

export interface CreatePlazaPostInput {
  userId: number;
  content: string;
  anonymous: boolean;
}

export async function createPlazaPost(db: D1Database, input: CreatePlazaPostInput): Promise<PlazaPostRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO plaza_posts (user_id, content, anonymous, status, created_at) VALUES (?, ?, ?, 'published', ?)`,
    )
    .bind(input.userId, input.content, input.anonymous ? 1 : 0, now)
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("树洞内容保存失败");
  return {
    id,
    userId: input.userId,
    content: input.content,
    anonymous: input.anonymous,
    status: "published",
    createdAt: now,
    owner: null,
  };
}

export interface PlazaPostListOptions {
  limit: number;
  offset: number;
  /** "published" is the public bot feed; "all" is the admin console. */
  view?: "all" | "published";
}

export interface PlazaPostListPage {
  items: PlazaPostRecord[];
  total: number;
}

export async function listPlazaPosts(db: D1Database, options: PlazaPostListOptions): Promise<PlazaPostListPage> {
  const where = options.view === "published" ? "WHERE p.status = 'published'" : "";
  const totalRow = await db.prepare(`SELECT COUNT(*) AS total FROM plaza_posts p ${where}`).first<{ total: number }>();
  const rows = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM plaza_posts p LEFT JOIN users u ON u.id = p.user_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(options.limit, options.offset)
    .all<PlazaPostRow>();
  return {
    items: (rows.results ?? []).map(mapPlazaPostRow),
    total: Number(totalRow?.total ?? 0),
  };
}

export async function setPlazaPostStatus(
  db: D1Database,
  id: number,
  status: "published" | "removed",
): Promise<PlazaPostRecord | null> {
  const result = await db.prepare(`UPDATE plaza_posts SET status = ? WHERE id = ?`).bind(status, id).run();
  if (!result.meta?.changes) return null;
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM plaza_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ? LIMIT 1`)
    .bind(id)
    .first<PlazaPostRow>();
  return row ? mapPlazaPostRow(row) : null;
}
