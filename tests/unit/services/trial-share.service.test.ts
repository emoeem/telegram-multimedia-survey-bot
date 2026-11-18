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
    // 2026-11-19 通宵批次 B4：晒卡正文走「小游戏」口径，身份用男向/女向，
    // 不再出现内部术语「任务包」与养殖叫法「公/母」（会同步镜像到频道）。
    expect(content).toContain("小游戏「示例 · 楼道挑战」");
    expect(content).toContain("女向");
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
