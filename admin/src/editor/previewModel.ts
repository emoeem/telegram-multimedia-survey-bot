import type { QuestionOption, QuestionType, SurveyQuestion } from '../../../src/db/schema';
import { buildSurveyFlow, type SurveyQuestionView } from '../../../src/survey/engine';

interface PreviewMediaRef {
  mediaAssetId: number;
  mediaType: string;
}

export interface PreviewQuestionInput {
  id: number;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  order: number;
  columns: string[];
  validation: Record<string, unknown> | null;
  condition: Record<string, unknown> | null;
  media: PreviewMediaRef[];
  options: Array<{
    id: number;
    label: string;
    order: number;
    media: PreviewMediaRef[];
  }>;
}

export interface EditorPreviewQuestion extends SurveyQuestionView {
  media: PreviewMediaRef[];
  optionMediaById: Map<number, PreviewMediaRef[]>;
}

export function buildEditorPreviewFlow(surveyId: number, questions: PreviewQuestionInput[]): EditorPreviewQuestion[] {
  const questionRows: SurveyQuestion[] = questions.map((question) => ({
    id: question.id,
    surveyId,
    type: question.type as QuestionType,
    title: question.title,
    description: question.description,
    required: question.required,
    order: question.order,
    pageId: null,
    validationJson: question.validation ? JSON.stringify(question.validation) : null,
    settingsJson: question.columns.length ? JSON.stringify({ columns: question.columns }) : null,
    parentQuestionId: null,
    conditionJson: question.condition ? JSON.stringify(question.condition) : null,
    skipToQuestionId: null,
    createdAt: '',
    updatedAt: '',
  }));
  const optionRows: QuestionOption[] = questions.flatMap((question) =>
    question.options.map((option) => ({
      id: option.id,
      questionId: question.id,
      label: option.label,
      value: option.label,
      order: option.order,
      isOther: false,
      createdAt: '',
      updatedAt: '',
    })),
  );
  const sourceById = new Map(questions.map((question) => [question.id, question]));

  return buildSurveyFlow(questionRows, optionRows).questions.map((question) => {
    const source = sourceById.get(question.id)!;
    return {
      ...question,
      media: source.media,
      optionMediaById: new Map(source.options.map((option) => [option.id, option.media])),
    };
  });
}
