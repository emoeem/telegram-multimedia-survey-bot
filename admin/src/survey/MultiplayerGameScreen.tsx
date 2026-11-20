import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, Gamepad2, Link2, LogOut, RefreshCw, Swords, Users, WifiOff } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";
import { ErrorState, SectionHeader } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import { safeCopy } from "./clipboard";
import { GomokuBoard } from "./GomokuBoard";
import {
  countdownTone,
  describeSettlement,
  formatCountdown,
  localMoveCheck,
  normalizeRoomCode,
  opponentLikelyOffline,
  parseGomokuView,
  undoRejectedNotice,
  type GomokuColor,
  type GomokuView,
} from "./game-room-logic";
import {
  closeGameRoom,
  createGameRoom,
  fetchGameRoomState,
  GameRoomConnection,
  joinGameRoom,
  selfDisplayName,
  type GameConnectionStatus,
} from "./game-room-client";
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";

/** 玩家/公开两种视图的玩家行公共字段（ready 只在玩家视图里有）。 */
type RoomPlayerRow = GamePlayerView["players"][number] | GamePublicView["players"][number];

/** 观战视图的玩家行没有 ready 字段：有就取，没有按未准备处理。 */
function playerReady(player: RoomPlayerRow): boolean {
  return "ready" in player ? player.ready : false;
}

/**
 * 五子棋 · 联机对战（批次 W3，/game）。
 *
 * 一屏两态：无房间时是大厅（创建房间 / 输入房间码加入），进入房间后按服务端
 * 下发的 status 分渲染——lobby（玩家列表 + 准备/开局）、playing（棋盘 +
 * 倒计时 + 悔棋/求和/认输）、settled/closed（结果与出口）。实时性全部由
 * GameRoomConnection 的 WS 推送维持，断线自动重连并拉 REST /state 兜底；
 * 身份沿用 identityHeaders() 约定（WS 走 Sec-WebSocket-Protocol 子协议携带），
 * 不新造身份体系。
 *
 * 「我是谁」不引入新的回传字段：玩家视图的 yourColor 对回玩法座位表即得到
 * 自己的 participantHash（engine-types 协议不变量三：视图按人裁剪）。
 */
