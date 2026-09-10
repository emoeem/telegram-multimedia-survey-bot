import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogs } from "../components/Dialogs";
import type { FocusEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Home,
  Lock,
  MailCheck,
  Palette,
  Paperclip,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { EmailAuthScreen } from "./EmailAuthScreen";
import { PlazaScreen } from "./PlazaScreen";
import { TrialScreen } from "./TrialScreen";
import { BottomNav } from "./BottomNav";
import { PresetSwatch, SURVEY_THEME_PRESETS, themeBackgroundStyle, themeCssVars, ThemePickerSheet } from "./theme-ui";
import {
  type AnswerValue,
  fetchAnswers,
  fetchSurvey,
  fetchSurveyList,
  fetchParticipantLinkStartUrl,
  fetchParticipantLinkStatus,
  getParticipantKey,
  hasTelegramIdentity,
  type ParticipantLinkStatus,
  type SurveyListItem,
  type SurveyThemeDto,
  type SurveyDto,
  type SurveyQuestionDto,
  saveAnswer,
  startResponse,
  submitResponse,
  uploadAnswerMedia,
  verifyAccessCode,
} from "./api";
import { identityHeaders } from "./api";

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
  | { kind: "access"; survey: SurveyDto }
  | {
      kind: "filling";
      survey: SurveyDto;
      responseId: number;
      currentQuestionId: number | null;
      answers: Record<number, AnswerValue>;
    }
  | { kind: "done"; survey: SurveyDto };

function surveyIdFromPath(): number {
  const match = window.location.pathname.match(/^\/s\/(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function closeSurveyPage(): void {
  // Inside the Telegram WebView we close the mini app directly; in a normal
  // browser we close the tab and fall back to the survey home page.
  if (window.Telegram?.WebApp?.close) {
    window.Telegram.WebApp.close();
    return;
  }
  window.close();
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = "/s";
}

function backSurveyPage(): void {
  // Browser back first (supports the mobile edge-swipe gesture and desktop
  // back button); falls back to the survey list when there is no history
  // (e.g. a deep link opened in the default browser).
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = "/s";
}

function SurveyListPage() {
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [communityGroupUrl, setCommunityGroupUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themePreset, setThemePreset] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem("surveyHomeTheme");
      return stored && SURVEY_THEME_PRESETS.some((preset) => preset.id === stored) ? stored : null;
    } catch {
      return null;
    }
  });

  const selectHomeTheme = (id: string | null) => {
    setThemePreset(id);
    setThemePickerOpen(false);
    try {
      if (id) localStorage.setItem("surveyHomeTheme", id);
      else localStorage.removeItem("surveyHomeTheme");
    } catch {
      // storage unavailable — session-only choice still applies
    }
  };

  const homeTheme = themePreset ? ({ preset: themePreset } as Parameters<typeof themeCssVars>[0]) : null;

  useEffect(() => {
    let cancelled = false;
    fetchSurveyList(debouncedQuery)
      .then((data) => {
        if (cancelled) return;
        setSurveys(data.surveys);
        setCommunityGroupUrl(data.communityGroupUrl);
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
  }, [debouncedQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  if (error) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-danger)]">{error}</div>;
  }
  if (!surveys) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷加载中…</div>;
  }
  if (surveys.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">当前没有可填写的问卷</div>
    );
  }

  return (
    <div
      className="survey-glow min-h-dvh pb-24"
      data-theme={themePreset ?? undefined}
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
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-5 pt-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {surveys.map((survey) => (
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
                />
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[17px] font-semibold leading-snug text-[var(--color-ink)]">{survey.title}</h2>
                {survey.accessCodeRequired ? (
                  <span className="badge badge-amber shrink-0">
                    <Lock className="h-3 w-3" />
                    需密码
                  </span>
                ) : null}
              </div>
              {survey.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{survey.description}</p>
              ) : null}
              <div className="mt-3 flex items-center justify-between">
                <span className="chip text-xs">{survey.questionCount} 道题</span>
                <span className="inline-flex items-center gap-1 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-3.5 py-2 text-sm font-medium text-white shadow-md shadow-indigo-500/25">
                  开始填写
                  <ArrowRight className="h-4 w-4" />
                </span>
              </div>
            </a>
          ))}
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
          {error ? <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p> : null}
        </>
      )}
    </div>
  );
}

function selectedOptionId(question: SurveyQuestionDto, value: AnswerValue | undefined): number | null {
  if (typeof value !== "number") return null;
  return question.options.some((option) => option.id === value) ? value : null;
}

