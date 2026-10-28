import { describe, expect, it } from "vitest";
import {
  findDependents,
  findTargets,
  stripReferences,
  type EditableConditionQuestion,
} from "../../../admin/src/editor/dependencies";

/**
 * 编辑器依赖分析：删除题目时要能说清"谁会受影响"，并把悬空跳转一起清掉。
 * 这层是纯函数，所以能被测试钉住——UI 只负责展示。
 */
function q(
  id: number,
  condition: Record<string, unknown> | null = null,
  title = `题 ${id}`,
): EditableConditionQuestion {
  return { id, title, condition };
}

describe("findDependents", () => {
  const questions = [
    q(1, {
      rules: [
        { optionId: 11, targetQuestionId: 3 },
        { optionId: 12, targetQuestionId: 2 },
      ],
      answerRules: [{ questionId: 1, equals: 11, targetQuestionId: 3 }],
      flagJumps: [{ flag: "ok", gte: 1, targetQuestionId: 3 }],
    }),
    q(2, { skipToQuestionId: 3, optionId: 21 }),
    q(3),
  ];

  it("找出所有指向目标题的引用（选项/答案规则/flag/旧式 skipTo）", () => {
    const refs = findDependents(questions, 3);
    const kinds = refs.map((ref) => ref.kind).sort();
    expect(kinds).toEqual(["answerRule", "flagJump", "option", "skipTo"]);
    expect(refs.every((ref) => ref.fromId !== 3)).toBe(true);
    expect(refs.find((ref) => ref.kind === "option")?.detail).toContain("选项 #11");
  });

  it("没有引用时返回空数组", () => {
    expect(findDependents([q(1), q(2)], 2)).toEqual([]);
  });

  it("字符串数字也认（导入格式的 authoring id 会走 String 比较）", () => {
    const refs = findDependents([q(1, { rules: [{ optionId: "11", targetQuestionId: "3" }] }), q(3)], 3);
    expect(refs).toHaveLength(1);
  });
});

describe("findTargets", () => {
  it("列出自身指向的后继", () => {
    const targets = findTargets(
      q(1, {
        rules: [{ optionId: 11, targetQuestionId: 2 }],
        flagJumps: [{ flag: "ok", gte: 1, targetQuestionId: 4 }],
      }),
    );
    expect(targets.map((t) => t.targetId).sort()).toEqual([2, 4]);
  });

  it("无条件返回空", () => {
    expect(findTargets(q(1))).toEqual([]);
  });
});

describe("stripReferences", () => {
  const questions = [
    q(1, {
      kind: "option_equals",
      rules: [
        { optionId: 11, targetQuestionId: 3 },
        { optionId: 12, targetQuestionId: 2 },
      ],
      answerRules: [{ questionId: 1, equals: 11, targetQuestionId: 3 }],
    }),
    q(2, { skipToQuestionId: 3 }),
    q(4, { rules: [{ optionId: 41, targetQuestionId: 3 }] }),
  ];

  it("只清掉指向目标的规则，其它规则原样保留", () => {
    const patches = stripReferences(questions, 3);
    const q1 = patches.find((patch) => patch.id === 1);
    expect(q1?.condition?.rules).toEqual([{ optionId: 12, targetQuestionId: 2 }]);
    expect(q1?.condition?.answerRules).toBeUndefined();
    // kind 保留（选项跳转的语义标记）
    expect(q1?.condition?.kind).toBe("option_equals");
  });

  it("删掉最后一条规则时整份 condition 置空", () => {
    const patches = stripReferences(questions, 3);
    expect(patches.find((patch) => patch.id === 2)?.condition).toBeNull();
    expect(patches.find((patch) => patch.id === 4)?.condition).toBeNull();
  });

  it("没有引用时不产生补丁（避免无谓保存）", () => {
    expect(stripReferences([q(1), q(2)], 99)).toEqual([]);
  });
});
