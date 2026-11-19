import { safeGet, safeSet } from "./storage";

/**
 * /trial 包级 18+ ack 键（0104）：页级门禁下沉到包卡级后的客户端语义。
 *
 * ack 语义选定（复核修订，四条都要遵守）：
 * ① 包级 ack 键（本模块的 TRIAL_PACK_ACKS_KEY 列表）为权威，且**绝不回写
 *    全局键** trialAdultAgreement:v1——回写会立即废掉包级粒度（一个包的
 *    确认瞬间变成所有包的确认）；
 * ② 全局键 === '1' 单向兼容视为已 ack 所有包：存量用户（旧页级门写入）与
 *    在 /s 已通过 GamePlayer/PluginGamePlay 确认过的用户零回归——读侧兼容、
 *    不再写它；
 * ③ 代价：仅在 /trial 按包确认过的新用户，进入 /s 答题流时会被 /s 自身的
 *    按局门（GamePlayer.tsx:69/:192、PluginGamePlay.tsx:73/:142，本轮零改动）
 *    再确认一次——属一次性独立上下文确认而非回归；
 * ④ 严格不触碰 PluginGamePlay.tsx / GamePlayer.tsx 与 cert-page.ts /
 *    cert/index.html。
 */

/** 全局键：只读兼容（②）；GamePlayer.tsx:30 的 TRIAL_AGREEMENT_KEY 是同一字面量（/s 侧写它，本轮不动）。 */
export const TRIAL_AGREEMENT_GLOBAL_KEY = "trialAdultAgreement:v1";

/** 包级 ack 列表键（①）：JSON 数组的 pack id，权威且不回写全局键。 */
export const TRIAL_PACK_ACKS_KEY = "trialAdultPackAcks:v1";

/** 纯解析：容忍脏数据（非 JSON/非数组/非正整数一律丢弃），去重升序。 */
export function parseTrialPackAcks(raw: string | null): number[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  for (const item of parsed) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0) seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 纯判定（②）：全局键 === '1' 单向兼容视为已 ack 所有包，否则查包级列表。 */
export function isAdultPackAckedIn(globalValue: string | null, ackedPackIds: number[], packId: number): boolean {
  return globalValue === "1" || ackedPackIds.includes(packId);
}

/** 纯写入（①）：返回加入该包后的列表；不含全局键，序列化交给调用方。 */
export function withPackAck(ackedPackIds: number[], packId: number): number[] {
  if (ackedPackIds.includes(packId)) return ackedPackIds;
  return [...ackedPackIds, packId].sort((a, b) => a - b);
}

/**
 * 纯移除（451 自愈专用）：返回剔除该包后的列表；不在列表时原样返回。
 * **不是**用户可触发的「撤销 ack」——服务端偏好只确认不撤销；唯一调用点是
 * 开局撞上 adult_ack_required 时的本地一致性修复（本地键残留/存储迁移导致
 * 本地视为已 ack 而服务端没有），修完重弹按包确认重新走服务端优先写。
 */
export function withoutPackAck(ackedPackIds: number[], packId: number): number[] {
  if (!ackedPackIds.includes(packId)) return ackedPackIds;
  return ackedPackIds.filter((id) => id !== packId);
}

/* ---------------- 存储包装（localStorage 不可用时静默降级） ---------------- */

export function readGlobalAdultAck(): boolean {
  return safeGet(TRIAL_AGREEMENT_GLOBAL_KEY) === "1";
}

export function readTrialPackAcks(): number[] {
  return parseTrialPackAcks(safeGet(TRIAL_PACK_ACKS_KEY));
}

/** 该 adult 包在本地是否已 ack（全局键兼容或包级命中）。 */
export function isAdultPackAckedLocally(packId: number): boolean {
  return isAdultPackAckedIn(safeGet(TRIAL_AGREEMENT_GLOBAL_KEY), readTrialPackAcks(), packId);
}

/**
 * 记录一个包级 ack：只写包级列表，**绝不写全局键**（语义①）。返回写入后
 * 的完整列表供调用方展示/断言。
 */
export function ackAdultPackLocally(packId: number): number[] {
  const next = withPackAck(readTrialPackAcks(), packId);
  safeSet(TRIAL_PACK_ACKS_KEY, JSON.stringify(next));
  return next;
}

/**
 * {@link ackAdultPackLocally} 的自愈对偶（{@link withoutPackAck}）：开局撞上
 * 服务端 451（adult_ack_required）时清掉该包的本地 ack，让下次交互重弹按包
 * 确认。同样**绝不写全局键**（语义①，全局键用户的兼容放行不受影响）。
 */
export function removeAdultPackAckLocally(packId: number): number[] {
  const next = withoutPackAck(readTrialPackAcks(), packId);
  safeSet(TRIAL_PACK_ACKS_KEY, JSON.stringify(next));
  return next;
}
