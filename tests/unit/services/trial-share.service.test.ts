import { describe, expect, it } from "vitest";
import { buildTrialShare } from "../../../src/services/trial-share.service";

describe("trial share service", () => {
  it("builds an anonymous share post with the real grade", () => {
    const { content, payload } = buildTrialShare({
      runId: 7,
      packId: 1,
      packName: "示例 · 楼道挑战",
      persona: "female",
      mode: "normal",
      startingFloor: 1,
      maxFloor: 10,
      score: 18,
      completedTasks: 8,
      skippedTasks: 1,
      maxScore: 50,
    });
    expect(payload.grade).toBe("C");
    expect(payload.score).toBe(18);
    expect(payload.floors).toBe(10);
    expect(content).toContain("🎯 挑战结局 · C 级");
    expect(content).toContain("示例 · 楼道挑战");
    expect(content).toContain("母");
  });

  it("grades a near-perfect run as S", () => {
    const { payload } = buildTrialShare({
      runId: 8,
      packId: 1,
      packName: "示例 · 楼道挑战",
      persona: "male",
      mode: "hell",
      startingFloor: 1,
      maxFloor: 12,
      score: 95,
      completedTasks: 11,
      skippedTasks: 0,
      maxScore: 100,
    });
    expect(payload.grade).toBe("S");
  });
});
