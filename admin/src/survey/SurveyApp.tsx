import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogs } from "../components/Dialogs";
import type { FocusEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Coins,
  Download,
  Home,
  Lock,
  MailCheck,
  Palette,
  Paperclip,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
  Star,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { SpriteLayer } from "./SpriteLayer";
import { closeWebApp } from "./navigation";
import { resolveBgmUrl, resolveSprite } from "../../../src/survey/theme";
import { BottomNav } from "./BottomNav";
import {
  isValidPresetId,
  loadGlobalPreset,
  PresetSwatch,
  resolvePresetId,
  saveGlobalPreset,
  SURVEY_THEME_PRESETS,
  themeBackgroundStyle,
  themeCssVars,
  ThemePickerSheet,
  useResolvedPreset,
} from "./theme-ui";
import {
  type AnswerValue,
  fetchAnswers,
  coinApi,
  confirmAgeVerification,
  createReportShare,
  revokeReportShare,
  fetchSurvey,
  fetchSurveyList,
  fetchParticipantLinkStartUrl,
  fetchParticipantLinkStatus,
  getParticipantKey,
  hasTelegramIdentity,
  type ParticipantLinkStatus,
  type StartResponseDto,
  type SurveyListItem,
  type SurveyThemeDto,
  type SurveyDto,
  type SurveyQuestionDto,
  type UnlockedAchievement,
  saveAnswer,
  startResponse,
  submitResponse,
  uploadAnswerMedia,
  verifyAccessCode,
} from "./api";
import { safeGet, safeSet } from "./storage";
import { AnswerSaveQueue } from "./save-queue";
import { collectQuestionImageUrls, preloadImages } from "./media-preload";

/**
 * 非答题界面的按需加载。
 *
 * 这些屏幕（金币经济、广场、展示区、挑战、我的、邮箱登录）共用问卷 SPA 的
 * 入口，但都不是「打开问卷 → 答第一题」路径上的东西：此前静态 import 把
 * ~3600 行界面塞进首屏关键依赖图，答题者要为用不到的代码付下载与解析时间。
 * 全部改为路由命中时动态加载；金币门（CoinGateScreen）同样按需——它是
 * 受限问卷的入口屏，短暂 fallback 无碍。
 */
const PlazaScreen = lazy(() => import("./PlazaScreen").then((m) => ({ default: m.PlazaScreen })));
const MyScreen = lazy(() => import("./MyScreen").then((m) => ({ default: m.MyScreen })));
const CoinsScreen = lazy(() => import("./CoinCenter").then((m) => ({ default: m.CoinsScreen })));
const GachaScreen = lazy(() => import("./CoinCenter").then((m) => ({ default: m.GachaScreen })));
const SubmissionsScreen = lazy(() => import("./CoinCenter").then((m) => ({ default: m.SubmissionsScreen })));
const CoinGateScreen = lazy(() => import("./CoinCenter").then((m) => ({ default: m.CoinGateScreen })));
const ShowcaseScreen = lazy(() => import("./ShowcaseScreen").then((m) => ({ default: m.ShowcaseScreen })));
const TrialScreen = lazy(() => import("./TrialScreen").then((m) => ({ default: m.TrialScreen })));
const SeriesScreen = lazy(() => import("./SeriesScreen").then((m) => ({ default: m.SeriesScreen })));
const EmailAuthScreen = lazy(() => import("./EmailAuthScreen").then((m) => ({ default: m.EmailAuthScreen })));

/** 懒加载屏幕的极简占位：整屏高度居中，避免布局跳动。 */
function LazyScreen({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-dvh place-items-center text-sm text-[var(--color-muted)]">加载中…</div>
      }
    >
      {children}
    </Suspense>
  );
}

const COMPLETED_SURVEYS_KEY = "surveyCompletedIds:v1";

/** Local "已填过" markers — best-effort hints for the list, not an authority. */
function getCompletedSurveyIds(): number[] {
  const raw = safeGet(COMPLETED_SURVEYS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function markSurveyCompleted(surveyId: number): void {
  const ids = getCompletedSurveyIds();
  if (!ids.includes(surveyId)) {
    safeSet(COMPLETED_SURVEYS_KEY, JSON.stringify([...ids.slice(-99), surveyId]));
  }
}

function botHandleFromUrl(url: string | null): string {
  if (!url) return "投稿机器人";
  const match = url.match(/t\.me\/([A-Za-z0-9_]+)/);
  return match ? `@${match[1]}` : "投稿机器人";
}
import { identityHeaders } from "./api";

import {
  configureSfx,
  playSfx,
  preloadSfx,
  registerSfxMusic,
  setSfxEnabled,
  sfxEnabled,
  subscribeSfxEnabled,
} from "./sfx";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        close?: () => void;
      };
    };
  }
}

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "age-gate" }
  | { kind: "auth-required" }
  | { kind: "access"; survey: SurveyDto }
  | { kind: "coin-gate"; survey: SurveyDto }
  | {
      kind: "filling";
      survey: SurveyDto;
      responseId: number;
      currentQuestionId: number | null;
      answers: Record<number, AnswerValue>;
    }
  | {
      kind: "done";
      survey: SurveyDto;
      reportUrl?: string;
      /** 报告 PDF 直链（与 reportUrl 同 token），完成页的「下载报告」用。 */
      reportPdfUrl?: string;
      profileUrl?: string;
      /** 提交那一刻新解锁的徽章（服务端判定），用于在完成页做一次庆祝。 */
      newAchievements?: UnlockedAchievement[];
    };

/**
 * VN 打字机（P2）：逐字展现文本，点击立即补全；respect prefers-reduced-motion
 * （系统减少动效时直接整段显示）。仅在问卷主题显式开启 vn 时使用。
 */
function Typewriter({ text, enabled, className }: { text: string; enabled: boolean; className?: string }) {
  const [shown, setShown] = useState(() => (enabled ? 0 : text.length));
  const doneRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      setShown(text.length);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text.length);
      return;
    }
    setShown(0);
    doneRef.current = false;
    const timer = window.setInterval(() => {
      setShown((current) => {
        if (current >= text.length) {
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, 28);
    return () => window.clearInterval(timer);
  }, [text, enabled]);
  const complete = () => setShown(text.length);
  return (
    <span className={className} onClick={complete} role={enabled && shown < text.length ? "button" : undefined}>
      {text.slice(0, shown)}
      {enabled && shown < text.length ? <span className="animate-pulse">▌</span> : null}
    </span>
  );
}

/**
 * 结局卡分享（0081）：完成页/「我的」里的分享入口。创建是幂等的——同一份
 * 答卷反复点击拿到的都是同一个链接；撤销只影响今后的访问。
 * 公开内容固定为「结局名 + 卷名」，答案永远不出现在分享卡上。
 */
function ShareEndingCard({ responseId }: { responseId: number }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createReportShare(responseId);
      const absolute = new URL(result.share.url, window.location.origin).toString();
      setShareUrl(absolute);
    } catch {
      // 创建失败安静回退：按钮回到初始态，用户可以再点。
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await revokeReportShare(responseId);
      setShareUrl(null);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（HTTP 域/旧 WebView）：链接文本本身可见，可手动复制。
    }
  };
  if (!shareUrl) {
    return (
      <div className="mt-4 flex flex-col items-center gap-1.5">
        <button type="button" className="btn px-6" disabled={busy} onClick={create}>
          <Share2 className="h-4 w-4" />
          {busy ? "生成中…" : "生成结局分享卡"}
        </button>
        <p className="text-[11px] text-[var(--survey-muted)]">公开结局名与卷名，不会公开你的答案</p>
      </div>
    );
  }
  return (
    <div className="mt-4 w-full max-w-sm rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-5 py-4">
      <p className="text-sm font-semibold text-[var(--survey-heading)]">结局分享卡已生成</p>
      <p className="mt-1.5 break-all rounded-lg bg-black/5 px-2.5 py-1.5 text-[11px] text-[var(--survey-muted)]">
        {shareUrl}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className="btn btn-primary px-5" onClick={copy}>
          {copied ? "已复制" : "复制链接"}
        </button>
        <button type="button" className="btn px-4 text-sm" disabled={busy} onClick={revoke}>
          撤销分享
        </button>
      </div>
    </div>
  );
}

/**
 * 路线感知的进度（P1.5）：分支问卷的线性百分比会跳变（33%→67%），改为沿
 * 真实跳转链重放整条路线，按「该路线上的作答步数」计算。
 *
 * - 复用答题侧同一套 nextIndex（选项跳转 / answerRules / flagJumps）；
 * - 剧情文段不占步数（与旧行为一致）；
 * - 答案变化会改变后续路线 → 用 useMemo 跟随 answers 重算。
 */
function routeProgress(
  questions: SurveyQuestionDto[],
  currentIndex: number,
  answers: Record<number, AnswerValue>,
): { done: number; total: number; percent: number } {
  // 1. 从头重放路线，得到按顺序访问的节点序列（含当前节点）。
  const walked: number[] = [];
  let cursor = 0;
  for (let guard = 0; cursor < questions.length && guard <= questions.length + 4; guard += 1) {
    walked.push(cursor);
    const next = nextIndex(questions, cursor, answers);
    if (next <= cursor) break;
    cursor = next;
  }
  // 2. 路线总步数 = 路线上需要作答的题；已完成 = 当前位置之前的作答步。
  const currentIndexInWalk = Math.max(0, walked.lastIndexOf(Math.min(currentIndex, questions.length - 1)));
  let total = 0;
  let done = 0;
  for (let position = 0; position < walked.length; position += 1) {
    const question = questions[walked[position]!]!;
    if (question.type === "note") continue;
    total += 1;
    if (position < currentIndexInWalk || (position === currentIndexInWalk && currentIndex !== 0)) {
      // 当前节点之前的作答步全部计入；当前节点在提交前不计，避免首题 100%。
      done += 1;
    }
  }
  // 兜底：重放被守卫截断（异常条件环）时退回线性计数。
  if (total === 0) {
    const answerable = questions.filter((item) => item.type !== "note").length;
    return { done: Math.min(currentIndex, answerable), total: answerable, percent: 0 };
  }
  const percent = Math.round((done / total) * 100);
  return { done, total, percent };
}

/**
 * 注册墙登录门（产品决策）：填卷要求邮箱注册或 Telegram 身份。未登录用户
 * 从这里去 /auth 登录，登录态存在 localStorage，回来点「重试」直接续上。
 */
function AuthRequiredScreen({ onRetry }: { onRetry: () => void }) {
  const hasEmailSession = typeof localStorage !== "undefined" && Boolean(localStorage.getItem("emailSessionToken"));
  return (
    <div className="mx-auto max-w-xl px-5 py-16 text-center">
      <p className="text-5xl">🔐</p>
      <h1 className="mt-4 text-lg font-semibold">注册或登录后开始填写</h1>
      <p className="mt-3 text-sm opacity-70">
        填写问卷需要一个账号（邮箱即可）：这样你的答卷进度、结局收集和追更通知都能找回，换设备也不会丢。
        用 Telegram 打开则自动使用 TG 身份。
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <a className="btn btn-primary px-8" href="/auth">
          {hasEmailSession ? "登录状态已过期，重新登录" : "注册 / 登录"}
        </a>
        <button type="button" className="btn px-6" onClick={onRetry}>
          我已完成登录，重试
        </button>
      </div>
    </div>
  );
}

