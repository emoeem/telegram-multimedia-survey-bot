import { useEffect, useState } from "react";
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";
import {
  LUDO_FINISH_POS,
  parseDoudizhuView,
  parseGomokuView,
  parseLudoView,
  parseWerewolfView,
  parseXiangqiView,
  type DoudizhuView,
} from "./game-room-logic";
import { safeGet, safeSet } from "./storage";

/**
 * 联机对局音效（game sound）——五款玩法（五子棋/象棋/飞行棋/斗地主/狼人杀）
 * 与大厅共用的系统提示音 + 玩法音效层。零外部资产：全部运行时 WebAudio 合成
 * （振荡器包络 / 噪声脉冲 / 滤波扫频），不引音频文件、不落盘、零存储成本。
 *
 * 混音结构（audio-design 技能的总线思想：按总线混音，不按单件改音量）：
 *
 *     destination ← master(音量滑条 0..1 经 dB 映射) ← { sfx(玩法动作), ui(系统提示) }
 *
 * - 每条事件的相对响度写进 CUES 表的 db 字段（改混音不动合成代码）；母线留
 *   头空间，事件内部再按 0 dB 缩放波形，叠加时不顶爆 0 dBFS。
 * - 音量感知是对数的：滑条线性插值的是 dB（-60..0），不是线性增益
 *   （volumeSliderToDb / volumeSliderToGain，转换只在边缘做）。
 * - 自动播放合规：AudioContext 只在用户手势后创建/resume；手势前一切 play()
 *   静默丢弃——WS 推送驱动的声音（对手落子/开局）绝不在手势前出声。
 * - 防机关枪：同一事件 200ms 内去重（isDeduped）；重复音效 ±6% 音高抖动
 *   （jitterRate）。
 * - fire-and-forget：play() 同步返回、从不 await；AudioContext 不可用/
 *   恢复失败一律静默降级（这次不响），绝不打断对局渲染。
 *
 * 接线纪律（调用点集中便于调音）：全部对局声音的唯一入口是
 * MultiplayerGameScreen 的 onState（状态差分 → deriveGameSoundEvents →
 * playGameSound）、onChat（消息 pop）与本地走秒（倒计时 tick）——Board 面板
 * 与大厅面板不直接发声；声音一律以服务端推送的权威状态为事实来源，本地点击
 * 不预放（等回声，双方同一时刻听到同一个声音）。
 *
 * 信息纪律：狼人杀夜间狼刀音（ww_knife）只从狼人私有字段（yourRole/wolfMates/
 * nightKnife）推导——普通客户端与观战视图的载荷从协议形状上就没有这些字段，
 * 推不出这个事件（deriveGameSoundEvents + 泄漏断言测试双保险）。
 */

// ---------------------------------------------------------------------------
// 事件全集（新增事件只在末尾追加）
// ---------------------------------------------------------------------------

export type GameSoundEvent =
  // ---- 系统类（ui 总线）----
  /** 轮到你（双音上行）。 */
  | "turn_you"
  /** 对手行动短 tick（叫分/过牌等不换手的动作；落子类由玩法音效覆盖）。 */
  | "opponent_action"
  /** 对局开始 stinger。 */
  | "game_start"
  /** 胜利（上行琶音）。 */
  | "victory"
  /** 失败（下行）。 */
  | "defeat"
  /** 平局（中性双音）。 */
  | "draw"
  /** 倒计时 ≤10s 每秒 tick。 */
  | "countdown_tick"
  /** 超时判负（警示）。 */
  | "timeout_loss"
  /** 玩家加入（轻 blip）。 */
  | "player_join"
  /** 玩家离开（轻 blip）。 */
  | "player_leave"
  /** 新聊天消息（soft pop；自己的回显不响）。 */
  | "chat_pop"
  // ---- 玩法类（sfx 总线）----
  /** 五子棋落子（石子敲击）。 */
  | "gomoku_place"
  /** 五子棋悔棋（回退 swish）。 */
  | "gomoku_undo"
  /** 象棋落子（木质 snap）。 */
  | "xiangqi_place"
  /** 象棋将军（警报双音）。 */
  | "xiangqi_check"
  /** 飞行棋骰子（噪声滚筒 ~0.3s）。 */
  | "ludo_dice"
  /** 飞行棋撞机。 */
  | "ludo_capture"
  /** 飞行棋到达终点。 */
  | "ludo_finish"
  /** 斗地主发牌（riffle）。 */
  | "dd_deal"
  /** 斗地主出牌（slap）。 */
  | "dd_play"
  /** 斗地主炸弹/王炸（boom）。 */
  | "dd_bomb"
  /** 斗地主春天（结算 jingle）。 */
  | "dd_spring"
  /** 狼人杀天黑（下行 sweep）。 */
  | "ww_night"
  /** 狼人杀天亮（上行）。 */
  | "ww_dawn"
  /** 狼人杀死亡（低音 sting）。 */
  | "ww_death"
  /** 狼人杀投票结果（亮票）。 */
  | "ww_vote"
  /** 狼人杀猎人开枪窗口。 */
  | "ww_hunter"
  /** 狼人杀夜间狼刀已定——只对狼人客户端触发（私有字段推导），普通客户端绝不播放。 */
  | "ww_knife";

// ---------------------------------------------------------------------------
// 音量与去重（纯函数：root tsc 以 WebWorker lib 编译本文件，测试直接导入）
// ---------------------------------------------------------------------------

