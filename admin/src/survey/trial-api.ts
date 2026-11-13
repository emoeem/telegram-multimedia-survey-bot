import { identityHeaders, type UnlockedAchievement } from "./api";
import type { GameRunView } from "../../../src/game-plugin/types";

export type TrialPersona = "male" | "female";
export type TrialMode = "normal" | "hell";
export type TrialRunStatus = "active" | "completed" | "abandoned";
export type TrialPhase = "shop" | "playing";
export type TrialGrade = "S" | "A" | "B" | "C";

export interface TrialInventory {
  skipTickets: number;
  boosters: number;
  shields: number;
}

export const TRIAL_SHOP_CONFIG = {
  normalCoins: [60, 110] as const,
  hellCoins: [90, 150] as const,
  items: [
    { kind: "skipTicket", label: "🎫 跳过券", description: "跳过当前层任务，不拿积分直接上楼", price: 45, cap: 3 },
    { kind: "booster", label: "⚡ 加倍券", description: "本层任务完成时积分 ×2", price: 35, cap: 3 },
    { kind: "shield", label: "🛡 护盾", description: "放弃时以当前成绩提前通关（不记为放弃）", price: 60, cap: 1 },
  ] as const,
} as const;

export interface TrialShopSelection {
  skipTickets: number;
  boosters: number;
  shields: number;
}

export interface TrialShopEconomy {
  normalCoins: readonly [number, number];
  hellCoins: readonly [number, number];
  rerollCap: number;
  prices: { skipTicket: number; booster: number; shield: number };
  caps: { skipTicket: number; booster: number; shield: number };
}

export interface TrialGameType {
  id: string;
  label: string;
  description: string;
}

export interface TrialPack {
  id: number;
  name: string;
  description: string | null;
  /** 玩法类型（engine-registry 注册表），客户端按它分组展示。 */
  gameType: string;
  gameLabel: string;
  normalFloors: number;
  hellFloors: number;
  /** Preparation checklist the player should gather before floor 1. */
  prepItems: string[];
  prepText: string | null;
}

export interface TrialTask {
  id: number;
  title: string;
  description: string;
  warning: string;
  score: number;
}

export interface TrialGradeCopy {
  title: string;
  text: string;
}

export interface TrialRun {
  id: number;
  packId: number;
  packName: string;
  persona: TrialPersona;
  mode: TrialMode;
  currentFloor: number;
  maxFloor: number;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  status: TrialRunStatus;
  phase: TrialPhase;
  coins: number;
  inventory: TrialInventory;
  boosted: boolean;
  coinRerolls?: number;
  startingFloor?: number;
  // 插件玩法局的摘要字段：服务端 pluginRunSummary 只给这些、不给
  // phase/coins/inventory（爬塔字段在此场景下是 undefined，别拿来比较）。
  plugin?: string;
  pluginTitle?: string;
  step?: number;
  total?: number;
}

export interface TrialHistoryItem extends TrialRun {
  startedAt: string;
  finishedAt: string | null;
  grade: TrialGrade | null;
  // plugin 字段直接继承 TrialRun：服务端（trial-api.ts 的 pluginFields 展开处）
  // 只在 truthy 时才带 plugin 键，历史条目运行时是 string | undefined，
  // 再声明 `plugin?: string | null` 会与父接口的 `plugin?: string` 冲突（TS2430）。
}

export interface TrialLeaderboardEntry {
  runId: number;
  displayName: string;
  score: number;
  floors: number;
  completedTasks: number;
  finishedAt: string;
  mine: boolean;
}

interface TrialStartRequest {
  packId: number;
  persona: TrialPersona;
  mode: TrialMode;
  startingFloor: number;
}

interface TrialActionResponse {
  run: TrialRun;
  task: TrialTask | null;
  earned: number;
  grade: TrialGrade | null;
  gradeCopy: TrialGradeCopy | null;
  /** 通关这一局时新解锁的徽章。 */
  newAchievements?: UnlockedAchievement[];
}

async function trialRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...identityHeaders(),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(typeof body.message === "string" ? body.message : "请求失败") as Error & {
      code?: string;
      status?: number;
    };
    error.code = typeof body.code === "string" ? body.code : "unknown";
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export function fetchTrialPacks(): Promise<{
  packs: TrialPack[];
  gameTypes?: TrialGameType[];
  submissionBotUrl: string | null;
  shop?: TrialShopEconomy;
}> {
  return trialRequest("/api/trial/packs");
}

export interface TrialMe {
  telegram: boolean;
  isAdmin: boolean;
}

export function fetchTrialMe(): Promise<TrialMe> {
  return trialRequest("/api/trial/me");
}

export function fetchTrialActiveRun(): Promise<{
  run: TrialRun | null;
  task: TrialTask | null;
  /** 插件玩法局才有：服务端算好的当帧视图；爬塔局没有此字段。 */
  view?: GameRunView | null;
  packMissing?: boolean;
  packEnabled?: boolean;
}> {
  return trialRequest("/api/trial/runs/active");
}

export function fetchTrialHistory(): Promise<{ runs: TrialHistoryItem[] }> {
  return trialRequest("/api/trial/history");
}

export function fetchTrialLeaderboard(packId: number, mode: TrialMode): Promise<{ entries: TrialLeaderboardEntry[] }> {
  return trialRequest(`/api/trial/leaderboard?packId=${packId}&mode=${mode}`);
}

export interface TrialGameTypeLeaderboardEntry extends TrialLeaderboardEntry {
  /** 成绩所属的任务包（玩法总榜合并了该玩法的全部包），前端据此映射包名。 */
  packId: number;
}

/** 玩法总榜：按 (gameType, mode) 分榜聚合该玩法全部任务包，每人单局最优。 */
export function fetchTrialGameTypeLeaderboard(
  gameType: string,
  mode: TrialMode,
): Promise<{ entries: TrialGameTypeLeaderboardEntry[] }> {
  return trialRequest(`/api/trial/leaderboard?gameType=${encodeURIComponent(gameType)}&mode=${mode}`);
}

export function startTrialRun(input: TrialStartRequest): Promise<{
  run: TrialRun;
  task: TrialTask | null;
  /** 插件玩法局才有：开局首帧视图；爬塔局没有此字段。 */
  view?: GameRunView | null;
}> {
  return trialRequest("/api/trial/runs", { method: "POST", body: JSON.stringify(input) });
}

export function confirmTrialShop(
  runId: number,
  selection: TrialShopSelection,
): Promise<{ run: TrialRun; task: TrialTask; spent: number }> {
  return trialRequest(`/api/trial/runs/${runId}/shop`, { method: "POST", body: JSON.stringify(selection) });
}

export function rerollTrialCoins(runId: number): Promise<{ run: TrialRun; task: null; coins: number }> {
  return trialRequest(`/api/trial/runs/${runId}/shop`, { method: "POST", body: JSON.stringify({ reroll: true }) });
}

export function sendTrialAction(
  runId: number,
  action: "complete" | "skip" | "abandon" | "boost" | "shield_exit",
): Promise<TrialActionResponse> {
  return trialRequest(`/api/trial/runs/${runId}/action`, { method: "POST", body: JSON.stringify({ action }) });
}
