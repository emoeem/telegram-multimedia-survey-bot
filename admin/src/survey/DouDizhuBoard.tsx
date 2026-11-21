import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Crown, Eye, RefreshCw } from "lucide-react";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import {
  countdownTone,
  doudizhuCardLabel,
  doudizhuCardRank,
  doudizhuHandSort,
  doudizhuPlayHint,
  doudizhuSeatName,
  formatCountdown,
  parseDoudizhuView,
  type DoudizhuSortDir,
} from "./game-room-logic";
import type { GameBoardProps } from "./game-board-registry";

/**
 * 斗地主 Board 面板（游戏批次 F2 客户端）——玩法私有渲染的唯一归属：三座位
 * 牌桌（地主标识/底牌三张/倍数与积分/剩余牌数）、手牌点选抬起、叫分、
 * 出牌/不出、牌型即时预判提示（客户端预判 + 服务端裁决）、上一手牌面展示、
 * 认输、结算与出口都在这里；大厅层与房间壳不 import 本文件的玩法逻辑。
 *
 * 自指信息（「我是谁」）从玩法载荷自取：玩家视图的 yourSeat 即自己的座位号
 * （engine-types 协议不变量三：视图按人裁剪；斗地主只有自己的手牌，其他座位
 * 只有张数）。动作四个：叫分 bid { score }（0 = 不叫）、出牌 play { cards }、
 * 过牌 pass、认输 resign——牌型合法性以服务端裁决为准，本地预判只做提示。
 *
 * 390px 纪律：手牌横向滚动 + 紧凑叠放（负 margin 相邻叠压 ~55%），选中牌
 * 整体上抬；对局记录侧栏默认收起。
 */

/** 单张牌的牌面：牌码 → 点数展示（无花色语义；双王给红/黑区分）。 */
function CardFace({ card, selected, onClick }: { card: string; selected: boolean; onClick: () => void }) {
  const rank = doudizhuCardRank(card);
  const label = doudizhuCardLabel(card);
  const isJoker = rank === 16 || rank === 17;
  // 双王只有一副（copy 0），无副本角标；数牌同点 4 张也不标副本——斗地主
  // 牌面只看点数，副本号是协议内部去重用的，不进 UI。
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={`relative flex h-[52px] w-[36px] shrink-0 flex-col items-center justify-center rounded-md border bg-white shadow-sm transition-transform touch-manipulation ${
        selected
          ? "-translate-y-3 border-[var(--survey-primary)] ring-2 ring-[var(--survey-primary)]"
          : "border-[#d6d3d1]"
      } ${isJoker ? (rank === 17 ? "text-red-600" : "text-slate-800") : "text-slate-900"}`}
    >
      <span className={`font-black leading-none ${isJoker ? "text-[13px]" : "text-[17px]"}`}>{label}</span>
      {isJoker ? <span className="mt-0.5 text-[9px] font-bold opacity-70">JOKER</span> : null}
    </button>
  );
}

