import type {
  SurveySessionDO,
  SurveySessionState,
} from "../durable-objects/survey-session";

export type SurveySessionNamespace = DurableObjectNamespace<SurveySessionDO>;

function getSessionId(userId: number, surveyId: number): string {
  return `user:${userId}:survey:${surveyId}`;
}

async function callSession(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
  body: Record<string, unknown>,
): Promise<SurveySessionState> {
  const id = namespace.idFromName(getSessionId(userId, surveyId));
  const stub = namespace.get(id);
  const response = await stub.fetch("https://session.internal/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Session request failed: ${response.status}`);
  }

  return response.json() as Promise<SurveySessionState>;
}

export async function initSession(
  namespace: SurveySessionNamespace,
  input: {
    userId: number;
    surveyId: number;
    responseId: number;
    currentQuestionId: number | null;
  },
): Promise<SurveySessionState> {
  return callSession(namespace, input.userId, input.surveyId, {
    action: "init",
    ...input,
  });
}

export async function getSession(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveySessionState> {
  return callSession(namespace, userId, surveyId, {
    action: "get",
  });
}

export async function setSessionCurrentQuestion(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
  questionId: number | null,
): Promise<SurveySessionState> {
  return callSession(namespace, userId, surveyId, {
    action: "set_current_question",
    questionId,
  });
}

export async function toggleSessionOption(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
  optionId: number,
): Promise<SurveySessionState> {
  return callSession(namespace, userId, surveyId, {
    action: "toggle_option",
    optionId,
  });
}

export async function getSessionSelectedOptions(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
): Promise<number[]> {
  const state = await callSession(namespace, userId, surveyId, {
    action: "get_selected_options",
  });

  return state.selectedOptionIds;
}

export async function clearSessionOptions(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveySessionState> {
  return callSession(namespace, userId, surveyId, {
    action: "clear_options",
  });
}

export async function completeSession(
  namespace: SurveySessionNamespace,
  userId: number,
  surveyId: number,
): Promise<SurveySessionState> {
  return callSession(namespace, userId, surveyId, {
    action: "complete",
  });
}
