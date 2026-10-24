import { describe, expect, it } from "vitest";
import {
  applyTrialAction,
  computeMaxScore,
  createShopState,
  eligibleTasks,
  emptyInventory,
  normalizeState,
  pickNextTask,
  rollStartCoins,
  shopCost,
  trialGrade,
  TRIAL_SHOP,
  validateShopSelection,
  type TrialRun,
  type TrialTaskItem,
} from "../../../src/trial/engine";

const items: TrialTaskItem[] = [
  { id: 1, title: "通用一层", description: "d", score: 3, persona: "any", mode: "any", minFloor: 1, maxFloor: 3 },
  { id: 2, title: "公向", description: "d", score: 5, persona: "male", mode: "any", minFloor: 1, maxFloor: 5 },
  { id: 3, title: "母向", description: "d", score: 5, persona: "female", mode: "any", minFloor: 2, maxFloor: 6 },
  { id: 4, title: "地狱专属", description: "d", score: 8, persona: "any", mode: "hell", minFloor: 3, maxFloor: 8 },
];

function makeRun(overrides: Partial<TrialRun> = {}): TrialRun {
  return {
    id: 1,
    packId: 1,
    persona: "male",
    mode: "normal",
    startingFloor: 1,
    currentFloor: 1,
    maxFloor: 3,
    score: 0,
    completedTasks: 0,
    skippedTasks: 0,
    status: "active",
    state: {
      phase: "playing",
      coins: 0,
      inventory: { skipTickets: 1, boosters: 0, shields: 0 },
      boosted: false,
      usedTaskIds: [1],
      maxScore: 13,
      currentTaskId: 1,
    },
    ...overrides,
  };
}