function nextIndex(questions: SurveyQuestionDto[], currentIndex: number, answers: Record<number, AnswerValue>): number {
  if (currentIndex >= questions.length - 1) return questions.length;
  const current = questions[currentIndex];
  if (!current) return currentIndex + 1;
  const selected = selectedOptionId(current, answers[current.id]);
  if (selected !== null && current.condition) {
    try {
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

function MediaBlock({ urls, type, cover }: { urls: Array<{ url: string }>; type: string; cover?: boolean }) {
  if (urls.length === 0) return null;
  if (cover) {
    return <AuthenticatedMedia key={urls[0]?.url ?? 0} url={urls[0]!.url} kind="image" cover />;
  }
  return (
    <div className="mt-3 grid gap-2">
      {urls.map((media, index) => {
        if (type === "video") {
          return <AuthenticatedMedia key={index} url={media.url} kind="video" />;
        }
        if (type === "audio") {
          return <AuthenticatedMedia key={index} url={media.url} kind="audio" />;
        }
        return <AuthenticatedMedia key={index} url={media.url} kind="image" />;
      })}
    </div>
  );
}

function AuthenticatedMedia({ url, kind, cover }: { url: string; kind: "image" | "video" | "audio"; cover?: boolean }) {
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
      className={cover ? "absolute inset-0 h-full w-full object-cover" : "w-full rounded-lg"}
      src={objectUrl}
      alt=""
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
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    const audio = new Audio();
    audio.loop = true;
    audioRef.current = audio;
    fetch(url, { headers: identityHeaders() })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const blob = await response.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        audio.src = createdUrl;
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      cancelled = true;
      audio.pause();
      audio.src = "";
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !ready) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      setPlaying(true);
      void audio.play().catch(() => setPlaying(false));
    }
  };

  if (!ready) return null;
  return (
    <button
      type="button"
      aria-label={playing ? "暂停背景音乐" : "播放背景音乐"}
      onClick={toggle}
      className="fixed bottom-28 right-4 z-20 grid h-11 w-11 place-items-center rounded-full border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-lg shadow-lg"
    >
      {playing ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
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
              onSelect={() => onChange(option.id)}
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
              onClick={() => onChange(option.id)}
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
              onClick={() => onChange(checked ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
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
        <table className="w-full min-w-[420px] border-collapse text-sm">
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
                          onChange(
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
    return question.type === "long_text" ? (
      <textarea
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请输入回答"
        className="input mt-4 min-h-36 w-full"
      />
    ) : (
      <input
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请输入回答"
        className="input mt-4 w-full"
      />
    );
  }

  if (question.type === "number") {
    return (
      <input
        disabled={disabled}
        type="number"
        value={typeof value === "number" ? String(value) : ""}
        onChange={(event) => {
          const parsed = event.target.value === "" ? null : Number(event.target.value);
          if (parsed !== null && Number.isFinite(parsed)) onChange(parsed);
        }}
        placeholder="请输入数字"
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
          <div className="flex items-center justify-between rounded-xl border border-[color-mix(in_srgb,var(--color-success)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] px-4 py-3 text-sm text-[var(--color-success)]">
            <span>已上传附件 #{mediaAnswer.mediaAssetId}</span>
            <button
              type="button"
              className="font-medium text-[var(--color-success)] underline"
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

function AccessScreen({ survey, onVerified }: { survey: SurveyDto; onVerified: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyAccessCode(survey.id, code);
      onVerified(code);
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
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30">
          <Lock className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-[var(--color-ink)]">需要访问密码</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">请输入此问卷的访问密码后继续填写。</p>
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
        {error ? <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
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
  if (window.location.pathname === "/plaza") {
    return <PlazaScreen />;
  }
  // The web task system ("/trial") also shares the SPA bundle.
  if (window.location.pathname === "/trial" || window.location.pathname.startsWith("/trial/")) {
    return <TrialScreen />;
  }
  // Email account login/registration for visitors without Telegram.
  if (window.location.pathname === "/auth" || window.location.pathname.startsWith("/auth/")) {
    return <EmailAuthScreen />;
  }
  const surveyId = useMemo(() => surveyIdFromPath(), []);
  const { toast } = useDialogs();

  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishToGallery, setPublishToGallery] = useState(false);
  const [galleryCoverMediaId, setGalleryCoverMediaId] = useState<number | null>(null);
  const [galleryShowUsername, setGalleryShowUsername] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);
  const [userThemePreset, setUserThemePreset] = useState<string | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

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
      setUserThemePreset(stored && SURVEY_THEME_PRESETS.some((preset) => preset.id === stored) ? stored : null);
    } catch {
      // storage unavailable — keep default
    }
  }, [surveyId]);

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
    fetchSurvey(surveyId)
      .then((survey) => {
        if (cancelled) return;
        if (survey.accessCodeRequired) {
          setScreen({ kind: "access", survey });
        } else {
          setScreen({ kind: "filling", survey, responseId: 0, currentQuestionId: null, answers: {} });
          void beginFilling(survey, undefined, () => cancelled);
        }
      })
      .catch((err) => {
        if (!cancelled) setScreen({ kind: "error", message: err instanceof Error ? err.message : "问卷加载失败" });
      });
    return () => {
      cancelled = true;
    };
    // Only surveyId should trigger a reload; survey/theme options are resolved
    // inside fetchSurvey and do not need to re-fire the fetch effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  const beginFilling = useCallback(
    async (survey: SurveyDto, accessCode: string | undefined, isCancelled: () => boolean = () => false) => {
      try {
        const started = await startResponse(survey.id, accessCode);
        if (isCancelled()) return;
        setPublishToGallery(false);
        setGalleryCoverMediaId(null);
        setGalleryShowUsername(false);
        const resumeAnswers = started.resumed ? (await fetchAnswers(survey.id, started.responseId)).answers : {};
        setAnswers(resumeAnswers);
        const startIndex = Math.max(
          0,
          survey.questions.findIndex((question) => question.id === started.currentQuestionId),
        );
        setIndex(startIndex >= 0 ? startIndex : 0);
        setScreen({
          kind: "filling",
          survey,
          responseId: started.responseId,
          currentQuestionId: started.currentQuestionId,
          answers: resumeAnswers,
        });
      } catch (err) {
        if (!isCancelled()) setScreen({ kind: "error", message: err instanceof Error ? err.message : "无法开始问卷" });
      }
    },
    [],
  );

  const onVerified = useCallback(
    (code: string) => {
      const survey = screen.kind === "access" ? screen.survey : null;
      if (!survey) return;
      setScreen({ kind: "filling", survey, responseId: 0, currentQuestionId: null, answers: {} });
      void beginFilling(survey, code);
    },
    [beginFilling, screen],
  );

  const updateAnswer = useCallback((questionId: number, value: AnswerValue) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }, []);

  const persistCurrent = useCallback(
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
      try {
        await saveAnswer(survey.id, responseId, question.id, value);
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
        return false;
      }
    },
    [answers, index],
  );

  const goNext = useCallback(async () => {
    if (screen.kind !== "filling") return;
    setBusy(true);
    try {
      const saved = await persistCurrent(screen.survey, screen.responseId);
      if (!saved) return;
      const next = nextIndex(screen.survey.questions, index, answers);
      if (next >= screen.survey.questions.length) {
        setScreen({ kind: "done", survey: screen.survey });
        return;
      }
      setIndex(next);
    } finally {
      setBusy(false);
    }
  }, [answers, index, persistCurrent, screen]);

  const goBack = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (screen.kind !== "filling") return;
    setBusy(true);
    try {
      const saved = await persistCurrent(screen.survey, screen.responseId);
      if (!saved) return;
      try {
        const result = await submitResponse(screen.survey.id, screen.responseId, {
          publishToGallery,
          galleryCoverMediaId,
          galleryShowUsername,
        });
        if (result.completed) {
          setScreen({ kind: "done", survey: screen.survey });
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
  }, [galleryCoverMediaId, galleryShowUsername, persistCurrent, publishToGallery, screen]);

  if (!Number.isFinite(surveyId)) {
    return <SurveyListPage />;
  }

  if (screen.kind === "loading") {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷加载中…</div>;
  }
  if (screen.kind === "error") {
    return (
      <div className="mx-auto max-w-xl px-5 py-16 text-center">
        <p className="text-[var(--color-danger)]">{screen.message}</p>
      </div>
    );
  }
  if (screen.kind === "access") {
    return <AccessScreen survey={screen.survey} onVerified={onVerified} />;
  }
  if (screen.kind === "done") {
    const completion = screen.survey.theme?.completion;
    const canRestart = completion?.showRestart === true && screen.survey.allowMultiple;
    const communityGroupUrl = screen.survey.communityGroupUrl;
    const theme: SurveyThemeDto | null = userThemePreset ? { preset: userThemePreset } : screen.survey.theme;
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
        <div className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-xl shadow-emerald-500/30">
          <CheckCircle2 className="h-10 w-10" strokeWidth={2.2} />
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-[var(--survey-heading)]">提交成功</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--survey-muted)]">
          {completion?.message ?? "感谢你的参与，你的回答已记录。"}
        </p>
        {galleryProfileEnabled && !publishToGallery ? (
          <p className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-2.5 text-xs text-[var(--survey-muted)]">
            已提交完成（未公开）。再次填写并勾选「发布到个人画廊」即可公开展示。
          </p>
        ) : null}
        <TelegramLinkCard />
        {communityGroupUrl ? (
          <div className="mt-5 w-full max-w-sm rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-5 py-4">
            <p className="text-sm font-semibold text-[var(--survey-heading)]">欢迎加入我们的 Telegram 群聊</p>
            <p className="mt-1 text-xs text-[var(--survey-muted)]">和大家交流问卷内容、分享结果、参与讨论</p>
            <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
              {showProfileLink ? (
                <a className="btn btn-primary px-6" href="/plaza?tab=profiles">
                  <Check className="h-4 w-4" />
                  查看我的个人资料
                </a>
              ) : null}
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
            </div>
          </div>
        ) : showProfileLink ? (
          <a className="btn btn-primary mt-7 px-8" href="/plaza?tab=profiles">
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
              void beginFilling(screen.survey, undefined);
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
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-[var(--color-muted)]">问卷为空</div>;
  }
  const currentPage = survey.pages.find((page) => page.id === question.pageId);
  const value = answers[question.id];
  const isLast = index === survey.questions.length - 1;
  const total = survey.questions.length;
  const percent = Math.round(((index + 1) / total) * 100);
  const pageIndex = currentPage ? survey.pages.findIndex((page) => page.id === currentPage.id) : -1;
  // The participant can override the survey's default theme for this session;
  // the choice is remembered per survey in localStorage.
  const theme: SurveyThemeDto | null = userThemePreset ? { preset: userThemePreset } : survey.theme;
  const vars = themeCssVars(theme);
  const backgroundStyle = themeBackgroundStyle(theme);
  const overlay = theme?.overlay;

  return (
    <div
      className={`survey-glow min-h-dvh ${navHidden ? "pb-10" : "pb-32"}`}
      data-theme={theme?.preset}
      style={{ ...vars, ...backgroundStyle }}
    >
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
                  onClick={closeSurveyPage}
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
                {index + 1}/{total} · {percent}%
              </span>
            </div>
          </div>
        </header>

        <main
          className="mx-auto w-full max-w-xl px-5 pb-2 pt-5 lg:max-w-3xl"
          onFocusCapture={handleInputFocus}
          onBlurCapture={handleInputBlur}
        >
          <div className="survey-card p-5">
            {currentPage?.title ? (
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--survey-primary)]">
                {currentPage.title}
              </p>
            ) : null}
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
            {error ? <p className="mt-4 text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
          </div>
          {isLast && survey.galleryProfile?.enabled ? (
            survey.galleryProfile.canPublish ? (
              <>
                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3.5">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-primary mt-0.5 shrink-0"
                    checked={publishToGallery}
                    disabled={busy}
                    onChange={(event) => setPublishToGallery(event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[var(--survey-heading)]">🌍 发布到个人画廊</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">
                      默认不展示 Telegram 个人信息，你还可以选择画廊封面
                    </span>
                  </span>
                </label>
                {publishToGallery ? (
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 text-sm">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary mt-0.5 shrink-0"
                        checked={galleryShowUsername}
                        disabled={busy}
                        onChange={(event) => setGalleryShowUsername(event.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold text-[var(--survey-heading)]">展示 Telegram 用户名</span>
                        <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">
                          勾选后，资料卡会显示你的 Telegram 用户名和姓名
                        </span>
                      </span>
                    </label>
                    <label className="block rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 text-sm">
                      <span className="block font-semibold text-[var(--survey-heading)]">画廊封面</span>
                      <select
                        className="select mt-2 w-full"
                        value={galleryCoverMediaId ?? ""}
                        onChange={(event) =>
                          setGalleryCoverMediaId(event.target.value ? Number(event.target.value) : null)
                        }
                      >
                        <option value="">默认第一张图片</option>
                        {survey.questions
                          .filter((question) => ["image", "video", "audio", "file"].includes(question.type))
                          .map((question) => {
                            const answer = answers[question.id];
                            const media =
                              answer && typeof answer === "object" && !Array.isArray(answer) && "mediaAssetId" in answer
                                ? answer.mediaAssetId
                                : null;
                            return typeof media === "number" ? (
                              <option key={question.id} value={media}>
                                {question.title}
                              </option>
                            ) : null;
                          })}
                      </select>
                    </label>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="mt-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 text-center text-xs leading-5 text-[var(--survey-muted)]">
                发布到个人画廊需要 Telegram 身份：请从 Telegram 机器人打开本问卷后提交，即可勾选发布。
              </p>
            )
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
                  "保存中…"
                ) : isLast ? (
                  <>
                    <Check className="h-4 w-4" />
                    提交问卷
                  </>
                ) : (
                  <>
                    下一题
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </nav>
        {theme?.audio?.url ? <BgmPlayer url={theme.audio.url} /> : null}
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
