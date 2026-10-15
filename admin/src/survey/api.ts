import { getTelegramInitData } from "../telegram";
import { safeGet, safeSet } from "./storage";
import { surveyDeviceHeaders } from "./deviceInfo";
import type { SurveySfxCue } from "../../../src/survey/theme";

export interface SurveyMediaDto {
  url: string;
  /** 插画替代文本；渲染为 <img alt>，图片加载失败时也是唯一的语义线索。 */
  alt?: string;
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
  audio?: {
    url?: string;
    byPage?: Record<string, string>;
    byQuestion?: Record<string, string>;
    /** 界面音效：事件名 → 音频 URL（见 src/survey/theme.ts 的 SURVEY_SFX_CUES）。 */
    sfx?: Partial<Record<SurveySfxCue, string>>;
  };
  /** 出场立绘（透明 PNG/WebP 多表情）——见 src/survey/theme.ts 的 resolveSprite。 */
  sprite?: {
    name?: string;
    expressions?: Record<string, string>;
    default?: string;
    byPage?: Record<string, string>;
    byQuestion?: Record<string, string>;
  };
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
  /** 金币解锁门：服务端在启用解锁且未持有时返回（内容此时不下发）。 */
  coinUnlock?: { required: boolean; price: number };
}

export interface SurveyListItem {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  /** 作者启用了金币解锁时的价格（免费问卷没有此字段）。 */
  coinUnlock?: { price: number };
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

/**
 * How long to wait before re-sending a request that failed transiently.
 *
 * A dropped packet on a cross-border mobile link is not a failed answer: the
 * save is an idempotent upsert, so re-sending it is free, whereas surfacing the
 * error leaves the participant stuck on a question with no way forward.
 */
const TRANSIENT_RETRY_DELAYS_MS = [400, 1200];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a status another attempt could plausibly succeed on. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    // Capped: waiting out a long Retry-After before showing the error serves
    // the participant worse than reporting it.
    return Math.min(retryAfter * 1000, 5000);
  }
  return TRANSIENT_RETRY_DELAYS_MS[Math.min(attempt, TRANSIENT_RETRY_DELAYS_MS.length - 1)] ?? 1200;
}

async function request<T>(path: string, init?: RequestInit, options: { retries?: number } = {}): Promise<T> {
  const retries = options.retries ?? 0;
  const deviceHeaders = await surveyDeviceHeaders();
  const headers = {
    ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...identityHeaders(),
    ...deviceHeaders,
    ...init?.headers,
  };
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }
    if (response.ok) {
      return (await parseJson(response)) as T;
    }
    if (isTransientStatus(response.status) && attempt < retries) {
      const delay = retryDelayMs(response, attempt);
      await response.text().catch(() => "");
      await sleep(delay);
      continue;
    }
    const body = await parseJson(response);
    // Keep the status visible when the body carries no message, so a
    // non-JSON edge/Worker error page is diagnosable from a screenshot.
    const error = new Error(String(body.message ?? `请求失败（HTTP ${response.status}）`)) as Error & {
      code?: string;
    };
    error.code = String(body.code ?? "unknown");
    throw error;
  }
}

/**
 * Fetches the survey definition. Retried: opening a survey is the one request a
 * participant cannot work around, and a single dropped packet used to mean the
 * "问卷加载失败" screen.
 */
