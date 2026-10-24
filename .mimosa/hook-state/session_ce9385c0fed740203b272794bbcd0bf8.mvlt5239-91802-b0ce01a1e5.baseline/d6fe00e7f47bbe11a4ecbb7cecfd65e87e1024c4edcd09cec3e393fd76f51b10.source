export interface TaskItemRecord {
  id: number;
  packId: number;
  title: string;
  description: string;
  /** Optional player-facing pop-up warning shown before the task. */
  warning: string;
  score: number;
  persona: string;
  mode: string;
  minFloor: number;
  maxFloor: number;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPackRecord {
  id: number;
  name: string;
  description: string | null;
  normalFloors: number;
  hellFloors: number;
  /** Preparation checklist shown to the player before floor 1. */
  prepItems: string[];
  prepText: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  items?: TaskItemRecord[];
}

export interface TaskItemInput {
  title: string;
  description: string;
  warning?: string;
  score?: number;
  persona?: string;
  mode?: string;
  minFloor?: number;
  maxFloor?: number;
  enabled?: boolean;
  sortOrder?: number;
}

const PACK_COLUMNS = `id, name, description, normal_floors, hell_floors, prep_items, prep_text, enabled, sort_order, created_at, updated_at`;
const ITEM_COLUMNS = `id, pack_id, title, description, warning, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at`;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback;
}

function parsePrepItems(raw: unknown): string[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(String(raw ?? "[]"));
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 60))
    .slice(0, 12);
}

