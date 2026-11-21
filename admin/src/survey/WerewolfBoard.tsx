import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Eye, Moon, RefreshCw, Sun } from "lucide-react";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import {
  countdownTone,
  formatCountdown,
  parseWerewolfView,
  WEREWOLF_PHASE_NAMES,
  WEREWOLF_PRESET_OPTIONS,
  WEREWOLF_ROLE_LABELS,
  WEREWOLF_SPEECH_MAX_CHARS,
  WEREWOLF_TURN_MS_OPTIONS,
  werewolfBoardSummary,
  werewolfDayLabel,
  werewolfLocalTargetCheck,
  werewolfSeatName,
  werewolfSeatPoints,
  werewolfSettlementCopy,
  werewolfTallyFromEvents,
  type WerewolfHostConfigForm,
} from "./game-room-logic";
import type { GameBoardProps } from "./game-board-registry";

/**
 * 狼人杀 Board 面板（游戏批次 R2 客户端）——玩法私有渲染的唯一归属：圆桌
 * 座位（头像位/生死状态/发言中标识）、日夜横幅（第 N 夜/白天）、身份卡
 * （只自己可见）、夜晚按角色动作面板（守卫守护/狼人刀人/预言家查验/女巫
 * 救毒）、白天发言与投票、猎人开枪、死亡出局提示、结算与出口都在这里；
 * 大厅层与房间壳不 import 本文件的玩法逻辑。
 *
 * 自指信息（「我是谁」）从玩法载荷自取：玩家视图的 yourSeat/yourRole/
 * yourRole 技能面（wolfMates/checkResults/potions/lastGuarded/tonightKnife）
 * 是引擎按人裁剪下发的**自己的**私有信息——他人身份从协议形状上就不在载荷
 * 里（私有视图纪律），本组件没有任何隐藏逻辑，拿到什么渲染什么。
 *
 * 动作九个（payload 形状以服务端 werewolfEngine.applyAction 为准）：guard
 * { target }、wolf_kill { target }、seer_check { target }、witch_save（无
 * payload，目标=引擎簿记的当夜刀口）、witch_poison { target }、witch_pass、
 * speak { text }、vote { target | null }（null = 弃票）、hunter_shot
 * { target } / hunter_pass。本地预判（werewolfLocalTargetCheck）只挡必被拒
 * 的选择，服务端是唯一裁决者。
 *
 * 390px 纪律：圆桌用容器百分比坐标的椭圆布局（座位 0 固定在正上方），
 * 头像位 + 纵排小名牌；对局记录侧栏默认收起。
 */

/** 身份卡/圆桌身份徽标的角色点缀（emoji 仅作视觉标识，语义走中文文案）。 */
const WEREWOLF_ROLE_EMOJI: Record<string, string> = {
  werewolf: "🐺",
  villager: "👤",
  seer: "🔮",
  witch: "⚗️",
  guard: "🛡️",
  hunter: "🏹",
};

/** 身份卡的语气配色：狼人危险色、神职主色、村民中性色。 */
function roleCardClass(role: string): string {
  if (role === "werewolf") {
    return "border-[color-mix(in_srgb,var(--app-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--app-danger)_10%,transparent)] text-[var(--app-danger)]";
  }
  if (role === "villager") {
    return "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-heading)]";
  }
  return "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]";
}

/**
 * 房主配置面板（建房入口，所选玩法为狼人杀时由屏层经 GameLobbyEntry 的
 * configPanel 插槽挂载）：板子预设（自动板 / 固定人数板）、每阶段时限、
 * 托管自动刀。受控组件——配置值由屏层持有，创建房间时经
 * buildWerewolfRoomConfig 随 POST /api/game/rooms 的 config 下发。
 */