export function DouDizhuBoardPanel({
  view,
  role,
  connection,
  online,
  remainingNow,
  sendAction,
  onExitRoom,
}: GameBoardProps) {
  const { toast, confirm } = useDialogs();
  /** 选中的手牌牌码（点选抬起；出牌时整组提交给服务端裁决）。 */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** 手牌排序方向：点数降序（默认）/ 升序，可切换。 */
  const [sortDir, setSortDir] = useState<DoudizhuSortDir>("desc");
  /** 对局记录侧栏折叠开关（默认收起，窄屏先看牌桌）。 */
  const [logOpen, setLogOpen] = useState(false);
  const logListRef = useRef<HTMLOListElement | null>(null);

  const dd = parseDoudizhuView(view.view);
  const status = view.status;

  const sortedHand = useMemo(() => (dd === null ? [] : doudizhuHandSort(dd.hand, sortDir)), [dd, sortDir]);

  // 对局记录自动滚底：新的记录落到列表底部后自动滚出最新一条。
  const logLength = (dd?.history.length ?? 0) + (dd?.events.length ?? 0);
  useEffect(() => {
    const list = logListRef.current;
    if (list !== null && logOpen) list.scrollTop = list.scrollHeight;
  }, [logLength, logOpen]);

  // 换局/出牌成功后清空选中：version 变化不代表清空时机（叫分也会 bump），
  // 这里按「我的手牌集合变化」收敛——出掉的牌不再处于选中态。
  const handKey = sortedHand.join(",");
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(sortedHand);
      const next = new Set([...prev].filter((card) => alive.has(card)));
      return next.size === prev.size ? prev : next;
    });
    // 依赖手牌集合本身而非 version：重排不影响选中（牌码不变）。
  }, [handKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (dd === null) {
    return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
  }

  const gameEnded = status === "settled" || status === "closed" || dd.outcome != null;
  const isMyBidTurn =
    dd.yourSeat !== null &&
    status === "playing" &&
    dd.phase === "bidding" &&
    dd.bidTurn === dd.yourSeat &&
    dd.outcome === null;
  const isMyTurn =
    dd.yourSeat !== null &&
    status === "playing" &&
    dd.phase === "playing" &&
    dd.currentTurn === dd.yourSeat &&
    dd.outcome === null;
  const interactive = connection === "open" && role === "player";

  const sendGameAction = async (action: string, payload?: unknown) => {
    try {
      await sendAction(action, payload);
    } catch (message) {
      toast({ message: String(message), variant: "error" });
    }
  };

  const toggleCard = (card: string) => {
    if (!isMyTurn || !interactive) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(card)) next.delete(card);
      else next.add(card);
      return next;
    });
  };

  const hint = doudizhuPlayHint([...selected], dd.lastPlay);
  /** 出牌预判通过 = 提示以「· 可出」收口；不合法/压不过的预判只挡明显误触
   * （按钮置灰），服务端仍是唯一裁决者。 */
  const selectionValid = hint !== null && hint.endsWith("· 可出");
  const canPlay = isMyTurn && interactive && selectionValid;
  const canPass = isMyTurn && interactive && dd.canPass;

  const handlePlay = () => {
    if (!canPlay) return;
    void sendGameAction("play", { cards: [...selected] });
  };
  const handlePass = () => {
    if (!canPass) return;
    void sendGameAction("pass");
  };
  const handleBid = (score: number) => {
    if (!isMyBidTurn || !interactive) return;
    void sendGameAction("bid", { score });
  };

  const handleResign = async () => {
    const agreed = await confirm({
      title: "认输退出",
      message: "认输后退出本局，其余玩家继续。确定认输吗？",
      confirmLabel: "认输",
      variant: "danger",
    });
    if (agreed) void sendGameAction("resign");
  };

  /** 结算文案：地主/农民方胜负 + 积分变动（结算快照只进 settle，这里用 outcome 文案）。 */
  const settlementCopy = (() => {
    const outcome = dd.outcome;
    if (!outcome) return null;
    if (outcome.result === "aborted" || outcome.winnerSide === null) {
      return { headline: "对局结束", detail: "对局中止", tone: "neutral" as const };
    }
    const sideText = outcome.winnerSide === "landlord" ? "地主" : "农民方";
    if (dd.yourSeat === null) {
      return { headline: "对局结束", detail: `${sideText}获胜`, tone: "neutral" as const };
    }
    const iWon = outcome.winnerSide === "landlord" ? dd.yourSeat === dd.landlordSeat : dd.yourSeat !== dd.landlordSeat;
    return iWon
      ? { headline: "你赢了！", detail: `${sideText}获胜`, tone: "win" as const }
      : { headline: "对局结束", detail: `${sideText}获胜`, tone: "lose" as const };
  })();

  const countdownText = formatCountdown(remainingNow);
  const countdownToneValue = countdownTone(remainingNow);

  const turnLabel = gameEnded
    ? "对局结束"
    : dd.phase === "bidding"
      ? isMyBidTurn
        ? "轮到你叫分"
        : `等待${doudizhuSeatName(view, dd, dd.bidTurn)}叫分`
      : isMyTurn
        ? dd.lastPlay === null
          ? "轮到你出牌（自由出）"
          : "轮到你出牌或不出"
        : `等待${doudizhuSeatName(view, dd, dd.currentTurn)}出牌`;

  const seatRow = (seatIndex: number) => {
    const seat = dd.seats[seatIndex];
    if (!seat) return null;
    const isTurn =
      !gameEnded &&
      ((dd.phase === "bidding" && dd.bidTurn === seatIndex) ||
        (dd.phase === "playing" && dd.currentTurn === seatIndex));
    return (
      <div
        key={seatIndex}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border px-2 py-1.5 ${
          isTurn
            ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
            : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
        }`}
      >
        {seat.isLandlord ? (
          <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="地主" />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--survey-heading)]">
          {doudizhuSeatName(view, dd, seatIndex)}
          {seatIndex === dd.yourSeat ? "（你）" : ""}
          {seat.resigned ? " · 已认输" : ""}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--survey-muted)]">
          {seat.isBidTurn ? "叫分中" : `剩 ${seat.handCount} 张`}
        </span>
      </div>
    );
  };

  return (
    <section className="survey-card p-4">
      {/* 回合条：轮到谁 + 倍数拆解 + 观战人数 + 倒计时 */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-bold text-[var(--survey-heading)]">{turnLabel}</span>
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

      {/* 倍数与积分：底分 × 叫分 × 2^炸弹（春天倍数结算时另计） */}
      <p className="mt-1 text-[11px] tabular-nums text-[var(--survey-muted)]">
        底分 {dd.multiplier.base} × 叫分 {dd.bidScore || 1} × 2^{dd.bombCount} 炸弹 = 单位分{" "}
        {dd.multiplier.base * (dd.bidScore || 1) * 2 ** dd.bombCount}（春天再 ×2）
      </p>

      {/* 三座位条 */}
      <div className="mt-2 flex items-stretch gap-1.5">{dd.seats.map((seat) => seatRow(seat.seatIndex))}</div>

      {/* 牌桌中央：底牌三张 + 上一手牌面 */}
      <div className="mt-3 rounded-xl border border-[var(--survey-card-border)] bg-[color-mix(in_srgb,var(--survey-primary-soft)_60%,transparent)] px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="shrink-0">
            <p className="text-[11px] font-semibold text-[var(--survey-muted)]">
              {dd.bottomCards === null ? `底牌 ×${dd.bottomCount}` : "底牌"}
            </p>
            {dd.bottomCards !== null ? (
              <p className="text-[13px] font-bold text-[var(--survey-heading)]">
                {dd.bottomCards.map((card) => doudizhuCardLabel(card)).join(" ")}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            {dd.phase === "playing" ? (
              dd.lastPlay === null ? (
                <p className="text-[12px] text-[var(--survey-muted)]">{gameEnded ? "—" : "新一轮自由出牌"}</p>
              ) : (
                <p className="truncate text-[12px] text-[var(--survey-heading)]">
                  <span className="font-semibold">{doudizhuSeatName(view, dd, dd.lastPlay.seatIndex)}</span>出{" "}
                  {dd.lastPlay.cards.map((card) => doudizhuCardLabel(card)).join(" ")}
                </p>
              )
            ) : (
              <p className="text-[12px] text-[var(--survey-muted)]">
                {dd.currentBid ? `当前最高叫分：${dd.currentBid.score} 分` : "还没人叫分"}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 叫分按钮：不叫 / 1-3 分（必须严格高于当前最高分，按钮已按此裁剪） */}
      {dd.phase === "bidding" && status === "playing" && dd.outcome === null ? (
        <div className="mt-3">
          {isMyBidTurn && interactive ? (
            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                onClick={() => handleBid(0)}
              >
                不叫
              </button>
              {[1, 2, 3].map((score) => {
                const blocked = dd.currentBid !== null && score <= dd.currentBid.score;
                return (
                  <button
                    key={score}
                    type="button"
                    disabled={blocked}
                    className="btn btn-primary btn-sm disabled:opacity-40"
                    onClick={() => handleBid(score)}
                  >
                    {score} 分
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--survey-muted)]">等待叫分…</p>
          )}
        </div>
      ) : null}

      {/* 自己的手牌：点选抬起；排序方向可切换；横向滚动兜住 390px */}
      {dd.yourSeat !== null && dd.hand.length > 0 ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[var(--survey-muted)]">
              你的手牌（{dd.hand.length} 张）
            </span>
            <button
              type="button"
              className="text-[11px] font-semibold text-[var(--survey-primary)] underline"
              onClick={() => setSortDir((dir) => (dir === "desc" ? "asc" : "desc"))}
            >
              按{sortDir === "desc" ? "点数降序" : "点数升序"} ▾
            </button>
          </div>
          <div className="mt-1.5 overflow-x-auto pb-1">
            <div className="flex w-max items-end" style={{ paddingLeft: 2 }}>
              {sortedHand.map((card, index) => (
                <div key={card} style={{ marginLeft: index === 0 ? 0 : -16 }}>
                  <CardFace card={card} selected={selected.has(card)} onClick={() => toggleCard(card)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : dd.yourSeat !== null && dd.phase === "playing" ? (
        <p className="mt-3 text-[12px] text-[var(--survey-muted)]">你的手牌已出完</p>
      ) : null}

      {/* 预判提示 + 出牌/不出（客户端预判只做提示，服务端裁决为准） */}
      {isMyTurn ? (
        <div className="mt-3 space-y-2">
          {hint !== null ? (
            <p
              role="status"
              className={`rounded-xl px-3 py-2 text-[12px] font-semibold ${
                selectionValid
                  ? "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
                  : "bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] text-[var(--app-warning)]"
              }`}
            >
              {hint}
            </p>
          ) : null}
          {interactive ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={!canPlay} onClick={handlePlay}>
                出牌{selected.size > 0 ? `（${selected.size} 张）` : ""}
              </button>
              <button
                type="button"
                className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                disabled={!canPass}
                onClick={handlePass}
              >
                不出
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 认输 + 记录 + 结算 */}
      <div className="mt-3 space-y-2">
        {status === "playing" && dd.outcome === null && role === "player" ? (
          <button
            type="button"
            className="btn btn-sm w-full border border-[color-mix(in_srgb,var(--app-danger)_35%,transparent)] bg-[var(--survey-card-bg)] text-[var(--app-danger)]"
            onClick={() => void handleResign()}
          >
            认输退出
          </button>
        ) : null}

        {dd.history.length > 0 || dd.events.length > 0 ? (
          <section
            className="overflow-hidden rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
            aria-label="对局记录"
          >
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-bold text-[var(--survey-heading)]"
              onClick={() => setLogOpen((open) => !open)}
              aria-expanded={logOpen}
            >
              对局记录（{dd.history.length} 手）
              <ChevronDown
                className={`h-4 w-4 text-[var(--survey-muted)] transition-transform ${logOpen ? "" : "-rotate-90"}`}
                aria-hidden="true"
              />
            </button>
            {logOpen ? (
              <ol ref={logListRef} className="max-h-40 overflow-y-auto px-3 pb-2 text-[12px] leading-6">
                {dd.history.map((record) => (
                  <li key={`m-${record.ply}`} className="flex items-start gap-2">
                    <span className="w-8 shrink-0 text-right tabular-nums text-[var(--survey-muted)]">
                      {record.ply}.
                    </span>
                    <span className="font-semibold text-[var(--survey-heading)]">{record.text}</span>
                  </li>
                ))}
                {dd.events.map((event, index) => (
                  <li key={`e-${event.ply}-${index}`} className="font-semibold text-[var(--app-warning)]">
                    {event.text}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}

        {settlementCopy !== null
          ? (() => {
              const toneClass =
                settlementCopy.tone === "win"
                  ? "bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] text-[var(--app-success)]"
                  : settlementCopy.tone === "lose"
                    ? "bg-[color-mix(in_srgb,var(--app-danger)_14%,transparent)] text-[var(--app-danger)]"
                    : "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]";
              return (
                <div className={`rounded-xl px-4 py-3 text-center ${toneClass}`} role="status">
                  <p className="text-lg font-black">{settlementCopy.headline}</p>
                  {settlementCopy.detail ? (
                    <p className="mt-0.5 text-[12px] opacity-80">{settlementCopy.detail}</p>
                  ) : null}
                  {dd.outcome?.spring === "spring" ? <p className="text-[12px] font-bold">春天！倍数再翻倍</p> : null}
                  {dd.outcome?.spring === "anti_spring" ? (
                    <p className="text-[12px] font-bold">反春天！倍数再翻倍</p>
                  ) : null}
                </div>
              );
            })()
          : null}

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
