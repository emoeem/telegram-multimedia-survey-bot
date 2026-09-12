import { getTelegramInitData } from "./telegram";

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
  const telegramInitData = getTelegramInitData();
  return {
    // initData contains non-ASCII characters (e.g. Chinese first names) which
    // are not valid in header values, so it must be percent-encoded.
    "x-telegram-init-data": telegramInitData ? encodeURIComponent(telegramInitData) : "",
    "x-telegram-user-id": localStorage.getItem("telegramUserId") || "",
    // Local development only: the worker accepts the x-telegram-user-id
    // fallback solely when this matches ADMIN_DEV_AUTH_SECRET, so a public
    // deployment can never be taken over by a spoofed user id header.
    "x-dev-auth-secret": localStorage.getItem("adminDevAuthSecret") || "",
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
  // An expired 7-day session cookie used to surface as endless "请求失败"
  // panels; route the user to the login page instead.
  if (response.status === 401 && !window.location.pathname.startsWith("/admin/login")) {
    window.location.assign("/admin/login");
  }
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

export async function apiPostBlob(path: string): Promise<Blob> {
  const response = await fetch(path, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: "{}",
  });
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

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(path, { method: "POST", headers: authHeaders(), body: formData });
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

export interface ImportQuestionWarning {
  order: number;
  title: string;
  type: string;
  confidence: { type?: number; required?: number } | null;
  warnings: string[];
}

export interface ImportIssue {
  path: string;
  message: string;
  questionNumber?: number;
  questionTitle?: string;
  field?: string;
}

export interface ImportSummary {
  title: string;
  description: string | null;
  cover: { url: string; mimeType?: string } | null;
  questionCount: number;
  optionCount: number;
  pageCount: number;
  typeCounts: Record<string, number>;
  media: { question: number; option: number; total: number };
  warnings: string[];
  lowConfidence: ImportQuestionWarning[];
  reportTemplateId: string | null;
  reportTemplateName: string | null;
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
  isAdmin?: boolean;
  theme: {
    preset?: string;
    background?: { color?: string; image?: string; position?: string; size?: string };
    overlay?: { color?: string; opacity?: number; blur?: number };
    audio?: { url?: string };
    primaryColor?: string;
    secondaryColor?: string;
    card?: { background?: string; border?: string; radius?: number; glass?: boolean };
    text?: { heading?: string; body?: string; muted?: string };
    button?: { radius?: number };
    completion?: { message?: string; redirectUrl?: string; showRestart?: boolean };
  } | null;
  themePresets: Array<{ id: string; name: string }>;
}

export interface ReportTemplateOption {
  id: string;
  name: string;
  theme: string;
  layout?: string | null;
  renderers: string[];
  isCustom?: boolean;
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
    statusLabel: string;
    updatedAt: string;
    completedAt: string | null;
    title: string;
    respondent: ResponseRespondent | null;
    participantKey: string | null;
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
  userId: number;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface ResponseListItem {
  id: number;
  status: ResponseStatus;
  statusLabel: string;
  version: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  respondent: ResponseRespondent | null;
  participantKey: string | null;
  deviceFingerprint?: string | null;
  browserInfo?: string | null;
  ipAddress?: string | null;
}

export interface ResponseListData {
  survey: { id: number; title: string; anonymous: boolean };
  items: ResponseListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ResponseActivityItem {
  id: number;
  surveyId: number;
  surveyTitle: string;
  status: ResponseStatus;
  statusLabel: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  respondent: ResponseRespondent | null;
  participantKey: string | null;
}

export interface ResponseActivityData {
  items: ResponseActivityItem[];
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
  raw: Record<string, unknown> | null;
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
  response: ResponseListItem & {
    submittedAt: string | null;
    previousResponseId: number | null;
    nextResponseId: number | null;
  };
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
  fileName?: string | null;
  mimeType?: string | null;
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
    theme?: { preset?: string } | null;
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
    bannedBy: number | null;
    banReason: string | null;
    createdAt: string;
  };
  tags: string[];
  responses: UserContentResponse[];
  responsePage: number;
  responsePageSize: number;
  responseTotal: number;
  responseTotalPages: number;
}

/** Opens the user's private chat in Telegram clients. */
export function userChatLink(userId: number): string {
  return `tg://openmessage?user_id=${userId}`;
}

/** Bans or unbans a user from the admin user directory. */
export async function setUserBan(
  userId: number,
  banned: boolean,
  reason?: string,
): Promise<{ ok: boolean; banned: boolean }> {
  return apiSend("POST", `/api/admin/users/${userId}/ban`, {
    banned,
    ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
  });
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
  plazaChannelId: string;
  defaultReportTemplate: string;
  mediaTtlSeconds: number;
  maxUploadMb: number;
  maxResponseMediaMb: number;
  pdfMaxMb: number;
  reportWatermark: string;
  profileGallerySurveyId: string;
}

export type SoftwareLicenseType = "timed" | "perpetual";
export type SoftwareLicenseStatus = "active" | "suspended" | "revoked";

export interface LicenseActivationView {
  installationId: string;
  installationName: string | null;
  appVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deactivatedAt: string | null;
}

export interface LicenseView {
  publicId: string;
  customerName: string | null;
  customerContact: string | null;
  licenseType: SoftwareLicenseType;
  status: SoftwareLicenseStatus;
  startsAt: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  maxActivations: number;
  notes: string | null;
  createdAt: string;
  revokedAt: string | null;
  activationCount: number;
  activations: LicenseActivationView[];
}

export interface SoftwareReleaseView {
  version: string;
  channel: string;
  releasedAt: string;
  minimumVersion: string | null;
  downloadUrl: string | null;
  notes: string | null;
}

export interface CreatorTrialView {
  userId: number;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  expiresAt: string;
  grantedAt: string;
}

export interface ProfileGalleryField {
  questionId: number;
  title: string;
  value: string;
}

export interface ProfileGalleryImage {
  mediaAssetId: number;
  url: string;
}

export interface ProfileGallerySummary {
  id: number;
  surveyId: number;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  showUsername: boolean;
  publishedAt: string | null;
  createdAt: string;
  images: ProfileGalleryImage[];
  fields: ProfileGalleryField[];
}

export interface ProfileGalleryData {
  items: ProfileGallerySummary[];
  total: number;
  publishedTotal: number;
  limit: number;
  offset: number;
  surveyId: number | null;
  surveyTitle: string;
  search?: string;
}

export function fetchProfileGallery(
  view: "all" | "published",
  offset: number,
  limit = 20,
  search = "",
): Promise<ProfileGalleryData> {
  const query = new URLSearchParams({
    view,
    offset: String(offset),
    limit: String(limit),
    ...(search ? { search } : {}),
  });
  return api<ProfileGalleryData>(`/api/admin/profile-gallery?${query}`);
}

export function setProfileGalleryPublished(
  id: number,
  published: boolean,
  options: { coverMediaId?: number | null } = {},
): Promise<{ ok: boolean }> {
  return apiSend("POST", "/api/admin/profile-gallery/publish", { id, published, ...options });
}

export interface PlazaPostSummary {
  id: number;
  userId: number;
  content: string;
  kind: "text" | "trial";
  payload: Record<string, unknown> | null;
  anonymous: boolean;
  status: "published" | "removed";
  createdAt: string;
  commentCount: number;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
  } | null;
}

export interface PlazaPostListData {
  items: PlazaPostSummary[];
  total: number;
  limit: number;
  offset: number;
}

export function fetchPlazaPosts(view: "all" | "published", offset: number, limit = 20): Promise<PlazaPostListData> {
  const query = new URLSearchParams({ view, offset: String(offset), limit: String(limit) });
  return api<PlazaPostListData>(`/api/admin/plaza/posts?${query}`);
}

export function setPlazaPostStatus(id: number, status: "published" | "removed"): Promise<{ ok: boolean }> {
  return apiSend("POST", "/api/admin/plaza/posts/status", { id, status });
}

export interface PlazaCommentSummary {
  id: number;
  postId: number;
  userId: number;
  content: string;
  status: "published" | "removed";
  createdAt: string;
  owner: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
  } | null;
}

