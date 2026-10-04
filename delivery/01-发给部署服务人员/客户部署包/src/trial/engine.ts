/**
 * Trial engine: the pure game mechanics for the web task system.
 * Content (task copy) lives in the DB; everything here is deterministic,
 * side-effect free and unit tested.
 *
 * P2 shop model: every run starts in the "shop" phase with a rolled coin
 * budget. Coins buy floor items (skip tickets, score boosters, an abandon
 * shield); the shop phase ends when the player confirms a purchase, which
 * draws the first floor task.
 */

export type TrialPersona = "male" | "female";
export type TrialMode = "normal" | "hell";
export type TrialPhase = "shop" | "playing";
export type TrialAction = "complete" | "skip" | "abandon" | "boost" | "shield_exit";
export type TrialItemKind = "skipTicket" | "booster" | "shield";

export interface TrialTaskItem {
  id: number;
  title: string;
  description: string;
  /** Optional player-facing pop-up warning shown before the task. */
  warning?: string;
  score: number;
  persona: string;
  mode: string;
  minFloor: number;
  maxFloor: number;
}

export interface TrialInventory {
  /** Skip one floor task without earning points, then climb. */
  skipTickets: number;
  /** Double the score earned by completing the current floor task. */
  boosters: number;
  /** Abandon protection: end the run as "completed" with current score. */
  shields: number;
}

export interface TrialRunState {
  phase: TrialPhase;
  /** Unspent starting coins (only meaningful while phase === "shop"). */
  coins: number;
  inventory: TrialInventory;
  /** True when the current floor task is boosted (completion pays x2). */
  boosted: boolean;
  /** Task ids already served in this run (avoid immediate repeats). */
  usedTaskIds: number[];
  /** Sum of the highest possible scores, fixed at run start for grading. */
  maxScore: number;
  /** Currently served task id (null only in the shop phase). */
  currentTaskId: number | null;
}

export interface TrialRun {
  id: number;
  packId: number;
  persona: TrialPersona;
  mode: TrialMode;
  startingFloor: number;
  currentFloor: number;
  maxFloor: number;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  status: "active" | "completed" | "abandoned";
  state: TrialRunState;
}

export const TRIAL_SHOP = {
  /** Starting coin ranges by mode: [min, max] inclusive. */
  normalCoins: [60, 110] as const,
  hellCoins: [90, 150] as const,
  prices: {
    skipTicket: 45,
    booster: 35,
    shield: 60,
  },
  caps: {
    skipTicket: 3,
    booster: 3,
    shield: 1,
  },
} as const;

export function normalizeTrialPersona(value: unknown): TrialPersona | null {
  return value === "male" || value === "female" ? value : null;
}

export function normalizeTrialMode(value: unknown): TrialMode | null {
  return value === "normal" || value === "hell" ? value : null;
}

export function rollStartCoins(mode: TrialMode, random: () => number = Math.random): number {
  const [min, max] = mode === "hell" ? TRIAL_SHOP.hellCoins : TRIAL_SHOP.normalCoins;
  return min + Math.floor(Math.max(0, Math.min(1, random())) * (max - min + 1));
}

