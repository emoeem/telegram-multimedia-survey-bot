import { useEffect, useRef } from "react";
import { Eye, RefreshCw } from "lucide-react";
import { GomokuBoard } from "./GomokuBoard";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import {
  countdownTone,
  describeSettlement,
  formatCountdown,
  localMoveCheck,
  parseGomokuView,
  undoRejectedNotice,
  type GomokuView,
} from "./game-room-logic";
import type { GameBoardProps } from "./game-board-registry";

/**
 * 五子棋 Board 面板（批次：Lobby/Board 分层）——玩法私有渲染的唯一归属：
 * 棋盘、回合条、黑白座位提示、悔棋/求和/认输、结算与出口都在这里；大厅层
 * （GameLobby.tsx）与房间壳（MultiplayerGameScreen）绝不 import 本文件的
 * 玩法逻辑。
 *
 * 自指信息（Board 内的「我是谁」）从玩法载荷自取：玩家视图的 yourColor 对
 * 回座位表即得到自己的座位令牌 seatToken（engine-types 协议不变量三：视图按
 * 人裁剪；修复 1 起座位对位键统一是座位令牌，participantHash 不再外发）。
 * 大厅层的「我的行」走 REST 信封 you（见 MultiplayerGameScreen），
 * 本面板不依赖它——玩法私有载荷与协议信封各管各的。
 */
