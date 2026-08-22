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

export async function apiBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { headers: authHeaders() });
  if (!response.ok) await throwApiError(response);
  return response.blob();
}

export async function apiSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
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

export interface PublishResult extends WriteResult {
  status: SurveyStatus;
  publishedAt: string | null;
  version: number;
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
  report_template_id?: string | null;
}

export interface ReportTemplateOption {
  id: string;
  name: string;
  theme: string;
  renderers: string[];
}

export interface DashboardData {
  users: number;
  surveys: number;
  publishedSurveys: number;
  responses: number;
  todayResponses: number;
  reportDeliveries: {
    pending: number;
    delivering: number;
    delivered: number;
    failed: number;
  };
  recentSurveys: { id: number; title: string; status: SurveyStatus; updatedAt: string }[];
  recentResponses: {
    id: number;
    surveyId: number;
    status: string;
    updatedAt: string;
    title: string;
  }[];
  recentActions: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    createdAt: string;
  }>;
}

export type ResponseStatus = "in_progress" | "completed" | "abandoned" | "cancelled" | "archived";

export interface ResponseRespondent {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface ResponseListItem {
  id: number;
  status: ResponseStatus;
  statusLabel: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  respondent: ResponseRespondent | null;
}

export interface ResponseListData {
  survey: { id: number; title: string; anonymous: boolean };
  items: ResponseListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ResponseAnswerView {
  questionId: number;
  questionTitle: string;
  questionType: string;
  order: number;
  answered: boolean;
  value: string;
  media: Array<{
    answerId: number;
    mediaAssetId: number;
    mediaType: string;
    fileName: string | null;
    mimeType: string | null;
    previewUrl?: string;
  }>;
}

export interface ResponseDetailData {
  survey: { id: number; title: string; anonymous: boolean };
  response: ResponseListItem & { submittedAt: string | null };
  answers: ResponseAnswerView[];
}

export interface SurveyAnalyticsData {
  survey: { id: number; title: string; status: SurveyStatus };
  overview: { totalStarted: number; totalCompleted: number; completionRate: number };
  statusCounts: Record<ResponseStatus, number>;
  optionStats: Array<{
    questionId: number;
    questionTitle: string;
    questionType: string;
    optionId: number;
    optionLabel: string;
    count: number;
    percentage: number;
  }>;
  numericStats: Array<{
    questionId: number;
    questionTitle: string;
    average: number | null;
    min: number | null;
    max: number | null;
    count: number;
  }>;
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
  pageId: number | null;
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
  pages: Array<{ id: number; title: string | null; description: string | null; order: number }>;
}

export interface UserDirectoryItem {
  id: number;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  systemRole: string;
  bannedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedResponses: number;
  tags: string[];
}

export interface UserDirectoryData {
  items: UserDirectoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UserContentResponse {
  responseId: number;
  surveyId: number;
  surveyTitle: string;
  status: string;
  completedAt: string | null;
}

export interface UserDetailData {
  user: {
    id: number;
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    systemRole: string;
    bannedAt: string | null;
    createdAt: string;
  };
  tags: string[];
  responses: UserContentResponse[];
}

/** Opens the user's private chat in Telegram clients. */
export function userChatLink(userId: number): string {
  return `tg://openmessage?user_id=${userId}`;
}

export interface SurveyVersionSummary {
  version: number;
  createdAt: string;
  createdBy: number | null;
  title: string;
  questionCount: number;
}

export interface SurveyVersionListData {
  versions: SurveyVersionSummary[];
}

export interface SurveyVersionDiffData {
  fromVersion: number;
  toVersion: number;
  diff: {
    added: string[];
    removed: string[];
    changed: Array<{ id: string; from: string; to: string }>;
  };
}

export interface ReportDeliveryItem {
  id: number;
  deliveryId: string;
  responseId: number;
  surveyId: number;
  surveyTitle: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

export interface ReportDeliveriesData {
  items: ReportDeliveryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SystemSettingsData {
  reportChannelId: string;
  defaultReportTemplate: string;
  mediaTtlSeconds: number;
  maxUploadMb: number;
  maxResponseMediaMb: number;
  pdfMaxMb: number;
}
