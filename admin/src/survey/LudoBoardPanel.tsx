import { useEffect, useRef, useState } from "react";
import { ChevronDown, Dices, Eye, RefreshCw } from "lucide-react";
import { LudoBoard } from "./LudoBoard";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import { playerRowLabel } from "./game-lobby-logic";
import {
  LUDO_SEAT_COLORS,
  countdownTone,
  formatCountdown,
  ludoBounceLanding,
  ludoBounceNote,
  parseLudoView,
} from "./game-room-logic";
import type { GameBoardProps } from "./game-board-registry";

/** 骰面点位的布局（1-6 的经典骰面，2×2/对角/十字），单位为骰面网格 0..2。 */
const DICE_PIPS: Record<number, Array<[number, number]>> = {
  1: [[1, 1]],
  2: [
    [0, 0],
    [2, 2],
  ],
  3: [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
  4: [
    [0, 0],
    [0, 2],
    [2, 0],
    [2, 2],
  ],
  5: [
    [0, 0],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 2],
  ],
  6: [
    [0, 0],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 0],
    [2, 2],
  ],
};

/** 骰面小部件：纯展示，点数永远来自服务端（视图 lastRoll），本地不做随机。 */
function DiceFace({ roll, size = 56 }: { roll: number | null; size?: number }) {
  if (roll === null) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--survey-card-border)] text-[var(--survey-muted)]"
        style={{ width: size, height: size }}
        aria-label="等待掷骰"
      >
        <Dices className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  const pips = DICE_PIPS[roll] ?? [];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 30 30"
      role="img"
      aria-label={`骰子点数 ${roll}`}
      className="rounded-xl bg-white shadow-sm ring-1 ring-[var(--survey-card-border)]"
    >
      <rect x={0.5} y={0.5} width={29} height={29} rx={6} fill="white" stroke="#d6d3d1" />
      {pips.map(([px, py], index) => (
        <circle key={index} cx={px * 10 + 5} cy={py * 10 + 5} r={2.6} fill="#1f2937" />
      ))}
    </svg>
  );
}

/**
 * 飞行棋 Board 面板（游戏批次 X2-C）——玩法私有渲染的唯一归属：棋盘、骰子
 * （服务端点数展示，本地不做随机）、掷骰/走子、座位条（颜色=玩家）、反弹
 * 预览、认输、结算与出口都在这里；大厅层与房间壳不 import 本文件的玩法逻辑。
 *
 * 自指信息（「我是谁」）从玩法载荷自取：玩家视图的 yourSeat 即自己的座位号
 * （engine-types 协议不变量三：视图按人裁剪；飞行棋无隐藏信息，公开视图仅缺
 * yourSeat）。动作两个：掷骰 roll（服务端权威骰点，客户端永不提交骰值）与
 * 走子 move { plane }（槽位来自服务端 legalPlanes，本地只裁剪可点性）。
 */
