import { nowIso } from "../db/client";

/**
 * /trial 包级 18+ ack 偏好（0104）。
 *
 * 存储在 participant_preferences（0080 同表先例，按 participant_hash），两列：
 * - trial_adult_ack_all：全局 ack 标志——客户端既有全局 localStorage 键
 *   （trialAdultAgreement:v1）的服务端落点，客户端单向同步（幂等）；
 * - trial_adult_acked_pack_ids：包级 ack 列表（JSON 数组）——包级 ack 键为
 *   权威，**绝不回写全局键**（回写会立即废掉包级粒度）。
 *
 * 放行规则（POST /api/trial/runs 对 adult 包的唯一服务端强制点）＝ ack_all
 * 或 包 id 命中列表，任一即放行；刻意**不含** 0080 的 age_verified_at——
 * /trial 与 /s 是独立上下文，/s 的 attestation 不豁免 /trial 的包级门。
 *
 * 写入侧只支持「确认」不支持「撤销」：ack 是一次性合规确认（与客户端
 * GamePlayer.agree 的单向 '1' 一致），撤销不在本批语义内。
 */

/** 包级列表的硬上限：task_packs 本身极小，上限只为约束恶意刷行体积。 */
const ACKED_PACK_IDS_CAP = 200;

export interface TrialAdultAck {
  ackAll: boolean;
  ackedPackIds: number[];
}

/** 纯解析：容忍脏数据（非数组/非正整数项静默丢弃），去重、有界。 */
export function parseAckedPackIds(raw: unknown): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  for (const item of parsed) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0) seen.add(id);
  }
  return [...seen].sort((a, b) => a - b).slice(0, ACKED_PACK_IDS_CAP);
}

/** 纯判定（单测锚点）：全局标志或命中该包，任一即放行。 */
export function trialAdultAckAllowsPack(ack: Pick<TrialAdultAck, "ackAll" | "ackedPackIds">, packId: number): boolean {
  return ack.ackAll || ack.ackedPackIds.includes(packId);
}

export async function getTrialAdultAck(db: D1Database, participantHash: string): Promise<TrialAdultAck> {
  const row = await db
    .prepare(
      "SELECT trial_adult_ack_all ackAll, trial_adult_acked_pack_ids ackedPackIds FROM participant_preferences WHERE participant_hash = ? LIMIT 1",
    )
    .bind(participantHash)
    .first<{ ackAll: number; ackedPackIds: string }>();
  if (!row) return { ackAll: false, ackedPackIds: [] };
  return { ackAll: Number(row.ackAll ?? 0) === 1, ackedPackIds: parseAckedPackIds(row.ackedPackIds) };
}

/** 全局 ack（客户端既有全局键 '1' 的单向同步目标；幂等）。 */
export async function setTrialAdultAckAll(db: D1Database, participantHash: string): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO participant_preferences (participant_hash, trial_adult_ack_all, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT(participant_hash) DO UPDATE SET
         trial_adult_ack_all = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(participantHash, timestamp)
    .run();
}

/**
 * 追加一条包级 ack（幂等：重复确认同一包不膨胀列表）。插入用 SQL JSON1
 * 原位追加，避免读改写竞态把并发确认互相覆盖。
 */
export async function addTrialAdultAckedPack(db: D1Database, participantHash: string, packId: number): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO participant_preferences (participant_hash, trial_adult_acked_pack_ids, updated_at)
       VALUES (?, json_array(?), ?)
       ON CONFLICT(participant_hash) DO UPDATE SET
         trial_adult_acked_pack_ids = CASE
           WHEN json_array_length(COALESCE(trial_adult_acked_pack_ids, '[]'), '$') >= ?
             THEN trial_adult_acked_pack_ids
           WHEN EXISTS (
             SELECT 1 FROM json_each(COALESCE(trial_adult_acked_pack_ids, '[]'), '$')
             WHERE json_each.value = ?)
             THEN trial_adult_acked_pack_ids
           ELSE json_insert(COALESCE(trial_adult_acked_pack_ids, '[]'), '$[#]', ?)
         END,
         updated_at = excluded.updated_at`,
    )
    .bind(participantHash, packId, timestamp, ACKED_PACK_IDS_CAP, packId, packId)
    .run();
}
