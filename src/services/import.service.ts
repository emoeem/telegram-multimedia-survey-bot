import type { QuestionType } from "../db/schema";
import { createSurvey } from "../db/repositories/survey.repository";
import {
  createQuestion,
} from "../db/repositories/question.repository";
import { legacyToUnified } from "../survey/converters/legacy-to-unified";
import { validateUnifiedSurvey } from "../survey/validator";

export interface ImportedQuestion {
  type: QuestionType;
  title: string;
  description?: string;
  required?: boolean | null;
  options?: string[];
}

export interface ImportedSurvey {
  title: string;
  description?: string;
  questions: ImportedQuestion[];
}

export function parseImportedSurvey(input: string): ImportedSurvey {
  const raw = JSON.parse(input) as Record<string, unknown>;

  let data: ImportedSurvey;

  if (typeof raw["schema_version"] === "number" && raw["survey"]) {
    const unifiedSurvey = raw["survey"] as {
      title?: string;
      description?: string;
      questions?: Array<{
        type?: QuestionType;
        title?: string;
        description?: string;
        required?: boolean | null;
        options?: Array<{ label?: string; value?: string } | string>;
      }>;
    };

    data = {
      title: unifiedSurvey.title ?? "",
      ...(unifiedSurvey.description ? { description: unifiedSurvey.description } : {}),
      questions: (unifiedSurvey.questions ?? []).map((question) => ({
        type: question.type ?? "text",
        title: question.title ?? "",
        ...(question.description ? { description: question.description } : {}),
        required: question.required ?? true,
        options: (question.options ?? []).map((option) =>
          typeof option === "string" ? option : (option.label ?? option.value ?? ""),
        ),
      })),
    };
  } else {
    data = raw as unknown as ImportedSurvey;
  }

  if (!data.title || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("JSON 必须包含 title 和 questions 数组");
  }

  const unified = legacyToUnified(data);
  const issues = validateUnifiedSurvey(unified);
  if (issues.length > 0) {
    throw new Error(
      issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  }

  return data;
}

export async function saveImportedSurvey(
  db: D1Database,
  ownerId: number,
  survey: ImportedSurvey,
): Promise<number> {
  const created = await createSurvey(db, {
    ownerId,
    title: survey.title,
    description: survey.description ?? null,
  });

  const optionStatements: D1PreparedStatement[] = [];

  for (let index = 0; index < survey.questions.length; index += 1) {
    const question = survey.questions[index];
    if (!question) continue;

    const questionId = await createQuestion(db, {
      surveyId: created.id,
      type: question.type,
      title: question.title,
      description: question.description ?? null,
      required: question.required ?? true,
      order: index,
    });

    for (let optionIndex = 0; optionIndex < (question.options ?? []).length; optionIndex += 1) {
      const option = question.options?.[optionIndex];
      if (option === undefined) continue;

      const timestamp = new Date().toISOString();
      optionStatements.push(
        db
          .prepare(
            `INSERT INTO question_options (
              question_id, label, value, "order", created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(questionId, option, option, optionIndex, timestamp, timestamp),
      );
    }
  }

  if (optionStatements.length > 0) {
    await db.batch(optionStatements);
  }

  return created.id;
}
