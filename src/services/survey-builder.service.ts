import type {
  SurveyBuilderDO,
  SurveyBuilderState,
} from "../durable-objects/survey-builder";
import { createSurvey } from "../db/repositories/survey.repository";
import {
  createQuestion,
  createQuestionOption,
} from "../db/repositories/question.repository";
import { createQuestionMedia } from "../db/repositories/media.repository";

export type SurveyBuilderNamespace = DurableObjectNamespace<SurveyBuilderDO>;

function getBuilderId(userId: number): string {
  return `user:${userId}`;
}

async function callBuilder(
  namespace: SurveyBuilderNamespace,
  userId: number,
  body: Record<string, unknown>,
): Promise<SurveyBuilderState> {
  const id = namespace.idFromName(getBuilderId(userId));
  const stub = namespace.get(id);
  const response = await stub.fetch("https://builder.internal/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Builder request failed: ${response.status}`);
  }

  return response.json() as Promise<SurveyBuilderState>;
}

export async function initBuilder(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "init",
    userId,
  });
}

export async function getBuilderState(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState | null> {
  try {
    return await callBuilder(namespace, userId, { action: "get" });
  } catch {
    return null;
  }
}

export async function setSurveyTitle(
  namespace: SurveyBuilderNamespace,
  userId: number,
  value: string,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_survey_title",
    value,
  });
}

export async function setSurveyDescription(
  namespace: SurveyBuilderNamespace,
  userId: number,
  value: string,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_survey_description",
    value,
  });
}

export async function setQuestionType(
  namespace: SurveyBuilderNamespace,
  userId: number,
  value: SurveyBuilderState["currentQuestionType"],
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_question_type",
    value,
  });
}

export async function setQuestionTitle(
  namespace: SurveyBuilderNamespace,
  userId: number,
  value: string,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_question_title",
    value,
  });
}

export async function addOption(
  namespace: SurveyBuilderNamespace,
  userId: number,
  value: string,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "add_option",
    value,
  });
}

export async function setQuestionMedia(
  namespace: SurveyBuilderNamespace,
  userId: number,
  mediaAssetId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_question_media",
    mediaAssetId,
  });
}

export async function finishOptions(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "finish_options",
  });
}

export async function startImport(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_import",
  });
}

export async function startOptionMedia(
  namespace: SurveyBuilderNamespace,
  userId: number,
  optionId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_option_media",
    optionId,
  });
}

export async function startEditQuestionTitle(
  namespace: SurveyBuilderNamespace,
  userId: number,
  questionId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_edit_question_title",
    questionId,
  });
}

export async function builderBack(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "back",
  });
}

export async function finishQuestions(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "finish_questions",
  });
}

export async function resetBuilder(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "reset",
  });
}

export async function saveDraftSurvey(
  db: D1Database,
  state: SurveyBuilderState,
  ownerId: number,
): Promise<number> {
  if (!state.surveyTitle) {
    throw new Error("Survey title is required");
  }

  if (state.questions.length === 0) {
    throw new Error("At least one question is required");
  }

  const survey = await createSurvey(db, {
    ownerId,
    title: state.surveyTitle,
    description: state.surveyDescription || null,
  });

  for (let index = 0; index < state.questions.length; index += 1) {
    const draftQuestion = state.questions[index];
    if (!draftQuestion) {
      continue;
    }

    const questionId = await createQuestion(db, {
      surveyId: survey.id,
      type: draftQuestion.type,
      title: draftQuestion.title,
      required: true,
      order: index,
    });

    if (draftQuestion.mediaAssetId) {
      await createQuestionMedia(db, {
        questionId,
        mediaAssetId: draftQuestion.mediaAssetId,
      });
    }

    for (
      let optionIndex = 0;
      optionIndex < draftQuestion.options.length;
      optionIndex += 1
    ) {
      const option = draftQuestion.options[optionIndex];
      if (option === undefined) {
        continue;
      }

      await createQuestionOption(db, {
        questionId,
        label: option,
        value: option,
        order: optionIndex,
      });
    }
  }

  return survey.id;
}
