import { identityHeaders } from "./api";

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

export interface TrialPack {
  id: number;
  name: string;
  description: string | null;
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
  startingFloor?: number;
}

export interface TrialHistoryItem extends TrialRun {
  startedAt: string;
  finishedAt: string | null;
  grade: TrialGrade | null;
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

export function fetchTrialPacks(): Promise<{ packs: TrialPack[]; submissionBotUrl: string | null }> {
  return trialRequest("/api/trial/packs");
}

export interface TrialMe {
  telegram: boolean;
  isAdmin: boolean;
}

export function fetchTrialMe(): Promise<TrialMe> {
  return trialRequest("/api/trial/me");
}

export function fetchTrialActiveRun(): Promise<{ run: TrialRun | null; task: TrialTask | null }> {
  return trialRequest("/api/trial/runs/active");
}

export function fetchTrialHistory(): Promise<{ runs: TrialHistoryItem[] }> {
  return trialRequest("/api/trial/history");
}

export function fetchTrialLeaderboard(packId: number, mode: TrialMode): Promise<{ entries: TrialLeaderboardEntry[] }> {
  return trialRequest(`/api/trial/leaderboard?packId=${packId}&mode=${mode}`);
}

export function startTrialRun(input: TrialStartRequest): Promise<{ run: TrialRun; task: TrialTask }> {
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