/** 音量滑条映射的 dB 下限（0 之上最近的一格也有可听的 -6dB 起步段）。 */
export const GAME_VOLUME_MIN_DB = -60;
/** 默认音量（0..1）：-12 dB，留足头空间。 */
export const GAME_SOUND_DEFAULT_VOLUME = 0.8;
/** 同一事件的最小重复间隔：连发去重，避免机关枪。 */
export const GAME_SOUND_DEDUP_MS = 200;
/** 重复音效的音高抖动幅度（±6%）。 */
export const GAME_SOUND_PITCH_JITTER = 0.06;
/** 倒计时 tick 的紧急窗口（≤10s 每秒 tick）。 */
export const GAME_SOUND_COUNTDOWN_URGENT_MS = 10_000;

/**
 * 持久化键（沿用本目录 settings 约定：扁平 camelCase，sfx.ts 的
 * surveyAudioEnabled 同款）。开关存 "1"/"0"，音量存 0..1 数字串。
 */
export const GAME_SOUND_ENABLED_KEY = "gameSoundEnabled";
export const GAME_SOUND_VOLUME_KEY = "gameSoundVolume";

/**
 * 音量滑条值（0..1）→ dB：对数感知的关键——滑条等分插值的是 dB 而不是增益，
 * 每 +0.1 都是恒定的 +6 dB，听感线性。0 → -Infinity（彻底静音），1 → 0 dB。
 */
export function volumeSliderToDb(value: number): number {
  // NaN 与 -Infinity 一律视为 0（彻底静音，母线增益精确为 0）；+Infinity 视为 1。
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY;
  const v = Math.min(1, value);
  return GAME_VOLUME_MIN_DB + (0 - GAME_VOLUME_MIN_DB) * v;
}

/** dB → 线性增益（转换只在边缘做；-Infinity → 0）。 */
export function dbToGain(db: number): number {
  if (db === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(db)) return db < 0 ? 0 : 1;
  return 10 ** (db / 20);
}

/** 音量滑条值 → 线性增益（母线 master 用）。 */
export function volumeSliderToGain(value: number): number {
  return dbToGain(volumeSliderToDb(value));
}

/** localStorage 读出的音量字符串 → 0..1（脏数据/缺省回默认值）。 */
export function parseStoredVolume(raw: string | null): number {
  if (raw === null) return GAME_SOUND_DEFAULT_VOLUME;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return GAME_SOUND_DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, parsed));
}

/** 去重判定：同一事件距上次播放不足 windowMs 就丢弃（从未播过 → 不去重）。 */
export function isDeduped(lastPlayedAt: number, now: number, windowMs: number = GAME_SOUND_DEDUP_MS): boolean {
  return now - lastPlayedAt < windowMs;
}

/** ±6% 音高抖动：random01 ∈ [0,1] → [0.94, 1.06]。 */
export function jitterRate(random01: number): number {
  return 1 + (Math.min(1, Math.max(0, random01)) * 2 - 1) * GAME_SOUND_PITCH_JITTER;
}

/**
 * 倒计时是否走到「下一秒且已进入 ≤10s 紧急窗口」：只在真实走秒（next < prev）
 * 时响——换手重置/重连跳变不响。两个 null（无时限/未同步）都不响。
 */
export function countdownTickDue(prevRemainingMs: number | null, nextRemainingMs: number | null): boolean {
  if (prevRemainingMs === null || nextRemainingMs === null) return false;
  if (nextRemainingMs <= 0 || nextRemainingMs > GAME_SOUND_COUNTDOWN_URGENT_MS) return false;
  if (nextRemainingMs >= prevRemainingMs) return false;
  return Math.floor(prevRemainingMs / 1000) !== Math.floor(nextRemainingMs / 1000);
}

// ---------------------------------------------------------------------------
// 状态差分 → 声音事件（纯函数：声音的事实来源是服务端推送的权威状态）
// ---------------------------------------------------------------------------

export interface GameSoundDiffInput {
  gameType: string;
  role: "player" | "spectator";
  /** 我的 participantHash（玩家身份）；观战为 null。 */
  myHash: string | null;
  /** 上一帧信封（null = 首帧/进房/重连后的第一帧）。 */
  prev: GamePlayerView | GamePublicView | null;
  /** 新帧信封。 */
  next: GamePlayerView | GamePublicView;
}

/**
 * 信封 + 玩法载荷的帧间差分 → 本帧要播的声音事件（按推导顺序排列）。
 *
 * 首帧一律不响：进房/重连不补放历史声音，只对「变化」发声。解析失败的载荷
 * 静默跳过玩法级差分（信封级差分照常）——声音是锦上添花，不制造新错误。
 */
export function deriveGameSoundEvents(input: GameSoundDiffInput): GameSoundEvent[] {
  const { gameType, role, myHash, prev, next } = input;
  const events: GameSoundEvent[] = [];
  if (prev === null) return events;
  const amPlayer = role === "player" && myHash !== null;

  // ---- 信封级差分（玩法无关）----

  // 对局开始：大厅 → 对局。
  if (prev.status === "lobby" && next.status === "playing") events.push("game_start");

  // 结算：胜/负/平/超时判负（观战者不给胜负音——横幅已足够）。
  if (prev.status !== "settled" && next.status === "settled") {
    const resultSound = settlementResultSound(gameType, amPlayer, myHash, next);
    if (resultSound !== null) events.push(resultSound);
  }

  // 玩家加入/离开：信封 players 在座行差分（大厅与对局都算）。
  const prevActive = new Set(
    (prev.players ?? []).filter((player) => player.leftAt === null).map((player) => player.participantHash),
  );
  for (const player of next.players ?? []) {
    if (player.leftAt !== null) {
      if (prevActive.has(player.participantHash)) events.push("player_leave");
    } else if (!prevActive.has(player.participantHash)) {
      events.push("player_join");
    }
  }

  // ---- 玩法级差分 ----
  if (gameType === "gomoku") deriveGomoku(events, amPlayer, myHash, prev, next);
  else if (gameType === "xiangqi") deriveXiangqi(events, amPlayer, myHash, prev, next);
  else if (gameType === "ludo") deriveLudo(events, amPlayer, prev, next);
  else if (gameType === "doudizhu") deriveDoudizhu(events, amPlayer, prev, next);
  else if (gameType === "werewolf") deriveWerewolf(events, amPlayer, prev, next);

  return events;
}

