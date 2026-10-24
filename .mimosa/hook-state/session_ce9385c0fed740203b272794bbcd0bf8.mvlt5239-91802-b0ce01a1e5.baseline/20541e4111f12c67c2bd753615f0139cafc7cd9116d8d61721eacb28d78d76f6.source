import { nowIso } from "../client";

export interface ParticipantLink {
  participantKey: string;
  userId: number;
  linkedAt: string;
}

export function participantHashForKey(participantKey: string): string {
  return `web_${participantKey}`;
}

export async function getParticipantLink(db: D1Database, participantKey: string): Promise<ParticipantLink | null> {
  const row = await db
    .prepare(
      `SELECT participant_key participantKey, user_id userId, linked_at linkedAt
       FROM participant_links
       WHERE participant_key = ?
       LIMIT 1`,
    )
    .bind(participantKey)
    .first<{ participantKey: string; userId: number; linkedAt: string }>();
  return row
    ? {
        participantKey: row.participantKey,
        userId: Number(row.userId),
        linkedAt: String(row.linkedAt),
      }
    : null;
}

export async function upsertParticipantLink(
  db: D1Database,
  input: { participantKey: string; userId: number },
): Promise<ParticipantLink> {
  const linkedAt = nowIso();
  await db
    .prepare(
      `INSERT INTO participant_links (participant_key, user_id, linked_at)
       VALUES (?, ?, ?)
       ON CONFLICT(participant_key) DO UPDATE SET
         user_id = excluded.user_id,
         linked_at = excluded.linked_at`,
    )
    .bind(input.participantKey, input.userId, linkedAt)
    .run();
  return { participantKey: input.participantKey, userId: input.userId, linkedAt };
}

/** Reassigns all anonymous responses created by one browser to a Telegram user. */
export async function linkResponsesToUser(
  db: D1Database,
  input: { participantKey: string; userId: number },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE survey_responses
       SET user_id = ?, updated_at = ?
       WHERE participant_hash = ? AND user_id IS NULL`,
    )
    .bind(input.userId, nowIso(), participantHashForKey(input.participantKey))
    .run();
  return result.meta?.changes ?? 0;
}

export async function countResponsesForParticipantKey(db: D1Database, participantKey: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM survey_responses
       WHERE participant_hash = ?`,
    )
    .bind(participantHashForKey(participantKey))
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