describe("trial engine", () => {
  it("filters tasks by persona, mode and floor range", () => {
    expect(eligibleTasks(items, "male", "normal", 1).map((item) => item.id)).toEqual([1, 2]);
    expect(eligibleTasks(items, "female", "hell", 4).map((item) => item.id)).toEqual([3, 4]);
    expect(eligibleTasks(items, "male", "normal", 9)).toEqual([]);
  });

  it("computes the grading ceiling as the best score per floor", () => {
    // Floor 1: best of 1(3) and 2(5) => 5; floor 2: same; floor 3: same.
    expect(computeMaxScore(items, "male", "normal", 1, 3)).toBe(15);
    expect(computeMaxScore(items, "male", "hell", 5, 5)).toBe(8);
  });

  it("prefers unused tasks and falls back to used ones", () => {
    const floor2Run = makeRun({
      currentFloor: 2,
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 1, boosters: 0, shields: 0 },
        boosted: false,
        usedTaskIds: [1, 2],
        maxScore: 13,
        currentTaskId: 2,
      },
    });
    expect(pickNextTask(items, floor2Run)?.id).toBe(1);

    const freshRun = makeRun({
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 1, boosters: 0, shields: 0 },
        boosted: false,
        usedTaskIds: [],
        maxScore: 13,
        currentTaskId: null,
      },
    });
    expect([1, 2]).toContain(pickNextTask(items, freshRun)?.id);
  });

  it("rolls starting coins inside the mode ranges", () => {
    const normal: number[] = [];
    const hell: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      normal.push(rollStartCoins("normal", () => Math.random()));
      hell.push(rollStartCoins("hell", () => Math.random()));
    }
    for (const coins of normal) {
      expect(coins).toBeGreaterThanOrEqual(TRIAL_SHOP.normalCoins[0]);
      expect(coins).toBeLessThanOrEqual(TRIAL_SHOP.normalCoins[1]);
    }
    for (const coins of hell) {
      expect(coins).toBeGreaterThanOrEqual(TRIAL_SHOP.hellCoins[0]);
      expect(coins).toBeLessThanOrEqual(TRIAL_SHOP.hellCoins[1]);
    }
    // Edge rolls hit the exact bounds.
    expect(rollStartCoins("normal", () => 0)).toBe(TRIAL_SHOP.normalCoins[0]);
    expect(rollStartCoins("hell", () => 0.999999)).toBe(TRIAL_SHOP.hellCoins[1]);
  });

  it("computes shop cost and rejects quantities above the caps", () => {
    expect(shopCost({ skipTickets: 1, boosters: 1, shields: 1 })).toBe(45 + 35 + 60);
    expect(shopCost({})).toBe(0);
    expect(validateShopSelection({ skipTickets: 3, boosters: 2, shields: 1 }).ok).toBe(true);
    expect(validateShopSelection({ skipTickets: 4 }).ok).toBe(false);
  });

  it("starts runs in the shop phase with no served task", () => {
    const state = createShopState(items, "male", "normal", 1, 3, 88);
    expect(state.phase).toBe("shop");
    expect(state.coins).toBe(88);
    expect(state.inventory).toEqual(emptyInventory());
    expect(state.currentTaskId).toBeNull();
    expect(state.maxScore).toBe(15);
    expect(normalizeState({ phase: "playing", coins: 50, maxScore: 99 })).toMatchObject({
      phase: "playing",
      coins: 50,
      maxScore: 99,
      inventory: { skipTickets: 0, boosters: 0, shields: 0 },
    });
  });

  it("completing awards the task score and climbs one floor", () => {
    const run = makeRun();
    const result = applyTrialAction(items, run, "complete");
    expect(result.earned).toBe(3);
    expect(result.run.score).toBe(3);
    expect(result.run.completedTasks).toBe(1);
    expect(result.run.currentFloor).toBe(2);
    expect(result.run.status).toBe("active");
    expect(result.nextTask?.id).toBe(2);
  });

  it("boost doubles the completed floor score and is consumed", () => {
    const run = makeRun({
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 0, boosters: 1, shields: 0 },
        boosted: false,
        usedTaskIds: [1],
        maxScore: 13,
        currentTaskId: 1,
      },
    });
    const boosted = applyTrialAction(items, run, "boost");
    expect(boosted.run.state.boosted).toBe(true);
    expect(boosted.run.state.inventory.boosters).toBe(0);
    expect(boosted.run.status).toBe("active");

    const completed = applyTrialAction(items, boosted.run, "complete");
    expect(completed.earned).toBe(6);
    expect(completed.run.score).toBe(6);
    expect(completed.run.state.boosted).toBe(false);
    expect(completed.run.currentFloor).toBe(2);
  });

  it("skip consumes a ticket without points but still climbs", () => {
    const run = makeRun({
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 1, boosters: 0, shields: 0 },
        boosted: false,
        usedTaskIds: [1],
        maxScore: 13,
        currentTaskId: 1,
      },
    });
    const result = applyTrialAction(items, run, "skip");
    expect(result.run.skippedTasks).toBe(1);
    expect(result.run.score).toBe(0);
    expect(result.run.state.inventory.skipTickets).toBe(0);
    expect(result.run.currentFloor).toBe(2);
    expect(result.nextTask?.id).toBe(2);
  });

  it("skip is ignored without a ticket", () => {
    const run = makeRun({
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 0, boosters: 0, shields: 0 },
        boosted: false,
        usedTaskIds: [1],
        maxScore: 13,
        currentTaskId: 1,
      },
    });
    const result = applyTrialAction(items, run, "skip");
    expect(result.run.status).toBe("active");
    expect(result.run.currentFloor).toBe(1);
    expect(result.run.skippedTasks).toBe(0);
    expect(result.nextTask).toBeNull();
  });

  it("shield exit settles the run as completed and consumes the shield", () => {
    const run = makeRun({
      score: 8,
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 0, boosters: 0, shields: 1 },
        boosted: false,
        usedTaskIds: [1],
        maxScore: 13,
        currentTaskId: 1,
      },
    });
    const result = applyTrialAction(items, run, "shield_exit");
    expect(result.run.status).toBe("completed");
    expect(result.run.state.inventory.shields).toBe(0);
    expect(result.run.score).toBe(8);
    expect(result.nextTask).toBeNull();
  });

  it("abandon settles the run as abandoned", () => {
    const run = makeRun();
    const result = applyTrialAction(items, run, "abandon");
    expect(result.run.status).toBe("abandoned");
    expect(result.nextTask).toBeNull();
  });

  it("finishing the top floor completes the run", () => {
    const run = makeRun({
      currentFloor: 3,
      maxFloor: 3,
      score: 10,
      state: {
        phase: "playing",
        coins: 0,
        inventory: { skipTickets: 0, boosters: 0, shields: 0 },
        boosted: false,
        usedTaskIds: [1, 2],
        maxScore: 13,
        currentTaskId: 2,
      },
    });
    const result = applyTrialAction(items, run, "complete");
    expect(result.earned).toBe(5);
    expect(result.run.status).toBe("completed");
    expect(result.nextTask).toBeNull();
  });

  it("grades by completed score ratio and rejects non-completed runs", () => {
    expect(trialGrade(makeRun({ score: 13, status: "completed" }))).toBe("S");
    expect(trialGrade(makeRun({ score: 10, status: "completed" }))).toBe("A");
    expect(trialGrade(makeRun({ score: 7, status: "completed" }))).toBe("B");
    expect(trialGrade(makeRun({ score: 3, status: "completed" }))).toBe("C");
    expect(trialGrade(makeRun({ status: "abandoned" }))).toBe("C");
  });
});