/** 结算 → 结果音（无赢家/中止局不响）。payload outcome 优先，信封 settlement 兜底。 */
function settlementResultSound(
  gameType: string,
  amPlayer: boolean,
  myHash: string | null,
  view: GamePlayerView | GamePublicView,
): GameSoundEvent | null {
  if (!amPlayer) return null;
  if (gameType === "doudizhu") {
    const d = parseDoudizhuView(view.view);
    const outcome = d?.outcome ?? null;
    if (outcome !== null) {
      // 春天/反春天是最具记忆点的结算时刻：以 jingle 替代常规胜负音。
      if (outcome.spring === "spring" || outcome.spring === "anti_spring") return "dd_spring";
      if (outcome.result === "aborted" || outcome.winnerSide === null) return null;
      const iAmLandlord =
        d !== null && d.yourSeat !== null && (d.seats.find((s) => s.seatIndex === d.yourSeat)?.isLandlord ?? false);
      if (outcome.winnerSide === "landlord") return iAmLandlord ? "victory" : "defeat";
      return iAmLandlord ? "defeat" : "victory";
    }
  } else if (gameType === "werewolf") {
    const w = parseWerewolfView(view.view);
    const outcome = w?.outcome ?? null;
    if (outcome !== null) {
      if (outcome.result === "aborted" || outcome.winnerSide === null) return null;
      const mySide = w?.yourRole === "werewolf" ? "wolves" : "good";
      return outcome.winnerSide === mySide ? "victory" : "defeat";
    }
  } else if (gameType === "ludo") {
    const l = parseLudoView(view.view);
    const outcome = l?.outcome ?? null;
    if (outcome !== null) {
      if (outcome.result === "aborted" || outcome.winnerSeat === null) return null;
      return outcome.winnerSeat === l?.yourSeat ? "victory" : "defeat";
    }
  } else if (gameType === "gomoku" || gameType === "xiangqi") {
    const outcome =
      gameType === "gomoku"
        ? (parseGomokuView(view.view)?.outcome ?? null)
        : (parseXiangqiView(view.view)?.outcome ?? null);
    const result = outcome?.result ?? view.settlement?.result ?? null;
    const winner = outcome?.winnerParticipantHash ?? view.settlement?.winnerParticipantHash ?? null;
    if (result === "draw") return "draw";
    if (result === "aborted" || winner === null) return null;
    if (myHash !== null && winner === myHash) return "victory";
    if (result === "timeout") return "timeout_loss";
    return "defeat";
  }
  // 信封 settlement 兜底（payload 解析失败的已知玩法与未注册玩法）。
  const settlement = view.settlement ?? null;
  if (settlement === null || settlement.result === "aborted") return null;
  if (settlement.result === "draw") return "draw";
  const winner = settlement.winnerParticipantHash;
  if (winner === null) return null;
  if (myHash !== null && winner === myHash) return "victory";
  if (settlement.result === "timeout") return "timeout_loss";
  return "defeat";
}

function deriveGomoku(
  events: GameSoundEvent[],
  amPlayer: boolean,
  myHash: string | null,
  prev: GamePlayerView | GamePublicView,
  next: GamePlayerView | GamePublicView,
): void {
  const prevG = parseGomokuView(prev.view);
  const nextG = parseGomokuView(next.view);
  if (prevG === null || nextG === null) return;
  // 落子/悔棋：moveCount 是权威计步（悔棋回退时变小）。
  if (nextG.moveCount > prevG.moveCount) events.push("gomoku_place");
  else if (nextG.moveCount < prevG.moveCount) events.push("gomoku_undo");
  // 轮到你：turn 变成我的颜色且对局还在进行（开局首帧不响——有开局 stinger）。
  if (
    amPlayer &&
    nextG.yourColor !== null &&
    next.status === "playing" &&
    nextG.outcome === null &&
    nextG.turn === nextG.yourColor &&
    prevG.turn !== nextG.yourColor
  ) {
    events.push("turn_you");
  }
}

function deriveXiangqi(
  events: GameSoundEvent[],
  amPlayer: boolean,
  myHash: string | null,
  prev: GamePlayerView | GamePublicView,
  next: GamePlayerView | GamePublicView,
): void {
  const prevX = parseXiangqiView(prev.view);
  const nextX = parseXiangqiView(next.view);
  if (prevX === null || nextX === null) return;
  if (nextX.moveCount > prevX.moveCount) {
    events.push("xiangqi_place");
    // 将军：最后一手带 givesCheck（全局事件，双方与观战都听警报）。
    if (nextX.lastMove?.givesCheck === true) events.push("xiangqi_check");
  }
  if (
    amPlayer &&
    nextX.yourColor !== null &&
    next.status === "playing" &&
    nextX.outcome === null &&
    nextX.turn === nextX.yourColor &&
    prevX.turn !== nextX.yourColor
  ) {
    events.push("turn_you");
  }
}

