import {
  SURVEY_SCHEMA_VERSION,
  type SurveyQuestionType,
  type UnifiedSurveyImport,
} from "./schema";

export interface ValidationIssue {
  path: string;
  message: string;
}

const QUESTION_TYPES: SurveyQuestionType[] = [
  "single",
  "multiple",
  "text",
  "long_text",
  "number",
  "boolean",
  "yes_no",
  "rating",
  "date",
  "time",
  "file",
  "image",
  "video",
  "audio",
];

export function validateUnifiedSurvey(
  input: unknown,
): ValidationIssue[] {
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

  data.survey.questions.forEach((question, index) => {
    const path = `$.survey.questions[${index}]`;

    if (!question || typeof question !== "object") {
      issues.push({ path, message: "question must be an object" });
      return;
    }

    if (!question.id) {
      issues.push({ path: `${path}.id`, message: "id is required" });
    }

    if (!QUESTION_TYPES.includes(question.type)) {
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
    } else if (
      (question.type === "single" ||
        question.type === "multiple" ||
        question.type === "yes_no" ||
        question.type === "rating") &&
      question.options.length < 2
    ) {
      issues.push({
        path: `${path}.options`,
        message: "this question type requires at least two options",
      });
    }
  });

  return issues;
}
