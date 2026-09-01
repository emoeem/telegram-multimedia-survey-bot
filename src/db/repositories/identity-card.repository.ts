export interface IdentityProfileRecord {
  id: number;
  userId: number;
  name: string;
  nickname: string | null;
  age: number | null;
  identityLabel: string | null;
  description: string | null;
  frontAssetId: number;
  backAssetId: number | null;
  backgroundAssetId: number | null;
  templateStyle: string;
  /** Opt-in publication flag for the bot-side identity card gallery. */
  galleryPublished: boolean;
  galleryPublishedAt: string | null;
  /** Media asset holding the stored card PNG produced by the report pipeline. */
  cardAssetId: number | null;
  createdAt: string;
  updatedAt: string;
}

const PROFILE_COLUMNS = `id, user_id, name, nickname, age, identity_label, description,
    front_asset_id, back_asset_id, background_asset_id, template_style,
    gallery_published, gallery_published_at, card_asset_id, created_at, updated_at`;

type IdentityProfileInput = Omit<IdentityProfileRecord, "id" | "createdAt" | "updatedAt">;

function mapIdentityProfileRow(row: Record<string, unknown>): IdentityProfileRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: String(row.name),
    nickname: typeof row.nickname === "string" ? row.nickname : null,
    age: typeof row.age === "number" ? row.age : null,
    identityLabel: typeof row.identity_label === "string" ? row.identity_label : null,
    description: typeof row.description === "string" ? row.description : null,
    frontAssetId: Number(row.front_asset_id),
    backAssetId: typeof row.back_asset_id === "number" ? row.back_asset_id : null,
    backgroundAssetId: typeof row.background_asset_id === "number" ? row.background_asset_id : null,
    templateStyle: String(row.template_style),
    galleryPublished: Number(row.gallery_published ?? 0) === 1,
    galleryPublishedAt: typeof row.gallery_published_at === "string" ? row.gallery_published_at : null,
    cardAssetId: typeof row.card_asset_id === "number" ? row.card_asset_id : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function createIdentityProfile(
  db: D1Database,
  input: IdentityProfileInput,
): Promise<IdentityProfileRecord> {
  const now = new Date().toISOString();
  const publishedAt = input.galleryPublished ? now : null;
  const result = await db
    .prepare(
      `INSERT INTO identity_profiles
      (user_id, name, nickname, age, identity_label, description, front_asset_id, back_asset_id, background_asset_id, template_style, gallery_published, gallery_published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.userId,
      input.name,
      input.nickname,
      input.age,
      input.identityLabel,
      input.description,
      input.frontAssetId,
      input.backAssetId,
      input.backgroundAssetId ?? null,
      input.templateStyle,
      input.galleryPublished ? 1 : 0,
      publishedAt,
      now,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法保存身份卡资料");
  return { ...input, id, galleryPublishedAt: publishedAt, createdAt: now, updatedAt: now };
}

export async function getIdentityProfileById(db: D1Database, id: number): Promise<IdentityProfileRecord | null> {
  const row = await db
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM identity_profiles WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return mapIdentityProfileRow(row);
}

export interface IdentityProfileListOptions {
  limit: number;
  offset: number;
  /** "published" serves the public bot gallery; "all" is the admin view. */
  view?: "all" | "published";
  userId?: number;
}

export interface IdentityProfileListPage {
  items: IdentityProfileRecord[];
  total: number;
}

export async function listIdentityProfiles(
  db: D1Database,
  options: IdentityProfileListOptions,
): Promise<IdentityProfileListPage> {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (options.view === "published") {
    conditions.push("gallery_published = 1");
  }
  if (options.userId !== undefined) {
    conditions.push("user_id = ?");
    bindings.push(options.userId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM identity_profiles ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await db
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM identity_profiles ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, options.limit, options.offset)
    .all<Record<string, unknown>>();
  return {
    items: (rows.results ?? []).map(mapIdentityProfileRow),
    total: Number(totalRow?.total ?? 0),
  };
}

export async function setIdentityProfileGalleryPublished(
  db: D1Database,
  id: number,
  published: boolean,
): Promise<IdentityProfileRecord | null> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE identity_profiles
       SET gallery_published = ?, gallery_published_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(published ? 1 : 0, published ? now : null, now, id)
    .run();
  if (!result.meta?.changes) return getIdentityProfileById(db, id);
  return getIdentityProfileById(db, id);
}

export async function setIdentityProfileCardAsset(db: D1Database, id: number, assetId: number | null): Promise<void> {
  await db
    .prepare(`UPDATE identity_profiles SET card_asset_id = ?, updated_at = ? WHERE id = ?`)
    .bind(assetId, new Date().toISOString(), id)
    .run();
}

export interface IdentityCardOwner {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
}

/** Batched owner lookup so public feeds can attribute cards to their makers. */
export async function getIdentityProfileOwners(
  db: D1Database,
  userIds: number[],
): Promise<Map<number, IdentityCardOwner>> {
  const unique = [...new Set(userIds)];
  const owners = new Map<number, IdentityCardOwner>();
  if (unique.length === 0) return owners;
  const rows = await db
    .prepare(
      `SELECT id, telegram_user_id, username, first_name FROM users WHERE id IN (${unique.map(() => "?").join(",")})`,
    )
    .bind(...unique)
    .all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    owners.set(Number(row.id), {
      telegramUserId: Number(row.telegram_user_id),
      username: typeof row.username === "string" ? row.username : null,
      firstName: typeof row.first_name === "string" ? row.first_name : null,
    });
  }
  return owners;
}