export function fetchSurvey(surveyId: number, accessGrant?: string | null): Promise<SurveyDto> {
  return request<SurveyDto>(
    `/api/survey/${surveyId}${accessGrant ? `?grant=${encodeURIComponent(accessGrant)}` : ""}`,
    undefined,
    { retries: 2 },
  );
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

/** 「我的报告」列表项：服务端为每条已完成答卷现铸 30 天报告 token。 */
export interface MyReportItem {
  responseId: number;
  surveyId: number;
  title: string;
  completedAt: string | null;
  reportUrl: string;
  pdfUrl: string;
}

export function fetchMyReports(): Promise<{ reports: MyReportItem[] }> {
  return request<{ reports: MyReportItem[] }>("/api/me/reports");
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
    undefined,
    { retries: 2 },
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
  /**
   * 续答命中时服务端直接带回的已答答案（省掉单独的 GET /responses 往返）；
   * 旧部署没有该字段，客户端回退到单独请求。
   */
  answers?: Record<string, AnswerValue>;
}

export function startResponse(surveyId: number, accessCode?: string): Promise<StartResponseDto> {
  // Retried: the server treats a repeated start as a resume of the same
  // in-progress response (and resolves the double-tap race), so a re-send costs
  // nothing while a dropped one blocks the participant at the door.
  return request<StartResponseDto>(
    `/api/survey/${surveyId}/responses`,
    {
      method: "POST",
      body: JSON.stringify(accessCode ? { accessCode } : {}),
    },
    { retries: 2 },
  );
}

export function fetchAnswers(surveyId: number, responseId: number): Promise<{ answers: Record<string, AnswerValue> }> {
  return request<{ answers: Record<string, AnswerValue> }>(
    `/api/survey/${surveyId}/responses/${responseId}`,
    undefined,
    { retries: 2 },
  );
}

export function saveAnswer(
  surveyId: number,
  responseId: number,
  questionId: number,
  value: AnswerValue,
): Promise<{ ok: boolean }> {
  // Retried: an idempotent upsert of the participant's own answer, so a re-send
  // is free and the alternative is a blocked "下一题" button. `keepalive` lets
  // the save that is in flight when the tab closes (or the Mini App navigates
  // away) finish server-side — the optimistic save queue fires exactly such
  // requests from its pagehide flush.
  return request<{ ok: boolean }>(
    `/api/survey/${surveyId}/responses/${responseId}/answers`,
    {
      method: "POST",
      body: JSON.stringify({ questionId, value }),
      keepalive: true,
    },
    { retries: 2 },
  );
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
  /** 报告 PDF 下载地址（服务端用同一 token 派生；完成页的「下载报告」按钮使用）。 */
  reportPdfUrl?: string;
  galleryPublished?: boolean;
  telegramPublicationQueued?: boolean;
  newAchievements?: UnlockedAchievement[];
}> {
  // One retry, network failures included: submission is guarded server-side
  // (an already-completed response answers with the same success shape), and a
  // submission lost on a bad link is the one failure the participant cannot
  // recover from without re-sending everything.
  return request<{
    ok: boolean;
    completed: boolean;
    reportUrl?: string;
    reportPdfUrl?: string;
    galleryPublished?: boolean;
    newAchievements?: UnlockedAchievement[];
  }>(
    `/api/survey/${surveyId}/responses/${responseId}/submit`,
    { method: "POST", body: JSON.stringify(options) },
    { retries: 1 },
  );
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

// ---- 金币经济（账户 / 签到 / 挑战 / 解锁 / 抽卡 / 投稿） ----------------

export interface CoinCheckinStatus {
  checkedInToday: boolean;
  streak: number;
  todayAmount: number | null;
  nextAmount: number;
  today: string;
  ladder: Array<{ minStreak: number; amount: number }>;
  days?: string[];
  backfill?: { enabled: boolean; cost: number; maxDays: number };
}

export interface CoinOverview {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  checkin: CoinCheckinStatus;
  earnedToday: number;
  dailyRewardCap: number;
  features: { checkin: boolean; challenges: boolean; gacha: boolean; submissions: boolean };
}

export interface CoinTransactionDto {
  id: number;
  amount: number;
  balanceAfter: number;
  kind: string;
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
}

export interface CoinChallengeDto {
  id: number;
  code: string;
  title: string;
  description: string;
  icon: string;
  goalType: string;
  goalTarget: number;
  reward: number;
  period: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  withinWindow: boolean;
}

export interface CoinUnlockDto {
  surveyId: number;
  surveyTitle: string | null;
  pricePaid: number;
  createdAt: string;
}

export interface GachaPoolDto {
  slug: string;
  name: string;
  description: string;
  costSingle: number;
  costMulti: number | null;
  endAt: string | null;
  pityAt: number | null;
}

export interface GachaPoolDetail {
  pool: GachaPoolDto;
  items: Array<{
    id: number;
    title: string;
    description: string;
    contentType: string;
    rarity: string;
    rate: number;
    soldOut: boolean;
  }>;
  rules: { currency: string; access: string; pity: string | null };
}

export interface GachaPullResult {
  ok: boolean;
  duplicate: boolean;
  results: Array<{ itemId: number; rarity: string; title: string; contentType: string; pity: boolean }>;
  balance: number;
}

export interface GachaCollectionItem {
  pullId: number;
  poolId: number;
  poolName: string;
  itemId: number;
  rarity: string;
  accessType: string;
  createdAt: string;
  title: string;
  description: string;
  contentType: string;
  previewMediaId: number | null;
  submissionId: number | null;
  isOwn: number;
}

export interface SubmissionDto {
  id: number;
  type: string;
  title: string;
  description: string | null;
  status: string;
  qualityTier: number | null;
  rewardAmount: number | null;
  reviewNote: string | null;
  mediaAssetId: number | null;
  thumbMediaAssetId?: number | null;
  mediaDurationSeconds?: number | null;
  createdAt: string;
}

export interface MySurveyResponseOption {
  id: number;
  surveyTitle: string;
  completedAt: string | null;
}

function coinRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

export const coinApi = {
  overview: () => coinRequest<CoinOverview>("/api/coins/overview"),
  checkin: () => coinRequest<{ ok: boolean; duplicate: boolean; amount: number; streak: number; balance: number }>("/api/coins/checkin", { method: "POST", body: "{}" }),
  transactions: (page: number) =>
    coinRequest<{ items: CoinTransactionDto[]; hasMore: boolean; page: number }>(`/api/coins/transactions?page=${page}`),
  challenges: () => coinRequest<{ challenges: CoinChallengeDto[] }>("/api/coins/challenges"),
  claimChallenge: (id: number) =>
    coinRequest<{ ok: boolean; duplicate: boolean; reward: number; balance: number }>(`/api/coins/challenges/${id}/claim`, { method: "POST", body: "{}" }),
  unlock: (surveyId: number, idempotencyKey: string) =>
    coinRequest<{ ok: boolean; required: boolean; duplicate: boolean; pricePaid: number; balance?: number }>(
      `/api/coins/unlock/${surveyId}`,
      { method: "POST", body: JSON.stringify({ idempotencyKey }) },
    ),
  pools: () => coinRequest<{ pools: GachaPoolDto[] }>("/api/gacha/pools"),
  pool: (slug: string) => coinRequest<GachaPoolDetail>(`/api/gacha/pools/${encodeURIComponent(slug)}`),
  pull: (slug: string, count: number, idempotencyKey: string) =>
    coinRequest<GachaPullResult>(`/api/gacha/pools/${encodeURIComponent(slug)}/pull`, {
      method: "POST",
      body: JSON.stringify({ count, idempotencyKey }),
    }),
  collection: () => coinRequest<{ items: GachaCollectionItem[] }>("/api/gacha/collection"),
  backfillCheckin: (day: string) =>
    coinRequest<{ ok: boolean; duplicate: boolean; day: string; cost: number; balance: number; streak: number }>(
      "/api/coins/checkin/backfill",
      { method: "POST", body: JSON.stringify({ day }) },
    ),
  itemContent: (itemId: number) =>
    coinRequest<{
      id: number;
      title: string;
      description: string;
      contentType: string;
      text?: string;
      mediaUrl?: string;
      previewUrl?: string | null;
      durationSeconds?: number;
      reportUrl?: string;
      summary?: string;
    }>(
      `/api/gacha/items/${itemId}/content`,
    ),
  mySubmissions: () => coinRequest<{ submissions: SubmissionDto[] }>("/api/submissions"),
  createSubmission: (body: Record<string, unknown>) =>
    coinRequest<{ id: number; status: string; duplicate: boolean }>("/api/submissions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createSubmissionWithFile: (form: FormData) =>
    coinRequest<{ id: number; status: string; duplicate: boolean }>("/api/submissions", { method: "POST", body: form }),
  withdraw: (id: number) => coinRequest<{ ok: boolean }>(`/api/submissions/${id}/withdraw`, { method: "POST", body: "{}" }),
  unlockables: () => coinRequest<{ unlocks: CoinUnlockDto[] }>("/api/coins/unlocks"),
};

/** 供解锁门使用的幂等键：每 (用户, 问卷) 一次随机生成、保存在 sessionStorage。 */
export function coinUnlockKey(surveyId: number): string {
  const storageKey = `coin-unlock-key:${surveyId}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const generated = `web-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return `web-${crypto.randomUUID()}`;
  }
}
