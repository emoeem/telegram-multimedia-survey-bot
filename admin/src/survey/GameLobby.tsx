import type { ReactNode } from "react";
import { Link2, Swords, Users } from "lucide-react";
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

export interface GameLobbyEntryProps {
  /** 已注册玩法列表（GET /api/game/types，失败时调用方回退静态列表）。 */
  gameTypes: GameTypeInfo[];
  /** 本次要创建的玩法（?type= 参数或列表首个）。 */
  selectedType: string;
  onSelectType: (name: string) => void;
  busy: boolean;
  error: string | null;
  joinInput: string;
  onJoinInputChange: (value: string) => void;
  onJoinSubmit: () => void;
  onCreate: () => void;
  onDismissError: () => void;
  /**
   * 玩法级创建配置面板插槽（可选）：屏层按所选玩法传入（如狼人杀的时限/
   * 板子预设），渲染在创建按钮之前。本层不解释插槽内容——大厅保持
   * gameType 无关，玩法私有配置由各玩法屏层提供。
   */
  configPanel?: ReactNode;
}

/** 无房间入口。多玩法时创建卡列出可选玩法；单玩法（现状）与旧版完全一致。 */
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
}: GameLobbyEntryProps) {
  const selected = gameTypes.find((game) => game.name === selectedType) ?? gameTypes[0] ?? null;
  return (
    <div className="space-y-4">
      <section className="survey-card p-4">
        <SectionHeader icon={Swords} title={`${selected?.displayName ?? "联机对战"} · 联机对战`} />
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--survey-muted)]">
          创建一个房间把房间码发给好友，或输入对方的房间码加入同一局。
          {selected?.description ? selected.description : ""}
        </p>
      </section>
      <section className="survey-card p-4">
        <SectionHeader icon={Users} title="创建房间" />
        <p className="mt-1.5 text-[12px] text-[var(--survey-muted)]">创建后你会拿到一个房间码，发给好友即可加入。</p>
        {gameTypes.length > 1 ? (
          <div className="mt-3 space-y-2" role="radiogroup" aria-label="选择玩法">
            {gameTypes.map((game) => {
              const active = game.name === selectedType;
              return (
                <button
                  key={game.name}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSelectType(game.name)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition ${
                    active
                      ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                      : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">
                      {game.displayName}
                    </span>
                    {game.description ? (
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--survey-muted)]">
                        {game.description}
                      </span>
                    ) : null}
                  </span>
                  {active ? (
                    <span className="shrink-0 rounded-full bg-[var(--survey-primary)] px-2 py-0.5 text-[10px] font-bold text-[var(--survey-primary-content)]">
                      已选
                    </span>
                  ) : null}
                </button>
              );
            })}
            {configPanel}
            <button
              type="button"
              className="btn btn-primary w-full disabled:opacity-50"
              disabled={busy}
              onClick={onCreate}
            >
              {busy ? "正在创建…" : `创建${selected?.displayName ?? ""}房间`}
            </button>
          </div>
        ) : (
          <>
            {configPanel}
            <button
              type="button"
              className="btn btn-primary mt-3 w-full disabled:opacity-50"
              disabled={busy}
              onClick={onCreate}
            >
              {busy ? "正在创建…" : "创建房间"}
            </button>
          </>
        )}
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
              key={player.participantHash}
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
