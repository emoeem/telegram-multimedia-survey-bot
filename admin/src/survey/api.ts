import { telegramInitData } from "../telegram";

export interface SurveyMediaDto {
  url: string;
}

export interface SurveyOptionDto {
  id: number;
  label: string;
  media: SurveyMediaDto[];
}

export interface SurveyQuestionDto {
  id: number;
  type: string;
  title: string;
  description?: string;
  required: boolean;
  order: number;
  pageId: number | null;
  validation: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  condition: Record<string, unknown> | null;
  skipToQuestionId: number | null;
  media: SurveyMediaDto[];
  options: SurveyOptionDto[];
}

export interface SurveyPageDto {
  id: number;
  title: string | null;
  description: string | null;
  order: number;
}

export interface SurveyDto {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  anonymous: boolean;
  allowMultiple: boolean;
  maxResponses: number;
  pages: SurveyPageDto[];
  questions: SurveyQuestionDto[];
}

export interface SurveyListItem {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  publishedAt: string | null;
  questionCount: number;
}

export type AnswerValue =
  | number
  | string
  | number[]
  | Record<string, number>
  | { mediaAssetId: number }
  | null;

let participantKey: string | null = null;

export function getParticipantKey(): string {
  if (participantKey) return participantKey;
  const stored = localStorage.getItem("webSurveyParticipantKey");
  if (stored) {
    participantKey = stored;
    return stored;
  }
  const generated = crypto.randomUUID().replaceAll("-", "");
  localStorage.setItem("webSurveyParticipantKey", generated);
  participantKey = generated;
  return generated;
}

export function identityHeaders(): Record<string, string> {
  if (telegramInitData) {
    return { "x-telegram-init-data": encodeURIComponent(telegramInitData) };
  }
  return { "x-participant-key": getParticipantKey() };
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...identityHeaders(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await parseJson(response);
    const error = new Error(String(body.message ?? "请求失败")) as Error & {
      code?: string;
    };
    error.code = String(body.code ?? "unknown");
    throw error;
  }
  return (await parseJson(response)) as T;
}

export function fetchSurvey(surveyId: number): Promise<SurveyDto> {
  return request<SurveyDto>(`/api/survey/${surveyId}`);
}

export function fetchSurveyList(): Promise<{ surveys: SurveyListItem[] }> {
  return request<{ surveys: SurveyListItem[] }>("/api/surveys");
}

export async function verifyAccessCode(surveyId: number, code: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/survey/${surveyId}/access`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export interface StartResponseDto {
  responseId: number;
  currentQuestionId: number | null;
  status: string;
  resumed: boolean;
}

export function startResponse(
  surveyId: number,
  accessCode?: string,
): Promise<StartResponseDto> {
  return request<StartResponseDto>(`/api/survey/${surveyId}/responses`, {
    method: "POST",
    body: JSON.stringify(accessCode ? { accessCode } : {}),
  });
}

export function fetchAnswers(
  surveyId: number,
  responseId: number,
): Promise<{ answers: Record<string, AnswerValue> }> {
  return request<{ answers: Record<string, AnswerValue> }>(
    `/api/survey/${surveyId}/responses/${responseId}`,
  );
}

export function saveAnswer(
  surveyId: number,
  responseId: number,
  questionId: number,
  value: AnswerValue,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/survey/${surveyId}/responses/${responseId}/answers`,
    {
      method: "POST",
      body: JSON.stringify({ questionId, value }),
    },
  );
}

export function submitResponse(
  surveyId: number,
  responseId: number,
): Promise<{ ok: boolean; completed: boolean }> {
  return request<{ ok: boolean; completed: boolean }>(
    `/api/survey/${surveyId}/responses/${responseId}/submit`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function uploadAnswerMedia(
  surveyId: number,
  file: File,
): Promise<{ ok: boolean; mediaAssetId: number; url: string }> {
  const form = new FormData();
  form.append("file", file);
  return request<{ ok: boolean; mediaAssetId: number; url: string }>(
    `/api/survey/${surveyId}/media`,
    { method: "POST", body: form },
  );
}