export function LudoBoardPanel({
  view,
  role,
  connection,
  online,
  remainingNow,
  sendAction,
  onExitRoom,
}: GameBoardProps) {
  const { toast, confirm } = useDialogs();
  /** 对局记录侧栏折叠开关（默认收起，窄屏先看棋盘）。 */
  const [logOpen, setLogOpen] = useState(false);
  const logListRef = useRef<HTMLOListElement | null>(null);

  const ludo = parseLudoView(view.view);
  const status = view.status;

  // 对局记录自动滚底：新的记录落到列表底部后自动滚出最新一条。
  const logLength = (ludo?.history.length ?? 0) + (ludo?.events.length ?? 0);
  useEffect(() => {
    const list = logListRef.current;
    if (list !== null && logOpen) list.scrollTop = list.scrollHeight;
  }, [logLength, logOpen]);

  if (ludo === null) {
    return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
  }

  const gameEnded = status === "settled" || status === "closed" || ludo.outcome != null;
  const isMyTurn =
    ludo.yourSeat !== null && status === "playing" && ludo.outcome === null && ludo.turnSeat === ludo.yourSeat;
  const canRoll = isMyTurn && ludo.phase === "await_roll" && connection === "open" && role === "player";
  const canMove = isMyTurn && ludo.phase === "await_move" && connection === "open" && role === "player";

  /** 座位 → 展示名：信封 players 的在座行序 = 引擎座位序（都源自 state.players
   * 按 leftAt 过滤后的顺序），对回座位号即得该色玩家的昵称。 */
  const seatName = (seatIndex: number) => {
    const row = view.players.filter((player) => player.leftAt === null)[seatIndex];
    return row ? playerRowLabel(row, seatIndex) : `玩家${seatIndex + 1}`;
  };

  const countdownText = formatCountdown(remainingNow);
  const countdownToneValue = countdownTone(remainingNow);

  const turnLabel = gameEnded
    ? "对局结束"
    : isMyTurn
      ? ludo.phase === "await_roll"
        ? "轮到你了，掷骰！"
        : "轮到你了，点一架亮灯的飞机"
      : ludo.phase === "await_move"
        ? `等待${LUDO_SEAT_COLORS[ludo.seats[ludo.turnSeat]?.colorIndex ?? 0] ?? "?"}方走子`
        : `等待${seatName(ludo.turnSeat) ?? "其他玩家"}掷骰`;

  /** 反弹预览：轮到我走子时，对每架可动飞机复算「掷点走完是否反弹」；
   * 纯展示辅助（权威落点在服务端），只有会发生反弹的才列出。 */
  const bouncePreviews =
    canMove && ludo.lastRoll !== null
      ? ludo.legalPlanes.flatMap((slot) => {
          const from = ludo.seats[ludo.yourSeat ?? -1]?.planes[slot] ?? null;
          const preview = ludoBounceLanding(from, ludo.lastRoll ?? 0);
          return preview !== null && preview.bounced && from !== null ? [{ slot, from, final: preview.final }] : [];
        })
      : [];

  const sendGameAction = async (action: string, payload?: unknown) => {
    try {
      await sendAction(action, payload);
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  const handleRoll = () => {
    if (!canRoll) return;
    void sendGameAction("roll");
  };

  const handleSelectPlane = (seatIndex: number, planeSlot: number) => {
    if (!canMove || seatIndex !== ludo.yourSeat) return;
    if (!ludo.legalPlanes.includes(planeSlot)) return;
    void sendGameAction("move", { plane: planeSlot });
  };

  const handleResign = async () => {
    const agreed = await confirm({
      title: "认输退出",
      message: "认输后你的飞机清回机库并退出对局，其余玩家继续。确定认输吗？",
      confirmLabel: "认输",
      variant: "danger",
    });
    if (agreed) void sendGameAction("resign");
  };

  const settlementCopy = (() => {
    const outcome = ludo.outcome;
    if (!outcome) return null;
    if (outcome.result === "aborted" || outcome.winnerSeat === null) {
      return { headline: "对局结束", detail: "对局中止", tone: "neutral" as const };
    }
    const winnerColor = LUDO_SEAT_COLORS[ludo.seats[outcome.winnerSeat]?.colorIndex ?? 0] ?? "?";
    if (ludo.yourSeat === null) {
      return { headline: "对局结束", detail: `${winnerColor}方获胜`, tone: "neutral" as const };
    }
    if (outcome.winnerSeat === ludo.yourSeat) {
      return { headline: "你赢了！", detail: "全部飞机到达终点", tone: "win" as const };
    }
    return {
      headline: "对局结束",
      detail: `${winnerColor}方（${seatName(outcome.winnerSeat)}）全部飞机到达`,
      tone: "lose" as const,
    };
  })();

  const renderSeatStrip = () => (
    <div className="grid grid-cols-2 gap-1.5">
      {ludo.seats.map((seat) => {
        const isTurn = !gameEnded && ludo.turnSeat === seat.seatIndex && ludo.outcome === null;
        const isYou = seat.seatIndex === ludo.yourSeat;
        const dotColor =
          ["bg-red-600", "bg-amber-600", "bg-blue-600", "bg-green-600"][seat.colorIndex] ?? "bg-gray-400";
        return (
          <div
            key={seat.seatIndex}
            className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 ${
              isTurn
                ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
            }`}
          >
            <span className={`h-3 w-3 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--survey-heading)]">
              {LUDO_SEAT_COLORS[seat.colorIndex] ?? "?"}
              {seatName(seat.seatIndex) !== `玩家${seat.seatIndex + 1}` ? ` · ${seatName(seat.seatIndex)}` : ""}
              {isYou ? "（你）" : ""}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--survey-muted)]">
              {seat.resigned ? "已认输" : `到达 ${seat.arrived}/4`}
            </span>
          </div>
        );
      })}
    </div>
  );

  const renderBouncePreview = () => {
    if (bouncePreviews.length === 0) return null;
    return (
      <div
        role="status"
        className="rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-[12px] text-[var(--survey-primary)]"
      >
        {bouncePreviews.map((item) => `${item.slot + 1}号机 ${item.from}格 → 反弹 → ${item.final}格`).join("；")}
        （终点需精确步数，超出反弹）
      </div>
    );
  };

  const renderLog = () => {
    if (ludo.history.length === 0 && ludo.events.length === 0) return null;
    return (
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
          对局记录（{ludo.history.length} 手）
          <ChevronDown
            className={`h-4 w-4 text-[var(--survey-muted)] transition-transform ${logOpen ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
        </button>
        {logOpen ? (
          <ol ref={logListRef} className="max-h-40 overflow-y-auto px-3 pb-2 text-[12px] leading-6">
            {ludo.history.map((record) => (
              <li key={`m-${record.ply}`} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right tabular-nums text-[var(--survey-muted)]">{record.ply}.</span>
                <span className="font-semibold text-[var(--survey-heading)]">{record.text}</span>
                <span className="text-[var(--survey-muted)]">
                  {ludoBounceNote(record.from, record.roll, record.to)}
                </span>
              </li>
            ))}
            {ludo.events.map((event, index) => (
              <li key={`e-${event.ply}-${index}`} className="font-semibold text-[var(--app-warning)]">
                {event.text}
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    );
  };

  const renderResultBanner = () => {
    if (settlementCopy === null) return null;
    const toneClass =
      settlementCopy.tone === "win"
        ? "bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] text-[var(--app-success)]"
        : settlementCopy.tone === "lose"
          ? "bg-[color-mix(in_srgb,var(--app-danger)_14%,transparent)] text-[var(--app-danger)]"
          : "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]";
    return (
      <div className={`rounded-xl px-4 py-3 text-center ${toneClass}`} role="status">
        <p className="text-lg font-black">{settlementCopy.headline}</p>
        {settlementCopy.detail ? <p className="mt-0.5 text-[12px] opacity-80">{settlementCopy.detail}</p> : null}
      </div>
    );
  };

  return (
    <section className="survey-card p-4">
      {/* 回合条：轮到谁 + 观战人数 + 倒计时（≤10s 转警示色，到点转告警色） */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-[var(--survey-heading)]">{turnLabel}</span>
        {status === "playing" && ludo.outcome === null ? (
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
        ) : null}
      </div>

      {/* 座位条：颜色=玩家（2-4 人，2 人对角坐红/蓝） */}
      <div className="mt-3">{renderSeatStrip()}</div>

      <div className="mt-3">
        <LudoBoard
          seats={ludo.seats}
          rules={ludo.rules}
          legalPlanes={canMove ? ludo.legalPlanes : []}
          yourSeat={ludo.yourSeat}
          playable={canMove}
          lastMove={ludo.history.length > 0 ? (ludo.history[ludo.history.length - 1] ?? null) : null}
          onSelectPlane={handleSelectPlane}
        />
      </div>

      {/* 骰子 + 掷骰按钮：点数永远是服务端结果（视图 lastRoll），本地零随机 */}
      {status === "playing" && ludo.outcome === null ? (
        <div className="mt-3 flex items-center gap-3">
          <DiceFace roll={ludo.lastRoll} />
          <div className="min-w-0 flex-1">
            {ludo.lastRoll !== null ? (
              <p className="text-[12px] text-[var(--survey-muted)]">
                服务端掷出 {ludo.lastRoll} 点
                {ludo.sixStreak > 0 ? `（${ludo.seats[ludo.turnSeat]?.color ?? ""}方连六 ${ludo.sixStreak} 次）` : ""}
              </p>
            ) : (
              <p className="text-[12px] text-[var(--survey-muted)]">
                {canRoll ? "点击掷骰，掷出 6 点可让待机飞机起飞" : "等待当前玩家掷骰"}
              </p>
            )}
            {canRoll ? (
              <button type="button" className="btn btn-primary btn-sm mt-1.5 px-5" onClick={handleRoll}>
                掷骰
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {renderBouncePreview()}
        {status === "playing" && ludo.outcome === null && role === "player" ? (
          <div className="grid grid-cols-1">
            <button
              type="button"
              className="btn btn-sm border border-[color-mix(in_srgb,var(--app-danger)_35%,transparent)] bg-[var(--survey-card-bg)] text-[var(--app-danger)]"
              onClick={() => void handleResign()}
            >
              认输退出
            </button>
          </div>
        ) : null}
        {renderLog()}
        {renderResultBanner()}
        {status === "settled" || status === "closed" ? (
          <div className="flex items-center justify-center gap-3 pt-1">
            <button type="button" className="btn btn-primary btn-sm px-5" onClick={onExitRoom}>
              再开一局（回大厅）
            </button>
            <a href="/trial" className="text-[12px] font-semibold text-[var(--survey-primary)] underline">
              回到小游戏
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
