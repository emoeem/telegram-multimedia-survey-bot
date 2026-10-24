import { describe, expect, it } from "vitest";
import { buildOpsFromDiff, type EditorSnapshot } from "../../../admin/src/editor/diffOps";

const baseline: EditorSnapshot = {
  surveyMeta: {
    title: "问卷",
    description: "",
    anonymous: false,
    allowMultipleResponses: false,
    maxResponsesPerUser: 1,
  },
  questions: [
    {
      id: 1,
      type: "single",
      title: "A",
      description: null,
      required: true,
      order: 0,
      pageId: null,
      columns: [],
      validation: null,
      condition: null,
      media: [],
      options: [
        { id: 11, label: "x", order: 0, media: [] },
        { id: 12, label: "y", order: 1, media: [] },
      ],
    },
  ],
};

function ids() {
  let key = 1000;
  let temp = -1;
  return { key: () => key++, temp: () => temp-- };
}

describe("buildOpsFromDiff", () => {
  it("emits PATCH, DELETE and POST ops for edits, deletions and additions", () => {
    const target: EditorSnapshot = {
      ...baseline,
      questions: [
        {
          ...baseline.questions[0]!,
          title: "B",
          options: [{ id: 11, label: "x", order: 0, media: [] }],
        },
        {
          id: -1,
          type: "text",
          title: "新题",
          description: null,
          required: true,
          order: 1,
          pageId: null,
          columns: [],
          validation: null,
          condition: null,
          media: [],
          options: [],
        },
      ],
    };

    const ops = buildOpsFromDiff(baseline, target, 5, ids());
    const labels = ops.map((op) => op.label);
    expect(labels).toEqual(expect.arrayContaining(["题目修改", "删除选项", "新增题目", "题目排序"]));

    const questionPatch = ops.find((op) => op.label === "题目修改");
    expect(questionPatch?.method).toBe("PATCH");
    expect(questionPatch?.body).toEqual({ title: "B" });

    const optionDelete = ops.find((op) => op.label === "删除选项");
    expect(optionDelete?.method).toBe("DELETE");
    expect(optionDelete?.path).toContain("/options/12");

    const questionCreate = ops.find((op) => op.label === "新增题目");
    expect(questionCreate?.method).toBe("POST");
    expect(questionCreate?.tempId).toBeLessThan(0);
    expect(questionCreate?.body).toMatchObject({ title: "新题", type: "text" });
  });

  it("emits one metadata PATCH when survey settings changed", () => {
    const target: EditorSnapshot = {
      ...baseline,
      surveyMeta: { ...baseline.surveyMeta, anonymous: true },
    };
    const ops = buildOpsFromDiff(baseline, target, 5, ids());
    const meta = ops.find((op) => op.label === "问卷设置");
    expect(meta?.method).toBe("PATCH");
    expect(meta?.body).toMatchObject({ anonymous: true });
  });
});
