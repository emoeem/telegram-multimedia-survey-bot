import type { SurveyMedia, UnifiedSurveyImport } from "../../survey/schema";
import type { PdfDetectedSurvey } from "./document-model";

export function convertPdfDetectedSurveyToUnified(
  detected: PdfDetectedSurvey,
): UnifiedSurveyImport {
  return {
    schema_version: 1,
    survey: {
      title: detected.title,
      pages: detected.pages.map((page) => ({
        id: page.id,
        ...(page.title ? { title: page.title } : {}),
        order: page.order,
      })),
      questions: detected.questions.map((question, index) => ({
        id: question.id,
        type: question.type as UnifiedSurveyImport["survey"]["questions"][number]["type"],
        title: question.title,
        required: question.required,
        order: index + 1,
        ...(question.page_id ? { page_id: question.page_id } : {}),
        options: question.options,
        media: question.media as SurveyMedia[],
      })),
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
        source: "pdf",
        warnings: detected.warnings,
      },
    },
  };
}
