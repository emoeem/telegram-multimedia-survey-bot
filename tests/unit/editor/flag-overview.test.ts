import { describe, expect, it } from "vitest";
import { collectFlagOverview } from "../../../admin/src/editor/flag-overview";

/**
 * flag/变量总览（G7c）纯收集器：产出点（flagRules + game 题自动 flag）与
 * 消费点（flagJumps）按 flag 名归组；使用点定位到规则所在题；结果规则不消费
 * flag（result-engine 上下文只有 answers），所以总览里不该出现它。
 */
function q(
  id: number,
  title: string,
  condition: Record<string, unknown> | null,
  type = "single",
): { id: number; type: string; title: string; condition: Record<string, unknown> | null } {
  return { id, type, title, condition };
}

describe("collectFlagOverview", () => {
  it("flagRules 是计分产出点、flagJumps 是跳题消费点，都定位到规则所在题", () => {
    const entries = collectFlagOverview([
      q(1, "选择题", { flagRules: [{ questionId: 1, equals: 11, flag: "勇气", score: 2 }] }),
      q(2, "跳转题", { flagJumps: [{ flag: "勇气", gte: 3, targetQuestionId: 5 }] }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.flag).toBe("勇气");
    expect(entries[0]?.usages).toHaveLength(2);
    const [scoring, jump] = entries[0]!.usages;
    expect(scoring).toMatchObject({ questionId: 1, questionTitle: "选择题", kind: "scoring" });
    expect(scoring?.detail).toContain("答案 = 11");
    expect(scoring?.detail).toContain("+2");
    expect(jump).toMatchObject({ questionId: 2, questionTitle: "跳转题", kind: "jump" });
    expect(jump?.detail).toContain("≥ 3");
    expect(jump?.detail).toContain("第 5 题");
  });

  it("game 题自动产出 game_passed_<题id>，无需创作者配置", () => {
    const entries = collectFlagOverview([q(4, "小游戏", null, "game")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.flag).toBe("game_passed_4");
    expect(entries[0]?.usages[0]).toMatchObject({ questionId: 4, kind: "game" });
  });

  it("同一 flag 多条产出累计为多个使用点；空 flag 名跳过（引擎也不产出）", () => {
    const entries = collectFlagOverview([
      q(1, "A", {
        flagRules: [
          { questionId: 1, equals: 11, flag: "好感", score: 1 },
          { questionId: 2, equals: 21, flag: "好感", score: 2 },
          { questionId: 3, equals: 31, flag: "   " },
        ],
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.flag).toBe("好感");
    expect(entries[0]?.usages).toHaveLength(2);
  });

  it("引用的来源题/目标题不存在时用「第 N 题」兜底，不抛错", () => {
    const entries = collectFlagOverview([
      q(1, "题 1", {
        flagRules: [{ questionId: 99, equals: 1, flag: "孤flag" }],
        flagJumps: [{ flag: "孤flag", gte: 1, targetQuestionId: 98 }],
      }),
    ]);
    expect(entries[0]?.usages[0]?.detail).toContain("第 99 题");
    expect(entries[0]?.usages[1]?.detail).toContain("第 98 题");
  });

  it("输出按 flag 名码元序稳定排序；空 condition / 无 flag 的问卷返回空", () => {
    const entries = collectFlagOverview([
      q(1, "A", { flagRules: [{ questionId: 1, equals: 1, flag: "b" }] }),
      q(2, "B", { flagRules: [{ questionId: 2, equals: 2, flag: "a" }] }),
      q(3, "C", null),
      q(4, "D", {}),
    ]);
    expect(entries.map((entry) => entry.flag)).toEqual(["a", "b"]);
    expect(collectFlagOverview([q(1, "空", null)])).toEqual([]);
  });
});
