import { describe, expect, it } from "vitest";
import {
  gameAnswerScore,
  isGameAnswerValue,
  numericAnswerValue,
  parseGameQuestionSettings,
  type SurveyGameAnswer,
} from "../../../src/survey/game";
import { buildSurveyFlow, computeFlags, gamePassedFlag, getNextQuestionAfterAnswers } from "../../../src/survey/engine";
import type { QuestionOption, SurveyQuestion } from "../../../src/db/schema";

function makeGameAnswer(overrides: Partial<SurveyGameAnswer> = {}): SurveyGameAnswer {
  return { kind: "game", runId: 7, score: 12, grade: "A", completed: true, ...overrides };
}

describe("parseGameQuestionSettings", () => {
  it("从 settings_json 字符串解析 packId", () => {
    expect(parseGameQuestionSettings('{"game":{"packId":3}}')).toEqual({ packId: 3 });
    expect(parseGameQuestionSettings({ game: { packId: 5 } })).toEqual({ packId: 5 });
  });

  it("缺失/脏数据返回 null", () => {
    expect(parseGameQuestionSettings(null)).toBeNull();
    expect(parseGameQuestionSettings("{}")).toBeNull();
    expect(parseGameQuestionSettings('{"game":{"packId":0}}')).toBeNull();
    expect(parseGameQuestionSettings('{"game":{"packId":"x"}}')).toBeNull();
    expect(parseGameQuestionSettings("not-json")).toBeNull();
  });
});

describe("game answer numeric projection", () => {
  it("isGameAnswerValue 只认形状正确的 game 答案", () => {
    expect(isGameAnswerValue(makeGameAnswer())).toBe(true);
    expect(isGameAnswerValue({ kind: "scene", visited: [] })).toBe(false);
    expect(isGameAnswerValue({ kind: "game", runId: 0, score: 1, grade: "A", completed: true })).toBe(false);
    expect(isGameAnswerValue(12)).toBe(false);
    expect(isGameAnswerValue(null)).toBe(false);
  });

  it("gameAnswerScore：通关给分，未通关为 0", () => {
    expect(gameAnswerScore(makeGameAnswer({ score: 12, completed: true }))).toBe(12);
    expect(gameAnswerScore(makeGameAnswer({ score: 0, completed: true }))).toBe(0);
    expect(gameAnswerScore(makeGameAnswer({ score: 30, completed: false }))).toBe(0);
    expect(gameAnswerScore(12)).toBeNull();
  });

  it("numericAnswerValue 保持其它类型的原行为", () => {
    expect(numericAnswerValue(4)).toBe(4);
    expect(numericAnswerValue("x")).toBeNaN();
    expect(numericAnswerValue(makeGameAnswer({ score: 9 }))).toBe(9);
  });
});

describe("engine: game answers drive flags and jumps", () => {
  const questions = [
    { id: 1, type: "game", conditionJson: null },
    {
      id: 2,
      type: "single",
      conditionJson: JSON.stringify({
        flagJumps: [{ flag: gamePassedFlag(1), gte: 1, targetQuestionId: 4 }],
      }),
    },
    { id: 3, type: "text", conditionJson: null },
    { id: 4, type: "text", conditionJson: null },
  ] as unknown as SurveyQuestion[];
  const flow = buildSurveyFlow(questions, [] as QuestionOption[]);

  it("通关自动置 game_passed flag", () => {
    const flags = computeFlags(flow, new Map([[1, makeGameAnswer({ completed: true, score: 10 })]]));
    expect(flags.get(gamePassedFlag(1))).toBe(1);
  });

  it("未通关不置 flag", () => {
    const flags = computeFlags(flow, new Map([[1, makeGameAnswer({ completed: false, score: 5 })]]));
    expect(flags.has(gamePassedFlag(1))).toBe(false);
  });

  it("flagJumps 用 game_passed 做必须通关的门槛", () => {
    const passed = getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, makeGameAnswer({ completed: true })]]));
    expect(passed?.id).toBe(4);
    const failed = getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, makeGameAnswer({ completed: false })]]));
    expect(failed?.id).toBe(3);
  });

  it("answerRules 数值比较对 game 答案用得分投影", () => {
    const flow2 = buildSurveyFlow(
      [
        { id: 1, type: "game", conditionJson: null },
        {
          id: 2,
          type: "text",
          conditionJson: JSON.stringify({ answerRules: [{ questionId: 1, equals: 12, targetQuestionId: 4 }] }),
        },
        { id: 3, type: "text", conditionJson: null },
        { id: 4, type: "text", conditionJson: null },
      ] as unknown as SurveyQuestion[],
      [] as QuestionOption[],
    );
    const hit = getNextQuestionAfterAnswers(flow2, 2, null, new Map([[1, makeGameAnswer({ score: 12 })]]));
    expect(hit?.id).toBe(4);
    const miss = getNextQuestionAfterAnswers(flow2, 2, null, new Map([[1, makeGameAnswer({ score: 11 })]]));
    expect(miss?.id).toBe(3);
  });
});
