import { describe, expect, it } from "vitest";
import { buildCanvasEdges, type EdgeQuestion } from "../../../admin/src/editor/canvas-edges";

/**
 * S6 画布连线的数据层：从 condition 四区段提取向后跳转的边；
 * 自环/向前跳转不画；kind 决定线的样式。
 */
function q(id: number, order: number, condition: Record<string, unknown> | null): EdgeQuestion {
  return { id, order, condition };
}

describe("buildCanvasEdges", () => {
  it("选项跳转 / flagJumps / answerRules / skipTo 都产生边，带 kind 与人话 label", () => {
    const edges = buildCanvasEdges([
      q(1, 0, { kind: "option_equals", rules: [{ optionId: 11, targetQuestionId: 2 }] }),
      q(2, 1, { kind: "option_equals", flagJumps: [{ flag: "好感", gte: 3, targetQuestionId: 4 }] }),
      q(3, 2, { kind: "option_equals", answerRules: [{ questionId: 1, equals: 2, targetQuestionId: 5 }] }),
      q(4, 3, { kind: "option_equals", optionId: 7, skipToQuestionId: 5 }),
      q(5, 4, null),
    ]);
    const keys = edges.map((edge) => `${edge.fromId}->${edge.toId}:${edge.kind}`);
    expect(keys).toEqual(["1->2:option", "2->4:flagJump", "3->5:answerRule", "4->5:skipTo"]);
    expect(edges[0]!.label).toContain("选项 #11");
    expect(edges[1]!.label).toContain("好感");
  });

  it("自环与向前（order 更小）的目标不画", () => {
    const edges = buildCanvasEdges([
      q(1, 0, {
        kind: "option_equals",
        rules: [
          { optionId: 1, targetQuestionId: 1 },
          { optionId: 2, targetQuestionId: 2 },
        ],
      }),
      q(2, 1, { kind: "option_equals", rules: [{ optionId: 3, targetQuestionId: 1 }] }),
    ]);
    expect(edges.map((edge) => `${edge.fromId}->${edge.toId}`)).toEqual(["1->2"]);
  });

  it("无 condition 的题不产生边", () => {
    expect(buildCanvasEdges([q(1, 0, null), q(2, 1, null)])).toEqual([]);
  });
});
