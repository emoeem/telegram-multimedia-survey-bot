import { describe, expect, it } from "vitest";

import { calculateResultProfile, parseResultRuleSet, serializeResultProfile } from "../../../src/services/result-engine.service";
import type { Answer } from "../../../src/db/schema";

function answer(input: Partial<Answer> & Pick<Answer, "questionId">): Answer {
  return {
    id: input.id ?? input.questionId,
    responseId: input.responseId ?? 1,
    questionId: input.questionId,
    textValue: input.textValue ?? null,
    numberValue: input.numberValue ?? null,
    booleanValue: input.booleanValue ?? null,
    ratingValue: input.ratingValue ?? null,
    dateValue: input.dateValue ?? null,
    timeValue: input.timeValue ?? null,
    jsonValue: input.jsonValue ?? null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("result engine", () => {
  it("builds arbitrary result fields from answer data and structured rules", () => {
    const profile = calculateResultProfile({
      answers: [
        answer({ questionId: 11, textValue: "夜行者" }),
        answer({ questionId: 12, ratingValue: 45 }),
        answer({ questionId: 13, numberValue: 42 }),
      ],
      ruleSet: {
        schemaVersion: 1,
        defaults: {
          resultType: "custom_relationship",
          fields: {
            relationship: { id: "relationship", type: "enum", value: "unknown" },
          },
        },
        rules: [
          { set: { title: { $from: "answers.11.value" }, "fields.total": { $sum: ["answers.12.value", "answers.13.value"] } } },
          {
            when: { path: "answers.12.value", operator: "greater_or_equal", value: 40 },
            set: {
              "fields.relationship": { id: "ignored", type: "enum", value: "ally" },
              tags: ["洞察", "冷静"],
            },
          },
        ],
      },
    });

    expect(profile.resultType).toBe("custom_relationship");
    expect(profile.title).toBe("夜行者");
    expect(profile.fields["total"]).toEqual({ id: "total", type: "number", value: 87 });
    expect(profile.fields["relationship"]).toEqual({ id: "relationship", type: "enum", value: "ally" });
    expect(profile.tags).toEqual(["洞察", "冷静"]);
  });

  it("supports nested condition groups without running template code", () => {
    const profile = calculateResultProfile({
      answers: [answer({ questionId: 20, jsonValue: "[\"night\",\"city\"]" })],
      ruleSet: {
        schemaVersion: 1,
        rules: [
          {
            when: {
              all: [
                { path: "answers.20.value", operator: "contains", value: "night" },
                { any: [{ path: "answers.20.value", operator: "contains", value: "city" }] },
              ],
            },
            set: { "fields.scene_type": "urban_noir" },
          },
        ],
      },
    });

    expect(profile.fields["scene_type"]).toEqual({ id: "scene_type", type: "text", value: "urban_noir" });
  });

  it("serializes a stable profile snapshot for persistence", () => {
    const serialized = serializeResultProfile(calculateResultProfile({
      answers: [],
      ruleSet: {
        schemaVersion: 1,
        defaults: { title: "人格结果", metadata: { source: "rules" } },
        rules: [],
      },
    }));

    expect(serialized.title).toBe("人格结果");
    expect(JSON.parse(serialized.metadataJson)).toEqual({ source: "rules" });
  });

  it("rejects executable-looking or unsafe rule definitions before evaluation", () => {
    expect(() => parseResultRuleSet(JSON.stringify({
      schemaVersion: 1,
      rules: [{ set: { "fields.__proto__": { $from: "answers.1.value" } } }],
    }))).toThrow("Invalid result rule path");
    expect(() => parseResultRuleSet(JSON.stringify({
      schemaVersion: 1,
      rules: [{ set: { title: { $eval: "score > 1" } } }],
    }))).toThrow("Invalid result expression");
  });
});
