import { describe, expect, it } from "vitest";

import { collectDiagnostics, countDiagnostics, type DiagnosticQuestion } from "../../../admin/src/editor/diagnostics";

function q(partial: Partial<DiagnosticQuestion> & { id: number; order: number }): DiagnosticQuestion {
  return {
    type: "text",
    title: `题 ${partial.id}`,
    required: false,
    options: [],
    columns: [],
    condition: null,
    gamePackId: null,
    ...partial,
  };
}

describe("collectDiagnostics", () => {
  it("结构完整的问卷没有 error/warning", () => {
    const issues = collectDiagnostics([
      q({
        id: 1,
        order: 0,
        type: "single",
        options: [
          { id: 11, label: "A" },
          { id: 12, label: "B" },
        ],
      }),
      q({ id: 2, order: 1 }),
    ]);
    expect(issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  });

  it("跳转目标不存在 → error，并带上来源题", () => {
    const issues = collectDiagnostics([
      q({
        id: 1,
        order: 0,
        type: "single",
        options: [{ id: 11, label: "A" }],
        condition: { rules: [{ optionId: 11, targetQuestionId: 99 }] },
      }),
    ]);
    const issue = issues.find((item) => item.key.startsWith("dangling-target"));
    expect(issue?.severity).toBe("error");
    expect(issue?.questionId).toBe(1);
    expect(issue?.detail).toContain("99");
  });

  it("跳转目标不在当前题之后 → warning（引擎会忽略）", () => {
    const issues = collectDiagnostics([
      q({ id: 1, order: 0 }),
      q({
        id: 2,
        order: 1,
        type: "single",
        options: [{ id: 21, label: "A" }],
        condition: { skipToQuestionId: 1 },
      }),
    ]);
    const issue = issues.find((item) => item.key.startsWith("backward-target"));
    expect(issue?.severity).toBe("warning");
  });

  it("选项题型没有选项 / 选项文案重复", () => {
    const issues = collectDiagnostics([
      q({ id: 1, order: 0, type: "single" }),
      q({
        id: 2,
        order: 1,
        type: "multiple",
        options: [
          { id: 21, label: "同一句" },
          { id: 22, label: "同一句" },
        ],
      }),
    ]);
    expect(issues.some((item) => item.key === "no-options:1")).toBe(true);
    expect(issues.some((item) => item.key === "duplicate-option:2:22")).toBe(true);
  });

  it("flagJumps 引用了没人产出的 flag → warning；有来源则通过", () => {
    const base = [
      q({
        id: 1,
        order: 0,
        type: "single",
        options: [{ id: 11, label: "A" }],
        condition: { flagRules: [{ questionId: 1, equals: 11, flag: "trust" }] },
      }),
      q({
        id: 2,
        order: 1,
        condition: { flagJumps: [{ flag: "trust", gte: 1, targetQuestionId: 3 }] },
      }),
      q({ id: 3, order: 2 }),
    ];
    expect(collectDiagnostics(base).some((item) => item.key.startsWith("unknown-flag"))).toBe(false);

    base[0] = q({ id: 1, order: 0 });
    expect(collectDiagnostics(base).some((item) => item.key === "unknown-flag:2:trust")).toBe(true);
  });

  it("answerRules / flagRules 引用不存在的题 → error", () => {
    const issues = collectDiagnostics([
      q({
        id: 1,
        order: 0,
        condition: {
          answerRules: [{ questionId: 99, equals: 1, targetQuestionId: 2 }],
          flagRules: [{ questionId: 98, equals: 1, flag: "x" }],
        },
      }),
      q({ id: 2, order: 1 }),
    ]);
    expect(issues.some((item) => item.key === "missing-answer-source:1:answer:99")).toBe(true);
    expect(issues.some((item) => item.key === "missing-flag-source:1:flag:98:x")).toBe(true);
  });

  it("小游戏题缺任务包 / 矩阵题缺列 → error；重复题面 → warning", () => {
    const issues = collectDiagnostics([
      q({ id: 1, order: 0, type: "game" }),
      q({ id: 2, order: 1, type: "matrix" }),
      q({ id: 3, order: 2, title: "题 2" }),
    ]);
    expect(issues.some((item) => item.key === "no-game-pack:1")).toBe(true);
    expect(issues.some((item) => item.key === "no-columns:2")).toBe(true);
    expect(issues.some((item) => item.key === "duplicate-title:3:2")).toBe(true);
  });

  it("countDiagnostics 只统计 error/warning", () => {
    const issues = collectDiagnostics([
      q({ id: 1, order: 0, type: "note", required: true }),
      q({ id: 2, order: 1, type: "single" }),
    ]);
    expect(countDiagnostics(issues)).toEqual({ total: 2, errors: 1, warnings: 0 });
  });
});
