import type { ShowcaseItem, ShowcaseItemKind, ShowcaseLink, ShowcasePerson, ShowcasePersonWithItems } from "../schema";

/**
 * Showcase (展示区) persistence.
 *
 * The feed is read constantly (every swipe of the public gallery) and written
 * rarely (an operator curating a page), so the read path batches: one query for
 * the page of people, one for every item of that page, joined with json_each.
 * Reading items per person would be the same N+1 the profile gallery feed had
 * to fix.
 */

interface ShowcasePersonRow {
  id: number;
  name: string;
  subtitle: string | null;
  description: string | null;
  accent_color: string | null;
  background_from: string | null;
  background_to: string | null;
  background_media_id: number | null;
  illustration_media_id: number | null;
  avatar_media_id: number | null;
  background_url: string | null;
  illustration_url: string | null;
  tags_json: string | null;
  links_json: string | null;
  survey_id: number | null;
  response_id: number | null;
  owner_user_id: number | null;
  feature_rank: number;
  published: number;
  sort_order: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface ShowcaseItemRow {
  id: number;
  person_id: number;
  title: string;
  description: string | null;
  kind: string;
  cover_media_id: number | null;
  cover_url: string | null;
  media_asset_id: number | null;
  url: string | null;
  featured: number;
  sort_order: number;
  created_at: string;
}

export interface ShowcasePersonInput {
  name: string;
  subtitle?: string | null;
  description?: string | null;
  accentColor?: string | null;
  backgroundFrom?: string | null;
  backgroundTo?: string | null;
  backgroundMediaId?: number | null;
  illustrationMediaId?: number | null;
  avatarMediaId?: number | null;
  backgroundUrl?: string | null;
  illustrationUrl?: string | null;
  tags?: string[];
  links?: ShowcaseLink[];
  surveyId?: number | null;
  responseId?: number | null;
  ownerUserId?: number | null;
  featureRank?: number;
  published?: boolean;
  sortOrder?: number;
  createdBy?: number | null;
}

export type ShowcasePersonPatch = Partial<ShowcasePersonInput>;

export interface ShowcaseItemInput {
  personId: number;
  title: string;
  description?: string | null;
  kind?: ShowcaseItemKind;
  coverMediaId?: number | null;
  coverUrl?: string | null;
  mediaAssetId?: number | null;
  url?: string | null;
  featured?: boolean;
  sortOrder?: number;
}

export type ShowcaseItemPatch = Partial<Omit<ShowcaseItemInput, "personId">>;

export function parseShowcaseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export function parseShowcaseLinks(raw: string | null): ShowcaseLink[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      if (!url) return [];
      return [
        {
          type: typeof record.type === "string" ? record.type : "other",
          label: typeof record.label === "string" && record.label ? record.label : url,
          url,
        },
      ];
    });
  } catch {
    return [];
  }
}

