import { describe, expect, it } from "vitest";

import type { Env } from "../../../src/index";
import { validateQuestionPayload } from "../../../src/http/admin/helpers";
import { saveWebAnswer } from "../../../src/http/survey/answers";

describe("note（剧情文段）question payload", () => {
  it("creates without a title and forces non-required", () => {
    const result = validateQuestionPayload({ type: "note" }, true);
    expect(result.error).toBeUndefined();
    expect(result.payload?.title).toBe("剧情");
    expect(result.payload?.required).toBe(false);
    expect(result.payload?.options).toEqual([]);
  });

  it("keeps a custom segment title and accepts long story bodies", () => {
    const body = { type: "note", title: "序章", description: "深".repeat(4000) };
    const result = validateQuestionPayload(body, true);
    expect(result.error).toBeUndefined();
    expect(result.payload?.title).toBe("序章");
    expect(result.payload?.description).toHaveLength(4000);
  });

  it("rejects story bodies over 5000 characters but allows them for plain description limits on other types", () => {
    const tooLong = { type: "note", description: "深".repeat(5001) };
    expect(validateQuestionPayload(tooLong, true).error).toContain("5000");
    const other = { type: "text", title: "文本题", description: "深".repeat(1001) };
    expect(validateQuestionPayload(other, true).error).toContain("1000");
  });

  it("honours the stored type on partial PATCH without body.type", () => {
    const result = validateQuestionPayload({ description: "续".repeat(3000) }, false, "note");
    expect(result.error).toBeUndefined();
    expect(result.payload?.required).toBe(false);
    expect(result.payload?.description).toHaveLength(3000);
  });
});

describe("note answers", () => {
  it("accepts (and ignores) any answer payload for narrative nodes", async () => {
    const question = {
      id: 7,
      surveyId: 1,
      type: "note",
      title: "剧情",
      description: null,
      required: false,
      order: 0,
      pageId: null,
      validationJson: null,
      settingsJson: null,
      parentQuestionId: null,
      conditionJson: null,
      skipToQuestionId: null,
      createdAt: "",
      updatedAt: "",
      options: [],
    } as unknown as Parameters<typeof saveWebAnswer>[2];
    // The note branch returns before touching the DB, so a stub env suffices.
    await expect(saveWebAnswer({} as Env, 1, question, { anything: true })).resolves.toBeNull();
  });
});