function deriveLudo(
  events: GameSoundEvent[],
  amPlayer: boolean,
  prev: GamePlayerView | GamePublicView,
  next: GamePlayerView | GamePublicView,
): void {
  const prevL = parseLudoView(prev.view);
  const nextL = parseLudoView(next.view);
  if (prevL === null || nextL === null) return;
  // 新的一手 = 一次掷骰 + 行动（服务端不复算，客户端只读历史末条）。
  if (nextL.history.length > prevL.history.length) {
    const move = nextL.history[nextL.history.length - 1];
    if (move) {
      events.push("ludo_dice");
      if (move.captures.length > 0) events.push("ludo_capture");
      if (move.to === LUDO_FINISH_POS) events.push("ludo_finish");
    }
  }
  // 轮到你（座位轮转）。
  if (
    amPlayer &&
    nextL.yourSeat !== null &&
    next.status === "playing" &&
    nextL.outcome === null &&
    nextL.turnSeat === nextL.yourSeat &&
    prevL.turnSeat !== nextL.turnSeat
  ) {
    events.push("turn_you");
  }
  // 我超时（事件流水）：警示音（结算音另行）。
  if (amPlayer && nextL.events.length > prevL.events.length) {
    const event = nextL.events[nextL.events.length - 1];
    if (event?.kind === "timeout" && event.seatIndex === nextL.yourSeat) events.push("timeout_loss");
  }
}

function deriveDoudizhu(
  events: GameSoundEvent[],
  amPlayer: boolean,
  prev: GamePlayerView | GamePublicView,
  next: GamePlayerView | GamePublicView,
): void {
  const prevD = parseDoudizhuView(prev.view);
  const nextD = parseDoudizhuView(next.view);
  if (prevD === null || nextD === null) return;
  // 发牌：手牌从无到有（玩家看自己的手牌，观战看任一座位来牌）或重发。
  const hadCards = prevD.hand.length > 0 || prevD.seats.some((s) => s.handCount > 0);
  const gotCards = nextD.hand.length > 0 || nextD.seats.some((s) => s.handCount > 0);
  if (!hadCards && gotCards) events.push("dd_deal");
  if (nextD.redealCount > prevD.redealCount) events.push("dd_deal");
  // 出牌/叫分/过：看历史末条（炸弹/王炸给 boom，其余出牌给 slap）。
  if (nextD.history.length > prevD.history.length) {
    const last = nextD.history[nextD.history.length - 1];
    if (last) {
      if (last.kind === "play") {
        events.push(last.playType === "bomb" || last.playType === "rocket" ? "dd_bomb" : "dd_play");
      } else if (last.kind === "bid" || last.kind === "pass") {
        if (last.seatIndex !== nextD.yourSeat) events.push("opponent_action");
      }
    }
  }
  // 轮到你：出牌轮（currentTurn）或叫分轮（我的座位 isBidTurn）。
  const myBidTurn = (d: DoudizhuView): boolean =>
    d.yourSeat !== null && (d.seats.find((s) => s.seatIndex === d.yourSeat)?.isBidTurn ?? false);
  const prevMyTurn = prevD.phase === "playing" ? prevD.currentTurn === prevD.yourSeat : myBidTurn(prevD);
  const nextMyTurn = nextD.phase === "playing" ? nextD.currentTurn === nextD.yourSeat : myBidTurn(nextD);
  if (amPlayer && next.status === "playing" && nextD.outcome === null && nextMyTurn && !prevMyTurn) {
    events.push("turn_you");
  }
}

function deriveWerewolf(
  events: GameSoundEvent[],
  amPlayer: boolean,
  prev: GamePlayerView | GamePublicView,
  next: GamePlayerView | GamePublicView,
): void {
  const prevW = parseWerewolfView(prev.view);
  const nextW = parseWerewolfView(next.view);
  if (prevW === null || nextW === null) return;
  // 天黑/天亮（猎人不算白天：它有自己的警报，避免天亮 sweep 叠加）。
  const wasNight = isWerewolfNightPhase(prevW.phase);
  const isNight = isWerewolfNightPhase(nextW.phase);
  if (!wasNight && isNight) events.push("ww_night");
  if (wasNight && (nextW.phase === "day_speak" || nextW.phase === "day_vote" || nextW.phase === "day_pk")) {
    events.push("ww_dawn");
  }
  if (prevW.phase !== "hunter_shot" && nextW.phase === "hunter_shot") events.push("ww_hunter");
  // 死亡：公开的死亡座位表增长（夜里刀死白天公布都在这里响）。
  if (nextW.deadSeats.length > prevW.deadSeats.length) events.push("ww_death");
  // 投票结果：亮票事件（完整票面公示）落地时响。
  if (nextW.events.length > prevW.events.length) {
    const newest = nextW.events[nextW.events.length - 1];
    if (newest?.kind === "vote") events.push("ww_vote");
  }
  // 轮到你发言（白天发言座）。
  if (
    amPlayer &&
    nextW.yourSeat !== null &&
    nextW.phase === "day_speak" &&
    nextW.speakTurnSeat === nextW.yourSeat &&
    prevW.speakTurnSeat !== nextW.yourSeat
  ) {
    events.push("turn_you");
  }
  // 夜间狼刀已定：只对狼人客户端触发——yourRole/wolfMates/nightKnife 是引擎
  // 按人裁剪的狼人私有字段，普通客户端/观战载荷从协议形状上没有它们，推不出
  // 这个事件（见 tests 的泄漏断言）。nightKnife 在新夜重置为 null，刀定即
  // null → 座位的跳变（托管自动刀同样进狼人视图，一样会响）。
  if (
    amPlayer &&
    nextW.yourRole === "werewolf" &&
    nextW.wolfMates !== null &&
    nextW.nightKnife !== null &&
    nextW.nightKnife !== prevW.nightKnife
  ) {
    events.push("ww_knife");
  }
}

