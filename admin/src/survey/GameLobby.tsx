import { useState, type ReactNode } from "react";
import { Link2, RefreshCw, Swords, Users } from "lucide-react";
import { SectionHeader } from "./PublicPrimitives";
import {
  activeRoomPlayers,
  allRoomPlayersReady,
  canStartMatch,
  lobbyPlayersHint,
  playerRowLabel,
  playerRowState,
  type GameTypeInfo,
  type RoomPlayerRow,
} from "./game-lobby-logic";

/**
 * 多人对局「大厅层」（批次：Lobby/Board 分层）。
 *
 * 分层纪律：本文件 **完全 gameType 无关**——创建/加入/玩家列表/准备/开局/
 * 观战提示，全部只消费房间信封（players/status/role）与玩法元数据
 * （GameTypeInfo），绝不 import 任何具体玩法的解析或组件。玩法私有渲染
 * （棋盘/牌桌/结算细节）走 Board 注册表（game-board-registry.ts），由
 * MultiplayerGameScreen 分发。
 */

// ---------------------------------------------------------------------------
// 无房间时的入口：玩法简介 + 创建 + 加入
// ---------------------------------------------------------------------------

export interface GameRoomListEntry {
  id: number;
  createdAt: string;
  isMine: boolean;
}

export interface GameLobbyEntryProps {
  /** 已注册玩法列表（GET /api/game/types，失败时调用方回退静态列表）。 */
  gameTypes: GameTypeInfo[];
  /** 本次要创建/查看的玩法（?type= 参数或列表首个）。 */
  selectedType: string;
  onSelectType: (name: string) => void;
  busy: boolean;
  error: string | null;
  joinInput: string;
  onJoinInputChange: (value: string) => void;
  onJoinSubmit: () => void;
  /** 创建房间；visibility 由本层的选择给出（公开免费 / 私人收占位积分）。 */
  onCreate: (visibility: "public" | "private") => void;
  onDismissError: () => void;
  /** 玩法级创建配置面板插槽（狼人杀的时限/板子预设），渲染在创建按钮之前。 */
  configPanel?: ReactNode;
  /** 0108 该玩法当前处于等待中的公共房间（仅 public），点「加入」直接进房。 */
  rooms: GameRoomListEntry[];
  roomsLoading: boolean;
  roomsError: string | null;
  onRefreshRooms: () => void;
  onJoinRoom: (roomId: number) => void;
}

/**
 * 无房间入口（M8 用户验收重设计）：选玩法 → 直接看该玩法等待中的公共房间，
 * 可一键加入；私人房间走创建卡（收占位积分、不进公共列表），或凭房间码加入。
 * 左区「房间列表 + 玩法切换」，右区「创建(主) + 加入(次)」；手机纵堆同序。
 */
