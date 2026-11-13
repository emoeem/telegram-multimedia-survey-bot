import { describe, expect, it } from "vitest";
import { planBatchQuestionUpdates, type BatchPlanQuestion } from "../../../admin/src/editor/batch-edit";

/**
 * 结构树批量操作（G7b）纯计划：批量必答/选填与批量移动分页只对「确实要改」
 * 的题生成 PATCH，note 题跳过必答（服务端强制 required=false），非法 pageId
 * 不进请求；输出顺序跟问卷题目顺序，不跟勾选顺序。
 */
function q(id: number, overrides: Partial<BatchPlanQuestion> = {}): BatchPlanQuestion {
  return { id, type: "single", required: false, pageId: null, ...overrides };
}

describe("planBatchQuestionUpdates —— 批量必答", () => {
  it("只对 required 会变的题生成 PATCH，已必答的跳过", () => {
    const questions = [q(1), q(2, { required: true }), q(3)];
    const updates = planBatchQuestionUpdates(questions, [1, 2, 3], { required: true });
    expect(updates).toEqual([
      { id: 1, body: { required: true } },
      { id: 3, body: { required: true } },
    ]);
  });

  it("批量选填同样只发要改的题", () => {
    const questions = [q(1, { required: true }), q(2, { required: false })];
    const updates = planBatchQuestionUpdates(questions, [1, 2], { required: false });
    expect(updates).toEqual([{ id: 1, body: { required: false } }]);
  });

  it("note（剧情）题跳过必答：服务端强制 required=false，避免本地与真值漂移", () => {
    const questions = [q(1, { type: "note" }), q(2)];
    const updates = planBatchQuestionUpdates(questions, [1, 2], { required: true });
    expect(updates).toEqual([{ id: 2, body: { required: true } }]);
  });
});

describe("planBatchQuestionUpdates —— 批量移动分页", () => {
  it("只对 pageId 会变的题生成 PATCH；移到 null（不分页）也合法", () => {
    const questions = [q(1, { pageId: 7 }), q(2, { pageId: null }), q(3, { pageId: 8 })];
    const updates = planBatchQuestionUpdates(questions, [1, 2, 3], { pageId: 8 });
    expect(updates).toEqual([
      { id: 1, body: { pageId: 8 } },
      { id: 2, body: { pageId: 8 } },
    ]);
    expect(planBatchQuestionUpdates(questions, [3], { pageId: null })).toEqual([{ id: 3, body: { pageId: null } }]);
  });

  it("非法 pageId（0 / 非整数）不生成任何请求", () => {
    const questions = [q(1), q(2)];
    expect(planBatchQuestionUpdates(questions, [1, 2], { pageId: 0 })).toEqual([]);
    expect(planBatchQuestionUpdates(questions, [1, 2], { pageId: 1.5 })).toEqual([]);
  });

  it("输出按问卷题目顺序而非勾选顺序；未知 id 忽略；无变更返回空", () => {
    const questions = [q(1), q(2), q(3)];
    const updates = planBatchQuestionUpdates(questions, [3, 404, 1], { required: true });
    expect(updates.map((update) => update.id)).toEqual([1, 3]);
    expect(planBatchQuestionUpdates(questions, [1], { required: false })).toEqual([]);
  });

  it("两个字段同时批改时合并进同一个 PATCH body", () => {
    const questions = [q(1, { required: false, pageId: null })];
    const updates = planBatchQuestionUpdates(questions, [1], { required: true, pageId: 5 });
    expect(updates).toEqual([{ id: 1, body: { required: true, pageId: 5 } }]);
  });
});
