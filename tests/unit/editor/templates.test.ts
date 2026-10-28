import { describe, expect, it } from "vitest";
import {
  defaultQuestionDraft,
  insertTemplate,
  TEMPLATE_OPTIONS,
  type QuestionDraft,
} from "../../../admin/src/editor/templates";
import { editableTypeList } from "../../../admin/src/components/editor/question-types";

/**
 * 新建题默认稿与内置模板（两套壳共用）：物料区点任何题型都要有合理的默认稿，
 * 模板按固定顺序插入固定数量的题目——编辑器外壳重排（P2）不能改这些行为。
 */
describe("defaultQuestionDraft", () => {
  it("每个可编辑题型都有非空默认标题", () => {
    for (const { type } of editableTypeList()) {
      const draft = defaultQuestionDraft(type);
      expect(draft.type).toBe(type);
      expect(draft.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("选择类题型默认给两个选项；矩阵题默认两列", () => {
    expect(defaultQuestionDraft("single").options).toEqual([{ label: "选项 1" }, { label: "选项 2" }]);
    expect(defaultQuestionDraft("yes_no").options?.map((option) => option.label)).toEqual(["是", "否"]);
    const matrix = defaultQuestionDraft("matrix");
    expect(matrix.columns).toEqual(["列 1", "列 2"]);
    expect(matrix.options).toEqual([{ label: "行 1" }]);
  });

  it("填写/上传/剧情类不携带选项与列", () => {
    for (const type of ["text", "long_text", "number", "date", "time", "image", "video", "audio", "file", "note", "game"]) {
      const draft = defaultQuestionDraft(type);
      expect(draft.options).toBeUndefined();
      expect(draft.columns).toBeUndefined();
    }
  });

  it("未知题型回落为通用默认稿", () => {
    expect(defaultQuestionDraft("scene")).toEqual({ type: "scene", title: "新题目" });
  });
});

describe("insertTemplate", () => {
  function fakeEditor() {
    const drafts: QuestionDraft[] = [];
    return {
      drafts,
      addQuestion: (draft: QuestionDraft) => {
        drafts.push(draft);
        return drafts.length;
      },
    };
  }

  it("三套模板的 id 与描述齐全", () => {
    expect(TEMPLATE_OPTIONS.map((template) => template.id)).toEqual(["survey", "single-game", "mixed"]);
    for (const template of TEMPLATE_OPTIONS) {
      expect(template.title.trim()).not.toBe("");
      expect(template.desc.trim()).not.toBe("");
    }
  });

  it("问卷基础 = 文本 + 单选 + 长文本，按顺序插入", () => {
    const editor = fakeEditor();
    insertTemplate(editor, "survey");
    expect(editor.drafts.map((draft) => draft.type)).toEqual(["text", "single", "long_text"]);
    expect(editor.drafts[1]!.options?.length).toBe(3);
  });

  it("单题小游戏 = 开场文段 + 游戏题；混合互动 = 热身 + 游戏 + 长文本", () => {
    const single = fakeEditor();
    insertTemplate(single, "single-game");
    expect(single.drafts.map((draft) => draft.type)).toEqual(["note", "game"]);

    const mixed = fakeEditor();
    insertTemplate(mixed, "mixed");
    expect(mixed.drafts.map((draft) => draft.type)).toEqual(["single", "game", "long_text"]);
  });
});
