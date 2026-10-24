export interface PlazaCommentRecord {
  id: number;
  postId: number;
  userId: number;
  content: string;
  status: "published" | "removed";
  createdAt: string;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
  } | null;
}

const COMMENT_COLUMNS = `c.id, c.post_id, c.user_id, c.content, c.status, c.created_at,
    u.telegram_user_id AS owner_telegram_user_id, u.username AS owner_username, u.first_name AS owner_first_name`;

type PlazaCommentRow = Record<string, unknown>;

function mapCommentRow(row: PlazaCommentRow): PlazaCommentRecord {
  const ownerTelegramUserId = row.owner_telegram_user_id;
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    userId: Number(row.user_id),
    content: String(row.content),
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

export interface PlazaCommentListOptions {
  limit: number;
  offset: number;
  view?: "all" | "published";
}

export async function createPlazaComment(
  db: D1Database,
  input: { postId: number; userId: number; content: string },
): Promise<PlazaCommentRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO plaza_post_comments (post_id, user_id, content, status, created_at)
       VALUES (?, ?, ?, 'published', ?)`,
    )
    .bind(input.postId, input.userId, input.content, now)
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("评论保存失败");
  return {
    id,
    postId: input.postId,
    userId: input.userId,
    content: input.content,
    status: "published",
    createdAt: now,
    owner: null,
  };
}

export async function getPlazaCommentById(db: D1Database, id: number): Promise<PlazaCommentRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM plaza_post_comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = ? LIMIT 1`,
    )
    .bind(id)
    .first<PlazaCommentRow>();
  return row ? mapCommentRow(row) : null;
}

export async function listPlazaComments(
  db: D1Database,
  postId: number,
  options: PlazaCommentListOptions,
): Promise<{ items: PlazaCommentRecord[]; total: number }> {
  const where = options.view === "published" ? "WHERE c.post_id = ? AND c.status = 'published'" : "WHERE c.post_id = ?";
  const count = await db
    .prepare(`SELECT COUNT(*) AS total FROM plaza_post_comments c ${where}`)
    .bind(postId)
    .first<{ total: number }>();
  const rows = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM plaza_post_comments c
       LEFT JOIN users u ON u.id = c.user_id
       ${where} ORDER BY c.id ASC LIMIT ? OFFSET ?`,
    )
    .bind(postId, options.limit, options.offset)
    .all<PlazaCommentRow>();
  return {
    items: (rows.results ?? []).map(mapCommentRow),
    total: Number(count?.total ?? 0),
  };
}

export async function setPlazaCommentStatus(
  db: D1Database,
  id: number,
  status: "published" | "removed",
): Promise<PlazaCommentRecord | null> {
  const result = await db.prepare("UPDATE plaza_post_comments SET status = ? WHERE id = ?").bind(status, id).run();
  if (!result.meta?.changes) return null;
  return getPlazaCommentById(db, id);
}
