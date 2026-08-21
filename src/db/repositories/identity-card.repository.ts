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
  createdAt: string;
  updatedAt: string;
}

export async function createIdentityProfile(
  db: D1Database,
  input: Omit<IdentityProfileRecord, "id" | "createdAt" | "updatedAt">,
): Promise<IdentityProfileRecord> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO identity_profiles
      (user_id, name, nickname, age, identity_label, description, front_asset_id, back_asset_id, background_asset_id, template_style, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.userId, input.name, input.nickname, input.age, input.identityLabel,
    input.description, input.frontAssetId, input.backAssetId, input.backgroundAssetId ?? null, input.templateStyle, now, now,
  ).run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法保存身份卡资料");
  return { ...input, id, createdAt: now, updatedAt: now };
}

export async function getIdentityProfileById(
  db: D1Database,
  id: number,
): Promise<IdentityProfileRecord | null> {
  const row = await db.prepare(
    `SELECT id, user_id, name, nickname, age, identity_label, description,
            front_asset_id, back_asset_id, background_asset_id, template_style,
            created_at, updated_at
     FROM identity_profiles WHERE id = ? LIMIT 1`,
  ).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: Number(row.id), userId: Number(row.user_id), name: String(row.name),
    nickname: typeof row.nickname === "string" ? row.nickname : null,
    age: typeof row.age === "number" ? row.age : null,
    identityLabel: typeof row.identity_label === "string" ? row.identity_label : null,
    description: typeof row.description === "string" ? row.description : null,
    frontAssetId: Number(row.front_asset_id),
    backAssetId: typeof row.back_asset_id === "number" ? row.back_asset_id : null,
    backgroundAssetId: typeof row.background_asset_id === "number" ? row.background_asset_id : null,
    templateStyle: String(row.template_style), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
