import { safeGet, safeSet } from "./storage";

/**
 * /trial 与问卷 game 题共用的包级 18+ ack 键（0106，B5 批次）。
 *
 * ack 语义（四条都要遵守）：
 * ① 包卡级一次性确认存 localStorage，**键含 pack id**（本模块的
 *    trialPackAckKey）——确认只对当前包生效，绝不写全局键
 *    trialAdultAgreement:v1（旧行为两个入口共用同一把全局钥匙，一次确认
 *    解锁所有包，本轮废除：TrialScreen / GamePlayer / PluginGamePlay 的
 *    写入全部改为按包）；
 * ② 全局键 === '1' 只读单向兼容视为已 ack 所有包：存量用户（旧页级门与旧
 *    GamePlayer/PluginGamePlay 写入）零回归——读侧兼容、不再写它；
 * ③ 服务端第二道闸：开局请求（POST /api/trial/runs）对 adult 包必须显式
 *    携带 adultAck: true（请求参数确认），客户端只有在本地包级 ack 后才
 *    可能带上；未携带时服务端 451 + adult_ack_required，客户端据此弹确认。
 *    本地键是唯一 ack 状态，服务端不存偏好，所以没有「本地/服务端 ack
 *    失配」的自愈问题——失配只可能来自包被管理员新标成 18+，此时 451 的
 *    错误码会触发调用方重弹确认；
 * ④ 严格不触碰 /s/{id} 答题流其余 DOM 与 cert/（GamePlayer/PluginGamePlay
 *    只换钥匙语义，门禁卡片的标记原样保留）。
 */

/** 全局键：只读兼容（②）。旧字面量留在 GamePlayer.tsx:30 已随本轮移除，仅此处保留。 */
export const TRIAL_AGREEMENT_GLOBAL_KEY = "trialAdultAgreement:v1";

/** 包级 ack 键前缀：完整键 = 前缀 + pack id（①：键含 pack id）。 */
export const TRIAL_PACK_ACK_PREFIX = "trialAdultPackAck:v1:";

/**
 * 18+ 确认弹层的统一文案（修复 3：徽标与门同源——三处确认（/trial 包卡弹层、
 * /s 内嵌 GamePlayer、/s 内嵌 PluginGamePlay）共用同一常量，绝不各写一份）：
 * - 文案里注明「确认仅对当前包生效」：包级 ack 键含 pack id，确认一个包不会
 *   放行其它包；
 * - 键语义说明：与旧全局键 trialAdultAgreement:v1 不互通也不迁移——全局键
 *   只读单向兼容存量用户（②），新确认永远只写包级键，避免误放行。
 */
export const TRIAL_ADULT_CONFIRM_LABEL = "我已年满 18 周岁，同意进入";

/** 18+ 警示正文：packName 拼进「本包为 18+」句；其余句子三处共用。 */
export function trialAdultNoticeLines(packName: string | null): string[] {
  const head = packName
    ? `「${packName}」为 18+ 成人向虚构文字任务游戏，含羞耻与服从主题内容。`
    : "该小游戏为 18+ 成人向虚构文字任务游戏，含羞耻与服从主题内容。";
  return [
    head,
    "全部场景均为想象中的虚拟情境，请遵守当地法律，切勿在现实公共场所实施任何内容。",
    // 包级记忆语义（修复 3 ④）：确认只写包级键、只对当前包生效；与旧全局键
    // trialAdultAgreement:v1 不互通、不迁移（避免一次确认解锁所有包）。
    "确认仅对当前包生效：换一个包需要重新确认（本偏好记录在本设备）。",
  ];
}

/** 纯键构造（单测锚点）：包级键必须含 pack id，不同包不同键。 */
export function trialPackAckKey(packId: number): string {
  return `${TRIAL_PACK_ACK_PREFIX}${packId}`;
}

/**
 * 纯判定（②）：全局键 '1' 单向兼容放行所有包；否则看该包的包级键。
 * 两个值都来自调用方读取的 localStorage，拆出来是为了纯函数可单测。
 */
export function isAdultPackAckedIn(globalValue: string | null, packValue: string | null): boolean {
  return globalValue === "1" || packValue === "1";
}

/* ---------------- 存储包装（localStorage 不可用时静默降级） ---------------- */

/** 读全局键（只读兼容，本模块任何写入路径都不碰它）。 */
export function readGlobalAdultAck(): string | null {
  return safeGet(TRIAL_AGREEMENT_GLOBAL_KEY);
}

/** 该 adult 包在本地是否已 ack（全局键兼容或包级键命中）。 */
export function isAdultPackAckedLocally(packId: number): boolean {
  return isAdultPackAckedIn(readGlobalAdultAck(), safeGet(trialPackAckKey(packId)));
}

/**
 * 记录一个包级 ack：只写包级键（trialAdultPackAck:v1:<packId> = '1'），
 * **绝不写全局键**（语义①）。幂等：重复确认重写同一值。
 */
export function ackAdultPackLocally(packId: number): void {
  safeSet(trialPackAckKey(packId), "1");
}
