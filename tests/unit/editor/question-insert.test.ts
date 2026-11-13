import { describe, expect, it } from "vitest";
import {
  insertQuestionAfter,
  questionCreateBody,
  type InsertableQuestion,
} from "../../../admin/src/editor/question-insert";

/**
 * 「在此后插入」（G7a）纯逻辑：插入落位 + 全量 order 重排要保引用（下游
 * 行 memo），锚点缺失要回退；创建 body 与「添加题目」共用同一份构造。
 */
interface Row extends InsertableQuestion {
  title: string;
}

function row(id: number, order: number, title = `题 ${id}`): Row {
  return { id, order, title };
}

describe("insertQuestionAfter", () => {
  it("插到锚点之后并把全量 order 重排为 0..n-1", () => {
    const questions = [row(1, 0), row(2, 1), row(3, 2)];
    const next = insertQuestionAfter(questions, 1, row(99, 0, "新题"));
    expect(next?.map((question) => question.id)).toEqual([1, 99, 2, 3]);
    expect(next?.map((question) => question.order)).toEqual([0, 1, 2, 3]);
  });

  it("插在末尾锚点之后等价于追加", () => {
    const questions = [row(1, 0), row(2, 1)];
    const next = insertQuestionAfter(questions, 2, row(9, 0));
    expect(next?.map((question) => question.id)).toEqual([1, 2, 9]);
    expect(next?.[2]?.order).toBe(2);
  });

  it("order 未变的行保持引用不变（行 memo 不整体失效）", () => {
    const first = row(1, 0);
    const second = row(2, 1);
    // 中间插入：first 的 order 保持 0（引用不变），second 被推后（换新对象）。
    const next = insertQuestionAfter([first, second], 1, row(9, 0));
    expect(next?.[0]).toBe(first);
    expect(next?.[1]?.id).toBe(9);
    expect(next?.[2]).not.toBe(second);
    expect(next?.[2]?.order).toBe(2);
    // 末尾插入不推挤任何行：所有旧行引用原样保留。
    const appended = insertQuestionAfter([first, second], 2, row(8, 0));
    expect(appended?.[0]).toBe(first);
    expect(appended?.[1]).toBe(second);
  });

  it("锚点不存在返回 null（调用方回退为追加）", () => {
    expect(insertQuestionAfter([row(1, 0)], 404, row(9, 0))).toBeNull();
    expect(insertQuestionAfter([], 1, row(9, 0))).toBeNull();
  });
});

describe("questionCreateBody", () => {
  it("基础字段 + 选项与「添加题目」的既有语义一致", () => {
    expect(questionCreateBody({ type: "single", title: "新的单选题", options: [{ label: "选项 1" }] }, null)).toEqual({
      type: "single",
      title: "新的单选题",
      required: true,
      options: [{ label: "选项 1" }],
    });
  });

  it("pageId 只在非 null 时下发（继承锚点分页）", () => {
    expect(questionCreateBody({ type: "text", title: "问" }, 7)).toMatchObject({ pageId: 7 });
    expect(questionCreateBody({ type: "text", title: "问" }, null)).not.toHaveProperty("pageId");
  });

  it("matrix 列与 game 任务包按题型写入 settings；显式 settings 优先", () => {
    expect(questionCreateBody({ type: "matrix", title: "矩阵", columns: ["列 1", "列 2"] }, null)).toEqual({
      type: "matrix",
      title: "矩阵",
      required: true,
      settings: { columns: ["列 1", "列 2"] },
    });
    expect(questionCreateBody({ type: "game", title: "小游戏", gamePackId: 3 }, null)).toEqual({
      type: "game",
      title: "小游戏",
      required: true,
      settings: { game: { packId: 3 } },
    });
    expect(questionCreateBody({ type: "note", title: "剧情", settings: {} }, null).settings).toEqual({});
    expect(questionCreateBody({ type: "text", title: "无 settings 的普通题" }, null)).not.toHaveProperty("settings");
  });
});