function isWerewolfNightPhase(phase: string): boolean {
  return phase === "night_guard" || phase === "night_wolf" || phase === "night_seer" || phase === "night_witch";
}

// ---------------------------------------------------------------------------
// WebAudio 合成（结构类型：root tsc 以 WebWorker lib 编译本文件，DOM 的
// AudioContext 系类型不在 lib 里——storage.ts 的 StorageLike 同款做法，
// 两端 tsconfig 都能编译；真实 DOM 节点天然满足这些结构）
// ---------------------------------------------------------------------------

type ToneType = "sine" | "square" | "triangle" | "sawtooth";
type FilterType = "lowpass" | "highpass" | "bandpass";

interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
}

interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

interface OscillatorNodeLike extends AudioNodeLike {
  type: ToneType;
  frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

interface BiquadFilterNodeLike extends AudioNodeLike {
  type: FilterType;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

interface AudioContextLike {
  readonly currentTime: number;
  readonly state: "running" | "suspended" | "closed" | "interrupted";
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
}

/** 单音（振荡器 + 包络）：attack 线性起音后指数衰减（打击/拨弦感）。
 *  freqEnd 给定时做频率扫音（滑音/sweep）。返回该音的总时长。 */
function tone(
  ctx: AudioContextLike,
  dest: AudioNodeLike,
  t0: number,
  rate: number,
  o: { freq: number; freqEnd?: number; type?: ToneType; start?: number; dur: number; db: number; attack?: number },
): number {
  const startAt = t0 + (o.start ?? 0);
  const endAt = startAt + o.dur;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(Math.max(1, o.freq * rate), startAt);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd * rate), endAt);
  }
  const gain = ctx.createGain();
  const peak = dbToGain(o.db);
  const attack = Math.min(o.attack ?? 0.006, o.dur / 2);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
  osc.connect(gain).connect(dest);
  osc.start(startAt);
  osc.stop(endAt + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  return (o.start ?? 0) + o.dur;
}

/** 噪声脉冲（共享白噪声 buffer + 滤波 + 包络）：石头/骰子/纸牌/爆炸的素材。
 *  freqEnd 给定时做滤波扫频（swish/开枪）。随机取读位置避免每声一模一样。 */
function noise(
  ctx: AudioContextLike,
  dest: AudioNodeLike,
  t0: number,
  buffer: AudioBufferLike,
  o: {
    start?: number;
    dur: number;
    db: number;
    type?: FilterType;
    freq?: number;
    freqEnd?: number;
    q?: number;
    attack?: number;
  },
): number {
  const startAt = t0 + (o.start ?? 0);
  const endAt = startAt + o.dur;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? "bandpass";
  filter.frequency.setValueAtTime(Math.max(1, o.freq ?? 1000), startAt);
  if (o.freqEnd !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), endAt);
  }
  filter.Q.value = o.q ?? 1;
  const gain = ctx.createGain();
  const peak = dbToGain(o.db);
  const attack = Math.min(o.attack ?? 0.004, o.dur / 2);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
  src.connect(filter).connect(gain).connect(dest);
  const maxOffset = Math.max(0, buffer.duration - o.dur - 0.01);
  src.start(startAt, Math.random() * maxOffset);
  src.stop(endAt + 0.02);
  src.onended = () => {
    src.disconnect();
    filter.disconnect();
    gain.disconnect();
  };
  return (o.start ?? 0) + o.dur;
}

