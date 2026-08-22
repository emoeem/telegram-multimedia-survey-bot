import { telegramInitData } from "./telegram";

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown> | null;

  constructor(status: number, message: string, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function authHeaders(): Record<string, string> {
  return {
    // initData contains non-ASCII characters (e.g. Chinese first names) which
    // are not valid in header values, so it must be percent-encoded.
    "x-telegram-init-data": telegramInitData ? encodeURIComponent(telegramInitData) : "",
    "x-telegram-user-id": localStorage.getItem("telegramUserId") || "",
  };
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function throwApiError(response: Response): Promise<never> {
  const data = await parseResponse(response);
  throw new ApiError(response.status, (data.message as string) || "请求失败", data);
}

export async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders() });
  if (!response.ok) await throwApiError(response);
  return (await parseResponse(response)) as T;
}

export async function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) await throwApiError(response);
  return (await parseResponse(response)) as T;
}

export interface WriteResult {
  id?: number;
  order?: number;
  updatedAt?: string;
  currentUpdatedAt?: string;
}

export async function fetchEnvironment(): Promise<string | null> {
  try {
    const response = await fetch("/health");
    const body = (await response.json()) as { environment?: string };
    return body.environment ?? null;
  } catch {
    return null;
  }
}

export type SurveyStatus = "draft" | "published" | "closed" | "archived";

export interface SurveySummary {
  id: number;
  title: string;
  description: string | null;
  status: SurveyStatus;
  ownerId: number;
  createdAt: string;
  updatedAt: string;
  questionCount: number;
  responseCount: number;
}

export interface SurveyListData {
  items: SurveySummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SurveyDetailData {
  id: number;
  title: string;
  description: string | null;
  status: SurveyStatus;
  owner_id: number;
  created_at: string;
  updated_at: string;
  access_code: string | null;
  questionCount: number;
  responseCount: number;
  completedCount: number;
  firstName?: string | null;
  username?: string | null;
}

export interface DashboardData {
  users: number;
  surveys: number;
  publishedSurveys: number;
  responses: number;
  recentSurveys: { id: number; title: string; status: SurveyStatus; updatedAt: string }[];
  recentResponses: {
    id: number;
    surveyId: number;
    status: string;
    updatedAt: string;
    title: string;
  }[];
}

export interface EditorMediaRef {
  mediaAssetId: number;
  mediaType: string;
}

export interface EditorOption {
  id: number;
  label: string;
  order: number;
  media: EditorMediaRef[];
}

export interface EditorQuestion {
  id: number;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  order: number;
  settings: { columns?: unknown } | null;
  validation: Record<string, unknown> | null;
  condition: Record<string, unknown> | null;
  media: EditorMediaRef[];
  options: EditorOption[];
}

export interface EditorData {
  survey: {
    id: number;
    title: string;
    description: string | null;
    status: SurveyStatus;
    anonymous: boolean;
    allowMultipleResponses: boolean;
    maxResponsesPerUser: number;
    version: number;
    createdAt: string;
    updatedAt: string;
    responseCount: number;
    questionCount: number;
    editable: boolean;
  };
  questions: EditorQuestion[];
}
