import { SURVEY_SCHEMA_VERSION, type UnifiedSurveyImport } from "./schema";
import { MATRIX_COLUMN_MIN, SURVEY_QUESTION_TYPES, isSurveyQuestionType, minOptionCount } from "./question-rules";
import { parseHotspotScene } from "./hotspot";
import { parseGameQuestionSettings } from "./game";

export interface ValidationIssue {
  path: string;
  message: string;
}

const QUESTION_TYPES = SURVEY_QUESTION_TYPES as readonly string[];

export function validateUnifiedSurvey(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof input !== "object" || input === null) {
    return [{ path: "$", message: "Survey must be an object" }];
  }

  const data = input as Partial<UnifiedSurveyImport>;

  if (data.schema_version !== SURVEY_SCHEMA_VERSION) {
    issues.push({
      path: "$.schema_version",
      message: `schema_version must be ${SURVEY_SCHEMA_VERSION}`,
    });
  }

  if (!data.survey || typeof data.survey !== "object") {
    issues.push({ path: "$.survey", message: "survey is required" });
    return issues;
  }

  if (!data.survey.title?.trim()) {
    issues.push({ path: "$.survey.title", message: "title is required" });
  }

  if (!Array.isArray(data.survey.questions) || data.survey.questions.length === 0) {
    issues.push({
      path: "$.survey.questions",
      message: "questions must be a non-empty array",
    });
    return issues;
  }

  const surveyQuestions = data.survey.questions;
  surveyQuestions.forEach((question, index) => {
    const path = `$.survey.questions[${index}]`;

    if (!question || typeof question !== "object") {
      issues.push({ path, message: "question must be an object" });
      return;
    }

    if (!question.id) {
      issues.push({ path: `${path}.id`, message: "id is required" });
    }

    if (!isSurveyQuestionType(question.type)) {
      issues.push({
        path: `${path}.type`,
        message: `type must be one of: ${QUESTION_TYPES.join(", ")}`,
      });
    }

    if (!question.title?.trim()) {
      issues.push({ path: `${path}.title`, message: "title is required" });
    }

    if (typeof question.required !== "boolean" && question.required !== null) {
      issues.push({
        path: `${path}.required`,
        message: "required must be a boolean or null",
      });
    }

    if (!Array.isArray(question.options)) {
      issues.push({
        path: `${path}.options`,
        message: "options must be an array",
      });
    } else if (isSurveyQuestionType(question.type)) {
      const minOptions = minOptionCount(question.type);
      if (minOptions !== null && question.options.length < minOptions) {
        issues.push({
          path: `${path}.options`,
          message:
            question.type === "matrix"
              ? `matrix questions require at least ${minOptions} row option(s)`
              : "this question type requires at least two options",
        });
      }
      if (question.type === "matrix") {
        const columns = Array.isArray(question.settings?.columns)
          ? (question.settings?.columns as unknown[]).filter((column): column is string => typeof column === "string")
          : [];
        if (columns.length < MATRIX_COLUMN_MIN) {
          issues.push({
            path: `${path}.settings.columns`,
            message: `matrix questions require at least ${MATRIX_COLUMN_MIN} columns`,
          });
        }
      }
      if (question.type === "scene" && !parseHotspotScene(question.settings, { allowPlaceholderRefs: true })) {
        issues.push({
          path: `${path}.settings.scene`,
          message: "scene questions require a valid settings.scene config (see docs/HOTSPOT_SCENES.md)",
        });
      }
      if (question.type === "game" && !parseGameQuestionSettings(question.settings)) {
        issues.push({
          path: `${path}.settings.game`,
          message: "game questions require settings.game.packId pointing at a task pack",
        });
      }
    }

    issues.push(...validateQuestionCondition(question, index, surveyQuestions));
  });

  return issues;
}

/**
 * Validates jump conditions on a question. Ids may be authoring slugs
 * (UnifiedSurveyImport) or numeric row ids (post-import snapshots); both
 * compare by string form. Jump targets are forward-only, matching the
 * engine, so a typo can never send a participant backwards.
 */
function validateQuestionCondition(
  question: UnifiedSurveyImport["survey"]["questions"][number],
  index: number,
  questions: UnifiedSurveyImport["survey"]["questions"],
): ValidationIssue[] {
  const condition = (question as { condition?: unknown }).condition;
  if (condition === undefined || condition === null) return [];
  const path = `$.survey.questions[${index}].condition`;
  if (typeof condition !== "object" || Array.isArray(condition)) {
    return [{ path, message: "condition must be an object" }];
  }

  const issues: ValidationIssue[] = [];
  const raw = condition as Record<string, unknown>;
  const optionIds = new Set((question.options ?? []).map((option) => String(option?.id)));
  const indexOfId = new Map(questions.map((entry, position) => [String(entry?.id), position]));
  const optionIdsByQuestion = new Map(
    questions.map((entry) => [String(entry?.id), new Set((entry?.options ?? []).map((option) => String(option?.id)))]),
  );

  const checkTarget = (value: unknown, targetPath: string): void => {
    const key = String(value);
    const targetIndex = indexOfId.get(key);
    if (targetIndex === undefined) {
      issues.push({ path: targetPath, message: "jump target must reference a question id in this survey" });
    } else if (targetIndex <= index) {
      issues.push({ path: targetPath, message: "jump targets are forward-only" });
    }
  };

  if (Array.isArray(raw.rules)) {
    raw.rules.forEach((rule, ruleIndex) => {
      const rulePath = `${path}.rules[${ruleIndex}]`;
      if (!rule || typeof rule !== "object") {
        issues.push({ path: rulePath, message: "rule must be an object" });
        return;
      }
      const entry = rule as Record<string, unknown>;
      if (!optionIds.has(String(entry.optionId))) {
        issues.push({ path: `${rulePath}.optionId`, message: "optionId must reference an option of this question" });
      }
      checkTarget(entry.targetQuestionId, `${rulePath}.targetQuestionId`);
    });
  } else if (raw.optionId !== undefined) {
    if (!optionIds.has(String(raw.optionId))) {
      issues.push({ path: `${path}.optionId`, message: "optionId must reference an option of this question" });
    }
  }

  if (raw.skipToQuestionId !== undefined && raw.skipToQuestionId !== null) {
    checkTarget(raw.skipToQuestionId, `${path}.skipToQuestionId`);
  }

  if (raw.answerRules !== undefined) {
    if (!Array.isArray(raw.answerRules)) {
      issues.push({ path: `${path}.answerRules`, message: "answerRules must be an array" });
    } else {
      raw.answerRules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.answerRules[${ruleIndex}]`;
        if (!rule || typeof rule !== "object") {
          issues.push({ path: rulePath, message: "answerRule must be an object" });
          return;
        }
        const entry = rule as Record<string, unknown>;
        if (indexOfId.get(String(entry.questionId)) === undefined) {
          issues.push({
            path: `${rulePath}.questionId`,
            message: "questionId must reference a question in this survey",
          });
        }
        // equals is the matched answer: a numeric option id, or (import
        // format) an option id of the referenced question.
        const equalsValid =
          entry.equals !== undefined &&
          (Number.isFinite(Number(entry.equals)) && Number(entry.equals) > 0
            ? true
            : typeof entry.equals === "string" &&
              (optionIdsByQuestion.get(String(entry.questionId))?.has(entry.equals) ?? false));
        if (!equalsValid) {
          issues.push({
            path: `${rulePath}.equals`,
            message: "equals must be a positive number or an option id of the referenced question",
          });
        }
        checkTarget(entry.targetQuestionId, `${rulePath}.targetQuestionId`);
      });
    }
  }

  return issues;
}
