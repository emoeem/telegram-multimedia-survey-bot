import { nowIso } from "../client";

/** One unlocked badge for a participant. */
export interface ParticipantAchievement {
  code: string;
  unlockedAt: string;
  seen: boolean;
  meta: Record<string, unknown> | null;
}

function mapRow(row: Record<string, unknown>): ParticipantAchievement {
  let meta: Record<string, unknown> | null = null;
  if (typeof row.meta_json === "string" && row.meta_json) {
    try {
      const parsed = JSON.parse(row.meta_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    code: String(row.code),
    unlockedAt: String(row.unlocked_at),
    seen: Number(row.seen ?? 0) === 1,
    meta,
  };
}

export async function listParticipantAchievements(
  db: D1Database,
  participantHash: string,
): Promise<ParticipantAchievement[]> {
  const rows = await db
    .prepare(
      `SELECT code, unlocked_at, seen, meta_json
         FROM participant_achievements
        WHERE participant_hash = ?
        ORDER BY unlocked_at DESC, id DESC`,
    )
    .bind(participantHash)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapRow);
}

/**
 * Records an unlock. Idempotent: the UNIQUE(participant_hash, code) constraint
 * makes a repeat evaluation a no-op, and `meta.changes` tells the caller
 * whether this call was the one that actually unlocked it (that boolean drives
 * the celebratory response payload, never the badge count).
 */
export async function insertParticipantAchievement(
  db: D1Database,
  input: { participantHash: string; code: string; meta?: Record<string, unknown> | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO participant_achievements (participant_hash, code, unlocked_at, seen, meta_json)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .bind(
      input.participantHash,
      input.code,
      nowIso(),
      input.meta === undefined || input.meta === null ? null : JSON.stringify(input.meta),
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface PendingAchievementUnlock {
  code: string;
  meta?: Record<string, unknown> | null;
}

/**
 * Batch version of {@link insertParticipantAchievement} for full re-evaluations:
 * callers qualify badges in memory and read the existing unlocks once, so only
 * genuinely new badges hit the database — and in one `db.batch` round trip
 * instead of one INSERT per badge. Returns the codes this call actually
 * unlocked (INSERT OR IGNORE changes > 0), in input order.
 */
export async function insertParticipantAchievements(
  db: D1Database,
  input: { participantHash: string; unlocks: PendingAchievementUnlock[] },
): Promise<string[]> {
  if (input.unlocks.length === 0) return [];
  const timestamp = nowIso();
  const statements = input.unlocks.map((unlock) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO participant_achievements (participant_hash, code, unlocked_at, seen, meta_json)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .bind(
        input.participantHash,
        unlock.code,
        timestamp,
        unlock.meta === undefined || unlock.meta === null ? null : JSON.stringify(unlock.meta),
      ),
  );
  const results = await db.batch(statements);
  return input.unlocks
    .filter((_, index) => (results[index]?.meta?.changes ?? 0) > 0)
    .map((unlock) => unlock.code);
}

/** Marks every unseen badge as seen; returns how many rows changed. */
export async function markParticipantAchievementsSeen(db: D1Database, participantHash: string): Promise<number> {
  const result = await db
    .prepare("UPDATE participant_achievements SET seen = 1 WHERE participant_hash = ? AND seen = 0")
    .bind(participantHash)
    .run();
  return result.meta?.changes ?? 0;
}