function mapPerson(row: ShowcasePersonRow): ShowcasePerson {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    accentColor: row.accent_color,
    backgroundFrom: row.background_from,
    backgroundTo: row.background_to,
    backgroundMediaId: row.background_media_id,
    illustrationMediaId: row.illustration_media_id,
    avatarMediaId: row.avatar_media_id,
    backgroundUrl: row.background_url,
    illustrationUrl: row.illustration_url,
    tags: parseShowcaseTags(row.tags_json),
    links: parseShowcaseLinks(row.links_json),
    surveyId: row.survey_id,
    responseId: row.response_id,
    ownerUserId: row.owner_user_id,
    featureRank: row.feature_rank,
    published: row.published === 1,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: ShowcaseItemRow): ShowcaseItem {
  return {
    id: row.id,
    personId: row.person_id,
    title: row.title,
    description: row.description,
    kind: row.kind as ShowcaseItemKind,
    coverMediaId: row.cover_media_id,
    coverUrl: row.cover_url,
    mediaAssetId: row.media_asset_id ?? null,
    url: row.url,
    featured: row.featured === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

const PERSON_COLUMNS = `id, name, subtitle, description, accent_color, background_from, background_to,
  background_media_id, illustration_media_id, avatar_media_id, background_url, illustration_url,
  tags_json, links_json, survey_id, response_id, owner_user_id, feature_rank, published, sort_order,
  created_by, created_at, updated_at`;

const ITEM_COLUMNS = `id, person_id, title, description, kind, cover_media_id, cover_url, media_asset_id,
  url, featured, sort_order, created_at`;

/** One query for every item of the page, keyed by person id. */
async function listItemsByPersonIds(db: D1Database, personIds: number[]): Promise<Map<number, ShowcaseItem[]>> {
  const map = new Map<number, ShowcaseItem[]>();
  if (personIds.length === 0) return map;
  const result = await db
    .prepare(
      // Every column is table-qualified: json_each also exposes an `id`, so a
      // bare ORDER BY id is an ambiguous-column error at runtime.
      `SELECT i.id, i.person_id, i.title, i.description, i.kind, i.cover_media_id, i.cover_url, i.media_asset_id, i.url,
              i.featured, i.sort_order, i.created_at
       FROM showcase_items i
       JOIN json_each(?) AS r ON r.value = i.person_id
       ORDER BY i.person_id ASC, i.sort_order ASC, i.id ASC`,
    )
    .bind(JSON.stringify(personIds))
    .all<ShowcaseItemRow>();
  for (const row of result.results ?? []) {
    const list = map.get(row.person_id) ?? [];
    list.push(mapItem(row));
    map.set(row.person_id, list);
  }
  return map;
}

export async function listShowcasePersons(
  db: D1Database,
  options: { publishedOnly?: boolean; ownerUserId?: number; limit?: number; offset?: number } = {},
): Promise<{ persons: ShowcasePersonWithItems[]; total: number }> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (options.publishedOnly) conditions.push("published = 1");
  if (options.ownerUserId !== undefined) {
    conditions.push("owner_user_id = ?");
    binds.push(options.ownerUserId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const offset = Math.max(0, options.offset ?? 0);

  const [rows, count] = (await db.batch([
    db
      .prepare(
        `SELECT ${PERSON_COLUMNS} FROM showcase_persons ${where}
         ORDER BY feature_rank DESC, sort_order ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset),
    db.prepare(`SELECT COUNT(*) AS count FROM showcase_persons ${where}`).bind(...binds),
  ])) as [D1Result<ShowcasePersonRow>, D1Result<{ count: number }>];

  const personRows = rows.results ?? [];
  const itemsByPerson = await listItemsByPersonIds(
    db,
    personRows.map((row) => row.id),
  );
  return {
    persons: personRows.map((row) => ({ ...mapPerson(row), items: itemsByPerson.get(row.id) ?? [] })),
    total: Number(count.results?.[0]?.count ?? 0),
  };
}

/** The showcase page generated from one gallery response (0065 的软连接字段). */
export async function getShowcasePersonByResponseId(
  db: D1Database,
  responseId: number,
): Promise<ShowcasePersonWithItems | null> {
  const row = await db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM showcase_persons WHERE response_id = ? LIMIT 1`)
    .bind(responseId)
    .first<ShowcasePersonRow>();
  if (!row) return null;
  const itemsByPerson = await listItemsByPersonIds(db, [row.id]);
  return { ...mapPerson(row), items: itemsByPerson.get(row.id) ?? [] };
}

export async function getShowcasePersonById(db: D1Database, id: number): Promise<ShowcasePersonWithItems | null> {
  const row = await db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM showcase_persons WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ShowcasePersonRow>();
  if (!row) return null;
  const itemsByPerson = await listItemsByPersonIds(db, [row.id]);
  return { ...mapPerson(row), items: itemsByPerson.get(row.id) ?? [] };
}

/** 公开阅读全文用：只有「已公开人物」名下的作品可读（下架即 404）。 */
export async function getPublishedShowcaseItemById(
  db: D1Database,
  id: number,
): Promise<{ item: ShowcaseItem; personId: number } | null> {
  const row = await db
    .prepare(
      `SELECT i.id, i.person_id, i.title, i.description, i.kind, i.cover_media_id, i.cover_url, i.media_asset_id, i.url,
              i.featured, i.sort_order, i.created_at
         FROM showcase_items i
         JOIN showcase_persons p ON p.id = i.person_id
        WHERE i.id = ? AND p.published = 1
        LIMIT 1`,
    )
    .bind(id)
    .first<ShowcaseItemRow>();
  return row ? { item: mapItem(row), personId: row.person_id } : null;
}

export async function getShowcaseItemById(db: D1Database, id: number): Promise<ShowcaseItem | null> {
  const row = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM showcase_items WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ShowcaseItemRow>();
  return row ? mapItem(row) : null;
}

export async function createShowcasePerson(db: D1Database, input: ShowcasePersonInput): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO showcase_persons (
        name, subtitle, description, accent_color, background_from, background_to,
        background_media_id, illustration_media_id, avatar_media_id, background_url, illustration_url,
        tags_json, links_json, survey_id, response_id, owner_user_id, feature_rank, published,
        sort_order, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.name,
      input.subtitle ?? null,
      input.description ?? null,
      input.accentColor ?? null,
      input.backgroundFrom ?? null,
      input.backgroundTo ?? null,
      input.backgroundMediaId ?? null,
      input.illustrationMediaId ?? null,
      input.avatarMediaId ?? null,
      input.backgroundUrl ?? null,
      input.illustrationUrl ?? null,
      input.tags?.length ? JSON.stringify(input.tags) : null,
      input.links?.length ? JSON.stringify(input.links) : null,
      input.surveyId ?? null,
      input.responseId ?? null,
      input.ownerUserId ?? null,
      input.featureRank ?? 0,
      input.published ? 1 : 0,
      input.sortOrder ?? 0,
      input.createdBy ?? null,
      timestamp,
      timestamp,
    )
    .run();
  return Number(result.meta.last_row_id);
}

const PERSON_PATCH_COLUMNS: Record<keyof ShowcasePersonPatch, string> = {
  name: "name",
  subtitle: "subtitle",
  description: "description",
  accentColor: "accent_color",
  backgroundFrom: "background_from",
  backgroundTo: "background_to",
  backgroundMediaId: "background_media_id",
  illustrationMediaId: "illustration_media_id",
  avatarMediaId: "avatar_media_id",
  backgroundUrl: "background_url",
  illustrationUrl: "illustration_url",
  tags: "tags_json",
  links: "links_json",
  surveyId: "survey_id",
  responseId: "response_id",
  ownerUserId: "owner_user_id",
  featureRank: "feature_rank",
  published: "published",
  sortOrder: "sort_order",
  createdBy: "created_by",
};

export async function updateShowcasePerson(db: D1Database, id: number, patch: ShowcasePersonPatch): Promise<boolean> {
  const assignments: string[] = [];
  const binds: unknown[] = [];
  for (const [key, column] of Object.entries(PERSON_PATCH_COLUMNS) as Array<[keyof ShowcasePersonPatch, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    assignments.push(`${column} = ?`);
    if (key === "tags") {
      const tags = Array.isArray(value) ? value : [];
      binds.push(tags.length ? JSON.stringify(tags) : null);
    } else if (key === "links") {
      const links = Array.isArray(value) ? value : [];
      binds.push(links.length ? JSON.stringify(links) : null);
    } else if (key === "published") {
      binds.push(value === true ? 1 : 0);
    } else {
      binds.push(value ?? null);
    }
  }
  if (assignments.length === 0) return false;
  assignments.push("updated_at = ?");
  binds.push(new Date().toISOString(), id);
  const result = await db
    .prepare(`UPDATE showcase_persons SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function deleteShowcasePerson(db: D1Database, id: number): Promise<boolean> {
  await db.prepare("DELETE FROM showcase_items WHERE person_id = ?").bind(id).run();
  const result = await db.prepare("DELETE FROM showcase_persons WHERE id = ?").bind(id).run();
  return Number(result.meta.changes ?? 0) > 0;
}

/** Applies a drag-reorder in one batch; ids not listed keep their previous order. */
export async function reorderShowcasePersons(db: D1Database, orderedIds: number[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const timestamp = new Date().toISOString();
  await db.batch(
    orderedIds.map((id, index) =>
      db.prepare("UPDATE showcase_persons SET sort_order = ?, updated_at = ? WHERE id = ?").bind(index, timestamp, id),
    ),
  );
}

export async function createShowcaseItem(db: D1Database, input: ShowcaseItemInput): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO showcase_items (
        person_id, title, description, kind, cover_media_id, cover_url, media_asset_id, url, featured, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.personId,
      input.title,
      input.description ?? null,
      input.kind ?? "other",
      input.coverMediaId ?? null,
      input.coverUrl ?? null,
      input.mediaAssetId ?? null,
      input.url ?? null,
      input.featured ? 1 : 0,
      input.sortOrder ?? 0,
      timestamp,
    )
    .run();
  return Number(result.meta.last_row_id);
}

const ITEM_PATCH_COLUMNS: Record<keyof ShowcaseItemPatch, string> = {
  title: "title",
  description: "description",
  kind: "kind",
  coverMediaId: "cover_media_id",
  coverUrl: "cover_url",
  mediaAssetId: "media_asset_id",
  url: "url",
  featured: "featured",
  sortOrder: "sort_order",
};

export async function updateShowcaseItem(db: D1Database, id: number, patch: ShowcaseItemPatch): Promise<boolean> {
  const assignments: string[] = [];
  const binds: unknown[] = [];
  for (const [key, column] of Object.entries(ITEM_PATCH_COLUMNS) as Array<[keyof ShowcaseItemPatch, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    assignments.push(`${column} = ?`);
    if (key === "featured") binds.push(value === true ? 1 : 0);
    else binds.push(value ?? null);
  }
  if (assignments.length === 0) return false;
  binds.push(id);
  const result = await db
    .prepare(`UPDATE showcase_items SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function deleteShowcaseItem(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM showcase_items WHERE id = ?").bind(id).run();
  return Number(result.meta.changes ?? 0) > 0;
}

/**
 * Authorization boundary for /api/showcase/media/:id: an asset is public only
 * while a PUBLISHED person (or one of their items) references it. Unpublishing
 * a person therefore withdraws their artwork immediately, without deleting it.
 */
export async function getPublishedShowcasePersonIdForAsset(
  db: D1Database,
  mediaAssetId: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT id personId FROM showcase_persons
       WHERE published = 1 AND (background_media_id = ? OR illustration_media_id = ? OR avatar_media_id = ?)
       LIMIT 1`,
    )
    .bind(mediaAssetId, mediaAssetId, mediaAssetId)
    .first<{ personId: number }>();
  if (row) return row.personId;
  const itemRow = await db
    .prepare(
      `SELECT p.id personId
       FROM showcase_items i
       JOIN showcase_persons p ON p.id = i.person_id
       WHERE p.published = 1 AND (i.cover_media_id = ? OR i.media_asset_id = ?)
       LIMIT 1`,
    )
    .bind(mediaAssetId, mediaAssetId)
    .first<{ personId: number }>();
  return itemRow ? itemRow.personId : null;
}

export async function countShowcasePersons(db: D1Database): Promise<{ total: number; published: number }> {
  const rows = (await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM showcase_persons"),
    db.prepare("SELECT COUNT(*) AS count FROM showcase_persons WHERE published = 1"),
  ])) as [D1Result<{ count: number }>, D1Result<{ count: number }>];
  return {
    total: Number(rows[0].results?.[0]?.count ?? 0),
    published: Number(rows[1].results?.[0]?.count ?? 0),
  };
}