/** 1s 白噪声（每 context 一份，全部噪声型音效共用）。 */
function buildNoiseBuffer(ctx: AudioContextLike): AudioBufferLike {
  const length = Math.max(1, Math.floor(ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** 合成器：建一组节点进 dest，返回整段总时长（供事件增益节点的清扫定时）。 */
type SynthFn = (
  ctx: AudioContextLike,
  dest: AudioNodeLike,
  t0: number,
  rate: number,
  noiseBuffer: AudioBufferLike,
) => number;

interface CueSpec {
  /** 总线：sfx = 玩法动作，ui = 系统提示。 */
  bus: "sfx" | "ui";
  /** 事件相对响度（dB，混音表——改这里不动合成代码）。 */
  db: number;
  /** 延迟起播（秒）：骰子滚完才响撞机/到达。 */
  delaySec?: number;
  synth: SynthFn;
}

/**
 * 事件 → 合成参数表（每条 ≤0.4s）。频率取常用音名（A4=440 起算），响度
 * 以 CUES.db 统一收口，事件内部各层用 0/-3/-6 dB 做层次。
 */
const CUES: Record<GameSoundEvent, CueSpec> = {
  // ---- 系统类（ui 总线）----
  // 轮到你：E5→A5 双音上行，「该你了」的轻唤。
  turn_you: {
    bus: "ui",
    db: -10,
    synth: (ctx, dest, t0, rate) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 659.25, dur: 0.09, db: 0 }),
        tone(ctx, dest, t0, rate, { freq: 880, start: 0.09, dur: 0.15, db: 0 }),
      ),
  },
  // 对手行动：极短高频 tick，只做「有人动了」的存在感。
  opponent_action: {
    bus: "ui",
    db: -16,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 1500, dur: 0.045, db: 0, type: "triangle" }),
  },
  // 开局 stinger：C5-E5-G5-C6 四音亮出。
  game_start: {
    bus: "ui",
    db: -9,
    synth: (ctx, dest, t0, rate) => {
      let total = 0;
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, index) => {
        total = Math.max(total, tone(ctx, dest, t0, rate, { freq, start: index * 0.07, dur: 0.08, db: -1 }));
      });
      total = Math.max(total, tone(ctx, dest, t0, rate, { freq: 1046.5, start: 0.21, dur: 0.16, db: 0 }));
      return total;
    },
  },
  // 胜利：上行琶音 C5-E5-G5-C6。
  victory: {
    bus: "ui",
    db: -8,
    synth: (ctx, dest, t0, rate) => {
      let total = 0;
      [523.25, 659.25, 783.99].forEach((freq, index) => {
        total = Math.max(total, tone(ctx, dest, t0, rate, { freq, start: index * 0.09, dur: 0.1, db: -1 }));
      });
      total = Math.max(total, tone(ctx, dest, t0, rate, { freq: 1046.5, start: 0.27, dur: 0.12, db: 0 }));
      return total;
    },
  },
  // 失败：A4→F4→D4 下行三音。
  defeat: {
    bus: "ui",
    db: -9,
    synth: (ctx, dest, t0, rate) => {
      let total = 0;
      [440, 349.23, 293.66].forEach((freq, index) => {
        total = Math.max(total, tone(ctx, dest, t0, rate, { freq, start: index * 0.12, dur: 0.12, db: 0 }));
      });
      return total;
    },
  },
  // 平局：B4→A4 中性双音，不喜不悲。
  draw: {
    bus: "ui",
    db: -10,
    synth: (ctx, dest, t0, rate) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 493.88, dur: 0.14, db: 0 }),
        tone(ctx, dest, t0, rate, { freq: 440, start: 0.16, dur: 0.18, db: 0 }),
      ),
  },
  // 倒计时 tick：1.2kHz 极短点。
  countdown_tick: {
    bus: "ui",
    db: -14,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 1200, dur: 0.035, db: 0 }),
  },
  // 超时判负：G3 方波双响警示。
  timeout_loss: {
    bus: "ui",
    db: -8,
    synth: (ctx, dest, t0, rate) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 196, dur: 0.14, db: 0, type: "square" }),
        tone(ctx, dest, t0, rate, { freq: 196, start: 0.18, dur: 0.14, db: 0, type: "square" }),
      ),
  },
  // 玩家加入/离开：C5→E5 与 E5→C5 的对称 blip。
  player_join: {
    bus: "ui",
    db: -13,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 523.25, freqEnd: 659.25, dur: 0.1, db: 0 }),
  },
  player_leave: {
    bus: "ui",
    db: -13,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 659.25, freqEnd: 523.25, dur: 0.1, db: 0 }),
  },
  // 聊天 pop：320→640 快扫 + 一点气泡噪声。
  chat_pop: {
    bus: "ui",
    db: -14,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 320, freqEnd: 640, dur: 0.09, db: 0 }),
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.03, db: -6, freq: 1800, q: 2 }),
      ),
  },
  // ---- 玩法类（sfx 总线）----
  // 五子棋落子：石子敲棋盘——高频瞬态 + 低频腔体共鸣。
  gomoku_place: {
    bus: "sfx",
    db: -8,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.05, db: 0, type: "lowpass", freq: 1800, q: 0.7 }),
        tone(ctx, dest, t0, rate, { freq: 170, dur: 0.08, db: -3 }),
      ),
  },
  // 五子棋悔棋：往回的 swish（滤波向上扫，像把棋子拿起来）。
  gomoku_undo: {
    bus: "sfx",
    db: -13,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      noise(ctx, dest, t0, noiseBuffer, { dur: 0.16, db: 0, type: "bandpass", freq: 600, freqEnd: 2400, q: 2 }),
  },
  // 象棋落子：木质 snap——硬瞬态 + 短共鸣 + 低频「啪」。
  xiangqi_place: {
    bus: "sfx",
    db: -8,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 820, dur: 0.035, db: 0, type: "triangle" }),
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.03, db: -3, type: "lowpass", freq: 1400 }),
        tone(ctx, dest, t0, rate, { freq: 150, dur: 0.06, db: -4 }),
      ),
  },
  // 象棋将军：880/988 交替双警报（×2）。
  xiangqi_check: {
    bus: "sfx",
    db: -9,
    synth: (ctx, dest, t0, rate) => {
      let total = 0;
      [880, 987.77, 880, 987.77].forEach((freq, index) => {
        total = Math.max(
          total,
          tone(ctx, dest, t0, rate, { freq, start: index * 0.09, dur: 0.09, db: 0, type: "square" }),
        );
      });
      return total;
    },
  },
  // 飞行棋骰子：噪声滚筒——衰减的连串颗粒（~0.3s）。
  ludo_dice: {
    bus: "sfx",
    db: -11,
    synth: (ctx, dest, t0, _rate, noiseBuffer) => {
      let total = 0;
      for (let i = 0; i < 7; i += 1) {
        total = Math.max(
          total,
          noise(ctx, dest, t0, noiseBuffer, { start: i * 0.04, dur: 0.03, db: -1 - i, freq: 900, q: 3 }),
        );
      }
      return total;
    },
  },
  // 撞机：闷击 + 下坠滑音（骰子滚完 0.32s 后起，跟在动作后面）。
  ludo_capture: {
    bus: "sfx",
    db: -9,
    delaySec: 0.32,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.08, db: 0, type: "lowpass", freq: 900 }),
        tone(ctx, dest, t0, rate, { freq: 320, freqEnd: 140, dur: 0.12, db: -2, type: "square" }),
      ),
  },
  // 到达终点：G5→C6 的小号角（同样跟在骰子后）。
  ludo_finish: {
    bus: "sfx",
    db: -9,
    delaySec: 0.32,
    synth: (ctx, dest, t0, rate) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 783.99, dur: 0.08, db: -1 }),
        tone(ctx, dest, t0, rate, { freq: 1046.5, start: 0.09, dur: 0.14, db: 0 }),
      ),
  },
  // 斗地主发牌：riffle——密集的纸牌摩擦颗粒。
  dd_deal: {
    bus: "sfx",
    db: -11,
    synth: (ctx, dest, t0, _rate, noiseBuffer) => {
      let total = 0;
      for (let i = 0; i < 9; i += 1) {
        total = Math.max(
          total,
          noise(ctx, dest, t0, noiseBuffer, {
            start: i * 0.036,
            dur: 0.022,
            db: i % 2 === 0 ? 0 : -3,
            freq: 2400,
            q: 4,
          }),
        );
      }
      return total;
    },
  },
  // 出牌：slap——拍在桌上的宽频瞬态 + 低频垫。
  dd_play: {
    bus: "sfx",
    db: -8,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.05, db: 0, freq: 1600, q: 1.2 }),
        tone(ctx, dest, t0, rate, { freq: 200, dur: 0.07, db: -4 }),
      ),
  },
  // 炸弹/王炸：boom——低频下坠 + 闷响噪声尾。
  dd_bomb: {
    bus: "sfx",
    db: -6,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        tone(ctx, dest, t0, rate, { freq: 100, freqEnd: 38, dur: 0.35, db: 0 }),
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.2, db: -6, type: "lowpass", freq: 300 }),
      ),
  },
  // 春天：C5-D5-E5-G5 上行小快板（triangle 亮而不刺）。
  dd_spring: {
    bus: "sfx",
    db: -8,
    synth: (ctx, dest, t0, rate) => {
      let total = 0;
      [523.25, 587.33, 659.25, 783.99].forEach((freq, index) => {
        total = Math.max(
          total,
          tone(ctx, dest, t0, rate, { freq, start: index * 0.08, dur: 0.08, db: 0, type: "triangle" }),
        );
      });
      return total;
    },
  },
  // 天黑：520→110 下行 sweep（夜幕落下）。
  ww_night: {
    bus: "sfx",
    db: -11,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 520, freqEnd: 110, dur: 0.35, db: 0 }),
  },
  // 天亮：140→660 上行 sweep。
  ww_dawn: {
    bus: "sfx",
    db: -11,
    synth: (ctx, dest, t0, rate) => tone(ctx, dest, t0, rate, { freq: 140, freqEnd: 660, dur: 0.3, db: 0 }),
  },
  // 死亡：低音 sting（130→80 的下坠三角波）。
  ww_death: {
    bus: "sfx",
    db: -9,
    synth: (ctx, dest, t0, rate) =>
      tone(ctx, dest, t0, rate, { freq: 130, freqEnd: 80, dur: 0.3, db: 0, type: "triangle" }),
  },
  // 投票结果：两次「盖章」（噪声 + 定音 blip）。
  ww_vote: {
    bus: "sfx",
    db: -10,
    synth: (ctx, dest, t0, rate, noiseBuffer) => {
      let total = 0;
      [0, 0.14].forEach((start) => {
        total = Math.max(
          total,
          noise(ctx, dest, t0, noiseBuffer, { start, dur: 0.04, db: -2, freq: 1200, q: 2 }),
          tone(ctx, dest, t0, rate, { freq: 660, start: start + 0.02, dur: 0.05, db: 0 }),
        );
      });
      return total;
    },
  },
  // 猎人开枪窗口：弓弦——高频掠过 + 弦音下坠。
  ww_hunter: {
    bus: "sfx",
    db: -9,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.06, db: 0, type: "highpass", freq: 2000, freqEnd: 4000, q: 2 }),
        tone(ctx, dest, t0, rate, { freq: 440, freqEnd: 220, dur: 0.14, db: -4 }),
      ),
  },
  // 狼刀已定（仅狼人客户端）：轻「锵」——短噪声 + 高频滑音，刻意比其它事件轻。
  ww_knife: {
    bus: "sfx",
    db: -13,
    synth: (ctx, dest, t0, rate, noiseBuffer) =>
      Math.max(
        noise(ctx, dest, t0, noiseBuffer, { dur: 0.05, db: 0, type: "highpass", freq: 3000, q: 2 }),
        tone(ctx, dest, t0, rate, { freq: 1400, freqEnd: 2600, dur: 0.1, db: -6 }),
      ),
  },
};