/**
 * r18 年龄确认门（0080）：确认走 /api/me/preferences，成功后由父级重试加载。
 * 独立组件——hooks 不能出现在条件分支里。
 */
function AgeGateScreen({ onConfirmed }: { onConfirmed: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const confirmAge = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      await confirmAgeVerification();
      onConfirmed();
    } catch {
      setConfirming(false);
    }
  };
  return (
    <div className="mx-auto max-w-xl px-5 py-16 text-center">
      <p className="text-5xl">🔞</p>
      <h1 className="mt-4 text-lg font-semibold">该内容为 18+ 内容</h1>
      <p className="mt-3 text-sm opacity-70">
        此问卷包含成人内容，仅限已满 18 周岁的访问者查看。确认后本次设备将记住你的选择。
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <button type="button" className="btn btn-primary px-8" disabled={confirming} onClick={confirmAge}>
          {confirming ? "确认中…" : "我已满 18 周岁，继续访问"}
        </button>
        <a className="btn px-6" href="/s">
          <Home className="h-4 w-4" />
          返回问卷列表
        </a>
      </div>
    </div>
  );
}

function surveyIdFromPath(): number {
  const match = window.location.pathname.match(/^\/s\/(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function closeSurveyPage(): void {
  // Leaving is delegated to the shared helper: it only lets the Telegram bridge
  // take over when the page really runs inside Telegram. The SDK object is also
  // installed in a plain browser tab, where its `close()` posts to a host that
  // is not listening — that used to make "确定退出" look like a dead button.
  closeWebApp();
}

function backSurveyPage(): void {
  // Browser back first (supports the mobile edge-swipe gesture and desktop
  // back button); falls back to the survey list when there is no history
  // (e.g. a deep link opened in the default browser).
  playSfx("cancel");
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = "/s";
}

function SurveyListPage() {
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [communityGroupUrl, setCommunityGroupUrl] = useState<string | null>(null);
  const [submissionBotUrl, setSubmissionBotUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"new" | "hot">("new");
  const [completedIds, setCompletedIds] = useState<number[]>(() => getCompletedSurveyIds());
  // 金币解锁状态：列表载荷是访客无关的（KV 缓存），解锁与否只能单独取。
  const [unlockedSurveyIds, setUnlockedSurveyIds] = useState<number[] | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themePreset, setThemePreset] = useState<string | null>(() => loadGlobalPreset());
  const [retryKey, setRetryKey] = useState(0);
  const resolvedPreset = useResolvedPreset(themePreset);

  const selectHomeTheme = (id: string | null) => {
    setThemePreset(id);
    setThemePickerOpen(false);
    saveGlobalPreset(id);
  };

  const homeTheme = resolvedPreset ? ({ preset: resolvedPreset } as Parameters<typeof themeCssVars>[0]) : null;

  useEffect(() => {
    let cancelled = false;
    fetchSurveyList(debouncedQuery)
      .then((data) => {
        if (cancelled) return;
        setSurveys(data.surveys);
        setCommunityGroupUrl(data.communityGroupUrl);
        setSubmissionBotUrl(data.submissionBotUrl);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setSurveys(null);
        setError(err instanceof Error ? err.message : "问卷加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, retryKey]);

  useEffect(() => {
    // 只在列表里确实存在金币解锁问卷时才查询解锁记录。
    if (!surveys?.some((survey) => survey.coinUnlock)) {
      setUnlockedSurveyIds(null);
      return;
    }
    let cancelled = false;
    coinApi
      .unlockables()
      .then((data) => {
        if (!cancelled) setUnlockedSurveyIds(data.unlocks.map((unlock) => unlock.surveyId));
      })
      .catch(() => {
        if (!cancelled) setUnlockedSurveyIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [surveys]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Every terminal state renders through the same shell, so the bottom
  // navigation is always reachable. The failure branch used to be a dead end:
  // a single flaky request left the visitor with a red line and no retry, and
  // no way to reach the challenge or plaza tabs without reloading the WebView.
  const shell = (content: React.ReactNode) => (
    <div
      className="survey-glow min-h-dvh pb-24"
      data-theme={resolvedPreset ?? undefined}
      style={{ ...themeCssVars(homeTheme), ...themeBackgroundStyle(homeTheme) }}
    >
      {content}
      <BottomNav />
    </div>
  );
  if (error) {
    return shell(
      <div className="mx-auto max-w-xl px-5 py-16 text-center">
        <p className="text-[var(--app-danger)]">{error}</p>
        <button
          type="button"
          className="survey-card mt-5 w-full py-3 text-sm font-semibold text-[var(--survey-heading)]"
          onClick={() => {
            setError(null);
            setRetryKey((key) => key + 1);
          }}
        >
          重新加载
        </button>
      </div>,
    );
  }
  if (!surveys) {
    return shell(
      <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷加载中…</div>,
    );
  }
  if (surveys.length === 0) {
    return shell(
      <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">
        {debouncedQuery ? (
          <>
            没有找到与「{debouncedQuery}」相关的问卷
            <button
              type="button"
              className="survey-card mt-5 w-full py-3 text-sm font-semibold text-[var(--survey-heading)]"
              onClick={() => setQuery("")}
            >
              清空搜索，看全部问卷
            </button>
          </>
        ) : (
          "当前没有可填写的问卷，过段时间再来看看"
        )}
      </div>,
    );
  }

  const orderedSurveys =
    sortOrder === "hot"
      ? [...surveys].sort((a, b) => (b.responseCount ?? 0) - (a.responseCount ?? 0))
      : surveys;

  return (
    <div
      className="survey-glow min-h-dvh pb-24"
      data-theme={resolvedPreset ?? undefined}
      style={{ ...themeCssVars(homeTheme), ...themeBackgroundStyle(homeTheme) }}
    >
      <header className="border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] px-5 pb-4 pt-7 backdrop-blur-md">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-[var(--color-ink)]">可填写问卷</h1>
              <p className="mt-1 text-sm text-[var(--color-muted)]">选择一份问卷，开始你的回答</p>
            </div>
            <div className="mt-1 flex shrink-0 items-center gap-1.5">
              <a href="/auth" aria-label="邮箱登录" title="邮箱登录" className="survey-icon-btn">
                <MailCheck className="h-4 w-4" />
              </a>
              <button
                type="button"
                aria-label="选择主题"
                title="选择主题"
                className="survey-icon-btn"
                onClick={() => setThemePickerOpen(true)}
              >
                <Palette className="h-4 w-4" />
              </button>
            </div>
          </div>
          <input
            type="search"
            className="input mt-4 w-full sm:max-w-md"
            placeholder="搜索问卷…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="mt-3 flex items-center gap-2">
            {(
              [
                { id: "new", label: "最新" },
                { id: "hot", label: "热门" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setSortOrder(option.id)}
                aria-pressed={sortOrder === option.id}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                  sortOrder === option.id
                    ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "text-[var(--color-muted)] hover:bg-[var(--survey-primary-soft)]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {communityGroupUrl ? (
            <a
              href={communityGroupUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              加入 Telegram 群聊，和大家交流
              <ArrowRight className="h-4 w-4" />
            </a>
          ) : null}
          {submissionBotUrl ? (
            <a
              href={submissionBotUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              <Send className="h-3.5 w-3.5" />
              投稿机器人 {botHandleFromUrl(submissionBotUrl)}，投稿给我
              <ArrowRight className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-5 pt-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orderedSurveys.map((survey) => {
            const isClosed = Boolean(survey.closedAt && new Date(survey.closedAt).getTime() < Date.now());
            const answered = completedIds.includes(survey.id);
            // 金币门：只有启用了金币解锁、且当前身份尚未解锁时才提示。
            const coinPrice = survey.coinUnlock?.price ?? null;
            const coinLocked =
              coinPrice !== null && !(unlockedSurveyIds ?? []).includes(survey.id);
            return (
              <a
                key={survey.id}
                href={`/s/${survey.id}`}
                className="survey-card block p-4 transition hover:-translate-y-0.5 hover:shadow-lg"
              >
                {survey.coverUrl ? (
                  <img
                    src={survey.coverUrl}
                    alt=""
                    className="mb-3 aspect-[16/7] w-full rounded-xl object-cover"
                    loading="lazy"
                    onError={(event) => {
                      // 封面失效时直接隐藏，避免公开页出现破图
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-[17px] font-semibold leading-snug text-[var(--color-ink)]">{survey.title}</h2>
                  {survey.contentRating === "r18" ? (
                    <span className="badge shrink-0 bg-red-600 text-white">18+</span>
                  ) : null}
                  {survey.accessCodeRequired ? (
                    <span className="badge badge-amber shrink-0">
                      <Lock className="h-3 w-3" />
                      需密码
                    </span>
                  ) : null}
                  {coinPrice !== null ? (
                    <span className={`badge shrink-0 ${coinLocked ? "badge-amber" : "badge-green"}`}>
                      <Coins className="h-3 w-3" />
                      {coinPrice > 0 ? `${coinPrice} 金币` : "限时免费"}
                    </span>
                  ) : null}
                </div>
                {survey.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{survey.description}</p>
                ) : null}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="chip text-xs">{survey.questionCount} 道题</span>
                  {survey.anonymous ? <span className="chip text-xs">🎭 匿名</span> : null}
                  {isClosed ? (
                    <span className="chip text-xs text-[var(--color-muted)]">已截止</span>
                  ) : null}
                  {coinPrice !== null && !coinLocked ? (
                    <span className="chip text-xs text-[var(--color-muted)]">已解锁</span>
                  ) : null}
                  {answered ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--survey-primary-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--survey-primary)]">
                      <Check className="h-3 w-3" />
                      已填过
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-[var(--color-muted)]">
                    {(survey.responseCount ?? 0) > 0 ? `${survey.responseCount} 份答卷` : "期待第一份回答"}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-xl px-3.5 py-2 text-sm font-medium shadow-md transition-transform"
                    style={{
                      backgroundColor: isClosed ? "var(--color-muted)" : "var(--survey-primary)",
                      color: isClosed ? "var(--survey-card-bg)" : "var(--survey-primary-content)",
                    }}
                  >
                    {isClosed
                      ? "已截止"
                      : coinLocked
                        ? coinPrice > 0
                          ? "解锁填写"
                          : "免费领取"
                        : survey.accessCodeRequired
                          ? "输入密码"
                          : "开始填写"}
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      </main>
      <ThemePickerSheet
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        selected={themePreset}
        onSelect={selectHomeTheme}
      />
      <BottomNav />
    </div>
  );
}

function TelegramLinkCard() {
  const [participantKey] = useState<string | null>(() => (hasTelegramIdentity() ? null : getParticipantKey()));
  const [linked, setLinked] = useState<ParticipantLinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkToken, setCheckToken] = useState(0);

  useEffect(() => {
    if (!participantKey) return;
    let cancelled = false;
    fetchParticipantLinkStatus(participantKey)
      .then((result) => {
        if (!cancelled && result.linked) setLinked(result);
      })
      .catch(() => {
        // A failed status check should never block the completion page.
      });
    return () => {
      cancelled = true;
    };
  }, [participantKey, checkToken]);

  if (!participantKey) return null;

  const openTelegram = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await fetchParticipantLinkStartUrl(participantKey);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法生成绑定链接，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const displayName = linked?.username
    ? `@${linked.username}`
    : linked?.firstName || (linked?.telegramUserId ? String(linked.telegramUserId) : "");

  return (
    <div className="mt-4 w-full max-w-sm rounded-2xl border border-dashed border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-5 py-4">
      <p className="text-sm font-semibold text-[var(--survey-heading)]">🔗 把答卷关联到 Telegram？</p>
      <p className="mt-1 text-xs leading-5 text-[var(--survey-muted)]">
        绑定后，这个浏览器填写的答卷会归到你的 Telegram 账号下，方便你以后查看与找回。 不绑定也完全不影响本次填写。
      </p>
      {linked?.linked ? (
        <p className="mt-3 rounded-xl bg-[var(--survey-primary-soft)] px-3 py-2 text-xs font-medium text-[var(--survey-primary)]">
          ✅ 已绑定{displayName ? `：${displayName}` : ""}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary px-5" disabled={busy} onClick={() => void openTelegram()}>
              <Users className="h-4 w-4" />
              {busy ? "生成链接中…" : "在 Telegram 中打开绑定"}
            </button>
            <button type="button" className="btn px-4" onClick={() => setCheckToken((value) => value + 1)}>
              我已绑定，检查状态
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--survey-muted)]">
            打开 Telegram 后点击「开始」即完成绑定，再回到本页点「检查状态」。
          </p>
          {error ? <p className="mt-2 text-xs text-[var(--app-danger)]">{error}</p> : null}
        </>
      )}
    </div>
  );
}

function selectedOptionId(question: SurveyQuestionDto, value: AnswerValue | undefined): number | null {
  if (typeof value !== "number") return null;
  return question.options.some((option) => option.id === value) ? value : null;
}

/** 剧情 flags（P2）：与服务端 engine.computeFlags 同构，由答案推导。 */
function computeFlags(
  questions: SurveyQuestionDto[],
  answers: Record<number, AnswerValue>,
): Map<string, number> {
  const flags = new Map<string, number>();
  for (const question of questions) {
    const condition = question.condition as { flagRules?: unknown } | null;
    if (!condition || !Array.isArray(condition.flagRules)) continue;
    for (const rule of condition.flagRules as Array<{ questionId?: unknown; equals?: unknown; flag?: unknown; score?: unknown }>) {
      const flag = typeof rule.flag === "string" ? rule.flag : null;
      if (!flag) continue;
      const value = answers[Number(rule.questionId)];
      if (value === undefined || value === null) continue;
      if (Number(rule.equals) !== Number(value)) continue;
      const score = Number(rule.score);
      flags.set(flag, (flags.get(flag) ?? 0) + (Number.isFinite(score) ? score : 1));
    }
  }
  return flags;
}

function nextIndex(questions: SurveyQuestionDto[], currentIndex: number, answers: Record<number, AnswerValue>): number {
  if (currentIndex >= questions.length - 1) return questions.length;
  const current = questions[currentIndex];
  if (!current) return currentIndex + 1;
  const flags = computeFlags(questions, answers);
  if (current.condition) {
    try {
      const selected = selectedOptionId(current, answers[current.id]);
      if (selected !== null) {
        const rules = Array.isArray(current.condition.rules)
          ? (current.condition.rules as Array<{ optionId?: unknown; targetQuestionId?: unknown }>)
          : current.condition.kind === "option_equals" && current.condition.optionId !== undefined
            ? [{ optionId: current.condition.optionId, targetQuestionId: current.skipToQuestionId }]
            : [];
        const rule = rules.find((item) => Number(item.optionId) === selected);
        const targetId = rule?.targetQuestionId !== undefined ? Number(rule.targetQuestionId) : null;
        if (targetId !== null && Number.isInteger(targetId) && targetId > 0) {
          const targetIndex = questions.findIndex((question) => question.id === targetId);
          if (targetIndex > currentIndex) return targetIndex;
        }
      }
      // State-driven jumps (answerRules) evaluate accumulated answers and also
      // fire on note questions, letting narrative cards branch on prior choices.
      const answerRules = (current.condition as { answerRules?: unknown }).answerRules;
      if (Array.isArray(answerRules)) {
        for (const rule of answerRules as Array<{ questionId?: unknown; equals?: unknown; targetQuestionId?: unknown }>) {
          const value = answers[Number(rule.questionId)];
          if (value === undefined || value === null) continue;
          if (Number(rule.equals) !== Number(value)) continue;
          const targetId = Number(rule.targetQuestionId);
          if (Number.isInteger(targetId) && targetId > 0) {
            const targetIndex = questions.findIndex((question) => question.id === targetId);
            if (targetIndex > currentIndex) return targetIndex;
          }
        }
      }
      // flags 路线锁定（P2）：与服务端同一语义——门槛达成即向前跳。
      const flagJumps = (current.condition as { flagJumps?: unknown }).flagJumps;
      if (Array.isArray(flagJumps)) {
        for (const jump of flagJumps as Array<{ flag?: unknown; gte?: unknown; targetQuestionId?: unknown }>) {
          const flag = typeof jump.flag === "string" ? jump.flag : null;
          if (!flag) continue;
          const threshold = Number(jump.gte);
          if (!Number.isFinite(threshold)) continue;
          if ((flags.get(flag) ?? 0) < threshold) continue;
          const targetId = Number(jump.targetQuestionId);
          if (Number.isInteger(targetId) && targetId > 0) {
            const targetIndex = questions.findIndex((question) => question.id === targetId);
            if (targetIndex > currentIndex) return targetIndex;
          }
        }
      }
    } catch {
      // malformed condition falls back to linear order
    }
  }
  return currentIndex + 1;
}

function validateQuestion(question: SurveyQuestionDto, value: AnswerValue | undefined): string | null {
  const validation = question.validation ?? {};
  // Text inputs settle at "" while the participant types; a blank string must
  // count as unanswered, otherwise required text questions can be skipped.
  const isBlank = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  if (question.required && isBlank) {
    return "此题必答";
  }
  if (isBlank) return null;
  if (question.type === "text" || question.type === "long_text") {
    if (typeof value !== "string") return "答案格式无效";
    const minLength = Number(validation.min_length ?? 0);
    const maxLength = Number(validation.max_length ?? Infinity);
    if (value.length < minLength) return `至少需要 ${minLength} 个字符`;
    if (value.length > maxLength) return `最多 ${maxLength} 个字符`;
  }
  if (question.type === "number" && typeof value === "number") {
    if (validation.min !== undefined && value < Number(validation.min)) return `不能小于 ${validation.min}`;
    if (validation.max !== undefined && value > Number(validation.max)) return `不能大于 ${validation.max}`;
  }
  if (question.type === "multiple" && Array.isArray(value)) {
    const minSelections = Number(validation.min_selections ?? 1);
    const maxSelections = Number(validation.max_selections ?? Infinity);
    if (value.length < minSelections) return `请至少选择 ${minSelections} 项`;
    if (value.length > maxSelections) return `最多选择 ${maxSelections} 项`;
  }
  if (question.type === "matrix" && value && typeof value === "object" && !Array.isArray(value)) {
    const selections = value as Record<string, number>;
    if (question.required && question.options.some((option) => selections[String(option.id)] === undefined)) {
      return "请为每一行选择一个选项";
    }
  }
  return null;
}

/**
 * 公开问卷媒体（题面/选项配图）直接走 URL：/api/survey/media/:id 对 survey
 * 范围资产不需要任何身份头，原生 `<img src>` 因此能用上浏览器 HTTP 缓存
 * （survey 资产是一年 immutable）、渐进解码和 `new Image()` 预热——旧实现的
 * `fetch → blob → objectURL` 三件套把这些全绕开了，还把参与者的 Telegram
 * initData 发给一个不需要它的端点。答卷上传预览（response 范围）仍走下面的
 * `AuthenticatedMedia`。
 */
function PublicImage({ url, alt, cover }: { url: string; alt?: string; cover?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className={`grid place-items-center rounded-lg bg-[var(--surface-muted)] text-xs text-[var(--color-muted-soft)] ${
          cover ? "absolute inset-0" : "h-24"
        }`}
      >
        图片加载失败
      </div>
    );
  }
  return (
    <img
      className={cover ? "absolute inset-0 h-full w-full object-cover" : "w-full rounded-lg"}
      src={url}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function MediaBlock({
  urls,
  type,
  cover,
}: {
  urls: Array<{ url: string; alt?: string }>;
  type: string;
  cover?: boolean;
}) {
  if (urls.length === 0) return null;
  if (cover) {
    return <PublicImage key={urls[0]?.url ?? 0} url={urls[0]!.url} alt={urls[0]!.alt} cover />;
  }
  return (
    <div className="mt-3 grid gap-2">
      {urls.map((media, index) => {
        if (type === "video") {
          return <video key={index} className="w-full rounded-lg bg-black" src={media.url} controls preload="metadata" />;
        }
        if (type === "audio") {
          return <audio key={index} className="w-full" src={media.url} controls preload="none" />;
        }
        return <PublicImage key={index} url={media.url} alt={media.alt} />;
      })}
    </div>
  );
}

/**
 * 私有媒体的加载通道（答卷上传预览等 response 范围资产）：这些请求必须携带
 * 参与者身份头，`<img src>` 做不到，所以保留 `fetch → blob → objectURL`。
 * 公开问卷媒体不要走这里——用 MediaBlock / PublicImage 的原生 URL 通道。
 */
function AuthenticatedMedia({
  url,
  kind,
  cover,
  alt,
  className,
}: {
  url: string;
  kind: "image" | "video" | "audio";
  cover?: boolean;
  alt?: string;
  /** 覆盖非 cover 图片的默认样式（缩略图等场景）。 */
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    fetch(url, { headers: identityHeaders() })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const blob = await response.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  if (failed) {
    return (
      <div className="rounded-lg bg-[var(--surface-muted)] p-4 text-center text-xs text-[var(--color-muted-soft)]">
        媒体加载失败
      </div>
    );
  }
  if (!objectUrl) {
    return (
      <div className={`animate-pulse bg-[var(--surface-muted)] ${cover ? "absolute inset-0" : "h-24 rounded-lg"}`} />
    );
  }
  if (kind === "video") {
    return <video className="w-full rounded-lg bg-black" src={objectUrl} controls />;
  }
  if (kind === "audio") {
    return <audio className="w-full" src={objectUrl} controls />;
  }
  return (
    <img
      className={cover ? "absolute inset-0 h-full w-full object-cover" : (className ?? "w-full rounded-lg")}
      src={objectUrl}
      alt={alt ?? ""}
      loading="lazy"
    />
  );
}

function ExpandableText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.split("\n").length > 3;
  return (
    <div>
      <p className={`${className ?? ""} ${!open && long ? "line-clamp-3" : ""}`}>{text}</p>
      {long ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-[var(--survey-primary)]"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起" : "展开全文"}
        </button>
      ) : null}
    </div>
  );
}

function BgmPlayer({ url }: { url: string }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Which track the audio element is currently pointed at (swaps are not free). */
  const loadedUrlRef = useRef<string | null>(null);
  // Survives src swaps: per-page BGM keeps playing across page changes.
  const playingRef = useRef(false);
  // 这个按钮是全站「声音开关」：同时管 BGM 与界面音效，状态存 localStorage。
  // 不新增第二个开关，也不把静音拆成两套互不一致的状态。
  const [soundOn, setSoundOn] = useState(() => sfxEnabled());

  useEffect(() => subscribeSfxEnabled(setSoundOn), []);

  /**
   * Attaches a track to the audio element — and only ever does that.
   *
   * The player used to `fetch()` the whole track into a blob when it mounted,
   * so simply opening a survey downloaded the survey's opening music (1.4MB in
   * the bundled story survey, ~10MB across its pages) whether or not the
   * participant ever turned sound on — bandwidth taken from the definition, the
   * scene images and every answer save on a cross-border mobile link. The
   * element now loads its source lazily, streams it, and lets the HTTP cache
   * (a year, immutable, for survey assets) do the storing; a plain `src` also
   * sends no identity headers, which is what the old blob dance was protecting.
   */
  const attach = useCallback((next: string): HTMLAudioElement => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audio.loop = true;
      audio.preload = "none";
      audioRef.current = audio;
      registerSfxMusic(audio);
    }
    if (loadedUrlRef.current !== next) {
      loadedUrlRef.current = next;
      audio.src = next;
    }
    return audio;
  }, []);

  const startPlayback = useCallback(
    (next: string) => {
      playingRef.current = true;
      setPlaying(true);
      const audio = attach(next);
      void audio.play().catch(() => {
        playingRef.current = false;
        setPlaying(false);
      });
    },
    [attach],
  );

  // 不做挂载自动播放：声音开关的存储值默认是「开」，照它自动起播等于每个第一次
  // 打开问卷的人都先下载一整首 BGM（本项目 1.4MB）——正是这次要消掉的带宽。
  // 开关的存储值仍然决定界面音效是否可用（sfx.ts）与按钮图标，音乐则只由用户
  // 明确点这一下开始；按钮一开始就显示为「开启声音」。

  // Track changes (per page, per question) while sound is on: swap and keep playing.
  useEffect(() => {
    if (!playingRef.current || !sfxEnabled()) return;
    startPlayback(url);
  }, [url, startPlayback]);

  // Unmount-only teardown: leaving the page (exit, back navigation, mini-app
  // close) never unmounts the tree React owns, so silence the track on
  // `pagehide` too: otherwise the audio keeps running until the document is
  // torn down and an entry restored from the back/forward cache resumes
  // mid-track.
  useEffect(() => {
    const stop = () => audioRef.current?.pause();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      audioRef.current?.pause();
      registerSfxMusic(null);
    };
  }, []);

  if (!url) return null;
  const toggle = () => {
    if (playing) {
      audioRef.current?.pause();
      playingRef.current = false;
      setPlaying(false);
      setSfxEnabled(false);
      return;
    }
    setSfxEnabled(true);
    // 首次真实手势：顺手把界面音效解码好（此处仍在手势调用栈内，
    // 满足浏览器的自动播放策略；失败也只是没有音效）。
    preloadSfx();
    startPlayback(url);
  };

  return (
    <button
      type="button"
      aria-label={playing ? "关闭声音" : "开启声音"}
      title={playing ? "关闭声音（背景音乐与界面音效）" : "开启声音（背景音乐与界面音效）"}
      onClick={toggle}
      className="fixed bottom-28 right-4 z-20 grid h-11 w-11 place-items-center rounded-full border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-lg shadow-lg"
    >
      {soundOn && playing ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
    </button>
  );
}

interface QuestionAnswerProps {
  question: SurveyQuestionDto;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  disabled: boolean;
}

function OptionCard({
  option,
  selected,
  multiple,
  disabled,
  onSelect,
}: {
  option: { id: number; label: string; media: Array<{ url: string }> };
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`group relative flex flex-col overflow-hidden rounded-[var(--survey-radius)] border text-left transition ${
        selected
          ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] ring-2 ring-[var(--survey-primary)]"
          : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
      }`}
    >
      {option.media.length ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden">
          <MediaBlock urls={option.media} type="image" cover />
          {selected ? (
            <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[var(--survey-primary)] text-[var(--survey-primary-content)] shadow">
              <Check className="h-4 w-4" strokeWidth={3} />
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2 p-2.5">
        <span
          className={`grid h-4.5 w-4.5 shrink-0 place-items-center border ${multiple ? "rounded" : "rounded-full"} ${
            selected
              ? "border-[var(--survey-primary)] bg-[var(--survey-primary)]"
              : "border-[var(--control-border)] bg-[var(--surface)]"
          }`}
        >
          {selected ? (
            multiple ? (
              <svg className="h-3 w-3 text-[var(--survey-primary-content)]" viewBox="0 0 12 12" fill="none">
                <path d="M2 6.5 4.5 9 10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--surface)]" />
            )
          ) : null}
        </span>
        <span className="min-w-0 text-sm font-medium text-[var(--survey-body)]">{option.label}</span>
      </div>
    </button>
  );
}

function QuestionAnswer({ question, value, onChange, disabled }: QuestionAnswerProps) {
  const { toast } = useDialogs();
  const [uploading, setUploading] = useState(false);

  // 每次「选项被按下」都先给一次轻点反馈（配置了 select 音效时）。
  // 走 click 而不是 pointerdown：鼠标 hover 不发声，避免择选过程变成噪音。
  const choose = useCallback(
    (next: AnswerValue) => {
      playSfx("select");
      onChange(next);
    },
    [onChange],
  );

  // Rating gets a star scale: the generic option list gave no visual sense of
  // "how much", and 1-5 options read like five unrelated choices.
  if (question.type === "rating") {
    const selectedId = typeof value === "number" ? value : null;
    const selectedIndex = selectedId !== null ? question.options.findIndex((option) => option.id === selectedId) : -1;
    const first = question.options[0]?.label ?? "";
    const last = question.options[question.options.length - 1]?.label ?? "";
    return (
      <div className="mt-4">
        <div className="flex items-center justify-between gap-1.5" role="radiogroup" aria-label={question.title}>
          {question.options.map((option, position) => {
            const active = selectedIndex >= 0 && position <= selectedIndex;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={value === option.id}
                disabled={disabled}
                onClick={() => choose(option.id)}
                className="flex flex-1 flex-col items-center gap-1 rounded-2xl border px-1 py-2.5 transition active:scale-95"
                style={
                  active
                    ? {
                        borderColor: "var(--survey-primary)",
                        backgroundColor: "var(--survey-primary-soft)",
                        color: "var(--survey-primary)",
                      }
                    : { borderColor: "var(--survey-card-border)", color: "var(--survey-muted)" }
                }
              >
                <Star className="h-6 w-6" strokeWidth={1.8} style={active ? { fill: "currentColor" } : undefined} />
                <span className="text-[11px] font-semibold">{option.label}</span>
              </button>
            );
          })}
        </div>
        {question.options.length >= 2 ? (
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--survey-muted)]">
            <span>{first}</span>
            <span>{last}</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (question.type === "single" || question.type === "yes_no" || question.type === "rating") {
    if (question.options.some((option) => option.media.length > 0)) {
      return (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {question.options.map((option) => (
            <OptionCard
              key={option.id}
              option={option}
              selected={value === option.id}
              multiple={false}
              disabled={disabled}
              onSelect={() => choose(option.id)}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="mt-4 grid gap-2">
        {question.options.map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => choose(option.id)}
              className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-left text-[15px] transition active:scale-[0.99] ${
                selected
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)] shadow-sm"
                  : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)]"
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                  selected
                    ? "border-[var(--survey-primary)] bg-[var(--survey-primary)]"
                    : "border-[var(--control-border)] bg-[var(--surface)]"
                }`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-[var(--surface)]" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                <MediaBlock urls={option.media} type="image" />
              </span>
              {selected ? <Check className="ml-auto mt-0.5 h-5 w-5 shrink-0" strokeWidth={2.5} /> : null}
            </button>
          );
        })}
      </div>
    );
  }

  if (question.type === "multiple") {
    const selected = Array.isArray(value) ? value : [];
    if (question.options.some((option) => option.media.length > 0)) {
      return (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {question.options.map((option) => {
            const checked = selected.includes(option.id);
            return (
              <OptionCard
                key={option.id}
                option={option}
                selected={checked}
                multiple
                disabled={disabled}
                onSelect={() =>
                  onChange(checked ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                }
              />
            );
          })}
        </div>
      );
    }
    return (
      <div className="mt-4 grid gap-2">
        {question.options.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => choose(checked ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
              className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-left text-[15px] transition active:scale-[0.99] ${
                checked
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)] shadow-sm"
                  : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)]"
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border ${
                  checked
                    ? "border-[var(--survey-primary)] bg-[var(--survey-primary)]"
                    : "border-[var(--control-border)] bg-[var(--surface)]"
                }`}
              >
                {checked ? (
                  <svg className="h-3 w-3 text-[var(--survey-primary-content)]" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6.5 4.5 9 10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                <MediaBlock urls={option.media} type="image" />
              </span>
              {checked ? <Check className="ml-auto mt-0.5 h-5 w-5 shrink-0" strokeWidth={2.5} /> : null}
            </button>
          );
        })}
      </div>
    );
  }

  if (question.type === "matrix") {
    const columns = Array.isArray(question.settings?.columns)
      ? (question.settings?.columns as string[]).filter((column) => typeof column === "string" && column.trim())
      : [];
    const selections =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : {};
    return (
      <div className="mt-4 overflow-x-auto rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]">
        <table className="w-full min-w-[300px] border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--surface-muted)] text-[var(--color-muted)]">
              <th className="px-3 py-2 text-left font-medium">行</th>
              {columns.map((column, columnIndex) => (
                <th key={`${column}-${columnIndex}`} className="px-3 py-2 text-center font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {question.options.map((row) => (
              <tr key={row.id} className="border-t border-[var(--color-edge-soft)]">
                <td className="px-3 py-2">{row.label}</td>
                {columns.map((_column, columnIndex) => {
                  const selected = selections[String(row.id)] === columnIndex;
                  return (
                    <td key={columnIndex} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          choose(
                            selected
                              ? Object.fromEntries(Object.entries(selections).filter(([key]) => key !== String(row.id)))
                              : { ...selections, [String(row.id)]: columnIndex },
                          )
                        }
                        aria-label={`${row.label} - ${_column}`}
                        className={`grid h-7 w-7 place-items-center rounded-full border ${
                          selected
                            ? "border-[var(--survey-primary)] bg-[var(--survey-primary)]"
                            : "border-[var(--control-border)] bg-[var(--surface)]"
                        }`}
                      >
                        {selected ? <span className="h-2 w-2 rounded-full bg-[var(--surface)]" /> : null}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (question.type === "text" || question.type === "long_text") {
    const maxLength = Number(question.validation?.max_length);
    const maxLengthAttr = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : undefined;
    const currentLength = typeof value === "string" ? value.length : 0;
    return question.type === "long_text" ? (
      <>
        <textarea
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder="请输入回答"
          maxLength={maxLengthAttr}
          className="input mt-4 min-h-36 w-full"
        />
        {maxLengthAttr ? (
          <p className={`mt-1 text-right text-[11px] ${currentLength > maxLengthAttr ? "text-[var(--app-danger)]" : "text-[var(--survey-muted)]"}`}>
            {currentLength}/{maxLengthAttr}
          </p>
        ) : null}
      </>
    ) : (
      <input
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请输入回答"
        maxLength={maxLengthAttr}
        className="input mt-4 w-full"
      />
    );
  }

  if (question.type === "number") {
    const min = Number(question.validation?.min);
    const max = Number(question.validation?.max);
    return (
      <input
        disabled={disabled}
        type="number"
        value={typeof value === "number" ? String(value) : ""}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        onChange={(event) => {
          if (event.target.value === "") {
            onChange(null);
            return;
          }
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        placeholder={
          Number.isFinite(min) && Number.isFinite(max)
            ? `请输入 ${min} – ${max} 之间的数字`
            : "请输入数字"
        }
        className="input mt-4 w-full"
      />
    );
  }

  if (question.type === "date" || question.type === "time") {
    return (
      <input
        disabled={disabled}
        type={question.type}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        className="input mt-4 w-full"
      />
    );
  }

  if (question.type === "image" || question.type === "video" || question.type === "audio" || question.type === "file") {
    const mediaAnswer =
      value && typeof value === "object" && !Array.isArray(value) ? (value as { mediaAssetId: number }) : null;
    const fileAccept =
      question.type === "image"
        ? "image/jpeg,image/png,image/webp"
        : question.type === "video"
          ? "video/mp4,video/webm,video/quicktime"
          : question.type === "audio"
            ? "audio/mpeg,audio/mp4,audio/wav,audio/ogg"
            : undefined;
    return (
      <div className="mt-4">
        {mediaAnswer ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--app-success)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--app-success)_12%,var(--surface))] px-4 py-3 text-sm text-[var(--app-success)]">
            <span className="flex min-w-0 items-center gap-3">
              {question.type === "image" ? (
                // 答卷上传是 response 范围的私有媒体：必须带身份头请求
                // （AuthenticatedMedia 的 blob 通道）。之前的裸 <img> 拿不到
                // 授权，缩略图一直是 403 后被 onError 静默藏掉的。
                <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg">
                  <AuthenticatedMedia
                    url={`/api/survey/media/${mediaAnswer.mediaAssetId}`}
                    alt=""
                    kind="image"
                    className="h-14 w-14 object-cover"
                  />
                </span>
              ) : null}
              <span className="min-w-0 truncate">已上传{question.type === "image" ? "图片" : "文件"}（#{mediaAnswer.mediaAssetId}）</span>
            </span>
            <button
              type="button"
              className="shrink-0 font-medium text-[var(--app-success)] underline"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              移除
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-10 text-sm text-[var(--survey-muted)] transition hover:border-[var(--survey-primary)]">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
              <Paperclip className="h-5 w-5" />
            </span>
            <span className="mt-3 font-medium">{uploading ? "上传中…" : "点击上传文件"}</span>
            <span className="mt-1 text-xs opacity-70">支持图片 / 视频 / 音频 / 文件</span>
            <input
              type="file"
              className="hidden"
              accept={fileAccept}
              disabled={disabled || uploading}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setUploading(true);
                try {
                  const result = await uploadAnswerMedia(surveyIdFromPath(), file, question.id);
                  onChange({ mediaAssetId: result.mediaAssetId });
                } catch (error) {
                  toast({ message: error instanceof Error ? error.message : "上传失败", variant: "error" });
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
        )}
      </div>
    );
  }

  return <input disabled className="input mt-4 w-full" placeholder="暂不支持该题型" />;
}

function AccessScreen({
  survey,
  onVerified,
}: {
  survey: SurveyDto;
  onVerified: (code: string, grant: string | null) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const grant = await verifyAccessCode(survey.id, code);
      onVerified(code, grant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "密码错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-5">
      <button
        type="button"
        aria-label="退出问卷"
        title="退出问卷"
        onClick={closeSurveyPage}
        className="survey-icon-btn absolute right-5 top-5"
      >
        <X className="h-5 w-5" />
      </button>
      <div className="survey-card p-6 text-center">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl shadow-lg"
          style={{
            backgroundColor: "var(--survey-primary)",
            color: "var(--survey-primary-content)",
            boxShadow: "0 16px 32px -12px color-mix(in srgb, var(--survey-primary) 45%, transparent)",
          }}
        >
          <Lock className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-[var(--color-ink)]">需要访问密码</h1>
        <p className="mt-1.5 truncate text-sm text-[var(--color-muted)]">「{survey.title}」已加密，输入访问密码后继续填写。</p>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder="访问密码"
          className="input mt-5 w-full text-center"
          autoFocus
        />
        {error ? <p className="mt-2 text-sm text-[var(--app-danger)]">{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="btn btn-primary mt-4 w-full disabled:opacity-50"
        >
          {busy ? (
            "验证中…"
          ) : (
            <>
              继续
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function SurveyApp() {
  // The plaza ("广场") shares this SPA bundle, entry styles and theme system.
  if (window.location.pathname === "/series" || window.location.pathname.startsWith("/series/")) {
    return (
      <Suspense fallback={null}>
        <SeriesScreen />
      </Suspense>
    );
  }
  if (window.location.pathname === "/plaza" || window.location.pathname.startsWith("/plaza/")) {
    return (
      <LazyScreen>
        <PlazaScreen />
      </LazyScreen>
    );
  }
  // "我的" 个人中心.
  if (window.location.pathname === "/me" || window.location.pathname.startsWith("/me/")) {
    return (
      <LazyScreen>
        <MyScreen />
      </LazyScreen>
    );
  }
  if (window.location.pathname === "/coins" || window.location.pathname.startsWith("/coins/")) {
    return (
      <LazyScreen>
        <CoinsScreen />
      </LazyScreen>
    );
  }
  if (window.location.pathname === "/gacha" || window.location.pathname.startsWith("/gacha/")) {
    return (
      <LazyScreen>
        <GachaScreen />
      </LazyScreen>
    );
  }
  if (window.location.pathname === "/submissions" || window.location.pathname.startsWith("/submissions/")) {
    return (
      <LazyScreen>
        <SubmissionsScreen />
      </LazyScreen>
    );
  }
  // The showcase ("展示区") is the immersive person gallery.
  if (window.location.pathname === "/showcase" || window.location.pathname.startsWith("/showcase/")) {
    return (
      <LazyScreen>
        <ShowcaseScreen />
      </LazyScreen>
    );
  }
  // The web task system ("/trial") also shares the SPA bundle.
  if (window.location.pathname === "/trial" || window.location.pathname.startsWith("/trial/")) {
    return (
      <LazyScreen>
        <TrialScreen />
      </LazyScreen>
    );
  }
  // Email account login/registration for visitors without Telegram.
  if (window.location.pathname === "/auth" || window.location.pathname.startsWith("/auth/")) {
    return (
      <LazyScreen>
        <EmailAuthScreen />
      </LazyScreen>
    );
  }
  const surveyId = useMemo(() => surveyIdFromPath(), []);
  const { toast, confirm } = useDialogs();

  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  // 「再填一次」必须复用通过验证的访问码，否则访问码问卷会直接 403 掉进错误页。
  const accessCodeRef = useRef<string | undefined>(undefined);
  const [index, setIndex] = useState(0);
  // Walked path (question indexes): 上一题 pops this stack instead of stepping
  // linearly, so going back inside a branch never lands in a sibling branch.
  const [backStack, setBackStack] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishToGallery, setPublishToGallery] = useState(false);
  const [publishToTelegram, setPublishToTelegram] = useState(false);
  const [galleryCoverMediaId, setGalleryCoverMediaId] = useState<number | null>(null);
  const [galleryShowUsername, setGalleryShowUsername] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);
  const [userThemePreset, setUserThemePreset] = useState<string | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  // 乐观保存队列的状态镜像（仅供界面指示，不参与逻辑判断）。
  const [pendingSaves, setPendingSaves] = useState(0);
  const [failedSaveQuestion, setFailedSaveQuestion] = useState<number | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      // When the on-screen keyboard opens, the visual viewport shrinks well
      // below the layout viewport height.
      setViewportShrunk(window.innerHeight - viewport.height > 80);
    };
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, []);

  // 答案保存队列：翻题不再等待保存往返，答案由队列按作答顺序串行落库。
  // sender 通过 ref 读取当前答卷标识（beginFilling 在拿到 responseId 后写入），
  // 避免闭包捕获过期的 screen 快照。
  const activeResponseRef = useRef<{ surveyId: number; responseId: number } | null>(null);
  const saveQueueRef = useRef<AnswerSaveQueue | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = new AnswerSaveQueue(
      async (task) => {
        const active = activeResponseRef.current;
        if (!active) throw new Error("response_not_ready");
        await saveAnswer(active.surveyId, active.responseId, task.questionId, task.value as AnswerValue);
      },
      {
        onPendingChange: setPendingSaves,
        onFailureChange: setFailedSaveQuestion,
      },
    );
  }
  const saveQueue = saveQueueRef.current;

  // 离开页面（关闭标签页 / Mini App 返回 / 刷新）时把还在队列里的答案冲出去。
  // saveAnswer 带 keepalive，在途请求可以在文档卸载后继续送达；尽力而为，
  // 失败的答案仍留在服务端上次成功保存的状态。
  useEffect(() => {
    const flushOnHide = () => {
      if (saveQueue.hasUnsaved) void saveQueue.flushSaves();
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, [saveQueue]);

  const isEditableTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  const handleInputFocus = useCallback((event: FocusEvent) => {
    if (!isEditableTarget(event.target)) return;
    setInputFocused(true);
    window.setTimeout(() => {
      (event.target as HTMLElement).scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 250);
  }, []);

  const handleInputBlur = useCallback((event: FocusEvent) => {
    if (!isEditableTarget(event.target)) return;
    setInputFocused(false);
  }, []);

  const navHidden = inputFocused || viewportShrunk;

  useEffect(() => {
    if (!Number.isFinite(surveyId)) return;
    try {
      const stored = localStorage.getItem(`surveyTheme:${surveyId}`);
      setUserThemePreset(stored && isValidPresetId(stored) ? stored : null);
    } catch {
      // storage unavailable — keep default
    }
  }, [surveyId]);

  const resolvedUserPreset = useResolvedPreset(userThemePreset);

  // 界面音效配置来自主题（theme.audio.sfx）。规则与 BGM 一致：用户自选主题预设
  // 会覆盖整份主题，自定义音效随之失效；老问卷没有 sfx 字段时一律不发声。
  const sfxUrls = (() => {
    if (resolvedUserPreset) return undefined;
    return "survey" in screen ? screen.survey.theme?.audio?.sfx : undefined;
  })();

  useEffect(() => {
    configureSfx(sfxUrls);
  }, [sfxUrls]);

  // 解码要等真实手势（自动播放策略），但只等第一次：此后点击就有声音。
  useEffect(() => {
    const once = () => preloadSfx();
    window.addEventListener("pointerdown", once, { once: true, passive: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  const selectTheme = useCallback(
    (id: string | null) => {
      setUserThemePreset(id);
      setThemePickerOpen(false);
      try {
        if (id) localStorage.setItem(`surveyTheme:${surveyId}`, id);
        else localStorage.removeItem(`surveyTheme:${surveyId}`);
      } catch {
        // storage unavailable — session-only choice still applies
      }
    },
    [surveyId],
  );

  useEffect(() => {
    if (!Number.isFinite(surveyId)) return;
    let cancelled = false;
    // 定义与开卷并行发射：两者互不依赖，服务端 /responses 自带密码、金币和
    // 次数校验，并行不会绕过任何门。受门禁的问卷这次开卷会收到 403/402 ——
    // 正是 access / coin-gate 屏要接管的信号，预检结果就地作废（验证通过后
    // 的 beginFilling 会带凭据重新开卷）。
    const preflight: Promise<StartResponseDto | null> = startResponse(surveyId).then(
      (started) => started,
      () => null,
    );
    fetchSurvey(surveyId)
      .then((survey) => {
        if (cancelled) return;
        if (survey.coinUnlock?.required) {
          setScreen({ kind: "coin-gate", survey });
        } else if (survey.accessCodeRequired) {
          setScreen({ kind: "access", survey });
        } else {
          setScreen({ kind: "filling", survey, responseId: 0, currentQuestionId: null, answers: {} });
          void beginFilling(survey, undefined, () => cancelled, preflight);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // r18 门（0080）：未确认年龄的访问者先过确认门，确认后重试整条加载链。
        if ((err as Error & { code?: string }).code === "age_restricted") {
          setScreen({ kind: "age-gate" });
          return;
        }
        setScreen({ kind: "error", message: err instanceof Error ? err.message : "问卷加载失败" });
      });
    return () => {
      cancelled = true;
    };
    // Only surveyId and retryKey should trigger a reload; survey/theme options
    // are resolved inside fetchSurvey and do not need to re-fire the fetch effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId, retryKey]);

  const beginFilling = useCallback(
    async (
      survey: SurveyDto,
      accessCode: string | undefined,
      isCancelled: () => boolean = () => false,
      preflight?: Promise<StartResponseDto | null>,
    ) => {
      try {
        if (accessCode) accessCodeRef.current = accessCode;
        // 新的填写会话开始：丢掉上一个会话遗留的队列任务与失败标记
        // （旧答卷仍停在服务端最后成功保存的状态，等价于直接关掉页面）。
        saveQueue.reset();
        // 首屏路径复用加载 effect 已并行发出的开卷结果；预检失败（含门禁
        // 403/402）或验证后路径则现开一次。
        let started = preflight ? await preflight : null;
        if (isCancelled()) return;
        if (!started) {
          started = await startResponse(survey.id, accessCode);
          if (isCancelled()) return;
        }
        activeResponseRef.current = { surveyId: survey.id, responseId: started.responseId };
        setPublishToGallery(false);
        setGalleryCoverMediaId(null);
        setGalleryShowUsername(false);
        // Restored single-type answers arrive as `[optionId]` arrays (server
        // compact shape). Normalize to the in-memory shape the fill flow uses:
        // a bare option id. Without this, resumed selections don't render and
        // option-driven jumps can't fire on the replayed path.
        // 服务端在续答命中时直接带回答案（answers 字段）；旧部署没有该字段，
        // 回退到单独的 GET /responses 请求。
        const restored = started.resumed
          ? (started.answers ?? (await fetchAnswers(survey.id, started.responseId)).answers)
          : {};
        const resumeAnswers: Record<number, AnswerValue> = {};
        for (const question of survey.questions) {
          const value = restored[String(question.id)];
          if (value === undefined || value === null) continue;
          const single = question.type === "single" || question.type === "yes_no" || question.type === "rating";
          if (single && Array.isArray(value)) {
            if (value.length > 0) resumeAnswers[question.id] = value[0]!;
            continue;
          }
          resumeAnswers[question.id] = value;
        }
        setAnswers(resumeAnswers);
        const startIndex = Math.max(
          0,
          survey.questions.findIndex((question) => question.id === started.currentQuestionId),
        );
        // Rebuild the walked path by replaying the jump-aware flow from the
        // start, so 上一题 keeps returning to the branch the participant
        // actually came from. On any disagreement with the server's resume
        // point, fall back to linear back navigation (empty stack).
        const replayedStack: number[] = [];
        if (startIndex > 0) {
          let cursor = 0;
          for (let guard = 0; cursor < startIndex && guard <= survey.questions.length + 4; guard += 1) {
            replayedStack.push(cursor);
            const next = nextIndex(survey.questions, cursor, resumeAnswers);
            if (next <= cursor || next >= survey.questions.length) break;
            cursor = next;
          }
          if (cursor !== startIndex) replayedStack.length = 0;
        }
        setBackStack(replayedStack);
        setIndex(startIndex >= 0 ? startIndex : 0);
        setScreen({
          kind: "filling",
          survey,
          responseId: started.responseId,
          currentQuestionId: started.currentQuestionId,
          answers: resumeAnswers,
        });
      } catch (err) {
        if (isCancelled()) return;
        // 注册墙（产品决策）：未登录开卷 → 登录门。
        if ((err as Error & { code?: string }).code === "registration_required") {
          setScreen({ kind: "auth-required" });
          return;
        }
        setScreen({ kind: "error", message: err instanceof Error ? err.message : "无法开始问卷" });
      }
    },
    [saveQueue],
  );

  const onVerified = useCallback(
    (code: string, grant: string | null) => {
      const survey = screen.kind === "access" ? screen.survey : null;
      if (!survey) return;
      // Re-fetch the full definition now that we hold a short-lived grant: the
      // payload returned before verification deliberately has no questions.
      const loadFull = async () => {
        try {
          const full = grant ? await fetchSurvey(survey.id, grant) : survey;
          setScreen({ kind: "filling", survey: full, responseId: 0, currentQuestionId: null, answers: {} });
          void beginFilling(full, code);
        } catch (err) {
          setScreen({ kind: "error", message: err instanceof Error ? err.message : "问卷加载失败" });
        }
      };
      void loadFull();
    },
    [beginFilling, screen],
  );

  const updateAnswer = useCallback((questionId: number, value: AnswerValue) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }, []);

  /**
   * 校验当前题并把答案交给保存队列（乐观导航）。
   *
   * 返回 true 表示可以立即切换题目：答案已入队（或本来就没有要存的值）。
   * 队列按作答顺序串行落库，失败会保留并提示，不会静默丢弃——所以这里不再
   * 等待网络往返。唯一的同步例外是答卷尚未创建（responseId=0 的过渡帧）：
   * 此时退回旧的阻塞保存，避免把第一题的答案丢在队列里。
   */
  const stageCurrent = useCallback(
    async (survey: SurveyDto, responseId: number): Promise<boolean> => {
      const question = survey.questions[index];
      if (!question) return true;
      const value = answers[question.id];
      const validationError = validateQuestion(question, value);
      if (validationError) {
        setError(validationError);
        return false;
      }
      if (value === undefined || value === null) return true;
      if (responseId <= 0) {
        try {
          await saveAnswer(survey.id, responseId, question.id, value);
          setError(null);
          return true;
        } catch (err) {
          setError(err instanceof Error ? err.message : "保存失败");
          return false;
        }
      }
      saveQueue.enqueue({ questionId: question.id, value });
      setError(null);
      return true;
    },
    [answers, index, saveQueue],
  );

  const goNext = useCallback(async () => {
    if (screen.kind !== "filling") return;
    const staged = await stageCurrent(screen.survey, screen.responseId);
    if (!staged) return;
    const next = nextIndex(screen.survey.questions, index, answers);
    if (next >= screen.survey.questions.length) {
      playSfx("transition");
      setScreen({ kind: "done", survey: screen.survey });
      return;
    }
    // 同一页里推进 = 翻过一段文字（page）；跨页 = 换了场景（transition）。
    // 两者互斥，不会同时响，避免一次点击叠两个声音。
    const current = screen.survey.questions[index];
    const target = screen.survey.questions[next];
    const pageChanged = Boolean(current && target && current.pageId !== target.pageId);
    playSfx(pageChanged ? "transition" : "page");
    setBackStack((stack) => [...stack, index]);
    setIndex(next);
  }, [answers, index, screen, stageCurrent]);

  const goBack = useCallback(async () => {
    if (screen.kind !== "filling") return;
    playSfx("cancel");
    // 往回翻也要把当前题落库，但不阻塞导航：答案入队（失败仍保留在队列里，
    // 本地 state 不受影响；续答时会再次保存）。答卷尚未创建时无事可存。
    const question = screen.survey.questions[index];
    const value = question ? answers[question.id] : undefined;
    if (question && value !== undefined && value !== null && screen.responseId > 0) {
      saveQueue.enqueue({ questionId: question.id, value });
    }
    // 按走过的路径回退；栈为空（如服务端恢复点与重放不一致）才退回线性顺序。
    setIndex((current) => {
      const previous = backStack[backStack.length - 1];
      return previous !== undefined ? previous : Math.max(0, current - 1);
    });
    setBackStack((stack) => stack.slice(0, -1));
    setError(null);
  }, [answers, backStack, index, saveQueue, screen]);

  const submit = useCallback(async () => {
    if (screen.kind !== "filling") return;
    const staged = await stageCurrent(screen.survey, screen.responseId);
    if (!staged) return;
    setBusy(true);
    try {
      // 提交前必须等队列完全落库：服务端 submit 从数据库重读全部答案做必答
      // 检查，队列里还有东西就意味着数据库不是最终状态。flushSaves 会先把
      // 失败条目重发一遍；仍失败则拦下提交，横幅上可以重试。
      if (screen.responseId > 0) {
        const flushed = await saveQueue.flushSaves();
        if (!flushed) {
          setError("有答案没能保存成功，请点击「重试保存」后再提交");
          return;
        }
      }
      try {
        const result = await submitResponse(screen.survey.id, screen.responseId, {
          publishToGallery,
          publishToTelegram,
          galleryCoverMediaId,
          galleryShowUsername,
        });
        if (result.completed) {
          playSfx("confirm");
          // 本地"已填过"标记：列表页下次挂载时读取（跨页面导航会重新初始化）。
          markSurveyCompleted(screen.survey.id);
          setScreen({
            kind: "done",
            survey: screen.survey,
            reportUrl: result.reportUrl,
            reportPdfUrl: result.reportPdfUrl,
            // 已发布画廊时带上资料卡深链，落点从 feed 顶部改为"我的卡片"。
            profileUrl: publishToGallery ? `/plaza/profile/${screen.responseId}` : undefined,
            newAchievements: result.newAchievements?.length ? result.newAchievements : undefined,
          });
        } else {
          // Server accepted the request but refused completion (e.g. a
          // required question is still missing); without feedback the
          // responder is stuck on a re-enabled button.
          setError("问卷尚未完成：还有必答题目未填写");
        }
      } catch (err) {
        const errorCode = (err as Error & { code?: string }).code;
        const message = err instanceof Error ? err.message : "提交失败";
        setError(message);
        if (errorCode === "required_missing") {
          const missingIndex = screen.survey.questions.findIndex((question) => message.includes(question.title));
          if (missingIndex >= 0) setIndex(missingIndex);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [galleryCoverMediaId, galleryShowUsername, publishToGallery, publishToTelegram, saveQueue, screen, stageCurrent]);

  /** 保存失败横幅上的手动重试：重发全部失败条目，成功即撤下横幅。 */
  const retryFailedSaves = useCallback(() => {
    void saveQueue.flushSaves();
  }, [saveQueue]);

  // 下一题媒体预热：答题者阅读当前题的空档里，把下一题（按跳题规则算出的
  // 真实后继）的公开题面/选项图拉进浏览器缓存，翻题时图片零等待。弱网与
  // 省流量模式跳过；只预热公开的定义媒体，答卷上传预览绝不在此列。
  useEffect(() => {
    if (screen.kind !== "filling") return;
    const questions = screen.survey.questions;
    const next = nextIndex(questions, index, answers);
    if (next <= index || next >= questions.length) return;
    const urls = collectQuestionImageUrls(questions[next]!);
    if (urls.length === 0) return;
    const timer = window.setTimeout(() => preloadImages(urls), 400);
    return () => window.clearTimeout(timer);
  }, [answers, index, screen]);

  // 退出前确认：填卷进行中直接关掉会丢掉未保存的输入。
  const exitFillingWithConfirm = useCallback(async () => {
    // `screen.answers` 是进入填卷屏时拍下的快照，之后不再同步：用它判断会永远
    // 认为「没有作答」，于是刚选完一个选项就退出也不会弹确认。改读实时的
    // `answers`，并忽略空串/空数组这类「点了但没真的填」的值。
    const hasAnswers = Object.values(answers).some((value) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    });
    const inProgress = screen.kind === "filling" && hasAnswers;
    if (!inProgress) {
      closeSurveyPage();
      return;
    }
    if (await confirm({ message: "确定要退出问卷吗？尚未提交的回答将丢失。", variant: "danger" })) {
      playSfx("confirm");
      // 尽力把还在队列里的答案冲出去：saveAnswer 带 keepalive，离开页面后
      // 在途请求仍会送达服务端；已保存到最后一题的进度可以续答恢复。
      if (saveQueue.hasUnsaved) void saveQueue.flushSaves();
      closeSurveyPage();
    } else {
      playSfx("cancel");
    }
  }, [answers, confirm, saveQueue, screen.kind]);

  if (!Number.isFinite(surveyId)) {
    return <SurveyListPage />;
  }

  const earlyTheme: SurveyThemeDto | null = userThemePreset
    ? { preset: userThemePreset }
    : screen.kind !== "loading" && screen.kind !== "error" && screen.kind !== "age-gate" && screen.kind !== "auth-required"
      ? screen.survey.theme
      : null;
  const earlyVars = themeCssVars(earlyTheme);
  const earlyBackground = themeBackgroundStyle(earlyTheme);

  if (screen.kind === "loading") {
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={earlyTheme?.preset}
        style={{ ...earlyVars, ...earlyBackground }}
      >
        <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷加载中…</div>
      </div>
    );
  }
  if (screen.kind === "error") {
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={earlyTheme?.preset}
        style={{ ...earlyVars, ...earlyBackground }}
      >
        <div className="mx-auto max-w-xl px-5 py-16 text-center">
          <p className="text-[var(--app-danger)]">{screen.message}</p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <button type="button" className="btn btn-primary px-8" onClick={() => setRetryKey((key) => key + 1)}>
              <RefreshCw className="h-4 w-4" />
              重新加载
            </button>
            <a className="btn px-6" href="/s">
              <Home className="h-4 w-4" />
              返回问卷列表
            </a>
          </div>
        </div>
      </div>
    );
  }
  if (screen.kind === "auth-required") {
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={earlyTheme?.preset}
        style={{ ...earlyVars, ...earlyBackground }}
      >
        <AuthRequiredScreen onRetry={() => setRetryKey((key) => key + 1)} />
      </div>
    );
  }
  if (screen.kind === "age-gate") {
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={earlyTheme?.preset}
        style={{ ...earlyVars, ...earlyBackground }}
      >
        <AgeGateScreen onConfirmed={() => setRetryKey((key) => key + 1)} />
      </div>
    );
  }
  if (screen.kind === "coin-gate") {
    return (
      <LazyScreen>
        <CoinGateScreen
          surveyId={screen.survey.id}
          title={screen.survey.title}
          description={screen.survey.description}
          price={screen.survey.coinUnlock?.price ?? 0}
          onUnlocked={() => {
            // 解锁成功：重取定义（此时服务端已放行内容；密码问卷接着走密码门）。
            accessCodeRef.current = undefined;
            setRetryKey((key) => key + 1);
          }}
          onSkip={() => {
            window.location.href = "/s";
          }}
        />
      </LazyScreen>
    );
  }
  if (screen.kind === "access") {
    const accessTheme: SurveyThemeDto | null = userThemePreset
      ? { preset: userThemePreset }
      : screen.survey.theme;
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={accessTheme?.preset}
        style={{ ...themeCssVars(accessTheme), ...themeBackgroundStyle(accessTheme) }}
      >
        <AccessScreen survey={screen.survey} onVerified={onVerified} />
      </div>
    );
  }
  if (screen.kind === "done") {
    const completion = screen.survey.theme?.completion;
    const canRestart = completion?.showRestart === true && screen.survey.allowMultiple;
    const communityGroupUrl = screen.survey.communityGroupUrl;
    const submissionBotUrl = screen.survey.submissionBotUrl;
    const theme: SurveyThemeDto | null = resolvedUserPreset ? { preset: resolvedUserPreset } : screen.survey.theme;
    const vars = themeCssVars(theme);
    const backgroundStyle = themeBackgroundStyle(theme);
    const galleryProfileEnabled = screen.survey.galleryProfile?.enabled === true;
    const showProfileLink = galleryProfileEnabled && publishToGallery;
    return (
      <div
        className="survey-glow mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center px-5 pb-24 text-center"
        data-theme={theme?.preset}
        style={{ ...vars, ...backgroundStyle }}
      >
        <div
          className="grid h-20 w-20 place-items-center rounded-full shadow-xl"
          style={{
            backgroundColor: "var(--survey-primary)",
            color: "var(--survey-primary-content)",
            boxShadow: "0 20px 40px -12px color-mix(in srgb, var(--survey-primary) 45%, transparent)",
          }}
        >
          <CheckCircle2 className="h-10 w-10" strokeWidth={2.2} />
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-[var(--survey-heading)]">提交成功</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--survey-muted)]">
          {completion?.message ?? "感谢你的参与，你的回答已记录。"}
        </p>
        {screen.reportUrl ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <a className="btn btn-primary px-7" href={screen.reportUrl}>
              <CheckCircle2 className="h-4 w-4" />
              查看我的报告
            </a>
            {/* 下载按钮：PDF 直链（同 token）。用户明确要「填完之后可以下载
                自己的报告」，而报告页本身只有阅读界面。 */}
            {screen.reportPdfUrl ? (
              <a className="btn px-6" href={screen.reportPdfUrl} download>
                <Download className="h-4 w-4" />
                下载 PDF
              </a>
            ) : null}
          </div>
        ) : null}
        {activeResponseRef.current ? <ShareEndingCard responseId={activeResponseRef.current.responseId} /> : null}
        {screen.newAchievements?.length ? (
          <div className="mt-5 w-full max-w-sm rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-5 py-4">
            <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-[var(--survey-heading)]">
              <Sparkles className="h-4 w-4 text-[var(--survey-primary)]" />
              {screen.newAchievements.length > 1 ? "解锁了新成就" : "解锁新成就"}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {screen.newAchievements.map((item) => (
                <span
                  key={item.code}
                  className="flex items-center gap-1.5 rounded-full bg-[var(--survey-primary-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--survey-heading)]"
                >
                  <span aria-hidden>{item.icon}</span>
                  {item.title}
                </span>
              ))}
            </div>
            <a className="mt-3 inline-block text-[11px] font-semibold text-[var(--survey-primary)] underline" href="/me">
              去「我的」看看全部徽章
            </a>
          </div>
        ) : null}
        {galleryProfileEnabled && !publishToGallery ? (
          <p className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-2.5 text-xs text-[var(--survey-muted)]">
            已提交完成（未公开）。再次填写并勾选「发布到个人画廊」即可公开展示。
          </p>
        ) : null}
        <TelegramLinkCard />
        {communityGroupUrl || submissionBotUrl ? (
          <div className="mt-5 w-full max-w-sm rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-5 py-4">
            <p className="text-sm font-semibold text-[var(--survey-heading)]">
              {communityGroupUrl ? "欢迎加入我们的 Telegram 群聊" : "在 Telegram 上继续"}
            </p>
            <p className="mt-1 text-xs text-[var(--survey-muted)]">
              {communityGroupUrl ? "和大家交流问卷内容、分享结果、参与讨论" : "打开投稿机器人，投稿或联系我们"}
            </p>
            <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
              {showProfileLink ? (
                <a className="btn btn-primary px-6" href={screen.profileUrl ?? "/plaza?tab=profiles"}>
                  <Check className="h-4 w-4" />
                  查看我的个人资料
                </a>
              ) : null}
              {communityGroupUrl ? (
                <a
                  className={`btn px-6 ${showProfileLink ? "" : "btn-primary"}`}
                  href={communityGroupUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={
                    showProfileLink
                      ? {
                          backgroundColor: "var(--survey-card-bg)",
                          borderColor: "var(--survey-card-border)",
                          color: "var(--survey-primary)",
                        }
                      : undefined
                  }
                >
                  <Users className="h-4 w-4" />
                  加入群聊
                </a>
              ) : null}
              {submissionBotUrl ? (
                <a
                  className="btn px-6"
                  href={submissionBotUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    backgroundColor: "var(--survey-card-bg)",
                    borderColor: "var(--survey-card-border)",
                    color: "var(--survey-primary)",
                  }}
                >
                  <Send className="h-4 w-4" />
                  投稿机器人
                </a>
              ) : null}
            </div>
          </div>
        ) : showProfileLink ? (
          <a className="btn btn-primary mt-7 px-8" href={screen.profileUrl ?? "/plaza?tab=profiles"}>
            <Check className="h-4 w-4" />
            查看我的个人资料
          </a>
        ) : null}
        {completion?.redirectUrl ? (
          <a
            className="btn btn-primary mt-7 px-8"
            href={completion.redirectUrl}
            target={completion.redirectUrl.startsWith("/") ? undefined : "_blank"}
            rel="noreferrer"
          >
            <Check className="h-4 w-4" />
            继续
          </a>
        ) : (
          <button type="button" className="btn btn-primary mt-7 px-8" onClick={closeSurveyPage}>
            <Check className="h-4 w-4" />
            完成
          </button>
        )}
        <a className="btn mt-3" href="/s">
          <Home className="h-4 w-4" />
          返回主页，填写其他问卷
        </a>
        {canRestart ? (
          <button
            type="button"
            className="btn mt-3"
            onClick={() => {
              setPublishToGallery(false);
              setScreen({
                kind: "filling",
                survey: screen.survey,
                responseId: 0,
                currentQuestionId: null,
                answers: {},
              });
              void beginFilling(screen.survey, screen.survey.accessCodeRequired ? accessCodeRef.current : undefined);
            }}
          >
            再填一次
          </button>
        ) : null}
        <BottomNav />
      </div>
    );
  }

  const { survey, responseId } = screen;
  const question = survey.questions[index];
  if (!question) {
    const emptyTheme: SurveyThemeDto | null = userThemePreset
      ? { preset: userThemePreset }
      : survey.theme;
    return (
      <div
        className="survey-glow min-h-dvh"
        data-theme={emptyTheme?.preset}
        style={{ ...themeCssVars(emptyTheme), ...themeBackgroundStyle(emptyTheme) }}
      >
        <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷为空</div>
      </div>
    );
  }
  const currentPage = survey.pages.find((page) => page.id === question.pageId);
  const value = answers[question.id];
  const isNote = question.type === "note";
  const vnMode = survey.theme?.vn === true && !resolvedUserPreset;
  const isLast = index === survey.questions.length - 1;
  // 进度按「当前路线」计数（routeProgress）：剧情文段不占步数，分支下不再跳变。
  // 无任何跳转条件的问卷，重放结果与线性顺序完全一致（行为兼容）。
  const { done: answerableIndex, total: answerableTotal, percent } = routeProgress(
    survey.questions,
    index,
    answers,
  );
  const total = answerableTotal;
  const pageIndex = currentPage ? survey.pages.findIndex((page) => page.id === currentPage.id) : -1;
  // The participant can override the survey's default theme for this session;
  // the choice is remembered per survey in localStorage.
  const theme: SurveyThemeDto | null = resolvedUserPreset ? { preset: resolvedUserPreset } : survey.theme;
  const vars = themeCssVars(theme);
  const backgroundStyle = themeBackgroundStyle(theme);
  const overlay = theme?.overlay;
  // A per-question cue (a story turn, an ending) wins over the page's
  // override, which wins over the survey-wide track. A user-chosen preset
  // replaces the whole theme, which intentionally silences custom music too.
  const bgmUrl = resolveBgmUrl(theme, question.order, pageIndex);
  // 立绘与 BGM 同一套优先级（节点级 > 页级 > 默认）；用户自选主题预设会
  // 覆盖整份主题，因此 `theme` 里没有 sprite 时立绘层整块不渲染。
  const sprite = resolveSprite(theme, question.order, pageIndex);

  return (
    <div
      className={`survey-glow min-h-dvh ${navHidden ? "pb-10" : "pb-32"}`}
      data-theme={theme?.preset}
      style={{ ...vars, ...(vnMode ? {} : backgroundStyle) }}
    >
      {vnMode ? (
        // VN 皮肤：场景图固定铺满视口，不随内容滚动（视觉小说的画面感）。
        <div aria-hidden className="fixed inset-0 z-0" style={{ ...backgroundStyle, backgroundAttachment: "fixed" }} />
      ) : null}
      {overlay ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0"
          style={{
            backgroundColor: overlay.color ?? "#000000",
            opacity: overlay.opacity ?? 0,
            ...(overlay.blur ? { backdropFilter: `blur(${overlay.blur}px)` } : {}),
          }}
        />
      ) : null}
      <div className="relative z-10">
        <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
          <div className="mx-auto max-w-xl px-5 pt-3 lg:max-w-3xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-[var(--survey-heading)]">{survey.title}</p>
                {pageIndex >= 0 ? (
                  <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">
                    第 {pageIndex + 1} / {survey.pages.length} 页
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label="返回上一页"
                  title="返回上一页"
                  onClick={backSurveyPage}
                  className="survey-icon-btn"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="选择主题"
                  title="选择主题"
                  className="survey-icon-btn"
                  onClick={() => setThemePickerOpen(true)}
                >
                  <Palette className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="退出问卷"
                  title="退出问卷"
                  onClick={() => void exitFillingWithConfirm()}
                  className="survey-icon-btn"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {survey.communityGroupUrl ? (
              <a
                href={survey.communityGroupUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--survey-primary)] hover:underline"
              >
                加入 Telegram 群聊
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            ) : null}
            <div className="flex items-center gap-3 pb-3 pt-2.5">
              <div className="survey-progress-track flex-1">
                <div className="survey-progress-bar" style={{ width: `${percent}%` }} />
              </div>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--survey-muted)]">
                {isNote ? "📖 剧情" : `${answerableIndex}/${answerableTotal} · ${percent}%`}
              </span>
            </div>
          </div>
        </header>

        <main
          className="mx-auto w-full max-w-xl px-5 pb-2 pt-5 lg:max-w-3xl"
          onFocusCapture={handleInputFocus}
          onBlurCapture={handleInputBlur}
        >
          {sprite ? (
            <SpriteLayer
              url={sprite.url}
              expression={sprite.expression}
              name={sprite.name}
              expressions={theme?.sprite?.expressions}
            />
          ) : null}
          <div className={`survey-card p-5 ${isNote ? "survey-card-story" : ""}`}>
            {currentPage?.title ? (
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--survey-primary)]">
                {currentPage.title}
              </p>
            ) : null}
            {isNote && vnMode ? (
              <>
                <MediaBlock urls={question.media} type="image" />
                {/* VN 对话框：名牌 + 打字机正文 + 继续，替代表单式叙事卡。 */}
                <div className="fixed bottom-0 left-0 right-0 z-20 px-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
                  <div className="relative mx-auto max-w-xl rounded-2xl border border-white/25 bg-black/70 px-5 py-4 text-white shadow-2xl backdrop-blur-md">
                    {question.settings?.speaker ? (
                      <span className="absolute -top-3.5 left-4 rounded-full border border-amber-300/60 bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 text-xs font-bold shadow-lg">
                        {String(question.settings.speaker)}
                      </span>
                    ) : null}
                    <p className="mt-1 min-h-[3rem] whitespace-pre-wrap text-[15px] leading-7">
                      <Typewriter text={question.description || question.title || ""} enabled />
                    </p>
                    <button
                      type="button"
                      className="mt-2 flex w-full items-center justify-end gap-1 text-sm font-semibold text-amber-300"
                      onClick={() => void goNext()}
                    >
                      继续 <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : isNote ? (
              <>
                {question.title ? (
                  <h1 className="mt-1 text-base font-bold tracking-tight text-[var(--survey-heading)]">
                    📖 <Typewriter text={question.title} enabled={vnMode} className="whitespace-pre-wrap" />
                  </h1>
                ) : null}
                {question.description ? (
                  <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-[var(--survey-body)]">
                    <Typewriter text={question.description} enabled={vnMode} />
                  </p>
                ) : null}
                <MediaBlock urls={question.media} type="image" />
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h1 className="min-w-0 text-[22px] font-bold leading-snug tracking-tight text-[var(--survey-heading)]">
                    {question.title}
                  </h1>
                  {question.required ? <span className="badge badge-red mt-1 shrink-0">必答</span> : null}
                </div>
                {question.description ? (
                  <ExpandableText
                    className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--survey-muted)]"
                    text={question.description}
                  />
                ) : null}
                <MediaBlock
                  urls={question.media}
                  type={question.type === "video" ? "video" : question.type === "audio" ? "audio" : "image"}
                />
                <div className="mt-5">
                  <QuestionAnswer
                    question={question}
                    value={value}
                    onChange={(next) => updateAnswer(question.id, next)}
                    disabled={busy}
                  />
                </div>
              </>
            )}
            {error ? <p className="mt-4 text-sm font-medium text-[var(--app-danger)]">{error}</p> : null}
            {failedSaveQuestion !== null ? (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3.5 py-2.5">
                <span className="text-xs leading-5 text-[var(--survey-body)]">
                  第 {failedSaveQuestion} 题的答案没能保存上，提交前需要重试；重新作答该题也可以。
                </span>
                <button
                  type="button"
                  className="btn btn-xs shrink-0"
                  style={{ backgroundColor: "var(--survey-card-bg)", borderColor: "var(--survey-card-border)" }}
                  onClick={retryFailedSaves}
                >
                  重试保存
                </button>
              </div>
            ) : null}
          </div>
          {isLast ? (
            <>
              <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3.5">
                <input type="checkbox" className="checkbox checkbox-primary mt-0.5 shrink-0" checked={publishToTelegram} disabled={busy} onChange={(event) => setPublishToTelegram(event.target.checked)} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[var(--survey-heading)]">📣 公开发布到 Telegram</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">发布到与投稿机器人相同的目标群组；报告会按分页生成图片并以 Telegram 相册发送。</span>
                </span>
              </label>
              {survey.galleryProfile?.enabled && survey.galleryProfile.canPublish ? (
                <>
                  <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3.5">
                    <input type="checkbox" className="checkbox checkbox-primary mt-0.5 shrink-0" checked={publishToGallery} disabled={busy} onChange={(event) => setPublishToGallery(event.target.checked)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-[var(--survey-heading)]">🌍 发布到个人画廊</span>
                      <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">默认不展示 Telegram 个人信息，你还可以选择画廊封面</span>
                    </span>
                  </label>
                  {publishToGallery ? (
                    <div className="mt-2 space-y-2">
                      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 text-sm">
                        <input type="checkbox" className="checkbox checkbox-primary mt-0.5 shrink-0" checked={galleryShowUsername} disabled={busy} onChange={(event) => setGalleryShowUsername(event.target.checked)} />
                        <span className="min-w-0">
                          <span className="block font-semibold text-[var(--survey-heading)]">展示 Telegram 用户名</span>
                          <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">勾选后，资料卡会显示你的 Telegram 用户名和姓名</span>
                        </span>
                      </label>
                      <label className="block rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 text-sm">
                        <span className="block font-semibold text-[var(--survey-heading)]">画廊封面</span>
                        <select className="select mt-2 w-full" value={galleryCoverMediaId ?? ""} onChange={(event) => setGalleryCoverMediaId(event.target.value ? Number(event.target.value) : null)}>
                          <option value="">默认第一张图片</option>
                          {survey.questions.filter((item) => ["image", "video", "audio", "file"].includes(item.type)).map((item) => {
                            const answer = answers[item.id];
                            const media = answer && typeof answer === "object" && !Array.isArray(answer) && "mediaAssetId" in answer ? answer.mediaAssetId : null;
                            return typeof media === "number" ? <option key={item.id} value={media}>{item.title}</option> : null;
                          })}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </main>

        <nav
          className={`fixed inset-x-0 bottom-0 z-10 transition-transform duration-200 ${
            navHidden ? "translate-y-full" : ""
          }`}
        >
          <div
            className="mx-auto max-w-xl px-4 pt-1 lg:max-w-3xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
          >
            <div className="flex items-center gap-2 rounded-[20px] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]/90 p-2 shadow-[0_-6px_34px_-14px_rgba(15,23,42,.28)] backdrop-blur">
              {index > 0 ? (
                <button
                  type="button"
                  onClick={goBack}
                  disabled={busy}
                  className="btn shrink-0 text-[var(--survey-body)]"
                  style={{
                    backgroundColor: "var(--survey-card-bg)",
                    borderColor: "var(--survey-card-border)",
                  }}
                >
                  <ArrowLeft className="h-4 w-4" />
                  上一题
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void (isLast ? submit() : goNext())}
                disabled={busy}
                className="btn btn-primary flex-1 font-semibold disabled:opacity-50"
                style={{ borderRadius: "var(--survey-button-radius, 12px)" }}
              >
                {busy ? (
                  // busy 现在只覆盖提交（翻题不再等保存往返）。
                  "提交中…"
                ) : isLast ? (
                  <>
                    <Check className="h-4 w-4" />
                    提交问卷
                  </>
                ) : isNote ? (
                  <>
                    继续
                    <ArrowRight className="h-4 w-4" />
                  </>
                ) : (
                  <>
                    下一题
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
            {pendingSaves > 0 && !busy ? (
              <p className="mt-1 text-center text-[11px] text-[var(--survey-muted)]" aria-live="polite">
                正在同步答案…
              </p>
            ) : null}
          </div>
        </nav>
        {bgmUrl ? <BgmPlayer url={bgmUrl} /> : null}
        <ThemePickerSheet
          open={themePickerOpen}
          onClose={() => setThemePickerOpen(false)}
          selected={userThemePreset}
          onSelect={selectTheme}
        />
      </div>
    </div>
  );
}