export function WerewolfHostConfigPanel({
  value,
  onChange,
}: {
  value: WerewolfHostConfigForm;
  onChange: (next: WerewolfHostConfigForm) => void;
}) {
  const summary =
    value.preset === "auto"
      ? "标准预女猎守板：狼/预言家/女巫/守卫/猎人按开局人数自动推导，6-12 人都能开局。"
      : `${werewolfBoardSummary(value.preset)}；需恰好 ${value.preset} 人在座才能开局。`;
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3">
      <p className="text-[12px] font-bold text-[var(--survey-heading)]">狼人杀房主配置</p>
      <div>
        <p className="text-[11px] font-semibold text-[var(--survey-muted)]">板子预设（6-12 人）</p>
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="板子预设">
          {WEREWOLF_PRESET_OPTIONS.map((option) => {
            const active = option.value === value.preset;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...value, preset: option.value })}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition ${
                  active
                    ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] leading-4 text-[var(--survey-muted)]">{summary}</p>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-[var(--survey-muted)]">每阶段时限</p>
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="每阶段时限">
          {WEREWOLF_TURN_MS_OPTIONS.map((option) => {
            const active = option.value === value.turnMs;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...value, turnMs: option.value })}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition ${
                  active
                    ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="flex items-start gap-2 text-[12px] leading-5 text-[var(--survey-heading)]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--survey-primary)]"
          checked={value.autoWolfKill}
          onChange={(event) => onChange({ ...value, autoWolfKill: event.target.checked })}
        />
        <span>狼人全员超时未出刀时，托管随机刀一名好人（掉线不卡局；关闭则空刀过夜）</span>
      </label>
    </div>
  );
}