// ---------------------------------------------------------------------------
// 引擎（AudioContext 部分：方法只在浏览器手势链路里被调用，单测不触碰）
// ---------------------------------------------------------------------------

function readEnabled(): boolean {
  const raw = safeGet(GAME_SOUND_ENABLED_KEY);
  return raw === null ? true : raw === "1";
}

function readVolume(): number {
  return parseStoredVolume(safeGet(GAME_SOUND_VOLUME_KEY));
}

class GameSoundEngine {
  private context: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private sfxBus: GainNodeLike | null = null;
  private uiBus: GainNodeLike | null = null;
  private noiseBuffer: AudioBufferLike | null = null;
  /** 用户手势已发生（自动播放合规的闸门）。 */
  private unlocked = false;
  private enabledValue = readEnabled();
  private volumeValue = readVolume();
  private readonly lastPlayedAt = new Map<GameSoundEvent, number>();
  private readonly listeners = new Set<() => void>();

  isEnabled(): boolean {
    return this.enabledValue;
  }

  getVolume(): number {
    return this.volumeValue;
  }

  /** 开关/音量变化订阅（React 侧同步 UI 状态）。返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) return;
    this.enabledValue = enabled;
    safeSet(GAME_SOUND_ENABLED_KEY, enabled ? "1" : "0");
    this.notify();
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (this.volumeValue === v) return;
    this.volumeValue = v;
    safeSet(GAME_SOUND_VOLUME_KEY, String(Math.round(v * 100) / 100));
    if (this.master !== null && this.context !== null) {
      this.master.gain.setValueAtTime(volumeSliderToGain(v), this.context.currentTime);
    }
    this.notify();
  }

  /** 用户手势解锁：置闸门 + 创建/恢复 AudioContext（幂等，重复调用无副作用）。 */
  unlock(): void {
    this.unlocked = true;
    const ctx = this.ensureContext();
    if (ctx !== null && ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  /** 播放一条事件：静音/未解锁/去重命中/环境不支持 → 静默丢弃，从不抛错。 */
  play(event: GameSoundEvent): void {
    if (!this.enabledValue || !this.unlocked) return;
    const now = Date.now();
    if (isDeduped(this.lastPlayedAt.get(event) ?? Number.NEGATIVE_INFINITY, now)) return;
    this.lastPlayedAt.set(event, now);
    try {
      const ctx = this.ensureContext();
      if (ctx === null || this.sfxBus === null || this.uiBus === null || this.noiseBuffer === null) return;
      if (ctx.state !== "running") {
        // 还没被浏览器放行（自动播放策略）：这次不响，恢复交给手势链路。
        void ctx.resume().catch(() => {});
        return;
      }
      const spec = CUES[event];
      const t0 = ctx.currentTime + (spec.delaySec ?? 0);
      const rate = jitterRate(Math.random());
      const eventGain = ctx.createGain();
      eventGain.gain.value = dbToGain(spec.db);
      const total = spec.synth(ctx, eventGain, t0, rate, this.noiseBuffer);
      eventGain.connect(spec.bus === "ui" ? this.uiBus : this.sfxBus);
      // 一次性事件增益节点：整段播完后摘线（fire-and-forget，不阻塞 UI）。
      setTimeout(() => eventGain.disconnect(), Math.ceil((total + 0.15) * 1000));
    } catch {
      /* 播放失败不值得打断对局 */
    }
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context !== null) return this.context;
    const scope = globalThis as unknown as {
      AudioContext?: new () => AudioContextLike;
      webkitAudioContext?: new () => AudioContextLike;
    };
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = volumeSliderToGain(this.volumeValue);
      master.connect(ctx.destination);
      const sfx = ctx.createGain();
      sfx.connect(master);
      const ui = ctx.createGain();
      ui.connect(master);
      this.context = ctx;
      this.master = master;
      this.sfxBus = sfx;
      this.uiBus = ui;
      this.noiseBuffer = buildNoiseBuffer(ctx);
      return ctx;
    } catch {
      return null;
    }
  }
}