export function GameLobbyEntry({
  gameTypes,
  selectedType,
  onSelectType,
  busy,
  error,
  joinInput,
  onJoinInputChange,
  onJoinSubmit,
  onCreate,
  onDismissError,
  configPanel,
  rooms,
  roomsLoading,
  roomsError,
  onRefreshRooms,
  onJoinRoom,
}: GameLobbyEntryProps) {
  const selected = gameTypes.find((game) => game.name === selectedType) ?? gameTypes[0] ?? null;
  const [roomVisibility, setRoomVisibility] = useState<"public" | "private">("public");
  return (
    <div className="game-lobby-grid">
      {/* 左区：该玩法等待中的公共房间 + 玩法切换 */}
      <div className="min-w-0 space-y-4">
        <section className="survey-card p-4">
          <div className="flex items-center justify-between gap-2">
            <SectionHeader icon={Swords} title="等待中的房间" />
            <button
              type="button"
              onClick={onRefreshRooms}
              disabled={roomsLoading}
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-[var(--survey-primary)] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${roomsLoading ? "animate-spin" : ""}`} aria-hidden="true" />
              刷新
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--survey-muted)]">
            {selected?.displayName ?? "联机对战"} · 房间由玩家创建，点「加入」直接进等待大厅
          </p>
          {roomsError ? (
            <p className="mt-2 text-xs text-[var(--app-danger)]">{roomsError}</p>
          ) : roomsLoading ? (
            <div className="mt-3 space-y-2">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3"
                >
                  <div className="h-3.5 w-24 rounded bg-[var(--survey-card-border)]" />
                </div>
              ))}
            </div>
          ) : rooms.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-[var(--survey-card-border)] p-4 text-center">
              <p className="text-[13px] text-[var(--survey-muted)]">还没有等待中的房间</p>
              <p className="mt-1 text-[11px] text-[var(--survey-muted)]">创建一个，把房间码发给好友就能开玩。</p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {rooms.map((room) => (
                <div
                  key={room.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-3 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">
                      房间 #{room.id}
                      {room.isMine ? (
                        <span className="ml-1.5 text-[10px] font-bold text-[var(--survey-primary)]">我的</span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                      {room.createdAt.slice(11, 16)} 创建 · 等待玩家中
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onJoinRoom(room.id)}
                    className="btn btn-sm shrink-0 disabled:opacity-50"
                  >
                    加入
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {gameTypes.length > 1 ? (
          <section className="survey-card p-4">
            <SectionHeader icon={Users} title="选择玩法" />
            <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="选择玩法">
              {gameTypes.map((game) => {
                const active = game.name === selectedType;
                return (
                  <button
                    key={game.name}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onSelectType(game.name)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                      active
                        ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                        : "border-[var(--survey-card-border)] text-[var(--survey-muted)] hover:bg-[var(--survey-primary-soft)]"
                    }`}
                  >
                    {game.displayName}
                  </button>
                );
              })}
            </div>
            {selected?.description ? (
              <p className="mt-2 text-[12px] leading-5 text-[var(--survey-muted)]">{selected.description}</p>
            ) : null}
          </section>
        ) : null}
      </div>

      {/* 右区：创建（公开/私人）+ 房间码加入 */}
      <div className="min-w-0 space-y-4">
        <section className="survey-card p-4">
          <SectionHeader icon={Users} title="创建房间" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRoomVisibility("public")}
              aria-pressed={roomVisibility === "public"}
              className={`rounded-xl border p-3 text-left transition-colors ${
                roomVisibility === "public"
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--survey-card-border)]"
              }`}
            >
              <span className="block text-[13px] font-bold text-[var(--survey-heading)]">公开房间</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">
                进入公共列表，玩家可直接加入
              </span>
            </button>
            <button
              type="button"
              onClick={() => setRoomVisibility("private")}
              aria-pressed={roomVisibility === "private"}
              className={`rounded-xl border p-3 text-left transition-colors ${
                roomVisibility === "private"
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--survey-card-border)]"
              }`}
            >
              <span className="block text-[13px] font-bold text-[var(--survey-heading)]">
                私人房间
                <span className="ml-1.5 rounded-full bg-[var(--survey-primary-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--survey-primary)]">
                  100 金币
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">
                不进公共列表，仅房间码可入 · 占位积分防滥建
              </span>
            </button>
          </div>
          {configPanel}
          <button
            type="button"
            className="btn btn-primary mt-3 w-full disabled:opacity-50"
            disabled={busy}
            onClick={() => onCreate(roomVisibility)}
          >
            {busy
              ? "正在创建…"
              : roomVisibility === "private"
                ? `创建私人${selected?.displayName ?? ""}房间（100 金币）`
                : `创建${selected?.displayName ?? ""}房间`}
          </button>
          <p className="mt-2 text-center text-[11px] text-[var(--survey-muted)]">
            私人房间不进公共列表、仅房间码可入；积分用于抑制房间滥建、降低服务器负担。
          </p>
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
              onChange={(event) => onJoinInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onJoinSubmit();
              }}
            />
            <button
              type="button"
              className="btn btn-primary shrink-0 disabled:opacity-50"
              disabled={busy}
              onClick={onJoinSubmit}
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
              onClick={onDismissError}
            >
              知道了
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 房间内 lobby 阶段：玩家列表 + 准备/开局 + 观战提示
// ---------------------------------------------------------------------------

export interface GameLobbyRoomPanelProps {
  /** 信封玩家行（含已离座行——列表要能显示「已离开房间」）。 */
  players: RoomPlayerRow[];
  status: string | null;
  role: "player" | "spectator";
  /** 我在座且是房主（决定「开局」按钮是否可见）。 */
  amHost: boolean;
  /** 我在座（玩家身份才显示准备/开局，观战只给提示）。 */
  isPlayer: boolean;
  myReady: boolean;
  /** 玩法开局人数下限（玩法元数据；未知玩法 null，服务端兜底）。 */
  minPlayers: number | null;
  onToggleReady: () => void;
  onStart: () => void;
}

/** 房间内 lobby 阶段面板。玩家行只有「序号/名字/房主/准备态」，无玩法语义。 */
export function GameLobbyRoomPanel({
  players,
  status,
  role,
  amHost,
  isPlayer,
  myReady,
  minPlayers,
  onToggleReady,
  onStart,
}: GameLobbyRoomPanelProps) {
  const active = activeRoomPlayers(players);
  const allReady = allRoomPlayersReady(active);
  const canStart = canStartMatch(active.length, allReady, minPlayers);
  return (
    <section className="survey-card space-y-3 p-4">
      <SectionHeader icon={Users} title="对局玩家" />
      <div className="space-y-2">
        {players.map((player, index) => {
          const stateText = playerRowState(player, status);
          return (
            <div
              key={player.seatToken}
              className="flex items-center gap-3 rounded-xl border border-[var(--survey-card-border)] px-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[var(--survey-heading)]">
                  {playerRowLabel(player, index)}
                </span>
                <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">{stateText}</span>
              </span>
              {player.isHost ? (
                <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--survey-primary)]">
                  房主
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--survey-muted)]">
        {lobbyPlayersHint(active.length, allReady, minPlayers)}
      </p>
      {role === "player" && isPlayer ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={onToggleReady}>
            {myReady ? "取消准备" : "准备"}
          </button>
          {amHost ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!canStart} onClick={onStart}>
              开局
            </button>
          ) : (
            <span className="grid place-items-center text-[12px] text-[var(--survey-muted)]">等待房主开局</span>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--survey-muted)]">你正在观战，对局开始后即可旁观。</p>
      )}
    </section>
  );
}