export function WerewolfBoardPanel({
  view,
  role,
  connection,
  online,
  remainingNow,
  sendAction,
  onExitRoom,
}: GameBoardProps) {
  const { toast } = useDialogs();
  /** 圆桌上点选的目标座位（夜晚技能/投票/开枪共用的选择态）。 */
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  /** 我的发言草稿（day_speak，≤200 字；空文本提交 = 沉默）。 */
  const [speechText, setSpeechText] = useState("");
  /** 对局记录（事件流水）侧栏折叠开关（默认收起，窄屏先看牌局）。 */
  const [logOpen, setLogOpen] = useState(false);
  const logListRef = useRef<HTMLOListElement | null>(null);

  const w = parseWerewolfView(view.view);
  const status = view.status;

  // 阶段/天数切换后清空点选：夜晚技能一阶段一目标，跨阶段保留旧选择必被拒。
  // 依赖收敛成原始字符串 phaseKey（而非整个载荷对象），阶段切换即触发清空。
  const phaseKey = w === null ? "" : `${w.day}:${w.phase}`;
  useEffect(() => {
    setSelectedSeat(null);
  }, [phaseKey]);

  // 事件流水自动滚底：新的记录落到列表底部后自动滚出最新一条。
  const logLength = w?.events.length ?? 0;
  useEffect(() => {
    const list = logListRef.current;
    if (list !== null && logOpen) list.scrollTop = list.scrollHeight;
  }, [logLength, logOpen]);

  const seatPoints = useMemo(() => werewolfSeatPoints(w?.seats.length ?? 0), [w?.seats.length]);

  if (w === null) {
    return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
  }

  const gameEnded = status === "settled" || status === "closed" || w.outcome != null;
  /** 可操作性总开关：连接在线 + 本人是玩家 + 对局未结束。观战/断线只读。 */
  const interactive = connection === "open" && role === "player" && !gameEnded && w.outcome === null;
  const iAmAlive = w.yourAlive === true;

  const sendGameAction = async (action: string, payload?: unknown) => {
    try {
      await sendAction(action, payload);
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  const toggleSeat = (seatIndex: number) => {
    if (!interactive) return;
    setSelectedSeat((prev) => (prev === seatIndex ? null : seatIndex));
  };

  const seatName = (seatIndex: number | null) => (seatIndex === null ? "—" : werewolfSeatName(view, w, seatIndex));

  // ------------------------------------------------------------------
  // 我的行动窗口（按角色/阶段；本地预判只挡必被拒的选择）
  // ------------------------------------------------------------------
  const acting = interactive && status === "playing" && w.outcome === null && role === "player" && w.yourSeat !== null;
  const guardActing = acting && w.phase === "night_guard" && w.yourRole === "guard" && iAmAlive;
  const wolfActing = acting && w.phase === "night_wolf" && w.yourRole === "werewolf" && iAmAlive;
  const seerActing = acting && w.phase === "night_seer" && w.yourRole === "seer" && iAmAlive;
  const witchActing = acting && w.phase === "night_witch" && w.yourRole === "witch" && iAmAlive;
  const speakActing = acting && w.phase === "day_speak" && w.speakTurnSeat === w.yourSeat;
  const voteActing = acting && (w.phase === "day_vote" || w.phase === "day_pk") && iAmAlive && !w.myVoteSubmitted;
  const shotActing = acting && w.pendingShotOpen && w.canShoot;
  /** 当前阶段需要点选目标的行动窗口（决定圆桌座位的可点态）。 */
  const needsTarget =
    guardActing ||
    wolfActing ||
    seerActing ||
    (witchActing && (w.potions?.poison ?? false)) ||
    voteActing ||
    shotActing;
  /** 点选目标的本地预判文案（null = 合法；未点选给引导文案）。 */
  const targetCheck = selectedSeat === null ? "先在圆桌上点选一个目标" : werewolfLocalTargetCheck(w, selectedSeat);
  const targetReady = selectedSeat !== null && targetCheck === null;

  const handleTargetAction = (action: string) => {
    if (!targetReady || selectedSeat === null) return;
    void sendGameAction(action, { target: selectedSeat });
  };

  const countdownText = formatCountdown(remainingNow);
  const countdownToneValue = countdownTone(remainingNow);
  const dayLabel = werewolfDayLabel(w.day, w.phase);
  const isNightPhase = w.phase.startsWith("night_");
  // 最近一条事件是亮票 → 展示本轮计票摘要（纯展示，权威票面在事件原文）。
  // 普通计算而非 useMemo：它在提前返回（w === null）之后，挂 hook 会让钩子
  // 数量随载荷形状漂移；亮票解析最多扫 200 条事件，开销可忽略。
  const lastEvent = w.events[w.events.length - 1] ?? null;
  const freshTally =
    lastEvent !== null && lastEvent.kind === "vote" && lastEvent.text.startsWith("亮票:")
      ? werewolfTallyFromEvents(w.events)
      : null;

  const settlementCopy = w.outcome ? werewolfSettlementCopy(w.outcome, w.yourRole) : null;

  // ------------------------------------------------------------------
  // 圆桌座位
  // ------------------------------------------------------------------
  const renderSeat = (index: number) => {
    const seat = w.seats[index];
    if (!seat) return null;
    const point = seatPoints[index];
    if (!point) return null;
    const name = seatName(seat.seatIndex);
    const isSpeaking = w.phase === "day_speak" && w.speakTurnSeat === seat.seatIndex;
    const isWolfMate = w.wolfMates !== null && w.wolfMates.includes(seat.seatIndex);
    const isPkCandidate = w.pkCandidates !== null && w.pkCandidates.includes(seat.seatIndex);
    const selected = selectedSeat === seat.seatIndex;
    const clickable = needsTarget && seat.alive && interactive;
    return (
      <button
        key={seat.seatIndex}
        type="button"
        aria-pressed={selected}
        aria-label={`座位 ${seat.seatIndex + 1} ${name}${seat.alive ? "" : "（出局）"}`}
        style={{ left: `${point.x}%`, top: `${point.y}%` }}
        onClick={() => toggleSeat(seat.seatIndex)}
        className={`absolute flex w-14 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 ${
          clickable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          className={`relative grid h-9 w-9 place-items-center rounded-full border text-[13px] font-black transition ${
            seat.alive
              ? "bg-[var(--survey-card-bg)] text-[var(--survey-heading)]"
              : "bg-[var(--survey-card-border)] text-[var(--survey-muted)] opacity-60"
          } ${
            selected
              ? "border-[var(--survey-primary)] ring-2 ring-[var(--survey-primary)]"
              : isSpeaking
                ? "border-amber-500 ring-2 ring-amber-400"
                : "border-[var(--survey-card-border)]"
          } ${seat.isYou ? "outline outline-2 outline-[var(--survey-primary)] outline-offset-1" : ""}`}
        >
          {name.slice(0, 1)}
          {!seat.alive ? (
            <span className="absolute -right-0.5 -top-0.5 text-[10px] font-black text-[var(--app-danger)]">✕</span>
          ) : null}
        </span>
        <span className="max-w-[60px] truncate text-[10px] font-semibold leading-3 text-[var(--survey-muted)]">
          {name}
          {seat.isYou ? "(你)" : ""}
        </span>
        <span className="flex h-3 items-center gap-0.5 text-[9px] font-bold leading-3">
          {isSpeaking ? <span className="text-amber-600">发言中</span> : null}
          {isWolfMate ? <span title="你的狼队友">🐺</span> : null}
          {isPkCandidate ? <span className="text-[var(--survey-primary)]">PK</span> : null}
        </span>
      </button>
    );
  };

  // ------------------------------------------------------------------
  // 各阶段动作面板
  // ------------------------------------------------------------------
  const renderNightActions = () => {
    if (guardActing) {
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--survey-muted)]">选择要守护的人（可以守自己，不能连守同一人）。</p>
          <button
            type="button"
            className="btn btn-primary btn-sm w-full disabled:opacity-40"
            disabled={!targetReady}
            onClick={() => handleTargetAction("guard")}
          >
            守护 {targetReady ? seatName(selectedSeat) : "…"}
          </button>
        </div>
      );
    }
    if (wolfActing) {
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--survey-muted)]">
            {w.nightKnife !== null
              ? `狼队当前刀口：${seatName(w.nightKnife)}（可重复提交，以后提交为准）`
              : "与狼队商议后选择今晚的刀口。"}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm w-full disabled:opacity-40"
            disabled={!targetReady}
            onClick={() => handleTargetAction("wolf_kill")}
          >
            出刀 {targetReady ? seatName(selectedSeat) : "…"}
          </button>
        </div>
      );
    }
    if (seerActing) {
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--survey-muted)]">查验一人身份（结果只有你自己可见）。</p>
          <button
            type="button"
            className="btn btn-primary btn-sm w-full disabled:opacity-40"
            disabled={!targetReady}
            onClick={() => handleTargetAction("seer_check")}
          >
            查验 {targetReady ? seatName(selectedSeat) : "…"}
          </button>
        </div>
      );
    }
    if (witchActing) {
      const canSave = (w.potions?.save ?? false) && w.tonightKnife !== null && w.tonightKnife !== w.yourSeat;
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--survey-muted)]">
            解药 {w.potions?.save ? "有" : "已用完"} · 毒药 {w.potions?.poison ? "有" : "已用完"}
            {w.tonightKnife !== null ? ` · 今夜被刀：${seatName(w.tonightKnife)}` : " · 今夜暂无刀口"}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm disabled:opacity-40"
              disabled={!canSave}
              onClick={() => void sendGameAction("witch_save")}
            >
              用解药
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm disabled:opacity-40"
              disabled={!targetReady}
              onClick={() => handleTargetAction("witch_poison")}
            >
              用毒药
            </button>
            <button
              type="button"
              className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
              onClick={() => void sendGameAction("witch_pass")}
            >
              不用药
            </button>
          </div>
        </div>
      );
    }
    return null;
  };

  const renderDayActions = () => {
    if (w.phase === "day_speak") {
      if (speakActing && interactive) {
        return (
          <div className="space-y-2">
            <textarea
              value={speechText}
              maxLength={WEREWOLF_SPEECH_MAX_CHARS}
              onChange={(event) => setSpeechText(event.target.value.slice(0, WEREWOLF_SPEECH_MAX_CHARS))}
              placeholder="轮到你发言（留空提交 = 沉默）"
              aria-label="发言内容"
              rows={3}
              className="input w-full resize-none text-[13px]"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] tabular-nums text-[var(--survey-muted)]">
                {speechText.length}/{WEREWOLF_SPEECH_MAX_CHARS}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm px-5"
                onClick={() => {
                  void sendGameAction("speak", { text: speechText });
                  setSpeechText("");
                }}
              >
                完成发言
              </button>
            </div>
          </div>
        );
      }
      return (
        <p className="text-[12px] text-[var(--survey-muted)]">
          等待 {seatName(w.speakTurnSeat)} 发言…（超时会自动跳过）
        </p>
      );
    }
    if (w.phase === "day_vote" || w.phase === "day_pk") {
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--survey-muted)]">
            {w.phase === "day_pk" && w.pkCandidates !== null
              ? `PK 候选：${w.pkCandidates.map((seat) => seatName(seat)).join("、")}（只能投候选，不能投自己）`
              : "点选要放逐的人，或弃票。"}{" "}
            已投 {w.votesSubmitted}/{w.votesNeeded}
          </p>
          {w.myVoteSubmitted ? (
            <p className="text-[12px] font-semibold text-[var(--survey-primary)]">你已投票，等待全员投完亮票。</p>
          ) : voteActing && interactive ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm disabled:opacity-40"
                disabled={!targetReady}
                onClick={() => handleTargetAction("vote")}
              >
                投 {targetReady ? seatName(selectedSeat) : "…"}
              </button>
              <button
                type="button"
                className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                onClick={() => void sendGameAction("vote", { target: null })}
              >
                弃票
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    if (w.pendingShotOpen) {
      if (shotActing && interactive) {
        return (
          <div className="space-y-2">
            <p className="text-[12px] text-[var(--survey-muted)]">
              你被放逐/被刀出局，可以开枪带走一人（被毒杀无枪声）。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm disabled:opacity-40"
                disabled={!targetReady}
                onClick={() => handleTargetAction("hunter_shot")}
              >
                开枪带走 {targetReady ? seatName(selectedSeat) : "…"}
              </button>
              <button
                type="button"
                className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                onClick={() => void sendGameAction("hunter_pass")}
              >
                不开枪
              </button>
            </div>
          </div>
        );
      }
      return <p className="text-[12px] text-[var(--survey-muted)]">猎人正在决定是否开枪…</p>;
    }
    return null;
  };

  return (
    <section className="survey-card p-4">
      {status === "lobby" ? (
        /* 大厅阶段：圆桌还没开席，只给等待开局卡（人数门槛由大厅层把守）。 */
        <div className="space-y-1 text-center">
          <p className="text-[14px] font-bold text-[var(--survey-heading)]">狼人杀 · 等待开局</p>
          <p className="text-[12px] leading-relaxed text-[var(--survey-muted)]">
            6-12 人开局，身份（狼人/预言家/女巫/守卫/猎人/村民）开局时随机分发且只有自己可见。
            人齐后全员准备，由房主在大厅点「开局」进入第一夜。
          </p>
        </div>
      ) : (
        <>
          {/* 日夜横幅：第 N 夜/白天 + 阶段名 + 观战人数 + 阶段倒计时 */}
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-bold text-[var(--survey-heading)]">
              {isNightPhase ? (
                <Moon className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
              ) : (
                <Sun className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              )}
              <span className="truncate">
                {dayLabel} · {WEREWOLF_PHASE_NAMES[w.phase]}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {online !== null && online.spectators > 0 ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--survey-card-border)] px-2.5 py-1 text-[12px] font-semibold text-[var(--survey-muted)]"
                  title={`${online.spectators} 人正在观战`}
                >
                  <Eye className="h-3 w-3" aria-hidden="true" />
                  {online.spectators}
                </span>
              ) : null}
              {countdownText !== null ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums ${
                    countdownToneValue === "expired"
                      ? "bg-[color-mix(in_srgb,var(--app-danger)_14%,transparent)] text-[var(--app-danger)]"
                      : countdownToneValue === "urgent"
                        ? "bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] text-[var(--app-warning)]"
                        : "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
                  }`}
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  {countdownText}
                </span>
              ) : null}
            </div>
          </div>

          {/* 身份卡：引擎只给「我的」角色，醒目但私密（仅自己可见）。 */}
          {w.yourRole !== null ? (
            <div
              className={`mt-2 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${roleCardClass(w.yourRole)}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-lg leading-none" aria-hidden="true">
                  {WEREWOLF_ROLE_EMOJI[w.yourRole] ?? "👤"}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-black">你的身份：{WEREWOLF_ROLE_LABELS[w.yourRole]}</span>
                  <span className="block text-[11px] opacity-80">
                    {w.yourAlive ? "你还活着，好好表演" : "你已出局，在「观战·出局」频道继续参与讨论"}
                  </span>
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-bold text-[var(--survey-muted)]">
                仅自己可见
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-[var(--survey-muted)]">你正在观战，身份对所有人保密。</p>
          )}

          {/* 昨夜死讯（座位名单，无死因无身份——口径与引擎一致）。 */}
          {w.lastNightDeaths.length > 0 ? (
            <p className="mt-2 rounded-xl bg-[color-mix(in_srgb,var(--app-danger)_8%,transparent)] px-3 py-2 text-[12px] font-semibold text-[var(--app-danger)]">
              昨夜倒下：{w.lastNightDeaths.map((seat) => seatName(seat)).join("、")}
            </p>
          ) : null}

          {/* 私有技能面：只汇总引擎发给「我」的技能结果。 */}
          <div className="mt-2 space-y-1 text-[11px] leading-5 text-[var(--survey-muted)]">
            {w.yourRole === "werewolf" && w.wolfMates !== null ? (
              <p>狼队友：{w.wolfMates.map((seat) => seatName(seat)).join("、")}</p>
            ) : null}
            {w.yourRole === "guard" && w.lastGuarded !== null ? (
              <p>上一夜守护了 {seatName(w.lastGuarded)}（不可连守）。</p>
            ) : null}
            {w.yourRole === "witch" && w.potions !== null ? (
              <p>
                药瓶：解药 {w.potions.save ? "还在" : "已用"} · 毒药 {w.potions.poison ? "还在" : "已用"}。
              </p>
            ) : null}
          </div>
          {w.yourRole === "seer" && w.checkResults !== null && w.checkResults.length > 0 ? (
            <p className="mt-1 rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--survey-primary)]">
              查验记录：
              {w.checkResults
                .map((record) => `第${record.night}夜 ${seatName(record.seatIndex)}=${record.isWolf ? "狼人" : "好人"}`)
                .join("；")}
            </p>
          ) : null}

          {/* 圆桌：座位均布椭圆，桌心放日夜徽标；点选目标即这里。 */}
          <div className="relative mx-auto mt-3 aspect-[6/5] w-full max-w-[360px]">
            {w.seats.map((seat, index) => renderSeat(index))}
            <span className="pointer-events-none absolute left-1/2 top-[48%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 text-center">
              <span className="text-xl leading-none" aria-hidden="true">
                {isNightPhase ? "🌙" : "☀️"}
              </span>
              <span className="text-[11px] font-bold text-[var(--survey-muted)]">{dayLabel}</span>
            </span>
          </div>

          {/* 阶段动作面板（夜晚按角色 / 白天发言投票 / 猎人开枪）。 */}
          {status === "playing" && w.outcome === null ? (
            <div className="mt-2">
              {renderNightActions()}
              {renderDayActions()}
              {needsTarget && targetCheck !== null ? (
                <p
                  role="status"
                  className="mt-2 rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--survey-primary)]"
                >
                  {targetCheck}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 亮票摘要（最近一轮投票的计票展示；权威票面在对局记录原文）。 */}
          {freshTally !== null ? (
            <p
              className="mt-2 rounded-xl bg-[var(--survey-card-bg)] px-3 py-2 text-[12px] font-semibold text-[var(--survey-heading)]"
              role="status"
            >
              得票：{freshTally.entries.map((entry) => `${entry.name} ${entry.votes} 票`).join("、") || "无人被投"}
              {freshTally.abstained > 0 ? ` · 弃票 ${freshTally.abstained}` : ""}
            </p>
          ) : null}

          {/* 对局记录（事件流水，服务端已按人裁剪；默认收起）。 */}
          {w.events.length > 0 ? (
            <section
              className="mt-3 overflow-hidden rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
              aria-label="对局记录"
            >
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-bold text-[var(--survey-heading)]"
                onClick={() => setLogOpen((open) => !open)}
                aria-expanded={logOpen}
              >
                对局记录（{w.events.length} 条）
                <ChevronDown
                  className={`h-4 w-4 text-[var(--survey-muted)] transition-transform ${logOpen ? "" : "-rotate-90"}`}
                  aria-hidden="true"
                />
              </button>
              {logOpen ? (
                <ol ref={logListRef} className="max-h-48 overflow-y-auto px-3 pb-2 text-[12px] leading-6">
                  {w.events.map((event) => (
                    <li key={event.seq} className="min-w-0 text-[var(--survey-heading)]">
                      {event.text}
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          ) : null}

          {/* 结算卡 + 出口。 */}
          {settlementCopy !== null
            ? (() => {
                const toneClass =
                  settlementCopy.tone === "win"
                    ? "bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] text-[var(--app-success)]"
                    : settlementCopy.tone === "lose"
                      ? "bg-[color-mix(in_srgb,var(--app-danger)_14%,transparent)] text-[var(--app-danger)]"
                      : "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]";
                return (
                  <div className={`mt-3 rounded-xl px-4 py-3 text-center ${toneClass}`} role="status">
                    <p className="text-lg font-black">{settlementCopy.headline}</p>
                    {settlementCopy.detail ? (
                      <p className="mt-0.5 text-[12px] opacity-80">{settlementCopy.detail}</p>
                    ) : null}
                  </div>
                );
              })()
            : null}
          {status === "settled" || status === "closed" ? (
            <div className="mt-3 flex items-center justify-center gap-3">
              <button type="button" className="btn btn-primary btn-sm px-5" onClick={onExitRoom}>
                再开一局（回大厅）
              </button>
              <a href="/trial" className="text-[12px] font-semibold text-[var(--survey-primary)] underline">
                回到小游戏
              </a>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
