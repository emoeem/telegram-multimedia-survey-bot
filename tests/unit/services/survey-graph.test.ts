import { describe, expect, it } from "vitest";
import { validateSurveyGraph, type SurveyGraphNode } from "../../../src/services/survey-graph.service";

function node(
  id: number,
  order: number,
  overrides: Partial<SurveyGraphNode> = {},
  optionIds: number[] = [],
): SurveyGraphNode {
  return {
    id,
    order,
    type: "single",
    conditionJson: null,
    skipToQuestionId: null,
    options: optionIds.map((optionId) => ({ id: optionId })),
    ...overrides,
  };
}

const linear = [node(1, 0), node(2, 1), node(3, 2)];

describe("validateSurveyGraph", () => {
  it("纯线性问卷无问题", () => {
    expect(validateSurveyGraph(linear)).toEqual([]);
  });

  it("单题问卷无问题", () => {
    expect(validateSurveyGraph([node(1, 0, {}, [10, 11])])).toEqual([]);
  });

  it("向前的选项规则合法（GATE 型分支）", () => {
    const graph = [
      node(
        1,
        0,
        {
          conditionJson: JSON.stringify({
            kind: "option_equals",
            rules: [
              { optionId: 10, targetQuestionId: 3 },
              { optionId: 11, targetQuestionId: 4 },
            ],
          }),
        },
        [10, 11, 12],
      ),
      node(2, 1),
      node(3, 2),
      node(4, 3),
    ];
    expect(validateSurveyGraph(graph)).toEqual([]);
  });

  it("拦截引用不存在选项的规则", () => {
    const graph = [
      node(
        1,
        0,
        { conditionJson: JSON.stringify({ kind: "option_equals", rules: [{ optionId: 99, targetQuestionId: 2 }] }) },
        [10],
      ),
      node(2, 1),
    ];
    const issues = validateSurveyGraph(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("error");
    expect(issues[0]!.message).toContain("不存在的选项");
  });

  it("拦截指向不存在题目的规则", () => {
    const graph = [
      node(
        1,
        0,
        { conditionJson: JSON.stringify({ kind: "option_equals", rules: [{ optionId: 10, targetQuestionId: 99 }] }) },
        [10],
      ),
      node(2, 1),
    ];
    const issues = validateSurveyGraph(graph);
    expect(issues[0]!.message).toContain("不存在的题目");
  });

  it("拦截向后跳转", () => {
    const graph = [
      node(1, 0),
      node(
        2,
        1,
        { conditionJson: JSON.stringify({ kind: "option_equals", rules: [{ optionId: 10, targetQuestionId: 1 }] }) },
        [10],
      ),
      node(3, 2),
    ];
    const issues = validateSurveyGraph(graph);
    expect(issues[0]!.message).toContain("跳转只能向前");
  });

  it("不可达的分支节点是错误（规则覆盖全部选项后，线性后继不再可达）", () => {
    const graph = [
      node(
        1,
        0,
        {
          conditionJson: JSON.stringify({
            kind: "option_equals",
            rules: [
              { optionId: 10, targetQuestionId: 3 },
              { optionId: 11, targetQuestionId: 3 },
              { optionId: 12, targetQuestionId: 3 },
            ],
          }),
        },
        [10, 11, 12],
      ),
      node(2, 1), // 被三门全跳过：不可达
      node(3, 2),
    ];
    const issues = validateSurveyGraph(graph);
    expect(issues.some((issue) => issue.questionId === 2 && issue.message.includes("不可达"))).toBe(true);
  });

  it("GATE 有未覆盖选项时线性兜底可达（距离线顺延结构）", () => {
    const graph = [
      node(
        1,
        0,
        {
          conditionJson: JSON.stringify({
            kind: "option_equals",
            rules: [
              { optionId: 10, targetQuestionId: 3 },
              { optionId: 11, targetQuestionId: 3 },
              { optionId: 12, targetQuestionId: 3 },
            ],
          }),
        },
        [10, 11, 12, 13],
      ),
      node(2, 1), // 选项 13 无规则 → 线性顺延可达
      node(3, 2),
    ];
    expect(validateSurveyGraph(graph)).toEqual([]);
  });

  it("legacy 单选项形状：有 skipTo 时校验目标，缺 skipTo 时给 warning", () => {
    const ok = [
      node(1, 0, { conditionJson: JSON.stringify({ kind: "option_equals", optionId: 10 }), skipToQuestionId: 2 }, [10]),
      node(2, 1),
    ];
    expect(validateSurveyGraph(ok)).toEqual([]);

    const missing = [
      node(1, 0, { conditionJson: JSON.stringify({ kind: "option_equals", optionId: 10 }) }, [10]),
      node(2, 1),
    ];
    const issues = validateSurveyGraph(missing);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("warning");
  });

  it("answerRules 计入可达性且校验字段", () => {
    const ok = [
      node(1, 0, {
        conditionJson: JSON.stringify({
          kind: "option_equals",
          answerRules: [{ questionId: 1, equals: 10, targetQuestionId: 3 }],
        }),
      }),
      node(2, 1),
      node(3, 2),
    ];
    expect(validateSurveyGraph(ok)).toEqual([]);

    const bad = [
      node(1, 0, {
        conditionJson: JSON.stringify({
          kind: "option_equals",
          answerRules: [{ questionId: 99, equals: 0, targetQuestionId: 2 }],
        }),
      }),
      node(2, 1),
    ];
    const issues = validateSurveyGraph(bad);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.level === "error")).toBe(true);
  });

  it("坏 JSON 的条件是错误", () => {
    const graph = [node(1, 0, { conditionJson: "{not json" }), node(2, 1)];
    const issues = validateSurveyGraph(graph);
    expect(issues[0]!.message).toContain("不是合法 JSON");
  });

  it("skip_to 无 kind 时是 warning（运行时不会生效）", () => {
    const graph = [node(1, 0, { skipToQuestionId: 2 }), node(2, 1)];
    const issues = validateSurveyGraph(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("warning");
  });
});
