import { describe, expect, it } from "vitest";
import {
  deletionConfirmMessage,
  planQuestionDeletion,
  type DeleteCascadePlan,
} from "../../../admin/src/editor/delete-with-cascade";
import type { EditableConditionQuestion } from "../../../admin/src/editor/dependencies";

/**
 * 删除题目的级联计划（旧壳与新壳共用）：影响面要列全（选项跳转 / 答案规则 /
 * flag 跳转 / 旧式 skipTo），清引用补丁只包含确实要改的题，确认文案要能截断。
 */
function q(id: number, condition: Record<string, unknown> | null, title = `题 ${id}`): EditableConditionQuestion {
  return { id, title, condition };
}

describe("planQuestionDeletion", () => {
  it("没有引用时：影响面为空、补丁为空，直接删除即可", () => {
    const questions = [q(1, null), q(2, { kind: "option_equals", rules: [{ optionId: 9, targetQuestionId: 3 }] })];
    const plan = planQuestionDeletion(questions, 5);
    expect(plan.dependents).toEqual([]);
    expect(plan.patches).toEqual([]);
  });

  it("选项跳转指向被删题：列入影响面并生成清引用补丁", () => {
    const questions = [
      q(1, {
        kind: "option_equals",
        rules: [
          { optionId: 11, targetQuestionId: 2 },
          { optionId: 12, targetQuestionId: 3 },
        ],
      }),
      q(2, null),
      q(3, null),
    ];
    const plan = planQuestionDeletion(questions, 2);
    expect(plan.dependents).toHaveLength(1);
    expect(plan.dependents[0]).toMatchObject({ fromId: 1, kind: "option" });
    expect(plan.patches).toEqual([
      {
        id: 1,
        condition: { kind: "option_equals", rules: [{ optionId: 12, targetQuestionId: 3 }] },
      },
    ]);
  });

  it("flag 跳转与旧式 skipTo 都算引用；只剩空壳时 condition 置 null", () => {
    const questions = [
      q(1, { kind: "option_equals", flagJumps: [{ flag: "好感", gte: 3, targetQuestionId: 9 }] }),
      q(2, { kind: "option_equals", optionId: 7, skipToQuestionId: 9 }),
    ];
    const plan: DeleteCascadePlan = planQuestionDeletion(questions, 9);
    expect(plan.dependents.map((ref) => ref.kind)).toEqual(["flagJump", "skipTo"]);
    expect(plan.patches).toEqual([
      { id: 1, condition: null },
      { id: 2, condition: null },
    ]);
  });

  it("被删题自己的跳转不算别人的影响面", () => {
    const questions = [q(1, { kind: "option_equals", rules: [{ optionId: 1, targetQuestionId: 2 }] }), q(2, null)];
    const plan = planQuestionDeletion(questions, 1);
    expect(plan.dependents).toEqual([]);
    expect(plan.patches).toEqual([]);
  });
});

describe("deletionConfirmMessage", () => {
  it("逐条列出影响面，超过 6 条截断并提示", () => {
    const questions = Array.from({ length: 8 }, (_, index) =>
      q(index + 1, { kind: "option_equals", rules: [{ optionId: index + 1, targetQuestionId: 99 }] }),
    );
    const plan = planQuestionDeletion(questions, 99);
    const message = deletionConfirmMessage(plan, "结局题");
    expect(message).toContain("有 8 条跳转指向「结局题」");
    expect(message).toContain("· 题 1：选项 #1 选择后跳转");
    expect(message).toContain("· 题 6：选项 #6 选择后跳转");
    expect(message).not.toContain("题 7：");
    expect(message).toContain("…");
    expect(message).toContain("可用撤销恢复");
  });
});
