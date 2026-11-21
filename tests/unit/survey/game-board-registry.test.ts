import { describe, expect, it, vi } from "vitest";

import {
  clearGameBoardsForTest,
  registerGameBoard,
  resolveGameBoard,
  type GameBoardProps,
} from "../../../admin/src/survey/game-board-registry";

/**
 * Board 注册表单测（Lobby/Board 分层批次）。
 *
 * 注册表文件是纯逻辑（无 JSX、无组件 import），node 环境直接测：注册/覆盖/
 * 解析/清空，以及「未知 gameType 返回 null」（屏层据此渲染「该游戏客户端
 * 即将上线」兜底）。真实 Board 组件的注册副作用在 game-boards.tsx，属静态
 * 接线，由 multiplayer-game-entry.test.ts 的源码守护覆盖。
 */

function stubBoard(name: string) {
  const component = vi.fn(() => null) as unknown as (props: GameBoardProps) => null;
  Object.defineProperty(component, "name", { value: name });
  return component;
}

describe("Board 注册表（registerGameBoard / resolveGameBoard）", () => {
  it("注册后按 gameType 解析到同一组件", () => {
    clearGameBoardsForTest();
    const board = stubBoard("StubBoard");
    registerGameBoard("gomoku", board);
    expect(resolveGameBoard("gomoku")).toBe(board);
  });

  it("重复注册以最后一次为准（测试桩需要可覆盖）", () => {
    clearGameBoardsForTest();
    const first = stubBoard("First");
    const second = stubBoard("Second");
    registerGameBoard("gomoku", first);
    registerGameBoard("gomoku", second);
    expect(resolveGameBoard("gomoku")).toBe(second);
    expect(resolveGameBoard("gomoku")).not.toBe(first);
  });

  it("未注册/清空后返回 null——屏层渲染「该游戏客户端即将上线」兜底", () => {
    clearGameBoardsForTest();
    registerGameBoard("gomoku", stubBoard("StubBoard"));
    expect(resolveGameBoard("chess")).toBeNull();
    clearGameBoardsForTest();
    expect(resolveGameBoard("gomoku")).toBeNull();
  });
});
