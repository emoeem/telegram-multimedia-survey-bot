import type { CardSlot } from "../../card-template/model";
import { normalizeCardTemplateDefinition } from "../../card-template/model";

export interface CardTemplateRecord {
  id: number;
  name: string;
  backgroundAssetId: number | null;
  backgroundColor: string;
  canvasWidth: number;
  canvasHeight: number;
  slots: CardSlot[];
  disclaimerText: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CardTemplateInput {
  name: string;
  backgroundAssetId?: number | null;
  backgroundColor?: string;
  slots?: unknown;
  disclaimerText?: string;
  enabled?: boolean;
  sortOrder?: number;
}

function mapRow(row: Record<string, unknown>): CardTemplateRecord {
  let parsedSlots: unknown = [];
  try {
    parsedSlots = JSON.parse(String(row.slots_json ?? "[]"));
  } catch {
    parsedSlots = [];
  }
  const definition = normalizeCardTemplateDefinition({
    backgroundColor: row.background_color,
    slots: parsedSlots,
    disclaimerText: row.disclaimer_text,
  });
  return {
    id: Number(row.id),
    name: String(row.name),
    backgroundAssetId: typeof row.background_asset_id === "number" ? row.background_asset_id : null,
    backgroundColor: definition.backgroundColor,
    canvasWidth: Number(row.canvas_width ?? 900),
    canvasHeight: Number(row.canvas_height ?? 1200),
    slots: definition.slots,
    disclaimerText: definition.disclaimerText,
    enabled: Number(row.enabled ?? 1) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listCardTemplates(
  db: D1Database,
  options: { enabledOnly?: boolean } = {},
): Promise<CardTemplateRecord[]> {
  const where = options.enabledOnly ? "WHERE enabled = 1" : "";
  const { results } = await db.prepare(`SELECT * FROM card_templates ${where} ORDER BY sort_order ASC, id ASC`).all();
  return (results ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function getCardTemplateById(db: D1Database, id: number): Promise<CardTemplateRecord | null> {
  const row = await db.prepare("SELECT * FROM card_templates WHERE id = ? LIMIT 1").bind(id).first();
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export async function createCardTemplate(db: D1Database, input: CardTemplateInput): Promise<CardTemplateRecord> {
  const definition = normalizeCardTemplateDefinition({
    backgroundColor: input.backgroundColor,
    slots: input.slots ?? [],
    disclaimerText: input.disclaimerText,
  });
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO card_templates
        (name, background_asset_id, background_color, slots_json, disclaimer_text, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.name.slice(0, 60),
      input.backgroundAssetId ?? null,
      definition.backgroundColor,
      JSON.stringify(definition.slots),
      definition.disclaimerText,
      input.enabled === false ? 0 : 1,
      input.sortOrder ?? 0,
      now,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法保存卡面模板");
  const created = await getCardTemplateById(db, id);
  if (!created) throw new Error("无法保存卡面模板");
  return created;
}

export async function updateCardTemplate(
  db: D1Database,
  id: number,
  input: Partial<CardTemplateInput>,
): Promise<CardTemplateRecord | null> {
  const existing = await getCardTemplateById(db, id);
  if (!existing) return null;
  const definition = normalizeCardTemplateDefinition({
    backgroundColor: input.backgroundColor ?? existing.backgroundColor,
    slots: input.slots ?? existing.slots,
    disclaimerText: input.disclaimerText ?? existing.disclaimerText,
  });
  await db
    .prepare(
      `UPDATE card_templates
       SET name = ?, background_asset_id = ?, background_color = ?, slots_json = ?,
           disclaimer_text = ?, enabled = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      (input.name ?? existing.name).slice(0, 60),
      input.backgroundAssetId === undefined ? existing.backgroundAssetId : input.backgroundAssetId,
      definition.backgroundColor,
      JSON.stringify(definition.slots),
      definition.disclaimerText,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      input.sortOrder ?? existing.sortOrder,
      new Date().toISOString(),
      id,
    )
    .run();
  return getCardTemplateById(db, id);
}

export async function deleteCardTemplate(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM card_templates WHERE id = ?").bind(id).run();
  return Boolean(result.meta?.changes);
}