export const gameSound = new GameSoundEngine();

// ---------------------------------------------------------------------------
// 便捷入口（对局屏/大厅/设置统一从这里拿，不直接摸引擎单例）
// ---------------------------------------------------------------------------

export function playGameSound(event: GameSoundEvent): void {
  gameSound.play(event);
}

export function gameSoundIsEnabled(): boolean {
  return gameSound.isEnabled();
}

export function setGameSoundEnabled(enabled: boolean): void {
  gameSound.setEnabled(enabled);
}

export function gameSoundVolume(): number {
  return gameSound.getVolume();
}

export function setGameSoundVolume(volume: number): void {
  gameSound.setVolume(volume);
}

export function subscribeGameSound(listener: () => void): () => void {
  return gameSound.subscribe(listener);
}

let gestureArmed = false;

/**
 * 装一次性的手势解锁监听（pointerdown/touchstart/keydown 各一次；幂等）。
 * 对局屏与「我的」设置挂载时调用——之后一切 play() 都发生在手势之后。
 */
export function armGameSoundGestureUnlock(): void {
  if (gestureArmed) return;
  const scope = globalThis as unknown as {
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  };
  if (typeof scope.addEventListener !== "function") return;
  gestureArmed = true;
  for (const type of ["pointerdown", "touchstart", "keydown"]) {
    scope.addEventListener(type, () => gameSound.unlock(), { once: true });
  }
}

/** React 侧设置状态（开关 + 音量），引擎订阅驱动重渲染。 */
export function useGameSoundSettings(): {
  enabled: boolean;
  volume: number;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
} {
  const [state, setState] = useState(() => ({ enabled: gameSound.isEnabled(), volume: gameSound.getVolume() }));
  useEffect(
    () => subscribeGameSound(() => setState({ enabled: gameSound.isEnabled(), volume: gameSound.getVolume() })),
    [],
  );
  return { ...state, setEnabled: setGameSoundEnabled, setVolume: setGameSoundVolume };
}