export function GomokuBoardPanel({
  view,
  role,
  connection,
  online,
  remainingNow,
  sendAction,
  onExitRoom,
}: GameBoardProps) {
  const { toast, confirm } = useDialogs();

  const gomoku = parseGomokuView(view.view);
  const status = view.status;
  /** 上一帧的玩法视图：悔棋被拒（对方落子顶掉申请）靠前后帧对比判定。 */
  const prevGomokuRef = useRef<GomokuView | null>(null);

  // 悔棋申请被顶掉（对方落子即拒绝）的帧间对比：你的申请上一帧还在等待，
  // 下一帧消失且步数增加 → 明确提示，而不是横幅无声消失。
  useEffect(() => {
    const next = parseGomokuView(view.view);
    const prev = prevGomokuRef.current;
    prevGomokuRef.current = next;
    if (prev === null || next === null) return;
    const myHashNow =
      next.yourColor != null ? (next.players.find((seat) => seat.color === next.yourColor)?.seatToken ?? null) : null;
    const rejected = undoRejectedNotice(
      prev.pendingUndoFrom ?? null,
      next.pendingUndoFrom ?? null,
      prev.moveCount,
      next.moveCount,
      myHashNow,
    );
    if (rejected) toast({ message: rejected, variant: "info" });
  }, [view, toast]);

  if (gomoku === null) {
    return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
  }

  const myHash =
    gomoku.yourColor !== null
      ? (gomoku.players.find((seat) => seat.color === gomoku.yourColor)?.seatToken ?? null)
      : null;
  const gameEnded = status === "settled" || status === "closed" || gomoku.outcome != null;
  const isMyTurn =
    gomoku.yourColor !== null && status === "playing" && gomoku.outcome === null && gomoku.turn === gomoku.yourColor;

  const remainingNowMs = remainingNow;
  const countdownText = formatCountdown(remainingNowMs);
  const countdownToneValue = countdownTone(remainingNowMs);

  const settlementCopy = gomoku.outcome
    ? describeSettlement(gomoku.outcome.result, gomoku.outcome.winnerSeatToken, myHash)
    : view.settlement
      ? describeSettlement(view.settlement.result, view.settlement.winnerSeatToken, myHash)
      : null;

  const sendGameAction = async (action: string) => {
    try {
      await sendAction(action);
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  const placeStone = async (row: number, col: number) => {
    const rejected = localMoveCheck(gomoku.board, row, col, gomoku.turn, gomoku.yourColor);
    if (rejected !== null) {
      toast({ message: rejected, variant: "error" });
      return;
    }
    try {
      await sendAction("move", { row, col });
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  const handleResign = async () => {
    const agreed = await confirm({
      title: "认输",
      message: "认输后本局立即结束，对方获胜。确定认输吗？",
      confirmLabel: "认输",
      variant: "danger",
    });
    if (agreed) void sendGameAction("resign");
  };

  const renderOfferBanners = () => {
    if (status !== "playing") return null;
    const undoPending = gomoku.pendingUndoFrom;
    const drawPending = gomoku.pendingDrawFrom;
    const offerRow = (text: string, action: string, label: string) => (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-3 py-2">
        <p className="text-[12px] font-medium text-[var(--survey-primary)]">{text}</p>
        <button
          type="button"
          className="shrink-0 rounded-full bg-[var(--survey-primary)] px-3 py-1 text-[11px] font-bold text-[var(--survey-primary-content)]"
          onClick={() => void sendGameAction(action)}
        >
          {label}
        </button>
      </div>
    );
    return (
      <>
        {undoPending !== null && undoPending !== myHash
          ? offerRow("对方申请悔棋（撤回最后一手）", "accept_undo", "同意悔棋")
          : null}
        {undoPending !== null && undoPending === myHash ? (
          <p className="px-1 text-[12px] text-[var(--survey-muted)]">已申请悔棋，等待对方同意…</p>
        ) : null}
        {drawPending !== null && drawPending !== myHash
          ? offerRow("对方提议平局结束", "accept_draw", "同意和棋")
          : null}
        {drawPending !== null && drawPending === myHash ? (
          <p className="px-1 text-[12px] text-[var(--survey-muted)]">已提议和棋，等待对方回应…</p>
        ) : null}
      </>
    );
  };

  const renderResultBanner = () => {
    if (settlementCopy === null) return null;
    const toneClass =
      settlementCopy.tone === "win"
        ? "bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] text-[var(--app-success)]"
        : settlementCopy.tone === "lose"
          ? "bg-[color-mix(in_srgb,var(--app-danger)_14%,transparent)] text-[var(--app-danger)]"
          : settlementCopy.tone === "draw"
            ? "bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] text-[var(--app-warning)]"
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
        <div className="flex items-center gap-1.5">
          <span
            className={`h-4 w-4 rounded-full border ${
              gomoku.turn === "black" ? "border-slate-600 bg-slate-900" : "border-slate-400 bg-white"
            }`}
            aria-hidden="true"
          />
          <span className="text-[13px] font-bold text-[var(--survey-heading)]">
            {isMyTurn ? "轮到你了" : gameEnded ? "对局结束" : `等待${gomoku.turn === "black" ? "黑棋" : "白棋"}落子`}
          </span>
        </div>
        {status === "playing" && gomoku.outcome === null ? (
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
                title={
                  countdownToneValue === "expired"
                    ? "本回合时间已用完"
                    : countdownToneValue === "urgent"
                      ? "剩余时间不足 10 秒"
                      : undefined
                }
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {countdownText}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* lobby 阶段的座位提示：你执哪色由引擎在入座时分配（玩法私有信息） */}
      {status === "lobby" && role === "player" && gomoku.yourColor !== null ? (
        <p className="mt-1 text-[12px] text-[var(--survey-muted)]">
          你执{gomoku.yourColor === "black" ? "黑先行" : "白后行"}，开局后棋盘由你先落子/应手。
        </p>
      ) : null}

      <div className="mt-3">
        <GomokuBoard
          board={gomoku.board}
          boardSize={gomoku.boardSize}
          lastMove={gomoku.lastMove}
          winningLine={gomoku.winningLine}
          playable={isMyTurn && connection === "open"}
          onCellClick={(row, col) => void placeStone(row, col)}
        />
      </div>

      <div className="mt-3 space-y-2">
        {renderOfferBanners()}
        {status === "playing" && gomoku.outcome === null && role === "player" ? (
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-heading)] disabled:opacity-40"
              disabled={
                !(
                  gomoku.outcome === null &&
                  gomoku.pendingUndoFrom === null &&
                  gomoku.lastMove !== null &&
                  gomoku.lastMove.seatToken === myHash
                )
              }
              title={
                gomoku.lastMove !== null && gomoku.lastMove.seatToken === myHash
                  ? "申请撤回你刚落的一手"
                  : "只能申请撤回你刚落下的一手"
              }
              onClick={() => void sendGameAction("request_undo")}
            >
              悔棋
            </button>
            <button
              type="button"
              className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-heading)] disabled:opacity-40"
              disabled={gomoku.pendingDrawFrom !== null}
              onClick={() =>
                void sendGameAction(
                  gomoku.pendingDrawFrom !== null && gomoku.pendingDrawFrom !== myHash ? "accept_draw" : "offer_draw",
                )
              }
            >
              {gomoku.pendingDrawFrom !== null && gomoku.pendingDrawFrom !== myHash ? "同意和棋" : "求和"}
            </button>
            <button
              type="button"
              className="btn btn-sm border border-[color-mix(in_srgb,var(--app-danger)_35%,transparent)] bg-[var(--survey-card-bg)] text-[var(--app-danger)]"
              onClick={() => void handleResign()}
            >
              认输
            </button>
          </div>
        ) : null}
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
