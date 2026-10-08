export interface PlazaPostRecord {
  id: number;
  userId: number;
  content: string;
  kind: "text" | "trial";
  payload: Record<string, unknown> | null;
  /** 配图（0068）：画廊/展示区同一套 durable 媒体，只在 published 时可读。 */
  imageAssetId: number | null;
  /** #话题#（0068）：由正文解析或客户端显式传入，用于筛选。 */
  topic: string | null;
  /** Anonymous posts hide the author in the public feed. */
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  deletedAt: string | null;
  commentCount: number;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
  } | null;
}

const POST_COLUMNS = `p.id, p.user_id, p.content, p.anonymous, p.status, p.created_at,
    p.kind, p.payload_json, p.image_asset_id, p.topic, p.deleted_at,
    (SELECT COUNT(*) FROM plaza_post_comments c WHERE c.post_id = p.id AND c.status = 'published') AS comment_count,
    u.telegram_user_id AS owner_telegram_user_id, u.username AS owner_username, u.first_name AS owner_first_name`;

type PlazaPostRow = Record<string, unknown>;

function mapPlazaPostRow(row: PlazaPostRow): PlazaPostRecord {
  const ownerTelegramUserId = row.owner_telegram_user_id;
  let payload: Record<string, unknown> | null = null;
  if (typeof row.payload_json === "string" && row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    content: String(row.content),
    kind: row.kind === "trial" ? "trial" : "text",
    payload,
    imageAssetId: row.image_asset_id === null || row.image_asset_id === undefined ? null : Number(row.image_asset_id),
    topic: typeof row.topic === "string" && row.topic ? row.topic : null,
    anonymous: Number(row.anonymous ?? 1) === 1,
    status: row.status === "removed" ? "removed" : "published",
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
    commentCount: Number(row.comment_count ?? 0),
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
  kind?: "text" | "trial";
  payload?: Record<string, unknown> | null;
  imageAssetId?: number | null;
  topic?: string | null;
}

export async function createPlazaPost(db: D1Database, input: CreatePlazaPostInput): Promise<PlazaPostRecord> {
  const now = new Date().toISOString();
  const kind = input.kind ?? "text";
  const result = await db
    .prepare(
      `INSERT INTO plaza_posts (user_id, content, anonymous, status, kind, payload_json, image_asset_id, topic, created_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.userId,
      input.content,
      input.anonymous ? 1 : 0,
      kind,
      input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
      input.imageAssetId ?? null,
      input.topic ?? null,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("树洞内容保存失败");
  return {
    id,
    userId: input.userId,
    content: input.content,
    kind,
    payload: input.payload ?? null,
    imageAssetId: input.imageAssetId ?? null,
    topic: input.topic ?? null,
    anonymous: input.anonymous,
    status: "published",
    createdAt: now,
    commentCount: 0,
    deletedAt: null,
    owner: null,
  };
}

export interface PlazaPostListOptions {
  limit: number;
  offset: number;
  /** "published" is the public bot feed; "all" is the admin console. */
  view?: "all" | "published";
  /** 只返回该话题的帖子（公开流筛选）。 */
  topic?: string | null;
}

export interface PlazaPostListPage {
  items: PlazaPostRecord[];
  total: number;
}

export async function listPlazaPosts(db: D1Database, options: PlazaPostListOptions): Promise<PlazaPostListPage> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  conditions.push("p.deleted_at IS NULL");
  if (options.view === "published") conditions.push("p.status = 'published'");
  if (options.topic) {
    conditions.push("p.topic = ?");
    binds.push(options.topic);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM plaza_posts p ${where}`)
    .bind(...binds)
    .first<{ total: number }>();
  const rows = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM plaza_posts p LEFT JOIN users u ON u.id = p.user_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, options.limit, options.offset)
    .all<PlazaPostRow>();
  return {
    items: (rows.results ?? []).map(mapPlazaPostRow),
    total: Number(totalRow?.total ?? 0),
  };
}

/** 公开流的话题榜：发布中的帖子按话题聚合，热度降序。 */
export async function listPlazaTopics(db: D1Database, limit = 12): Promise<Array<{ topic: string; count: number }>> {
  const rows = await db
    .prepare(
      `SELECT topic, COUNT(*) AS count, MAX(id) AS latestId
         FROM plaza_posts
        WHERE deleted_at IS NULL AND status = 'published' AND topic IS NOT NULL AND topic <> ''
        GROUP BY topic
        ORDER BY count DESC, latestId DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ topic: string; count: number }>();
  return (rows.results ?? []).map((row) => ({ topic: String(row.topic), count: Number(row.count ?? 0) }));
}

/** 公开读图的唯一授权：图片必须挂在一个发布中的帖子上。 */
export async function isPublishedPlazaImage(db: D1Database, mediaAssetId: number): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM plaza_posts WHERE image_asset_id = ? AND deleted_at IS NULL AND status = 'published' LIMIT 1",
    )
    .bind(mediaAssetId)
    .first<{ found: number }>();
  return Boolean(row);
}

export async function getPlazaPostImageAssetId(db: D1Database, postId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT image_asset_id AS imageAssetId FROM plaza_posts WHERE id = ? AND deleted_at IS NULL LIMIT 1")
    .bind(postId)
    .first<{ imageAssetId: number | null }>();
  return row?.imageAssetId === null || row?.imageAssetId === undefined ? null : Number(row.imageAssetId);
}

/** 下架时摘掉配图引用（blob 由服务层负责删除）。 */
export async function detachPlazaPostImage(db: D1Database, postId: number): Promise<void> {
  await db.prepare("UPDATE plaza_posts SET image_asset_id = NULL WHERE id = ?").bind(postId).run();
}

export async function softDeletePlazaPost(
  db: D1Database,
  id: number,
  now = new Date().toISOString(),
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE plaza_posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(now, id)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function restorePlazaPost(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE plaza_posts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(id)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function setPlazaPostStatus(
  db: D1Database,
  id: number,
  status: "published" | "removed",
): Promise<PlazaPostRecord | null> {
  const result = await db.prepare(`UPDATE plaza_posts SET status = ? WHERE id = ?`).bind(status, id).run();
  if (!result.meta?.changes) return null;
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM plaza_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
    )
    .bind(id)
    .first<PlazaPostRow>();
  return row ? mapPlazaPostRow(row) : null;
}
