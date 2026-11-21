/**
 * 多人玩法 Board 注册表（批次：Lobby/Board 分层）。
 *
 * 与服务端 engine-registry.ts 同款模式：小写 gameType、显式注册、查找返回
 * null。新增一款玩法 = 写一个 *BoardPanel 组件（消费 GameBoardProps）+ 在
 * game-boards.tsx 里 registerGameBoard 一行——大厅/连接/房间壳全部复用，
 * 未知 gameType 由调用方渲染「该游戏客户端即将上线」兜底。
 *
 * 本文件保持纯逻辑（无 JSX、无组件 import），注册表本身可在 vitest node
 * 环境单测；具体 Board 的注册副作用集中在 game-boards.tsx（与服务端
 * server-engines.ts 的「注册与实现分离」同构）。
 */
import type { ComponentType } from "react";
import type { GamePlayerView, GamePublicView } from "../../../src/game/multiplayer/engine-types";
import type { GameConnectionStatus } from "./game-lobby-logic";

/**
 * Board 组件统一入参：房间信封 + 通道回调。玩法私有载荷在 `view.view` 里，
 * 各 Board 自行用对应的 parse* 收敛（如 gomoku 用 parseGomokuView）——
 * 「我是谁」等玩法私有的自指信息（五子棋是 yourColor）也由 Board 从载荷
 * 自取，大厅层与房间壳不解释玩法载荷。
 */
export interface GameBoardProps {
  /** 服务端下发的当前视图信封（玩家视图或观战公开视图，按 role 区分）。 */
  view: GamePlayerView | GamePublicView;
  /** 本连接身份：player 可操作，spectator 只读。 */
  role: "player" | "spectator";
  /** WS 连接状态：非 open 时 Board 应关闭可交互面（落子按钮/棋盘点击）。 */
  connection: GameConnectionStatus;
  /** 在线人数推送（presence），null = 尚未收到首条。 */
  online: { players: number; spectators: number } | null;
  /** 本地走秒后的回合剩余毫秒（null = 无时限）。 */
  remainingNow: number | null;
  /** 发送玩法动作（走 WS，actionId/幂等/版本由 GameRoomConnection 收口）。 */
  sendAction: (action: string, payload?: unknown) => Promise<void>;
  /** 退出房间回大厅（结算后的「再开一局」等出口共用）。 */
  onExitRoom: () => void;
}

export type GameBoardComponent = ComponentType<GameBoardProps>;

const boards = new Map<string, GameBoardComponent>();

/** 注册一个 Board；重复 gameType 以最后一次为准（测试桩需要可覆盖）。 */
export function registerGameBoard(gameType: string, component: GameBoardComponent): void {
  boards.set(gameType, component);
}

/** 按 gameType 取 Board 组件；未登记返回 null（调用方渲染「即将上线」兜底）。 */
export function resolveGameBoard(gameType: string): GameBoardComponent | null {
  return boards.get(gameType) ?? null;
}

/** 仅测试用：清空注册表（vitest 各用例互不串扰）。 */
export function clearGameBoardsForTest(): void {
  boards.clear();
}