export function MultiplayerGameScreen() {
  const themeState = usePublicTheme();
  const { toast, confirm } = useDialogs();

  const [roomId, setRoomId] = useState<number | null>(null);
  const [view, setView] = useState<GamePlayerView | GamePublicView | null>(null);
  const [role, setRole] = useState<"player" | "spectator">("spectator");
  const [connection, setConnection] = useState<GameConnectionStatus>("closed");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("room");
    return fromUrl === null ? "" : fromUrl;
  });
  /** 房间进入瞬间的剩余毫秒快照，与本地时钟配合做倒计时显示。 */
  const [syncedRemaining, setSyncedRemaining] = useState<{ ms: number | null; at: number }>({ ms: null, at: 0 });
  const [clockMs, setClockMs] = useState(() => Date.now());
  /** presence 推送的在线人数（null = 还没收到首条推送，不做掉线判定）。 */
  const [online, setOnline] = useState<{ players: number; spectators: number } | null>(null);

  const connRef = useRef<GameRoomConnection | null>(null);
  const versionRef = useRef(0);
  const autoJoinedRef = useRef(false);
  /** 上一帧的玩法视图：悔棋被拒（对方落子顶掉申请）靠前后帧对比判定。 */
  const prevGomokuRef = useRef<GomokuView | null>(null);

  // 倒计时本地走秒：500ms 一跳，配合 syncedRemaining 换算剩余时间。
  useEffect(() => {
    const timer = setInterval(() => setClockMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // 卸载时彻底断开，不给休眠连接留尾巴。
  useEffect(
    () => () => {
      connRef.current?.dispose();
      connRef.current = null;
    },
    [],
  );

  // ------------------------------------------------------------------
  // 进入 / 退出房间
  // ------------------------------------------------------------------

  const exitRoom = useCallback(() => {
    connRef.current?.dispose();
    connRef.current = null;
    setRoomId(null);
    setView(null);
    setRole("spectator");
    setConnection("closed");
    setReconnectAttempt(0);
    setSyncedRemaining({ ms: null, at: 0 });
    setOnline(null);
    versionRef.current = 0;
    prevGomokuRef.current = null;
  }, []);

  const attachConnection = useCallback(
    (id: number) => {
      connRef.current?.dispose();
      const connection = new GameRoomConnection({
        roomId: id,
        onState: (nextView, nextRole) => {
          setView(nextView);
          setRole(nextRole);
          versionRef.current = nextView.version;
          setSyncedRemaining({ ms: nextView.remainingMs, at: Date.now() });
          // 悔棋申请被顶掉（对方落子即拒绝）的帧间对比：你的申请上一帧还在
          // 等待，下一帧消失且步数增加 → 明确提示，而不是横幅无声消失。
          const nextGomoku = parseGomokuView(nextView.view);
          const myHashNow =
            nextGomoku?.yourColor != null
              ? (nextGomoku.players.find((seat) => seat.color === nextGomoku.yourColor)?.participantHash ?? null)
              : null;
          const rejected = undoRejectedNotice(
            prevGomokuRef.current?.pendingUndoFrom ?? null,
            nextGomoku?.pendingUndoFrom ?? null,
            prevGomokuRef.current?.moveCount ?? 0,
            nextGomoku?.moveCount ?? 0,
            myHashNow,
          );
          prevGomokuRef.current = nextGomoku;
          if (rejected) toast({ message: rejected, variant: "info" });
        },
        onNotice: (message) => toast({ message, variant: "error" }),
        onFatal: (message) => {
          exitRoom();
          setError(message);
        },
        onStatus: (status, attempt) => {
          setConnection(status);
          setReconnectAttempt(attempt);
        },
        onPresence: (counts) => setOnline(counts),
      });
      connRef.current = connection;
      setRoomId(id);
      setConnection("connecting");
      connection.connect();
    },
    [exitRoom, toast],
  );

  const enterRoom = useCallback(
    async (id: number) => {
      setError(null);
      setBusy(true);
      try {
        const stateResult = await fetchGameRoomState(id);
        if (!stateResult.ok) {
          setError(
            stateResult.error.code === "room_not_found"
              ? "房间不存在或已被回收，请核对房间码"
              : stateResult.error.message,
          );
          return;
        }
        let snapshot = stateResult.data;
        if (snapshot.role !== "player") {
          // 还不是本房间玩家：先尝试入座。服务端在满员/已开局时不再报错，
          // 而是把请求降级为只读观战（spectatorFallback）——第三人进入房间
          // 就能看到棋局，不占座位、不可操作。
          const joinResult = await joinGameRoom(id, selfDisplayName());
          if (joinResult.ok) {
            snapshot = joinResult.data;
            if (snapshot.role === "spectator") {
              toast({
                message: snapshot.spectatorFallback
                  ? "对局进行中或房间已满，你将以观战身份看这一局"
                  : "你以观战身份进入了房间",
                variant: "info",
              });
            }
          } else {
            const retry = await fetchGameRoomState(id);
            if (!retry.ok) {
              setError(joinResult.error.message);
              return;
            }
            snapshot = retry.data;
            toast({ message: "房间已满，你将以观战身份看这一局", variant: "info" });
          }
        }
        attachConnection(snapshot.roomId);
      } finally {
        setBusy(false);
      }
    },
    [attachConnection, toast],
  );

  // ?room=<房间码> 直达：进屏自动走加入流程（粘贴链接/深链接落地的路径）。
  useEffect(() => {
    if (autoJoinedRef.current) return;
    const rawParam = new URLSearchParams(window.location.search).get("room");
    if (rawParam === null) return;
    autoJoinedRef.current = true;
    const requested = normalizeRoomCode(rawParam);
    if (requested === null) {
      // 链接带了房间参数但解析不出：明说，而不是静默停在大厅。
      setError("链接里的房间码无效，请让好友重新发送邀请");
      return;
    }
    void enterRoom(requested);
  }, [enterRoom]);

  // ------------------------------------------------------------------
  // 派生视图模型（动作回调都依赖它，必须先于回调声明）
  // ------------------------------------------------------------------

  const gomoku = useMemo(() => (view ? parseGomokuView(view.view) : null), [view]);
  const myHash = useMemo(() => {
    if (gomoku === null || gomoku.yourColor === null) return null;
    return gomoku.players.find((seat) => seat.color === gomoku.yourColor)?.participantHash ?? null;
  }, [gomoku]);
  const mePlayer = useMemo(
    // `players?.` 防御：信封由服务端装配、正常恒带 players，但坏帧不应白屏。
    () => view?.players?.find((player) => player.participantHash === myHash && player.leftAt === null) ?? null,
    [myHash, view],
  );
  const amHost = mePlayer?.isHost ?? false;
  const myReady = mePlayer !== null && playerReady(mePlayer);
  const activePlayers = useMemo(() => (view?.players ?? []).filter((player) => player.leftAt === null), [view]);
  const bothReady = activePlayers.length === 2 && activePlayers.every(playerReady);
  const status = view?.status ?? null;
  const gameEnded = status === "settled" || status === "closed" || gomoku?.outcome != null;
  const isMyTurn =
    gomoku !== null &&
    gomoku.yourColor !== null &&
    status === "playing" &&
    gomoku.outcome === null &&
    gomoku.turn === gomoku.yourColor;
  /** 观战身份标识：进入房间后由服务端 role 决定（第三人/满员/公开视图都算）。 */
  const isSpectator = view !== null && role === "spectator";
  /** 对手掉线风险：对局中在线玩家 < 2（presence 推送，按身份去重）。 */
  const opponentOffline = opponentLikelyOffline(status, online?.players ?? null);

  /** 本地走秒后的剩余毫秒：倒计时文案与紧迫度都从这里派生。 */
  const remainingNow = syncedRemaining.ms === null ? null : syncedRemaining.ms - (clockMs - syncedRemaining.at);
  const countdownText = useMemo(() => formatCountdown(remainingNow), [remainingNow]);
  const countdownToneValue = countdownTone(remainingNow);

  const settlementCopy = useMemo(() => {
    if (gomoku?.outcome) {
      return describeSettlement(gomoku.outcome.result, gomoku.outcome.winnerParticipantHash, myHash);
    }
    const settlement = view?.settlement;
    if (settlement) {
      return describeSettlement(settlement.result, settlement.winnerParticipantHash, myHash);
    }
    return null;
  }, [gomoku, myHash, view]);

  const seatPlayer = useCallback(
    (color: GomokuColor): { player: RoomPlayerRow | null; left: boolean } => {
      const seat = gomoku?.players.find((item) => item.color === color) ?? null;
      const player = seat
        ? (view?.players.find((item) => item.participantHash === seat.participantHash) ?? null)
        : null;
      return { player, left: player?.leftAt != null };
    },
    [gomoku, view],
  );

  // ------------------------------------------------------------------
  // 大厅动作
  // ------------------------------------------------------------------

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createGameRoom(selfDisplayName());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      attachConnection(result.data.roomId);
    } finally {
      setBusy(false);
    }
  }, [attachConnection]);

  const handleJoinInput = useCallback(async () => {
    const id = normalizeRoomCode(joinInput);
    if (id === null) {
      setError("房间码是创建房间时生成的一串数字，请核对后再试");
      return;
    }
    await enterRoom(id);
  }, [enterRoom, joinInput]);

  // ------------------------------------------------------------------
  // 房间内动作
  // ------------------------------------------------------------------

  const copyRoomCode = useCallback(async () => {
    if (roomId === null) return;
    const copied = await safeCopy(String(roomId));
    toast(
      copied
        ? { message: "房间码已复制，发给好友就能一起玩", variant: "success" }
        : { message: "复制失败，请手动记下房间码", variant: "error" },
    );
  }, [roomId, toast]);

  const leaveRoom = useCallback(() => {
    connRef.current?.sendLeave();
    exitRoom();
  }, [exitRoom]);

  const startGame = useCallback(() => {
    connRef.current?.sendStart();
  }, []);

  const toggleReady = useCallback(() => {
    if (mePlayer === null) {
      toast({ message: "你还不是本房间玩家", variant: "error" });
      return;
    }
    connRef.current?.sendReady(!myReady);
  }, [mePlayer, myReady, toast]);

  const sendGameAction = useCallback(
    async (action: string) => {
      if (connRef.current === null) return;
      try {
        await connRef.current.sendAction(action, undefined, versionRef.current);
      } catch (message) {
        toast({ message: String(message), variant: "error" });
      }
    },
    [toast],
  );

  const placeStone = useCallback(
    async (row: number, col: number) => {
      if (gomoku === null || connRef.current === null) return;
      const rejected = localMoveCheck(gomoku.board, row, col, gomoku.turn, gomoku.yourColor);
      if (rejected !== null) {
        toast({ message: rejected, variant: "error" });
        return;
      }
      try {
        await connRef.current.sendAction("move", { row, col }, versionRef.current);
      } catch (message) {
        toast({ message: String(message), variant: "error" });
      }
    },
    [gomoku, toast],
  );

  const handleResign = useCallback(async () => {
    const agreed = await confirm({
      title: "认输",
      message: "认输后本局立即结束，对方获胜。确定认输吗？",
      confirmLabel: "认输",
      variant: "danger",
    });
    if (agreed) void sendGameAction("resign");
  }, [confirm, sendGameAction]);

  const handleCloseRoom = useCallback(async () => {
    if (roomId === null) return;
    const agreed = await confirm({
      title: "关闭房间",
      message: "关闭后房间立即结束，双方都无法再进入。确定关闭吗？",
      confirmLabel: "关闭房间",
      variant: "danger",
    });
    if (!agreed) return;
    const result = await closeGameRoom(roomId);
    if (!result.ok) {
      toast({ message: result.error.message, variant: "error" });
      return;
    }
    toast({ message: "房间已关闭", variant: "success" });
    exitRoom();
  }, [confirm, exitRoom, roomId, toast]);

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  const renderSeatRow = (color: GomokuColor) => {
    const { player, left } = seatPlayer(color);
    const isMine = player !== null && player.participantHash === myHash;
    const label =
      player?.displayName?.trim() || (player !== null ? `玩家${color === "black" ? "一" : "二"}` : "等待加入…");
    const stateText =
      player === null
        ? "对方加入后显示在这里"
        : left
          ? "已离开房间"
          : (player.isHost ? "房主" : "玩家") +
            (status === "lobby" ? (playerReady(player) ? " · 已准备" : " · 未准备") : "");
    return (
      <div
        key={color}
        className="flex items-center gap-3 rounded-xl border border-[var(--survey-card-border)] px-3 py-2.5"
      >
        <span
          className={`h-5 w-5 shrink-0 rounded-full border ${
            color === "black" ? "border-slate-600 bg-slate-900" : "border-slate-400 bg-white"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-[var(--survey-heading)]">
            {color === "black" ? "黑棋" : "白棋"} · {label}
            {isMine ? "（我）" : ""}
          </span>
          <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">{stateText}</span>
        </span>
        {player !== null && player.isHost ? (
          <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--survey-primary)]">
            房主
          </span>
        ) : null}
      </div>
    );
  };

  const renderConnectionBanner = () => {
    if (view === null || connection === "open") return null;
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] px-3 py-2 text-[12px] font-medium text-[var(--app-warning)]"
      >
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        {reconnectAttempt > 0 ? `连接中断，正在自动重连（第 ${reconnectAttempt} 次）…` : "正在连接房间…"}
      </div>
    );
  };

  /** 观战标识：第三人/满员降级进来的只读身份，一眼可辨。 */
  const renderSpectatorBadge = () => {
    if (!isSpectator) return null;
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--survey-primary)]"
      >
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          观战模式 · 你可以实时看这一局，但不能落子或参与操作
          {online !== null && online.spectators > 1 ? `（当前 ${online.spectators} 人观战）` : ""}
        </span>
      </div>
    );
  };

  /** 对手掉线提示：presence 显示对局中在线玩家不足两人时亮起。 */
  const renderOfflineBanner = () => {
    if (!opponentOffline || role !== "player") return null;
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--app-warning)_14%,transparent)] px-3 py-2 text-[12px] font-medium text-[var(--app-warning)]"
      >
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        对方似乎已掉线，等待重连…（回合超时会判负）
      </div>
    );
  };

  const renderRoomHeader = () => (
    <section className="survey-card flex items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-[var(--survey-muted)]">房间码</p>
        <p className="text-2xl font-black tabular-nums tracking-[0.2em] text-[var(--survey-heading)]">{roomId}</p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--survey-muted)]">
          把这串数字发给好友，对方在本页输入即可加入
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <button
          type="button"
          className="survey-icon-btn"
          aria-label="复制房间码"
          title="复制房间码"
          onClick={() => void copyRoomCode()}
        >
          <Copy className="h-4 w-4" />
        </button>
        {amHost ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--app-danger)]"
            onClick={() => void handleCloseRoom()}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            关闭房间
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--survey-muted)]"
            onClick={leaveRoom}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            离开房间
          </button>
        )}
      </div>
    </section>
  );

  const renderOfferBanners = () => {
    if (gomoku === null || status !== "playing") return null;
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

  const renderBoardCard = () => {
    if (gomoku === null) {
      return <ErrorState message="对局数据没有加载出来，请稍候或重新进入房间。" />;
    }
    const canUndo =
      status === "playing" &&
      gomoku.outcome === null &&
      gomoku.pendingUndoFrom === null &&
      gomoku.lastMove !== null &&
      gomoku.lastMove.participantHash === myHash;
    const drawPendingFromOpponent = gomoku.pendingDrawFrom !== null && gomoku.pendingDrawFrom !== myHash;
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
                disabled={!canUndo}
                title={canUndo ? "申请撤回你刚落的一手" : "只能申请撤回你刚落下的一手"}
                onClick={() => void sendGameAction("request_undo")}
              >
                悔棋
              </button>
              <button
                type="button"
                className="btn btn-sm border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-heading)] disabled:opacity-40"
                disabled={gomoku.pendingDrawFrom !== null}
                onClick={() => void sendGameAction(drawPendingFromOpponent ? "accept_draw" : "offer_draw")}
              >
                {drawPendingFromOpponent ? "同意和棋" : "求和"}
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
              <button type="button" className="btn btn-primary btn-sm px-5" onClick={exitRoom}>
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
  };

  const renderLobbyControls = () => (
    <section className="survey-card space-y-3 p-4">
      <SectionHeader icon={Users} title="对局双方" />
      <div className="space-y-2">
        {renderSeatRow("black")}
        {renderSeatRow("white")}
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--survey-muted)]">
        {activePlayers.length < 2
          ? "把房间码发给好友，对方加入后就能开局。"
          : bothReady
            ? "双方都已准备，房主可以开局。"
            : "双方都点「准备」后，由房主开局。"}
      </p>
      {role === "player" && mePlayer !== null ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={toggleReady}>
            {myReady ? "取消准备" : "准备"}
          </button>
          {amHost ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!bothReady} onClick={startGame}>
              开局
            </button>
          ) : (
            <span className="grid place-items-center text-[12px] text-[var(--survey-muted)]">等待房主开局</span>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--survey-muted)]">你正在观战，对局开始后就能看到棋盘。</p>
      )}
    </section>
  );

  const renderRoom = () => {
    if (status === "closed") {
      return (
        <div className="space-y-4">
          {renderRoomHeader()}
          <ErrorState message="房间已关闭，本局到此为止。回大厅再开一局，或把新房间码发给好友。" />
          <button type="button" className="btn btn-primary w-full" onClick={exitRoom}>
            返回大厅
          </button>
        </div>
      );
    }
    if (view === null) {
      // WS 首帧还没到：只渲染房间头与占位，不落错误态。
      return (
        <div className="space-y-4">
          {renderRoomHeader()}
          {renderConnectionBanner()}
          <p className="py-10 text-center text-[13px] text-[var(--survey-muted)]">正在进入房间…</p>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {renderRoomHeader()}
        {renderConnectionBanner()}
        {renderSpectatorBadge()}
        {renderOfflineBanner()}
        {status === "lobby" ? renderLobbyControls() : null}
        {renderBoardCard()}
      </div>
    );
  };

  const renderEmpty = () => (
    <div className="space-y-4">
      <section className="survey-card p-4">
        <SectionHeader icon={Swords} title="五子棋 · 联机对战" />
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--survey-muted)]">
          创建一个房间把房间码发给好友，或输入对方的房间码加入同一局。黑白轮流落子，先连成五子的一方获胜；每一步限时一分钟。
        </p>
      </section>
      <section className="survey-card p-4">
        <SectionHeader icon={Gamepad2} title="创建房间" />
        <p className="mt-1.5 text-[12px] text-[var(--survey-muted)]">创建后你会拿到一个房间码，你执黑先行。</p>
        <button
          type="button"
          className="btn btn-primary mt-3 w-full disabled:opacity-50"
          disabled={busy}
          onClick={() => void handleCreate()}
        >
          {busy ? "正在创建…" : "创建房间"}
        </button>
      </section>
      <section className="survey-card p-4">
        <SectionHeader icon={Link2} title="加入房间" />
        <div className="mt-2 flex gap-2">
          <input
            className="input min-w-0 flex-1 text-center tracking-widest"
            inputMode="numeric"
            autoComplete="off"
            placeholder="输入房间码"
            aria-label="房间码"
            value={joinInput}
            onChange={(event) => setJoinInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleJoinInput();
            }}
          />
          <button
            type="button"
            className="btn btn-primary shrink-0 disabled:opacity-50"
            disabled={busy}
            onClick={() => void handleJoinInput()}
          >
            加入
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--survey-muted)]">直接粘贴好友发来的邀请链接也可以。</p>
      </section>
      {error !== null ? (
        <div role="alert" className="survey-card border-[color-mix(in_srgb,var(--app-danger)_35%,transparent)] p-3">
          <p className="text-[13px] font-medium text-[var(--app-danger)]">{error}</p>
          <button
            type="button"
            className="mt-1 text-[12px] font-semibold text-[var(--survey-primary)] underline"
            onClick={() => setError(null)}
          >
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        helpKey="game"
        title="五子棋 · 联机对战"
        subtitle="创建房间或输入房间码，两人实时对弈"
        titleIcon={<Swords className="h-4 w-4" />}
        backHref="/trial"
        backLabel="小游戏"
        wide={false}
        actions={<ThemeAction themeState={themeState} />}
      />
      <main className="mx-auto max-w-xl space-y-4 px-5 py-5">{roomId === null ? renderEmpty() : renderRoom()}</main>
    </ScreenShell>
  );
}
