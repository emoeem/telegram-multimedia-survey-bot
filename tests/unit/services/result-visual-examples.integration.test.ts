import { describe, expect, it } from "vitest";

import type { Answer } from "../../../src/db/schema";
import { calculateResultProfile } from "../../../src/services/result-engine.service";
import { renderResultVisualSvg } from "../../../src/services/result-visual-renderer.service";
import { parseVisualTemplateDefinition } from "../../../src/services/visual-template-validator.service";
import {
  characterCardExampleTemplate,
  customResultPosterExampleTemplate,
  personalityResultExampleTemplate,
} from "../../../src/visual-template/examples";

function answer(questionId: number, value: string): Answer {
  return {
    id: questionId,
    responseId: 1,
    questionId,
    textValue: value,
    numberValue: null,
    booleanValue: null,
    ratingValue: null,
    dateValue: null,
    timeValue: null,
    jsonValue: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function profileFor(fields: Record<string, unknown>) {
  return calculateResultProfile({
    answers: Object.entries(fields).map(([questionId, value]) => answer(Number(questionId), String(value))),
    ruleSet: {
      schemaVersion: 1,
      rules: [{
        set: Object.fromEntries(Object.keys(fields).map((questionId) => [
          `fields.field_${questionId}`,
          { $from: `answers.${questionId}.value` },
        ])),
      }],
    },
  });
}

describe("result visual example templates", () => {
  it("validates three layouts with different dynamic field contracts", () => {
    const templates = [
      characterCardExampleTemplate,
      personalityResultExampleTemplate,
      customResultPosterExampleTemplate,
    ];

    for (const template of templates) {
      expect(parseVisualTemplateDefinition(JSON.stringify(template))).toEqual(template);
    }

    expect(characterCardExampleTemplate.variables.map((entry) => entry.path)).toContain("result.stats");
    expect(personalityResultExampleTemplate.variables.map((entry) => entry.path)).toContain("result.fields.personality");
    expect(customResultPosterExampleTemplate.variables.map((entry) => entry.path)).toContain("result.fields.relationship");
    expect(characterCardExampleTemplate.variables.map((entry) => entry.path)).not.toContain("result.fields.relationship");
  });

  it("runs answer to ResultProfile to template SVG without renderer-specific field logic", () => {
    const characterProfile = profileFor({ 1: "林星", 2: "守夜人" });
    characterProfile.fields = {
      name: { id: "name", type: "text", value: characterProfile.fields.field_1!.value },
      title: { id: "title", type: "text", value: characterProfile.fields.field_2!.value },
      role: { id: "role", type: "text", value: "探索者" },
      level: { id: "level", type: "integer", value: 42 },
      rarity: { id: "rarity", type: "enum", value: "SSR" },
      description: { id: "description", type: "long_text", value: "由结果规则生成的自定义角色说明。" },
    };
    characterProfile.tags = ["勇敢", "观察者"];
    characterProfile.stats = [{ id: "focus", label: "专注", value: 92, max: 100 }];

    const personalityProfile = profileFor({ 3: "陈雨", 4: "分析者" });
    personalityProfile.fields = {
      name: { id: "name", type: "text", value: personalityProfile.fields.field_3!.value },
      personality: { id: "personality", type: "enum", value: personalityProfile.fields.field_4!.value },
      summary: { id: "summary", type: "long_text", value: "你倾向于先理解环境，再做出清晰的判断。" },
      traits: { id: "traits", type: "tags", value: ["冷静", "好奇"] },
    };

    const posterProfile = profileFor({ 5: "周末计划", 6: "探索型" });
    posterProfile.fields = {
      name: { id: "name", type: "text", value: posterProfile.fields.field_5!.value },
      category: { id: "category", type: "enum", value: posterProfile.fields.field_6!.value },
      relationship: { id: "relationship", type: "text", value: "协作伙伴" },
      special_label: { id: "special_label", type: "text", value: "自定义结果" },
      special_trait: { id: "special_trait", type: "text", value: "善于将不确定性转化为新的选择。" },
      description: { id: "description", type: "long_text", value: "这是完全由问卷作者定义字段和版式的结果海报。" },
    };

    const characterSvg = renderResultVisualSvg(characterCardExampleTemplate, characterProfile);
    const personalitySvg = renderResultVisualSvg(personalityResultExampleTemplate, personalityProfile);
    const posterSvg = renderResultVisualSvg(customResultPosterExampleTemplate, posterProfile);

    expect(characterSvg).toContain("林星");
    expect(characterSvg).toContain("专注 92");
    expect(personalitySvg).toContain("分析者");
    expect(personalitySvg).toContain("冷静 · 好奇");
    expect(posterSvg).toContain("协作伙伴");
    expect(posterSvg).toContain("自定义结果");
  });
});
