import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, LogOut, Swords, WifiOff } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";
import { ErrorState } from "./PublicPrimitives";
import { useDialogs } from "../components/Dialogs";
import { safeCopy } from "./clipboard";
import { GameLobbyEntry, GameLobbyRoomPanel } from "./GameLobby";
import { UnknownGameBoard, resolveGameBoard } from "./game-boards";
import { FALLBACK_GAME_TYPES, findGameType, isRoomPlayerReady, type RoomPlayerRow } from "./game-lobby-logic";
import {
  closeGameRoom,
  createGameRoom,
  fetchGameRoomState,
  fetchGameTypes,
  GameRoomConnection,
  joinGameRoom,
  selfDisplayName,
  type GameConnectionStatus,
} from "./game-room-client";
import { normalizeRoomCode, opponentLikelyOffline } from "./game-room-logic";
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";

/**
 * 多人对局房（/game，批次：Lobby/Board 分层）。
 *
 * 三层结构，新增玩法只加 Board 组件 + 注册（game-boards.tsx 一行）：
 * - 房间壳（本文件）：连接管理（WS + 断线重连 + REST 兜底）、房间头
 *   （房间码/复制/关闭/离开）、连接/观战/掉线横幅，以及 Board 按
 *   view.gameType 分发（未知玩法渲染 UnknownGameBoard）；
 * - 大厅层（GameLobby.tsx）：创建/加入/玩家列表/准备/开局/观战提示，
 *   完全 gameType 无关；
 * - Board 层（*BoardPanel）：玩法私有渲染（棋盘/牌桌/悔棋求和/结算）。
 *
 * 「我是谁」不引入新身份体系：REST create/join/state 信封带 you（Worker
 * 鉴权后自己的 participantHash，见 game-api.ts），用它对回信封 players 即
 * 得到自己的 isHost/ready；WS 帧不重复携带——身份在一次连接内不变。
 *
 * 玩法列表来自 GET /api/game/types（失败回退 FALLBACK_GAME_TYPES 静态五子
 * 棋入口）；?type=<gameType> 预选创建的玩法，?room=<房间码> 直达加入。
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
  /** ?type= 预选玩法（创建用）；null = 跟随玩法列表首个。 */
  const [selectedType, setSelectedType] = useState<string | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("type");
    return raw !== null && /^[a-z0-9_-]+$/.test(raw) ? raw : null;
  });
  /** 已注册玩法列表（null = 未拉到，渲染静态兜底，入口不闪空）。 */
  const [gameTypes, setGameTypes] = useState<typeof FALLBACK_GAME_TYPES | null>(null);
  /** 房间进入瞬间的剩余毫秒快照，与本地时钟配合做倒计时显示。 */
  const [syncedRemaining, setSyncedRemaining] = useState<{ ms: number | null; at: number }>({ ms: null, at: 0 });
  const [clockMs, setClockMs] = useState(() => Date.now());
  /** presence 推送的在线人数（null = 还没收到首条推送，不做掉线判定）。 */
  const [online, setOnline] = useState<{ players: number; spectators: number } | null>(null);
  /** 我的 participantHash（REST 快照 you 字段；一次连接内不变）。 */
  const [myHash, setMyHash] = useState<string | null>(null);

  const connRef = useRef<GameRoomConnection | null>(null);
  const versionRef = useRef(0);
  const autoJoinedRef = useRef(false);

  // 倒计时本地走秒：500ms 一跳，配合 syncedRemaining 换算剩余时间。
  useEffect(() => {
    const timer = setInterval(() => setClockMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // 已注册玩法列表：入口卡与开局人数下限都从它来；拉不到（部署未升级/
  // 网络失败）回退静态五子棋入口，入口在任何部署下都不消失。
  useEffect(() => {
    let cancelled = false;
    void fetchGameTypes().then((result) => {
      if (!cancelled) setGameTypes(result.ok ? result.data : FALLBACK_GAME_TYPES);
    });
    return () => {
      cancelled = true;
    };
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
    setMyHash(null);
    versionRef.current = 0;
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
          // 就能看到对局，不占座位、不可操作。
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
        // 自己的 participantHash 只随 REST 快照更新（身份一次连接内不变，
        // WS 帧不重复携带）；信封 players 里以它定位「我的行」。
        setMyHash(snapshot.selfParticipantHash);
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
  // 玩法元数据（大厅入口与开局人数下限都来自它）
  // ------------------------------------------------------------------

  const types = gameTypes ?? FALLBACK_GAME_TYPES;
  /** 生效的创建玩法：?type= 命中已注册列表就用它，否则取列表首个。 */
  const effectiveType = useMemo(() => {
    if (selectedType !== null && findGameType(types, selectedType) !== null) return selectedType;
    return types[0]?.name ?? "gomoku";
  }, [selectedType, types]);
  const selectedGame = useMemo(() => findGameType(types, effectiveType), [types, effectiveType]);

  // ------------------------------------------------------------------
  // 房间信封派生（先于动作回调声明）：我的行 + 在座状态
  // ------------------------------------------------------------------

  const players: RoomPlayerRow[] = useMemo(() => (view?.players ?? []) as RoomPlayerRow[], [view]);
  /** 「我的行」按自己的 participantHash 对回信封 players；观战者不在座为 null。 */
  const mePlayer = useMemo(
    () => players.find((player) => player.participantHash === myHash && player.leftAt === null) ?? null,
    [myHash, players],
  );
  const amHost = mePlayer?.isHost ?? false;
  const myReady = mePlayer !== null && isRoomPlayerReady(mePlayer);

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

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createGameRoom(effectiveType, selfDisplayName());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      // 建房是唯一不经 enterRoom 的进房路径：这里必须同步落「我的行」锚点
      // （REST 信封 you），否则 mePlayer 恒 null——房主在 lobby 被渲染成观战
      // （无准备/开局按钮、房间头无「关闭房间」），建→备→开局链路第一步即断。
      setMyHash(result.data.selfParticipantHash);
      attachConnection(result.data.roomId);
    } finally {
      setBusy(false);
    }
  }, [attachConnection, effectiveType]);

  const handleJoinInput = useCallback(async () => {
    const id = normalizeRoomCode(joinInput);
    if (id === null) {
      setError("房间码是创建房间时生成的一串数字，请核对后再试");
      return;
    }
    await enterRoom(id);
  }, [enterRoom, joinInput]);

  const leaveRoom = useCallback(() => {
    connRef.current?.sendLeave();
    exitRoom();
  }, [exitRoom]);

  const startGame = useCallback(() => {
    connRef.current?.sendStart();
  }, []);

  const toggleReady = useCallback(() => {
    connRef.current?.sendReady(!myReady);
  }, [myReady]);

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

  /** Board 统一的动作通道：幂等键/版本号由 GameRoomConnection 收口。 */
  const sendBoardAction = useCallback(async (action: string, payload?: unknown) => {
    if (connRef.current === null) throw new Error("连接已关闭");
    await connRef.current.sendAction(action, payload, versionRef.current);
  }, []);

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

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
    if (view === null || role !== "spectator") return null;
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--survey-primary)]"
      >
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          观战模式 · 你可以实时看这一局，但不能参与操作
          {online !== null && online.spectators > 1 ? `（当前 ${online.spectators} 人观战）` : ""}
        </span>
      </div>
    );
  };

  /** 对手掉线提示：presence 显示对局中在线玩家不足两人时亮起。 */
  const renderOfflineBanner = () => {
    const opponentOffline = opponentLikelyOffline(view?.status ?? null, online?.players ?? null);
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

  const renderRoom = () => {
    if (roomId === null) return null;
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
    if (view.status === "closed") {
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
    const lobbyMinPlayers = findGameType(types, view.gameType)?.minPlayers ?? null;
    const BoardPanel = resolveGameBoard(view.gameType);
    return (
      <div className="space-y-4">
        {renderRoomHeader()}
        {renderConnectionBanner()}
        {renderSpectatorBadge()}
        {renderOfflineBanner()}
        {view.status === "lobby" ? (
          <GameLobbyRoomPanel
            players={players}
            status={view.status}
            role={role}
            amHost={amHost}
            isPlayer={role === "player" && mePlayer !== null}
            myReady={myReady}
            minPlayers={lobbyMinPlayers}
            onToggleReady={toggleReady}
            onStart={startGame}
          />
        ) : null}
        {BoardPanel !== null ? (
          <BoardPanel
            view={view}
            role={role}
            connection={connection}
            online={online}
            remainingNow={syncedRemaining.ms === null ? null : syncedRemaining.ms - (clockMs - syncedRemaining.at)}
            sendAction={sendBoardAction}
            onExitRoom={exitRoom}
          />
        ) : (
          <UnknownGameBoard gameType={view.gameType} />
        )}
      </div>
    );
  };

  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        helpKey="game"
        title={`${selectedGame?.displayName ?? "五子棋"} · 联机对战`}
        subtitle={selectedGame?.description || "创建房间或输入房间码，与好友实时对弈"}
        titleIcon={<Swords className="h-4 w-4" />}
        backHref="/trial"
        backLabel="小游戏"
        wide={false}
        actions={<ThemeAction themeState={themeState} />}
      />
      <main className="mx-auto max-w-xl space-y-4 px-5 py-5">
        {roomId === null ? (
          <GameLobbyEntry
            gameTypes={types}
            selectedType={effectiveType}
            onSelectType={setSelectedType}
            busy={busy}
            error={error}
            joinInput={joinInput}
            onJoinInputChange={setJoinInput}
            onJoinSubmit={() => void handleJoinInput()}
            onCreate={() => void handleCreate()}
            onDismissError={() => setError(null)}
          />
        ) : (
          renderRoom()
        )}
      </main>
    </ScreenShell>
  );
}
