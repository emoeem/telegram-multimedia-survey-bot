import type {
  DraftQuestion,
  SurveyBuilderDO,
  SurveyBuilderState,
} from "../durable-objects/survey-builder";
import {
  createSurvey,
  getLatestDraftSurveyByOwner,
  getSurveyById,
  updateDraftSurvey,
} from "../db/repositories/survey.repository";
import {
  createQuestion,
  createQuestionOption,
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from "../db/repositories/question.repository";
import {
  createOptionMedia,
  createQuestionMedia,
  getOptionMediaByOptionId,
  getQuestionMediaByQuestionId,
} from "../db/repositories/media.repository";

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
    let reason = `Builder request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error === "choice_options_incomplete") {
        reason = "单选题或多选题至少需要两个选项";
      } else if (body.error === "question_incomplete") {
        reason = "当前题目还没有填写完整";
      } else if (body.error) {
        reason = body.error;
      }
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(reason);
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

export async function startBuilderDraft(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, { action: "start" });
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
  mediaAssetId: number | null = null,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "add_option",
    value,
    mediaAssetId,
  });
}

export async function startQuestionOptions(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_question_options",
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

export async function startAddQuestionOption(
  namespace: SurveyBuilderNamespace,
  userId: number,
  questionId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_add_question_option",
    questionId,
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

export async function startQuestionMedia(
  namespace: SurveyBuilderNamespace,
  userId: number,
  questionId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_question_media",
    questionId,
  });
}

export async function startEditOptionLabel(
  namespace: SurveyBuilderNamespace,
  userId: number,
  optionId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_edit_option_label",
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

export async function startSurveyAccessCode(
  namespace: SurveyBuilderNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_survey_access_code",
    surveyId,
  });
}

export async function startSetSurveyAccessCode(
  namespace: SurveyBuilderNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "start_set_survey_access_code",
    surveyId,
  });
}

export async function resumeBuilderAfterAuxiliary(
  namespace: SurveyBuilderNamespace,
  userId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "resume_auxiliary",
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

async function setDraftSurveyId(
  namespace: SurveyBuilderNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "set_draft_survey_id",
    surveyId,
  });
}

async function restoreBuilder(
  namespace: SurveyBuilderNamespace,
  userId: number,
  input: {
    surveyId: number;
    surveyTitle: string;
    surveyDescription: string;
    questions: DraftQuestion[];
  },
): Promise<SurveyBuilderState> {
  return callBuilder(namespace, userId, {
    action: "restore",
    ...input,
  });
}

export async function saveDraftSurvey(
  db: D1Database,
  state: SurveyBuilderState,
  ownerId: number,
): Promise<number> {
  if (!state.surveyTitle.trim()) {
    throw new Error("问卷标题不能为空");
  }

  if (state.questions.length === 0) {
    throw new Error("至少需要一道完整题目");
  }

  let surveyId = state.draftSurveyId;
  if (surveyId) {
    const existing = await getSurveyById(db, surveyId);
    if (
      !existing ||
      existing.ownerId !== ownerId ||
      existing.status !== "draft"
    ) {
      throw new Error("原草稿不存在、已发布，或不属于当前用户");
    }

    await updateDraftSurvey(db, {
      id: surveyId,
      ownerId,
      title: state.surveyTitle.trim(),
      description: state.surveyDescription.trim() || null,
    });
    await db
      .prepare("DELETE FROM survey_questions WHERE survey_id = ?")
      .bind(surveyId)
      .run();
  } else {
    const survey = await createSurvey(db, {
      ownerId,
      title: state.surveyTitle.trim(),
      description: state.surveyDescription.trim() || null,
    });
    surveyId = survey.id;
  }

  for (let index = 0; index < state.questions.length; index += 1) {
    const draftQuestion = state.questions[index];
    if (!draftQuestion) {
      continue;
    }

    const questionId = await createQuestion(db, {
      surveyId,
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
      if (!option) {
        continue;
      }

      const optionId = await createQuestionOption(db, {
        questionId,
        label: option.label,
        value: option.label,
        order: optionIndex,
      });

      if (option.mediaAssetId) {
        await createOptionMedia(db, {
          questionOptionId: optionId,
          mediaAssetId: option.mediaAssetId,
        });
      }
    }
  }

  return surveyId;
}

export async function persistBuilderDraft(
  db: D1Database,
  namespace: SurveyBuilderNamespace,
  state: SurveyBuilderState,
  ownerId: number,
): Promise<number> {
  const surveyId = await saveDraftSurvey(db, state, ownerId);
  await setDraftSurveyId(namespace, state.userId, surveyId);
  return surveyId;
}

export async function restoreLatestBuilderDraft(
  db: D1Database,
  namespace: SurveyBuilderNamespace,
  userId: number,
  ownerId: number,
): Promise<SurveyBuilderState | null> {
  const survey = await getLatestDraftSurveyByOwner(db, ownerId);
  if (!survey) {
    return null;
  }

  const questions = await listQuestionsBySurvey(db, survey.id);
  if (questions.length === 0) {
    return null;
  }

  const options = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  const draftQuestions: DraftQuestion[] = [];

  for (const question of questions) {
    const questionMedia = await getQuestionMediaByQuestionId(db, question.id);
    const questionOptions = options.filter(
      (option) => option.questionId === question.id,
    );
    const draftOptions = [];

    for (const option of questionOptions) {
      const optionMedia = await getOptionMediaByOptionId(db, option.id);
      draftOptions.push({
        label: option.label,
        mediaAssetId: optionMedia[0]?.mediaAssetId ?? null,
      });
    }

    draftQuestions.push({
      type: question.type,
      title: question.title,
      options: draftOptions,
      mediaAssetId: questionMedia[0]?.mediaAssetId ?? null,
    });
  }

  return restoreBuilder(namespace, userId, {
    surveyId: survey.id,
    surveyTitle: survey.title,
    surveyDescription: survey.description ?? "",
    questions: draftQuestions,
  });
}
