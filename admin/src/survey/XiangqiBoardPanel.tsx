import { useEffect, useRef, useState } from "react";
import { ChevronDown, Eye, RefreshCw } from "lucide-react";
import { XiangqiBoard } from "./XiangqiBoard";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import {
  XIANGQI_PIECE_CHARS,
  countdownTone,
  formatCountdown,
  localXiangqiMoveCheck,
  parseXiangqiView,
  xiangqiSettlementCopy,
  type XiangqiColor,
  type XiangqiPointView,
} from "./game-room-logic";
import type { GameBoardProps } from "./game-board-registry";

/** 棋子码 → 颜色（大写红 / 小写黑，与服务端 xiangqi.ts 编码一致）。 */
function colorOfPiece(piece: string): XiangqiColor {
  return piece === piece.toUpperCase() ? "red" : "black";
}

/**
 * 象棋 Board 面板（多人玩法批次 X1）——玩法私有渲染的唯一归属：棋盘、
 * 回合条、红黑座位提示、将军横幅、选子走子、求和/认输、结算与出口都在
 * 这里；大厅层（GameLobby.tsx）与房间壳（MultiplayerGameScreen）不 import
 * 本文件的玩法逻辑。
 *
 * 自指信息（「我是谁」）从玩法载荷自取：玩家视图的 yourColor 对回座位表即
 * 得到自己的 participantHash（engine-types 协议不变量三：视图按人裁剪）。
 * 走子采用两段式：先点选己方棋子，再点目标交点发 { from, to }——权威校验
 * 全在服务端引擎，本地预判（localXiangqiMoveCheck）只挡必被拒的操作；
 * 选中后按服务端 legalMoves 画可走点提示，点在提示外直接提示不发请求
 * （旧部署没有 legalMoves 字段时提示缺位，退回直接发送由服务端拒）。
 * 棋谱侧栏渲染服务端 history 的中文记谱（重连/中途观战也能看到全谱）。
 */
