/**
 * 内置多人玩法引擎注册（P0 批次 G2）——与 src/game-plugin/server-plugins.ts
 * 同一模式：新增内置玩法时**只需在这里加一行**。
 *
 * 引擎实现（engines/*.ts）保持纯函数、可被单测直接 import；是否进注册表由
 * 本文件显式决定。src/index.ts 在 Worker 启动路径上副作用导入本模块，
 * 保证 REST/DO 首个请求到达前 resolveGameEngine("gomoku") 已非空。
 */
import { registerGameEngine } from "./engine-registry";
import { gomokuEngine } from "./engines/gomoku";
import { xiangqiEngine } from "./engines/xiangqi";

/** 登记全部内置多人引擎（可重复调用；重复 gameType 以最后一次为准）。 */
export function registerBuiltinMultiplayerEngines(): void {
  registerGameEngine(gomokuEngine);
  registerGameEngine(xiangqiEngine);
}

// Worker 启动即注册：src/index.ts 的副作用 import 触发本行。
registerBuiltinMultiplayerEngines();