export function fetchAdminPlazaComments(
  postId: number,
  view: "all" | "published" = "all",
): Promise<{ items: PlazaCommentSummary[]; total: number; postId: number }> {
  return api<{ items: PlazaCommentSummary[]; total: number; postId: number }>(
    `/api/admin/plaza/posts/${postId}/comments?view=${view}&limit=100&offset=0`,
  );
}

export function setPlazaCommentStatus(id: number, status: "published" | "removed"): Promise<{ ok: boolean }> {
  return apiSend("POST", "/api/admin/plaza/comments/status", { id, status });
}

export type AdminTaskPersona = "any" | "male" | "female";
export type AdminTaskMode = "any" | "normal" | "hell";

export interface AdminTaskItem {
  id: number;
  packId: number;
  title: string;
  description: string;
  warning: string;
  score: number;
  persona: AdminTaskPersona;
  mode: AdminTaskMode;
  minFloor: number;
  maxFloor: number;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTaskPack {
  id: number;
  name: string;
  description: string | null;
  normalFloors: number;
  hellFloors: number;
  prepItems: string[];
  prepText: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  items: AdminTaskItem[];
}

export interface AdminTaskItemInput {
  title: string;
  description: string;
  warning?: string;
  score: number;
  persona: AdminTaskPersona;
  mode: AdminTaskMode;
  minFloor: number;
  maxFloor: number;
  enabled: boolean;
  sortOrder: number;
}

export interface AdminTaskPackInput {
  name: string;
  description: string | null;
  normalFloors: number;
  hellFloors: number;
  prepItems: string[];
  prepText: string | null;
  enabled: boolean;
  items: AdminTaskItemInput[];
}

export function fetchAdminTaskPacks(): Promise<{ packs: AdminTaskPack[] }> {
  return api<{ packs: AdminTaskPack[] }>("/api/admin/task-packs");
}

export function createAdminTaskPack(input: AdminTaskPackInput): Promise<{ pack: AdminTaskPack }> {
  return apiSend("POST", "/api/admin/task-packs", input as unknown as Record<string, unknown>);
}

export function updateAdminTaskPack(id: number, input: AdminTaskPackInput): Promise<{ pack: AdminTaskPack }> {
  return apiSend("PUT", `/api/admin/task-packs/${id}`, input as unknown as Record<string, unknown>);
}

export function deleteAdminTaskPack(id: number): Promise<{ ok: boolean }> {
  return apiSend("DELETE", `/api/admin/task-packs/${id}`);
}