export function XiangqiBoardPanel({
  view,
  role,
  connection,
  online,
  remainingNow,
  sendAction,
  onExitRoom,
}: GameBoardProps) {
  const { toast, confirm } = useDialogs();
  const [selected, setSelected] = useState<XiangqiPointView | null>(null);
  /** 棋谱侧栏折叠开关（默认展开；窄屏可收起省屏幕）。 */
  const [movesOpen, setMovesOpen] = useState(true);
  /** 棋谱列表容器：新的一手落到列表底部后自动滚到底。 */
  const movesListRef = useRef<HTMLOListElement | null>(null);

  const xiangqi = parseXiangqiView(view.view);
  const status = view.status;

  // 棋谱自动滚底：新的一手（或折叠/展开）后把列表滚到最新一手。effect 必须在
  // 早退 return 之前挂（rules-of-hooks），xiangqi 还没解析好时靠长度 0 空转。
  const historyLength = xiangqi?.history.length ?? 0;
  useEffect(() => {
    const list = movesListRef.current;
    if (list !== null && movesOpen) list.scrollTop = list.scrollHeight;
  }, [historyLength, movesOpen]);

  if (xiangqi === null) {
    return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
  }

  const myHash =
    xiangqi.yourColor !== null
      ? (xiangqi.players.find((seat) => seat.color === xiangqi.yourColor)?.participantHash ?? null)
      : null;
  const gameEnded = status === "settled" || status === "closed" || xiangqi.outcome != null;
  const isMyTurn =
    xiangqi.yourColor !== null &&
    status === "playing" &&
    xiangqi.outcome === null &&
    xiangqi.turn === xiangqi.yourColor;

  const countdownText = formatCountdown(remainingNow);
  const countdownToneValue = countdownTone(remainingNow);

  const reasonFromSummary = () => {
    const summary = view.settlement?.summary;
    return summary && typeof summary === "object" && typeof (summary as Record<string, unknown>).reason === "string"
      ? ((summary as Record<string, unknown>).reason as string)
      : null;
  };
  const settlementCopy = xiangqi.outcome
    ? xiangqiSettlementCopy(
        xiangqi.outcome.result,
        xiangqi.outcome.winnerParticipantHash,
        myHash,
        xiangqi.outcome.reason,
      )
    : view.settlement
      ? xiangqiSettlementCopy(
          view.settlement.result,
          view.settlement.winnerParticipantHash,
          myHash,
          reasonFromSummary(),
        )
      : null;

  const sendGameAction = async (action: string) => {
    try {
      await sendAction(action);
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  /** 选中棋子的合法落点（服务端 legalMoves 按 from 过滤）：可走点提示与
   * 点击拦截共用。旧部署没有该字段时整表为空——提示缺位，点击退回直接
   * 发送路径，由服务端权威拒绝。 */
  const hintPoints =
    selected !== null && isMyTurn && xiangqi.legalMoves.length > 0
      ? xiangqi.legalMoves
          .filter((move) => move.from.row === selected.row && move.from.col === selected.col)
          .map((move) => move.to)
      : [];

  const handleCellClick = async (row: number, col: number) => {
    if (!isMyTurn || connection !== "open") return;
    const piece = xiangqi.board[row]?.[col] ?? null;
    // 未选中：点己方棋子即选中（点对方棋子提示）；点已选中棋子取消选择。
    if (selected === null || (selected.row === row && selected.col === col)) {
      if (piece !== null && colorOfPiece(piece) === xiangqi.yourColor) {
        setSelected(selected === null ? { row, col } : null);
      } else if (piece !== null) {
        toast({ message: "请先选择你自己的棋子", variant: "info" });
      } else if (selected !== null) {
        setSelected(null);
      }
      return;
    }
    // 已选中：点己方另一枚棋子 = 换选；点空格/对方棋子 = 尝试走子。
    if (piece !== null && colorOfPiece(piece) === xiangqi.yourColor) {
      setSelected({ row, col });
      return;
    }
    // 合法走法表在手时，提示之外的落点直接拦下（不发必被拒的请求），保留
    // 选中让用户改点提示位置；表为空（旧部署/该子无着可走）走服务端判定。
    const inHints = hintPoints.some((point) => point.row === row && point.col === col);
    if (hintPoints.length > 0 && !inHints) {
      toast({ message: "这枚棋子走不到那里", variant: "info" });
      return;
    }
    const from = selected;
    setSelected(null);
    const rejected = localXiangqiMoveCheck(xiangqi, from, { row, col });
    if (rejected !== null) {
      toast({ message: rejected, variant: "error" });
      return;
    }
    try {
      await sendAction("move", { from, to: { row, col } });
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

  const turnLabel = gameEnded
    ? "对局结束"
    : isMyTurn
      ? "轮到你了"
      : `等待${xiangqi.turn === "red" ? "红棋" : "黑棋"}走子`;

  const checkBanner = () => {
    if (status !== "playing" || xiangqi.outcome !== null || xiangqi.check === null) return null;
    const mine = xiangqi.check === xiangqi.yourColor;
    const text =
      xiangqi.yourColor === null
        ? `${xiangqi.check === "red" ? "红棋" : "黑棋"}正被将军`
        : mine
          ? "你的将/帅正被将军，请立即应将！"
          : "将军！对方正在应将";
    return (
      <div
        className="rounded-xl bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] px-3 py-2 text-center text-[12px] font-bold text-[var(--app-warning)]"
        role="status"
      >
        {text}
      </div>
    );
  };

  const renderOfferBanner = () => {
    if (status !== "playing") return null;
    const drawPending = xiangqi.pendingDrawFrom;
    if (drawPending === null) return null;
    if (drawPending === myHash) {
      return <p className="px-1 text-[12px] text-[var(--survey-muted)]">已提议和棋，等待对方回应…</p>;
    }
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-3 py-2">
        <p className="text-[12px] font-medium text-[var(--survey-primary)]">对方提议平局结束</p>
        <button
          type="button"
          className="shrink-0 rounded-full bg-[var(--survey-primary)] px-3 py-1 text-[11px] font-bold text-[var(--survey-primary-content)]"
          onClick={() => void sendGameAction("accept_draw")}
        >
          同意和棋
        </button>
      </div>
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
              xiangqi.turn === "red" ? "border-red-700 bg-red-600" : "border-slate-600 bg-slate-900"
            }`}
            aria-hidden="true"
          />
          <span className="text-[13px] font-bold text-[var(--survey-heading)]">{turnLabel}</span>
        </div>
        {status === "playing" && xiangqi.outcome === null ? (
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

      {/* lobby 阶段的座位提示：你执哪色由引擎在入座时分配（房主红先手） */}
      {status === "lobby" && role === "player" && xiangqi.yourColor !== null ? (
        <p className="mt-1 text-[12px] text-[var(--survey-muted)]">
          你执{xiangqi.yourColor === "red" ? "红先行" : "黑后行"}，开局后棋盘按红先黑后轮流走子。
        </p>
      ) : null}

      <div className="mt-3">
        <XiangqiBoard
          board={xiangqi.board}
          lastMoveTo={xiangqi.lastMove?.to ?? null}
          selected={isMyTurn ? selected : null}
          hints={hintPoints}
          playable={isMyTurn && connection === "open"}
          onCellClick={(row, col) => void handleCellClick(row, col)}
        />
      </div>

      {/* 棋谱侧栏（X2）：服务端中文记谱全量渲染，最新一手在底部、自动滚出。
          记谱缺串（异常数据）退化为坐标记法保持中文可读。 */}
      {xiangqi.history.length > 0 ? (
        <section
          className="mt-3 overflow-hidden rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
          aria-label="棋谱"
        >
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-bold text-[var(--survey-heading)]"
            onClick={() => setMovesOpen((open) => !open)}
            aria-expanded={movesOpen}
          >
            棋谱（{xiangqi.moveCount} 手）
            <ChevronDown
              className={`h-4 w-4 text-[var(--survey-muted)] transition-transform ${movesOpen ? "" : "-rotate-90"}`}
              aria-hidden="true"
            />
          </button>
          {movesOpen ? (
            <ol ref={movesListRef} className="max-h-40 overflow-y-auto px-3 pb-2 text-[12px] leading-6">
              {xiangqi.history.map((move) => (
                <li key={move.ply} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-right tabular-nums text-[var(--survey-muted)]">{move.ply}.</span>
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      move.color === "red" ? "bg-red-600" : "bg-slate-900"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="font-semibold text-[var(--survey-heading)]">
                    {move.notation ||
                      `${XIANGQI_PIECE_CHARS[move.piece] ?? move.piece}(${move.from.row},${move.from.col})→(${move.to.row},${move.to.col})`}
                  </span>
                  {move.captured !== null ? (
                    <span className="text-[var(--survey-muted)]">
                      吃{XIANGQI_PIECE_CHARS[move.captured] ?? move.captured}
                    </span>
                  ) : null}
                  {move.givesCheck ? <span className="font-bold text-[var(--app-warning)]">将军</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      <div className="mt-3 space-y-2">
        {checkBanner()}
        {renderOfferBanner()}
        {status === "playing" && xiangqi.outcome === null && role === "player" ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-heading)] disabled:opacity-40"
              disabled={xiangqi.pendingDrawFrom !== null}
              onClick={() =>
                void sendGameAction(
                  xiangqi.pendingDrawFrom !== null && xiangqi.pendingDrawFrom !== myHash ? "accept_draw" : "offer_draw",
                )
              }
            >
              {xiangqi.pendingDrawFrom !== null && xiangqi.pendingDrawFrom !== myHash ? "同意和棋" : "求和"}
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
