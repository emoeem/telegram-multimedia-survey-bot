import { getTelegramInitData } from "../telegram";
import { safeGet, safeSet } from "./storage";
import { surveyDeviceHeaders } from "./deviceInfo";

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

export interface SurveyThemeDto {
  preset?: string;
  background?: {
    color?: string;
    image?: string;
    position?: string;
    size?: string;
  };
  overlay?: {
    color?: string;
    opacity?: number;
    blur?: number;
  };
  audio?: { url?: string };
  primaryColor?: string;
  secondaryColor?: string;
  card?: {
    background?: string;
    border?: string;
    radius?: number;
    glass?: boolean;
  };
  text?: {
    heading?: string;
    body?: string;
    muted?: string;
  };
  button?: {
    radius?: number;
  };
  completion?: {
    message?: string;
    redirectUrl?: string;
    showRestart?: boolean;
  };
}

export interface SurveyGalleryProfileDto {
  enabled: true;
  canPublish: boolean;
}

export interface SurveyDto {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  anonymous: boolean;
  allowMultiple: boolean;
  maxResponses: number;
  theme: SurveyThemeDto | null;
  galleryProfile?: SurveyGalleryProfileDto;
  pages: SurveyPageDto[];
  questions: SurveyQuestionDto[];
  communityGroupUrl: string | null;
  submissionBotUrl: string | null;
}

export interface SurveyListItem {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  publishedAt: string | null;
  closedAt?: string | null;
  anonymous?: boolean;
  questionCount: number;
  responseCount?: number;
  coverUrl?: string;
  theme: SurveyThemeDto | null;
}

export type AnswerValue = number | string | number[] | Record<string, number> | { mediaAssetId: number } | null;

let participantKey: string | null = null;

export function getParticipantKey(): string {
  if (participantKey) return participantKey;
  const stored = safeGet("webSurveyParticipantKey");
  if (stored) {
    participantKey = stored;
    return stored;
  }
  const generated = crypto.randomUUID().replaceAll("-", "");
  safeSet("webSurveyParticipantKey", generated);
  participantKey = generated;
  return generated;
}

export function identityHeaders(): Record<string, string> {
  const telegramInitData = getTelegramInitData();
  if (telegramInitData) {
    return { "x-telegram-init-data": encodeURIComponent(telegramInitData) };
  }
  // The bot mints a signed participant token (pt=…) when a Telegram user
  // opens a survey from the chat, so browser responses stay linked to the
  // real Telegram account without forcing the WebView.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("pt");
  if (token) {
    safeSet("webSurveyParticipantToken", token);
  }
  const storedToken = safeGet("webSurveyParticipantToken");
  if (storedToken) {
    return { "x-participant-token": storedToken };
  }
  // Email accounts (registered at /auth) ride along on every survey/trial
  // request so progress is attributed and resumable across devices.
  const emailSession = safeGet("emailSessionToken");
  if (emailSession) {
    return { "x-email-session": emailSession };
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const deviceHeaders = await surveyDeviceHeaders();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...identityHeaders(),
      ...deviceHeaders,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await parseJson(response);
    // Keep the status visible when the body carries no message, so a
    // non-JSON edge/Worker error page is diagnosable from a screenshot.
    const error = new Error(String(body.message ?? `请求失败（HTTP ${response.status}）`)) as Error & {
      code?: string;
    };
    error.code = String(body.code ?? "unknown");
    throw error;
  }
  return (await parseJson(response)) as T;
}

export function fetchSurvey(surveyId: number, accessGrant?: string | null): Promise<SurveyDto> {
  return request<SurveyDto>(`/api/survey/${surveyId}${accessGrant ? `?grant=${encodeURIComponent(accessGrant)}` : ""}`);
}

/** 成就徽章：目录由服务端下发，客户端不硬编码任何一条。 */
export interface AchievementItem {
  code: string;
  title: string;
  description: string;
  icon: string;
  group: "问卷" | "挑战" | "广场" | "彩蛋";
  secret: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
}

export interface AchievementOverview {
  unlocked: number;
  total: number;
  /** 已解锁但还没在「我的」页面看过的数量，用于显示小红点。 */
  unseen: number;
  items: AchievementItem[];
}

/** 动作接口返回的「刚刚解锁」列表（提交问卷 / 通关挑战 / 广场发言）。 */
export interface UnlockedAchievement {
  code: string;
  title: string;
  description: string;
  icon: string;
}

/** 展示页软连接：由自己的资料卡生成（showcase_persons.response_id）。 */
export interface MyShowcase {
  personId: number;
  published: boolean;
}

