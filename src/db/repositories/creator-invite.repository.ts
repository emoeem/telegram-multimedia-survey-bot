/** 体验创作者邀请码：生成、列表、作废、原子核销。 */
export interface CreatorInviteRecord {
  code: string;
  days: number;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  note: string | null;
  createdBy: number | null;
  createdAt: string;
}

interface CreatorInviteRow {
  code: string;
  days: number;
  max_uses: number;
  used_count: number;
  expires_at: string;
  note: string | null;
  created_by: number | null;
  created_at: string;
}

function mapInvite(row: CreatorInviteRow): CreatorInviteRecord {
  return {
    code: row.code,
    days: Number(row.days),
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    expiresAt: row.expires_at,
    note: row.note,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at,
  };
}

export async function createCreatorInvite(
  db: D1Database,
  input: { code: string; days: number; maxUses: number; expiresAt: string; note: string | null; createdBy: number | null },
): Promise<CreatorInviteRecord> {
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO creator_invites (code, days, max_uses, used_count, expires_at, note, created_by, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(input.code, input.days, input.maxUses, input.expiresAt, input.note, input.createdBy, createdAt)
    .run();
  return {
    code: input.code,
    days: input.days,
    maxUses: input.maxUses,
    usedCount: 0,
    expiresAt: input.expiresAt,
    note: input.note,
    createdBy: input.createdBy,
    createdAt,
  };
}

export async function listCreatorInvites(db: D1Database, limit = 50): Promise<CreatorInviteRecord[]> {
  const rows = await db
    .prepare(
      `SELECT code, days, max_uses, used_count, expires_at, note, created_by, created_at
         FROM creator_invites
        ORDER BY created_at DESC, code ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<CreatorInviteRow>();
  return (rows.results ?? []).map(mapInvite);
}

export async function deleteCreatorInvite(db: D1Database, code: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM creator_invites WHERE code = ?").bind(code).run();
  return (result.meta?.changes ?? 0) > 0;
}

export type RedeemCreatorInviteResult =
  | { ok: true; days: number }
  | { ok: false; reason: "not_found" | "expired" | "exhausted" };

/**
 * 核销一次。原子性靠单条 UPDATE 的条件（次数 + 有效期），并发兑换只会有一个拿走名额；
 * 失败时再查一次行，好让调用方给出「不存在 / 已过期 / 已用完」的准确文案。
 */
export async function redeemCreatorInvite(
  db: D1Database,
  code: string,
  now = new Date().toISOString(),
): Promise<RedeemCreatorInviteResult> {
  const updated = await db
    .prepare(
      `UPDATE creator_invites
          SET used_count = used_count + 1
        WHERE code = ? AND used_count < max_uses AND expires_at > ?
        RETURNING days`,
    )
    .bind(code, now)
    .first<{ days: number }>();
  if (updated) return { ok: true, days: Number(updated.days) };

  const existing = await db
    .prepare("SELECT used_count, max_uses, expires_at FROM creator_invites WHERE code = ? LIMIT 1")
    .bind(code)
    .first<{ used_count: number; max_uses: number; expires_at: string }>();
  if (!existing) return { ok: false, reason: "not_found" };
  if (String(existing.expires_at) <= now) return { ok: false, reason: "expired" };
  return { ok: false, reason: "exhausted" };
}
