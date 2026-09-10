import { useEffect, useId, useState } from "react";
import { Check, ChevronRight, Paperclip, X } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditorPreviewQuestion } from "../../editor/previewModel";
import {
  getMatrixColumns,
  getQuestionInstruction,
  isSingleChoiceQuestion,
} from "../../../../src/survey/question-presentation";

interface SurveyPreviewProps {
  title: string;
  description: string;
  questions: EditorPreviewQuestion[];
  dirty: boolean;
  onClose: () => void;
  /** Renders as a static embedded pane instead of a modal overlay. */
  inline?: boolean;
}

export function PreviewChoice({
  label,
  multiple,
  mediaCount,
}: {
  label: string;
  multiple: boolean;
  mediaCount: number;
}) {
  return (
    <div className="phone-choice">
      <span aria-hidden="true" className={`phone-choice-glyph ${multiple ? "square" : "round"}`}>
        {multiple ? "✓" : "•"}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {mediaCount ? (
        <span className="inline-flex items-center gap-1 text-xs">
          <Paperclip className="h-3 w-3" />×{mediaCount}
        </span>
      ) : null}
    </div>
  );
}

export function PreviewAnswer({ question }: { question: EditorPreviewQuestion }) {
  if (isSingleChoiceQuestion(question) || question.type === "multiple") {
    return (
      <div className="grid gap-2">
        {question.options.map((option) => (
          <PreviewChoice
            key={option.id}
            label={option.label}
            multiple={question.type === "multiple"}
            mediaCount={question.optionMediaById.get(option.id)?.length ?? 0}
          />
        ))}
        {question.type === "multiple" ? (
          <button type="button" className="phone-btn secondary" disabled>
            完成选择
          </button>
        ) : null}
      </div>
    );
  }

  if (question.type === "matrix") {
    const columns = getMatrixColumns(question);
    return (
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--survey-card-border)" }}>
        <table className="w-full min-w-[440px] border-collapse text-sm" style={{ color: "var(--survey-body)" }}>
          <thead style={{ background: "var(--survey-bg)", color: "var(--survey-muted)" }}>
            <tr>
              <th className="px-3 py-2 text-left">行</th>
              {columns.map((column, index) => (
                <th key={`${column}-${index}`} className="px-3 py-2 text-center font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {question.options.map((option) => (
              <tr key={option.id} style={{ borderTop: "1px solid var(--survey-card-border)" }}>
                <td className="px-3 py-2">{option.label}</td>
                {columns.map((column, index) => (
                  <td
                    key={`${column}-${index}`}
                    className="px-3 py-2 text-center"
                    style={{ color: "var(--survey-muted)" }}
                  >
                    ○
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (question.type === "long_text") {
    return <textarea className="phone-input min-h-24" disabled placeholder="在 Telegram 中输入回答" />;
  }
  if (question.type === "number") {
    return <input className="phone-input" type="number" disabled placeholder="输入数字" />;
  }
  if (question.type === "date" || question.type === "time") {
    return <input className="phone-input" type={question.type} disabled />;
  }
  if (["image", "video", "audio", "file"].includes(question.type)) {
    return (
      <div
        className="rounded-lg border border-dashed p-4 text-center text-sm"
        style={{
          borderColor: "var(--survey-card-border)",
          background: "var(--survey-bg)",
          color: "var(--survey-muted)",
        }}
      >
        {question.media.length ? `已配置 ${question.media.length} 个题目附件` : "请在 Telegram 中发送对应媒体文件"}
      </div>
    );
  }
  return <input className="phone-input" disabled placeholder="在 Telegram 中输入回答" />;
}

function InteractiveAnswer({
  question,
  value,
  onChange,
}: {
  question: EditorPreviewQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  if (isSingleChoiceQuestion(question) || question.type === "multiple") {
    const selected = value ? value.split(",").filter(Boolean) : [];
    return (
      <div className="grid gap-2">
        {question.options.map((option) => {
          const active = selected.includes(String(option.id));
          return (
            <button
              key={option.id}
              type="button"
              className={`phone-choice text-left ${active ? "ring-2 ring-[var(--survey-primary)]" : ""}`}
              onClick={() => {
                const next =
                  question.type === "multiple"
                    ? active
                      ? selected.filter((id) => id !== String(option.id))
                      : [...selected, String(option.id)]
                    : [String(option.id)];
                onChange(next.join(","));
              }}
            >
              <span className={`phone-choice-glyph ${question.type === "multiple" ? "square" : "round"}`}>
                {active ? "✓" : ""}
              </span>
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }
  if (question.type === "long_text")
    return (
      <textarea
        className="phone-input min-h-24"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="输入回答"
      />
    );
  if (question.type === "number" || question.type === "date" || question.type === "time")
    return (
      <input
        className="phone-input"
        type={question.type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <input
      className="phone-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="输入回答"
    />
  );
}

export function SurveyPreview({ title, description, questions, dirty, onClose, inline = false }: SurveyPreviewProps) {
  const titleId = useId();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (inline) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [inline, onClose]);

  useEffect(() => {
    setCurrentIndex(0);
    setAnswers({});
    setError(null);
  }, [questions]);

  const currentQuestion = questions[currentIndex];
  const currentValue = currentQuestion ? (answers[currentQuestion.id] ?? "") : "";
  const advance = () => {
    if (!currentQuestion) return;
    if (currentQuestion.required && !currentValue.trim()) {
      setError("这道题为必答题，请先填写后继续");
      return;
    }
    setError(null);
    if (currentIndex < questions.length - 1) setCurrentIndex((index) => index + 1);
    else setError("模拟提交成功（不会写入真实数据）");
  };

  return (
    <div
      className={
        inline
          ? "h-full overflow-hidden rounded-xl border"
          : "fixed inset-0 z-50 flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-6"
      }
      style={inline ? { borderColor: "var(--color-edge)", background: "var(--survey-bg)" } : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={
          inline
            ? "flex h-full flex-col"
            : "flex max-h-[100dvh] w-full max-w-3xl flex-col shadow-xl sm:max-h-[90dvh] sm:rounded-xl"
        }
        style={{
          background: "var(--surface)",
          border: inline ? 0 : "1px solid var(--color-edge)",
          borderRadius: inline ? 0 : undefined,
        }}
      >
        <header
          className="flex items-center justify-between gap-3 border-b p-4"
          style={{ borderColor: "var(--color-edge)", background: "var(--surface)" }}
        >
          <div>
            <h2 id={titleId} className="font-semibold" style={{ color: "var(--color-ink)" }}>
              问卷填写预览
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--color-muted)" }}>
              {dirty ? "包含尚未保存的本地修改" : "当前已保存版本"} · Telegram 实际填写时每次显示一题
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
            <X className="h-4 w-4" />
            关闭
          </button>
        </header>

        <div className="overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-xl" style={{ background: "var(--survey-bg)" }}>
            <div className="survey-card p-5">
              <h3 className="text-xl font-bold" style={{ color: "var(--survey-heading)" }}>
                {title || "未命名问卷"}
              </h3>
              {description ? (
                <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: "var(--survey-body)" }}>
                  {description}
                </p>
              ) : null}
              <p className="mt-3 text-xs" style={{ color: "var(--survey-muted)" }}>
                共 {questions.length} 题
              </p>
            </div>

            {currentQuestion ? (
              <div className="mt-4">
                <article className="survey-card p-5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold" style={{ color: "var(--survey-primary)" }}>
                      第 {currentIndex + 1} / {questions.length} 题
                    </span>
                    <span
                      className="rounded px-2 py-0.5 font-semibold"
                      style={{
                        background: "var(--survey-primary-soft)",
                        color: "var(--survey-primary)",
                      }}
                    >
                      {QUESTION_TYPE_LABELS[currentQuestion.type] ?? currentQuestion.type}
                    </span>
                    <span style={{ color: currentQuestion.required ? "var(--color-danger)" : "var(--survey-muted)" }}>
                      {currentQuestion.required ? "必答" : "选答"}
                    </span>
                  </div>
                  <h4 className="mt-3 font-semibold" style={{ color: "var(--survey-heading)" }}>
                    {currentQuestion.title || "未填写题目标题"}
                  </h4>
                  {currentQuestion.description ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm" style={{ color: "var(--survey-muted)" }}>
                      {currentQuestion.description}
                    </p>
                  ) : null}
                  {currentQuestion.media.length ? (
                    <div
                      className="mt-3 rounded-lg p-3 text-xs"
                      style={{ background: "var(--survey-primary-soft)", color: "var(--survey-primary)" }}
                    >
                      题目媒体附件 ×{currentQuestion.media.length}（Web 预览仅展示引用状态）
                    </div>
                  ) : null}
                  <p className="my-3 text-sm" style={{ color: "var(--survey-muted)" }}>
                    {getQuestionInstruction(currentQuestion)}
                  </p>
                  <InteractiveAnswer
                    question={currentQuestion}
                    value={currentValue}
                    onChange={(value) => setAnswers((current) => ({ ...current, [currentQuestion.id]: value }))}
                  />
                  {error ? (
                    <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
                      {error}
                    </p>
                  ) : null}
                  <div className="mt-3 flex gap-2 border-t pt-3" style={{ borderColor: "var(--survey-card-border)" }}>
                    {currentIndex > 0 ? (
                      <button
                        type="button"
                        className="phone-btn secondary flex-1"
                        onClick={() => {
                          setError(null);
                          setCurrentIndex((index) => index - 1);
                        }}
                      >
                        <ChevronRight className="h-4 w-4 rotate-180" />
                        上一题
                      </button>
                    ) : null}
                    <button type="button" className="phone-btn flex-1" onClick={advance}>
                      {currentIndex === questions.length - 1 ? (
                        <>
                          <Check className="h-4 w-4" />
                          提交
                        </>
                      ) : (
                        <>
                          下一题
                          <ChevronRight className="h-4 w-4" />
                        </>
                      )}
                    </button>
                  </div>
                </article>
              </div>
            ) : (
              <div className="survey-card mt-4 p-8 text-center text-sm" style={{ color: "var(--survey-muted)" }}>
                问卷尚无题目
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