export interface MyOverview {
  identity: { telegram: boolean };
  completedSurveys: number;
  profileSurveyId: number | null;
  myProfile: { responseId: number; heading: string | null; publishedAt: string | null } | null;
  trial: { runs: number; completed: number; bestScore: number };
  achievements: AchievementOverview;
  showcase: MyShowcase | null;
}

export function fetchMyOverview(): Promise<MyOverview> {
  return request<MyOverview>("/api/me/overview");
}

/** 用当前资料卡生成/取回展示页草稿（草稿需管理员审核后公开）。 */
export function createMyShowcase(): Promise<{
  showcase: { personId: number; created: boolean; published: boolean; url: string };
}> {
  return request<{ showcase: { personId: number; created: boolean; published: boolean; url: string } }>(
    "/api/me/showcase",
    { method: "POST" },
  );
}

/** 打开「我的」后清掉徽章小红点。 */
export function markAchievementsSeen(): Promise<{ ok: boolean; marked: number }> {
  return request<{ ok: boolean; marked: number }>("/api/me/achievements/seen", { method: "POST" });
}

export function fetchSurveyList(
  q = "",
): Promise<{ surveys: SurveyListItem[]; communityGroupUrl: string | null; submissionBotUrl: string | null }> {
  return request<{ surveys: SurveyListItem[]; communityGroupUrl: string | null; submissionBotUrl: string | null }>(
    `/api/surveys${q ? `?q=${encodeURIComponent(q)}` : ""}`,
  );
}

export async function verifyAccessCode(surveyId: number, code: string): Promise<string | null> {
  const result = await request<{ ok: boolean; grant?: string | null }>(`/api/survey/${surveyId}/access`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  return result.grant ?? null;
}

export interface StartResponseDto {
  responseId: number;
  currentQuestionId: number | null;
  status: string;
  resumed: boolean;
}

export function startResponse(surveyId: number, accessCode?: string): Promise<StartResponseDto> {
  return request<StartResponseDto>(`/api/survey/${surveyId}/responses`, {
    method: "POST",
    body: JSON.stringify(accessCode ? { accessCode } : {}),
  });
}

export function fetchAnswers(surveyId: number, responseId: number): Promise<{ answers: Record<string, AnswerValue> }> {
  return request<{ answers: Record<string, AnswerValue> }>(`/api/survey/${surveyId}/responses/${responseId}`);
}

export function saveAnswer(
  surveyId: number,
  responseId: number,
  questionId: number,
  value: AnswerValue,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/survey/${surveyId}/responses/${responseId}/answers`, {
    method: "POST",
    body: JSON.stringify({ questionId, value }),
  });
}

export function submitResponse(
  surveyId: number,
  responseId: number,
  options: {
    publishToGallery?: boolean;
    galleryCoverMediaId?: number | null;
    galleryVisibleQuestionIds?: number[];
    galleryShowUsername?: boolean;
    publishToTelegram?: boolean;
  } = {},
): Promise<{
  ok: boolean;
  completed: boolean;
  reportUrl?: string;
  galleryPublished?: boolean;
  telegramPublicationQueued?: boolean;
  newAchievements?: UnlockedAchievement[];
}> {
  return request<{
    ok: boolean;
    completed: boolean;
    reportUrl?: string;
    galleryPublished?: boolean;
    newAchievements?: UnlockedAchievement[];
  }>(`/api/survey/${surveyId}/responses/${responseId}/submit`, { method: "POST", body: JSON.stringify(options) });
}

export function uploadAnswerMedia(
  surveyId: number,
  file: File,
  questionId: number,
): Promise<{ ok: boolean; mediaAssetId: number; url: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("questionId", String(questionId));
  return request<{ ok: boolean; mediaAssetId: number; url: string }>(`/api/survey/${surveyId}/media`, {
    method: "POST",
    body: form,
  });
}

/**
 * True when the current browser already carries a Telegram identity (Mini App
 * initData or a bot-minted participant token), so the opt-in bind card on the
 * completion page is unnecessary.
 */
export function hasTelegramIdentity(): boolean {
  if (getTelegramInitData()) return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get("pt")) return true;
  return Boolean(safeGet("webSurveyParticipantToken"));
}

export interface ParticipantLinkStatus {
  linked: boolean;
  username?: string | null;
  firstName?: string | null;
  telegramUserId?: number | null;
}

export function fetchParticipantLinkStartUrl(participantKey: string): Promise<{ url: string }> {
  return request<{ url: string }>(`/api/survey/participant-link/start?key=${encodeURIComponent(participantKey)}`);
}

export function fetchParticipantLinkStatus(participantKey: string): Promise<ParticipantLinkStatus> {
  return request<ParticipantLinkStatus>(
    `/api/survey/participant-link/status?key=${encodeURIComponent(participantKey)}`,
  );
}