function mapPack(row: Record<string, unknown>): TaskPackRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : null,
    normalFloors: clampInt(row.normal_floors, 1, 60, 10),
    hellFloors: clampInt(row.hell_floors, 1, 60, 12),
    prepItems: parsePrepItems(row.prep_items),
    prepText: typeof row.prep_text === "string" ? row.prep_text : null,
    enabled: Number(row.enabled ?? 1) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapItem(row: Record<string, unknown>): TaskItemRecord {
  return {
    id: Number(row.id),
    packId: Number(row.pack_id),
    title: String(row.title),
    description: String(row.description),
    warning: typeof row.warning === "string" ? row.warning : "",
    score: clampInt(row.score, 1, 20, 5),
    persona: String(row.persona ?? "any"),
    mode: String(row.mode ?? "any"),
    minFloor: clampInt(row.min_floor, 1, 60, 1),
    maxFloor: clampInt(row.max_floor, 1, 99, 99),
    enabled: Number(row.enabled ?? 1) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Whitelists item fields from untrusted admin JSON. */
function normalizeItemInput(raw: unknown, index: number): TaskItemInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim().slice(0, 60) : "";
  const description = typeof item.description === "string" ? item.description.trim().slice(0, 3000) : "";
  if (!title || !description) return null;
  const warning = typeof item.warning === "string" ? item.warning.trim().slice(0, 300) : "";
  const persona = item.persona === "male" || item.persona === "female" ? item.persona : "any";
  const mode = item.mode === "normal" || item.mode === "hell" ? item.mode : "any";
  return {
    title,
    description,
    warning,
    score: clampInt(item.score, 1, 20, 5),
    persona,
    mode,
    minFloor: clampInt(item.min_floor ?? item.minFloor, 1, 60, 1),
    maxFloor: clampInt(item.max_floor ?? item.maxFloor, 1, 99, 99),
    enabled: item.enabled === false ? false : true,
    sortOrder: clampInt(item.sortOrder ?? item.sort_order ?? index, 0, 999, index),
  };
}

export async function listTaskPacks(
  db: D1Database,
  options: { enabledOnly?: boolean; withItems?: boolean } = {},
): Promise<TaskPackRecord[]> {
  const where = options.enabledOnly ? "WHERE enabled = 1" : "";
  const { results } = await db
    .prepare(`SELECT ${PACK_COLUMNS} FROM task_packs ${where} ORDER BY sort_order ASC, id ASC`)
    .all();
  const packs = (results ?? []).map((row) => mapPack(row as Record<string, unknown>));
  if (!options.withItems || packs.length === 0) return packs;
  const placeholders = packs.map(() => "?").join(",");
  const itemRows = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM task_items WHERE pack_id IN (${placeholders}) AND enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(...packs.map((pack) => pack.id))
    .all();
  const byPack = new Map<number, TaskItemRecord[]>();
  for (const row of (itemRows.results ?? []) as Record<string, unknown>[]) {
    const item = mapItem(row);
    const list = byPack.get(item.packId) ?? [];
    list.push(item);
    byPack.set(item.packId, list);
  }
  return packs.map((pack) => ({ ...pack, items: byPack.get(pack.id) ?? [] }));
}

export async function getTaskPackById(db: D1Database, id: number): Promise<TaskPackRecord | null> {
  const row = await db.prepare(`SELECT ${PACK_COLUMNS} FROM task_packs WHERE id = ? LIMIT 1`).bind(id).first();
  if (!row) return null;
  const pack = mapPack(row as Record<string, unknown>);
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM task_items WHERE pack_id = ? ORDER BY sort_order ASC, id ASC`)
    .bind(id)
    .all();
  return { ...pack, items: (results ?? []).map((row) => mapItem(row as Record<string, unknown>)) };
}

export async function countTaskItems(db: D1Database, packId: number, enabledOnly = false): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM task_items WHERE pack_id = ? ${enabledOnly ? "AND enabled = 1" : ""}`)
    .bind(packId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function createTaskPack(
  db: D1Database,
  input: {
    name: string;
    description?: string | null;
    normalFloors?: number;
    hellFloors?: number;
    prepItems?: string[];
    prepText?: string | null;
    items?: unknown[];
  },
): Promise<TaskPackRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO task_packs (name, description, normal_floors, hell_floors, prep_items, prep_text, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM task_packs), ?, ?)`,
    )
    .bind(
      input.name.slice(0, 60),
      input.description?.slice(0, 300) ?? null,
      clampInt(input.normalFloors, 1, 60, 10),
      clampInt(input.hellFloors, 1, 60, 12),
      JSON.stringify(parsePrepItems(input.prepItems ?? [])),
      input.prepText?.slice(0, 300) ?? null,
      now,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法保存任务包");
  const items = (input.items ?? []).map(normalizeItemInput).filter((item): item is TaskItemInput => item !== null);
  if (items.length > 0) await insertTaskItems(db, id, items);
  const created = await getTaskPackById(db, id);
  if (!created) throw new Error("无法保存任务包");
  return created;
}

async function insertTaskItems(db: D1Database, packId: number, items: TaskItemInput[]): Promise<void> {
  const now = new Date().toISOString();
  const statement = await db.prepare(
    `INSERT INTO task_items (pack_id, title, description, warning, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = items.map((item) =>
    statement.bind(
      packId,
      item.title,
      item.description,
      item.warning ?? "",
      item.score ?? 5,
      item.persona ?? "any",
      item.mode ?? "any",
      item.minFloor ?? 1,
      item.maxFloor ?? 99,
      item.enabled === false ? 0 : 1,
      item.sortOrder ?? 0,
      now,
      now,
    ),
  );
  await db.batch(batch);
}

export async function updateTaskPack(
  db: D1Database,
  id: number,
  input: {
    name?: string;
    description?: string | null;
    normalFloors?: number;
    hellFloors?: number;
    prepItems?: string[];
    prepText?: string | null;
    enabled?: boolean;
    sortOrder?: number;
    items?: unknown[];
  },
): Promise<TaskPackRecord | null> {
  const existing = await getTaskPackById(db, id);
  if (!existing) return null;
  await db
    .prepare(
      `UPDATE task_packs SET name = ?, description = ?, normal_floors = ?, hell_floors = ?, prep_items = ?, prep_text = ?, enabled = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      (input.name ?? existing.name).slice(0, 60),
      (input.description !== undefined ? input.description : existing.description)?.slice(0, 300) ?? null,
      clampInt(input.normalFloors ?? existing.normalFloors, 1, 60, 10),
      clampInt(input.hellFloors ?? existing.hellFloors, 1, 60, 12),
      JSON.stringify(parsePrepItems(input.prepItems ?? existing.prepItems)),
      (input.prepText !== undefined ? input.prepText : existing.prepText)?.slice(0, 300) ?? null,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      clampInt(input.sortOrder ?? existing.sortOrder, 0, 999, existing.sortOrder),
      new Date().toISOString(),
      id,
    )
    .run();
  if (input.items !== undefined) {
    const items = input.items.map(normalizeItemInput).filter((item): item is TaskItemInput => item !== null);
    await db.prepare("DELETE FROM task_items WHERE pack_id = ?").bind(id).run();
    if (items.length > 0) await insertTaskItems(db, id, items);
  }
  return getTaskPackById(db, id);
}

export async function deleteTaskPack(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM task_packs WHERE id = ?").bind(id).run();
  return Boolean(result.meta?.changes);
}
