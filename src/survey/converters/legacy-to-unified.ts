import type {
  SurveyOption,
  SurveyQuestion,
  UnifiedSurveyImport,
} from "../schema";
import type { ImportedSurvey } from "../../services/import.service";

function normalizeQuestion(
  question: ImportedSurvey["questions"][number],
  index: number,
): SurveyQuestion {
  const options: SurveyOption[] = (question.options ?? []).map(
    (label, optionIndex) => ({
      id: `q${index + 1}_o${optionIndex + 1}`,
      label,
      value: label,
      order: optionIndex + 1,
    }),
  );

  return {
    id: `q${index + 1}`,
    type: question.type,
    title: question.title,
    ...(question.description ? { description: question.description } : {}),
    required: question.required ?? true,
    order: index + 1,
    options,
    media: [],
  };
}

export function legacyToUnified(
  imported: ImportedSurvey,
): UnifiedSurveyImport {
  return {
    schema_version: 1,
    survey: {
      title: imported.title,
      ...(imported.description ? { description: imported.description } : {}),
      pages: [],
      questions: imported.questions.map(normalizeQuestion),
      settings: {
        anonymous: false,
        allow_multiple: false,
        max_responses: 1,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
      metadata: {
        source: "json",
      },
    },
  };
}
