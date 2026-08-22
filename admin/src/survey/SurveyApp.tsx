import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AnswerValue,
  fetchAnswers,
  fetchSurvey,
  fetchSurveyList,
  type SurveyListItem,
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
  | { kind: "filling"; survey: SurveyDto; responseId: number; currentQuestionId: number | null; answers: Record<number, AnswerValue> }
  | { kind: "done" };

function surveyIdFromPath(): number {
  const match = window.location.pathname.match(/^\/s\/(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function SurveyListPage() {
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSurveyList()
      .then((data) => {
        if (!cancelled) setSurveys(data.surveys);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "问卷加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-red-600">{error}</div>;
  }
  if (!surveys) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-gray-500">问卷加载中…</div>;
  }
  if (surveys.length === 0) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-gray-500">当前没有可填写的问卷</div>;
  }

  return (
    <div className="min-h-dvh bg-page pb-10">
      <header className="border-b border-gray-200 bg-white/90 px-5 py-4">
        <h1 className="text-xl font-bold text-gray-900">可填写问卷</h1>
      </header>
      <main className="mx-auto w-full max-w-xl px-5 pt-5">
        <div className="grid gap-3">
          {surveys.map((survey) => (
            <a
              key={survey.id}
              href={`/s/${survey.id}`}
              className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition hover:border-indigo-300"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-gray-900">{survey.title}</h2>
                {survey.accessCodeRequired ? (
                  <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">🔐 需密码</span>
                ) : null}
              </div>
              {survey.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-gray-500">{survey.description}</p>
              ) : null}
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-gray-400">{survey.questionCount} 道题</span>
                <span className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">开始填写</span>
              </div>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}

function selectedOptionId(question: SurveyQuestionDto, value: AnswerValue | undefined): number | null {
  if (typeof value !== "number") return null;
  return question.options.some((option) => option.id === value) ? value : null;
}

function nextIndex(
  questions: SurveyQuestionDto[],
  currentIndex: number,
  answers: Record<number, AnswerValue>,
): number {
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
  if (question.required && (value === undefined || value === null)) {
    return "此题必答";
  }
  if (value === undefined || value === null) return null;
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

function MediaBlock({ urls, type }: { urls: Array<{ url: string }>; type: string }) {
  if (urls.length === 0) return null;
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

function AuthenticatedMedia({ url, kind }: { url: string; kind: "image" | "video" | "audio" }) {
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
    return <div className="rounded-lg bg-gray-100 p-4 text-center text-xs text-gray-400">媒体加载失败</div>;
  }
  if (!objectUrl) {
    return <div className="h-24 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (kind === "video") {
    return <video className="w-full rounded-lg bg-black" src={objectUrl} controls />;
  }
  if (kind === "audio") {
    return <audio className="w-full" src={objectUrl} controls />;
  }
  return <img className="w-full rounded-lg" src={objectUrl} alt="" loading="lazy" />;
}

interface QuestionAnswerProps {
  question: SurveyQuestionDto;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  disabled: boolean;
}

function QuestionAnswer({ question, value, onChange, disabled }: QuestionAnswerProps) {
  const [uploading, setUploading] = useState(false);

  if (question.type === "single" || question.type === "yes_no" || question.type === "rating") {
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
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left text-[15px] transition ${
                selected
                  ? "border-indigo-500 bg-indigo-50 text-indigo-900"
                  : "border-gray-200 bg-white text-gray-800"
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                  selected ? "border-indigo-500 bg-indigo-500" : "border-gray-300 bg-white"
                }`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                <MediaBlock urls={option.media} type="image" />
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  if (question.type === "multiple") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="mt-4 grid gap-2">
        {question.options.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange(checked ? selected.filter((id) => id !== option.id) : [...selected, option.id])
              }
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left text-[15px] transition ${
                checked ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-gray-200 bg-white text-gray-800"
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border ${
                  checked ? "border-indigo-500 bg-indigo-500" : "border-gray-300 bg-white"
                }`}
              >
                {checked ? (
                  <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6.5 4.5 9 10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                <MediaBlock urls={option.media} type="image" />
              </span>
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
    const selections = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, number>)
      : {};
    return (
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-500">
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
              <tr key={row.id} className="border-t border-gray-100">
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
                              ? Object.fromEntries(
                                  Object.entries(selections).filter(([key]) => key !== String(row.id)),
                                )
                              : { ...selections, [String(row.id)]: columnIndex },
                          )
                        }
                        aria-label={`${row.label} - ${_column}`}
                        className={`grid h-7 w-7 place-items-center rounded-full border ${
                          selected ? "border-indigo-500 bg-indigo-500" : "border-gray-300 bg-white"
                        }`}
                      >
                        {selected ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
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
    const mediaAnswer = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { mediaAssetId: number })
      : null;
    return (
      <div className="mt-4">
        {mediaAnswer ? (
          <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <span>已上传附件 #{mediaAnswer.mediaAssetId}</span>
            <button
              type="button"
              className="font-medium text-green-700 underline"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              移除
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white px-4 py-8 text-sm text-gray-500">
            <span className="text-2xl">📎</span>
            <span className="mt-2">{uploading ? "上传中…" : "点击上传文件"}</span>
            <input
              type="file"
              className="hidden"
              disabled={disabled || uploading}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setUploading(true);
                try {
                  const result = await uploadAnswerMedia(surveyIdFromPath(), file);
                  onChange({ mediaAssetId: result.mediaAssetId });
                } catch (error) {
                  window.alert(error instanceof Error ? error.message : "上传失败");
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
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-5">
      <h1 className="text-2xl font-bold text-gray-900">🔐 需要访问密码</h1>
      <p className="mt-2 text-sm text-gray-500">请输入此问卷的访问密码后继续填写。</p>
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
        placeholder="访问密码"
        className="input mt-4 w-full"
        autoFocus
      />
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      <button type="button" disabled={busy} onClick={() => void submit()} className="btn mt-4 w-full bg-indigo-600 text-white disabled:opacity-50">
        {busy ? "验证中…" : "继续"}
      </button>
    </div>
  );
}

export function SurveyApp() {
  const surveyId = useMemo(() => surveyIdFromPath(), []);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          void beginFilling(survey, undefined, cancelled);
        }
      })
      .catch((err) => {
        if (!cancelled) setScreen({ kind: "error", message: err instanceof Error ? err.message : "问卷加载失败" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  const beginFilling = useCallback(async (survey: SurveyDto, accessCode: string | undefined, cancelled = false) => {
    try {
      const started = await startResponse(survey.id, accessCode);
      if (cancelled) return;
      const resumeAnswers = started.resumed
        ? (await fetchAnswers(survey.id, started.responseId)).answers
        : {};
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
      if (!cancelled) setScreen({ kind: "error", message: err instanceof Error ? err.message : "无法开始问卷" });
    }
  }, []);

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
        setScreen({ kind: "done" });
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
        const result = await submitResponse(screen.survey.id, screen.responseId);
        if (result.completed) {
          setScreen({ kind: "done" });
        }
      } catch (err) {
        const errorCode = (err as Error & { code?: string }).code;
        const message = err instanceof Error ? err.message : "提交失败";
        setError(message);
        if (errorCode === "required_missing") {
          const missingIndex = screen.survey.questions.findIndex((question) =>
            message.includes(question.title),
          );
          if (missingIndex >= 0) setIndex(missingIndex);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [persistCurrent, screen]);

  if (!Number.isFinite(surveyId)) {
    return <SurveyListPage />;
  }

  if (screen.kind === "loading") {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-gray-500">问卷加载中…</div>;
  }
  if (screen.kind === "error") {
    return (
      <div className="mx-auto max-w-xl px-5 py-16 text-center">
        <p className="text-red-600">{screen.message}</p>
      </div>
    );
  }
  if (screen.kind === "access") {
    return <AccessScreen survey={screen.survey} onVerified={onVerified} />;
  }
  if (screen.kind === "done") {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center px-5 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-green-100 text-3xl">✅</div>
        <h1 className="mt-4 text-2xl font-bold text-gray-900">提交成功</h1>
        <p className="mt-2 text-sm text-gray-500">感谢你的参与！</p>
        <button
          type="button"
          className="btn mt-6"
          onClick={() => {
            if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close();
            else window.location.href = "/";
          }}
        >
          关闭
        </button>
      </div>
    );
  }

  const { survey, responseId } = screen;
  const question = survey.questions[index];
  if (!question) {
    return <div className="mx-auto max-w-xl px-5 py-16 text-center text-gray-500">问卷为空</div>;
  }
  const currentPage = survey.pages.find((page) => page.id === question.pageId);
  const value = answers[question.id];
  const isLast = index === survey.questions.length - 1;

  return (
    <div className="min-h-dvh bg-page pb-32">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-xl px-5 py-3">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{survey.title}</span>
            <span>
              第 {index + 1} / {survey.questions.length} 题
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${((index + 1) / survey.questions.length) * 100}%` }}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl px-5 pt-6">
        {currentPage?.title ? <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">{currentPage.title}</p> : null}
        <h1 className="mt-2 text-xl font-bold leading-snug text-gray-900">{question.title}</h1>
        {question.description ? <p className="mt-2 whitespace-pre-wrap text-sm text-gray-500">{question.description}</p> : null}
        {question.required ? (
          <span className="mt-2 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-600">必答</span>
        ) : null}
        <MediaBlock urls={question.media} type={question.type === "video" ? "video" : question.type === "audio" ? "audio" : "image"} />
        <QuestionAnswer question={question} value={value} onChange={(next) => updateAnswer(question.id, next)} disabled={busy} />
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </main>

      <nav className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl gap-3 px-5 py-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}>
          {index > 0 ? (
            <button type="button" onClick={goBack} disabled={busy} className="btn flex-1">
              上一题
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void (isLast ? submit() : goNext())}
            disabled={busy}
            className="btn flex-1 bg-indigo-600 font-medium text-white disabled:opacity-50"
          >
            {busy ? "保存中…" : isLast ? "提交问卷" : "下一题"}
          </button>
        </div>
      </nav>
    </div>
  );
}
