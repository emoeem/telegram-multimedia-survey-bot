/**
 * 多人玩法引擎注册表（G1 协议骨架）。风格对齐 src/trial/engine-registry.ts
 * 与 src/game-plugin/registry.ts：小写 id、显式注册、查找返回 null。
 *
 * G1 只落协议底座，不内置任何具体玩法——五子棋在 G2、狼人杀在后续批次
 * 分别 registerGameEngine 进来。注册表为空时创建房间返回 unknown_game_type，
 * DO 与 REST 层都有可解释的兜底。
 */
import type { MultiplayerGameEngine } from "./engine-types";

const engines = new Map<string, MultiplayerGameEngine>();

/** 注册一个多人引擎；重复 gameType 以最后一次为准（测试桩需要可覆盖）。 */
export function registerGameEngine(engine: MultiplayerGameEngine): void {
  engines.set(engine.gameType, engine);
}

/** 按 gameType 取引擎；未登记返回 null（调用方决定错误码）。 */
export function resolveGameEngine(gameType: string): MultiplayerGameEngine | null {
  return engines.get(gameType) ?? null;
}

/** 已登记的 gameType 列表（列表接口/诊断用）。 */
export function listMultiplayerGameTypes(): string[] {
  return [...engines.keys()];
}

/** 已登记引擎实例列表（GET /api/game/types 的数据源；注册顺序即展示顺序）。 */
export function listGameEngines(): MultiplayerGameEngine[] {
  return [...engines.values()];
}

/** 仅测试用：清空注册表（vitest 各用例互不串扰）。 */
export function clearGameEnginesForTest(): void {
  engines.clear();
}