export function emptyInventory(): TrialInventory {
  return { skipTickets: 0, boosters: 0, shields: 0 };
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

export function normalizeInventory(value: unknown): TrialInventory {
  const raw = (value ?? {}) as Record<string, unknown>;
  const clampToCap = (kind: TrialItemKind, parsed: number) => Math.min(TRIAL_SHOP.caps[kind], parsed);
  return {
    skipTickets: clampToCap("skipTicket", clampNonNegativeInt(raw.skipTickets, 0)),
    boosters: clampToCap("booster", clampNonNegativeInt(raw.boosters, 0)),
    shields: clampToCap("shield", clampNonNegativeInt(raw.shields, 0)),
  };
}

export function normalizeState(raw: unknown): TrialRunState {
  const state = (raw ?? {}) as Record<string, unknown>;
  const usedTaskIds = Array.isArray(state.usedTaskIds)
    ? state.usedTaskIds.filter((id): id is number => Number.isInteger(id))
    : [];
  const maxScore = Number(state.maxScore);
  return {
    phase: state.phase === "playing" ? "playing" : "shop",
    coins: clampNonNegativeInt(state.coins, 0),
    inventory: normalizeInventory(state.inventory),
    boosted: state.boosted === true,
    usedTaskIds,
    maxScore: Number.isFinite(maxScore) && maxScore > 0 ? maxScore : 1,
    currentTaskId:
      state.currentTaskId !== undefined && state.currentTaskId !== null ? Number(state.currentTaskId) : null,
  };
}

export function itemPrice(kind: TrialItemKind): number {
  return TRIAL_SHOP.prices[kind];
}

export function itemCap(kind: TrialItemKind): number {
  return TRIAL_SHOP.caps[kind];
}

export interface ShopSelection {
  skipTickets?: number;
  boosters?: number;
  shields?: number;
}

function selectionQuantity(kind: TrialItemKind, selection: ShopSelection): number {
  const raw =
    kind === "skipTicket" ? selection.skipTickets : kind === "booster" ? selection.boosters : selection.shields;
  const num = Number(raw ?? 0);
  return Number.isInteger(num) && num >= 0 ? num : 0;
}

export function shopCost(selection: ShopSelection): number {
  return (
    selectionQuantity("skipTicket", selection) * itemPrice("skipTicket") +
    selectionQuantity("booster", selection) * itemPrice("booster") +
    selectionQuantity("shield", selection) * itemPrice("shield")
  );
}

export function validateShopSelection(selection: ShopSelection): { ok: true } | { ok: false; reason: string } {
  for (const kind of ["skipTicket", "booster", "shield"] as const) {
    const quantity = selectionQuantity(kind, selection);
    if (quantity > itemCap(kind)) {
      return { ok: false, reason: `${kind} 超过单局上限` };
    }
  }
  return { ok: true };
}

/** Creates the shop-phase state for a new run (no first task yet). */
export function createShopState(
  items: TrialTaskItem[],
  persona: TrialPersona,
  mode: TrialMode,
  fromFloor: number,
  toFloor: number,
  coins: number,
): TrialRunState {
  return {
    phase: "shop",
    coins,
    inventory: emptyInventory(),
    boosted: false,
    usedTaskIds: [],
    maxScore: computeMaxScore(items, persona, mode, fromFloor, toFloor),
    currentTaskId: null,
  };
}

/** Tasks eligible for a given floor/persona/mode. */
export function eligibleTasks(
  items: TrialTaskItem[],
  persona: TrialPersona,
  mode: TrialMode,
  floor: number,
): TrialTaskItem[] {
  return items.filter(
    (item) =>
      (item.persona === "any" || item.persona === persona) &&
      (item.mode === "any" || item.mode === mode) &&
      floor >= item.minFloor &&
      floor <= item.maxFloor,
  );
}

/** Upper bound for grading: sum of the best available score per floor. */
export function computeMaxScore(
  items: TrialTaskItem[],
  persona: TrialPersona,
  mode: TrialMode,
  fromFloor: number,
  toFloor: number,
): number {
  let total = 0;
  for (let floor = fromFloor; floor <= toFloor; floor += 1) {
    const best = eligibleTasks(items, persona, mode, floor).reduce((max, item) => Math.max(max, item.score), 0);
    total += best;
  }
  return Math.max(total, 1);
}

/** Picks the next task: prefer unused, otherwise reuse (excluding current). */
export function pickNextTask(items: TrialTaskItem[], run: TrialRun): TrialTaskItem | null {
  const eligible = eligibleTasks(items, run.persona, run.mode, run.currentFloor);
  if (eligible.length === 0) return null;
  const unused = eligible.filter(
    (item) => !run.state.usedTaskIds.includes(item.id) && item.id !== run.state.currentTaskId,
  );
  const pool = unused.length > 0 ? unused : eligible.filter((item) => item.id !== run.state.currentTaskId);
  const candidates = pool.length > 0 ? pool : eligible;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

export interface TrialActionResult {
  run: TrialRun;
  /** The current/newly drawn task for an active run (null when settled). */
  nextTask: TrialTaskItem | null;
  /** Points earned by this action (complete only). */
  earned: number;
}

function withState(
  run: TrialRun,
  patch: Omit<Partial<TrialRun>, "state"> & { state?: Partial<TrialRunState> },
): TrialRun {
  return { ...run, ...patch, state: { ...run.state, ...(patch.state ?? {}) } };
}

function advance(items: TrialTaskItem[], run: TrialRun): TrialActionResult {
  const nextFloor = run.currentFloor + 1;
  if (nextFloor > run.maxFloor) {
    return { run: withState(run, { status: "completed", state: { boosted: false } }), nextTask: null, earned: 0 };
  }
  const moved = withState(run, { currentFloor: nextFloor, state: { boosted: false } });
  const nextTask = pickNextTask(items, moved);
  const usedTaskIds = nextTask ? [...moved.state.usedTaskIds.slice(-59), nextTask.id] : moved.state.usedTaskIds;
  return {
    run: withState(moved, { state: { currentTaskId: nextTask?.id ?? null, usedTaskIds } }),
    nextTask,
    earned: 0,
  };
}

/**
 * Applies a playing action to a run and draws the next task.
 * boost/shield_exit act on the current floor without climbing.
 */
export function applyTrialAction(items: TrialTaskItem[], run: TrialRun, action: TrialAction): TrialActionResult {
  if (run.status !== "active") return { run, nextTask: null, earned: 0 };

  if (action === "abandon") {
    return { run: withState(run, { status: "abandoned" }), nextTask: null, earned: 0 };
  }

  if (action === "shield_exit") {
    if (run.state.inventory.shields <= 0) return { run, nextTask: null, earned: 0 };
    return {
      run: withState(run, {
        status: "completed",
        state: {
          inventory: { ...run.state.inventory, shields: run.state.inventory.shields - 1 },
          boosted: false,
        },
      }),
      nextTask: null,
      earned: 0,
    };
  }

  if (action === "boost") {
    if (run.state.inventory.boosters <= 0 || run.state.boosted || run.state.currentTaskId === null) {
      return { run, nextTask: null, earned: 0 };
    }
    return {
      run: withState(run, {
        state: {
          inventory: { ...run.state.inventory, boosters: run.state.inventory.boosters - 1 },
          boosted: true,
        },
      }),
      nextTask: null,
      earned: 0,
    };
  }

  if (action === "skip") {
    if (run.state.inventory.skipTickets <= 0) return { run, nextTask: null, earned: 0 };
    const skipped = withState(run, {
      skippedTasks: run.skippedTasks + 1,
      state: {
        inventory: { ...run.state.inventory, skipTickets: run.state.inventory.skipTickets - 1 },
      },
    });
    return advance(items, skipped);
  }

  const current = items.find((item) => item.id === run.state.currentTaskId);
  const earned = run.state.boosted && current ? current.score * 2 : (current?.score ?? 0);
  const completed = withState(run, {
    score: run.score + earned,
    completedTasks: run.completedTasks + 1,
    state: { boosted: false },
  });
  const advanced = advance(items, completed);
  return { ...advanced, earned };
}

export type TrialGrade = "S" | "A" | "B" | "C";

export function trialGrade(run: TrialRun): TrialGrade {
  if (run.status !== "completed") return "C";
  const ratio = run.score / Math.max(1, run.state.maxScore);
  if (ratio >= 0.9) return "S";
  if (ratio >= 0.7) return "A";
  if (ratio >= 0.5) return "B";
  return "C";
}

export const TRIAL_GRADE_COPY: Record<TrialGrade, { title: string; text: string }> = {
  S: { title: "完美臣服", text: "每一层都走满了。你把整栋楼都刻进了身体里。" },
  A: { title: "优雅上行", text: "几乎没有迟疑。偶尔的停顿也算风景。" },
  B: { title: "喘息着抵达", text: "中途想过放弃，但还是站到了顶层。" },
  C: { title: "初次挑战", text: "楼还在，下一局再来。" },
};
