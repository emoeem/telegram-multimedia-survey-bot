import { describe, expect, it, vi } from "vitest";

import {
  getSurveyResultVisualSettings,
  saveSurveyResultVisualSettings,
} from "../../../src/db/repositories/survey-result-visual-settings.repository";

describe("survey result visual settings repository", () => {
  it("defaults safely to disabled when a survey has no visual configuration", async () => {
    const db = {
      prepare: vi.fn(() => {
        const statement = { bind: vi.fn(() => statement), first: vi.fn(async () => null) };
        return statement;
      }),
    } as unknown as D1Database;

    await expect(getSurveyResultVisualSettings(db, 7)).resolves.toEqual({
      surveyId: 7,
      enabled: false,
      autoGenerate: false,
      templateId: null,
      updatedAt: "",
    });
  });

  it("upserts an explicit template reference without embedding template JSON", async () => {
    const statements: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        statements.push(sql);
        const statement = { bind: vi.fn(() => statement), run: vi.fn(async () => ({ success: true })) };
        return statement;
      }),
    } as unknown as D1Database;

    const saved = await saveSurveyResultVisualSettings(db, {
      surveyId: 7,
      enabled: true,
      autoGenerate: true,
      templateId: 8,
    });

    expect(saved).toMatchObject({ surveyId: 7, enabled: true, autoGenerate: true, templateId: 8 });
    expect(statements[0]).toContain("ON CONFLICT(survey_id)");
  });
});
