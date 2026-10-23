import { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Flag, History, X } from "lucide-react";
import { buildSurveyFlow, getNextQuestionAfterAnswers } from "../../../../src/survey/engine";
import type { EditorPreviewQuestion } from "../../editor/previewModel";
import { getQuestionInstruction } from "../../../../src/survey/question-presentation";
import { themeBackgroundStyle, themeCssVars } from "../../survey/theme-ui";

/**
 * 编辑器内试玩（P1）：从任意节点出发、按真实跳转走（直接复用服务端
 * engine.getNextQuestionAfterAnswers——选项跳转 / answerRules / flagJumps
 * 与玩家看到的完全同一套逻辑），走过的路径以足迹呈现。
 *
 * 只收集驱动跳转的作答：单选/是非/评分选值，其余题型直接「继续」。
 */

interface TrialPlayProps {
  title: string;
  questions: EditorPreviewQuestion[];
  startIndex: number;
  onExit: () => void;
  preset?: string | null;
}

type TrialValue = number;

export function TrialPlay({ title, questions, startIndex, onExit, preset }: TrialPlayProps) {
  const flow = useMemo(
    () =>
      buildSurveyFlow(
        questions.map((question) => ({
          id: question.id,
          surveyId: question.surveyId,
          type: question.type,
          title: question.title,
          description: question.description,
          required: question.required,
          order: question.order,
          pageId: null,
          settingsJson: null,
          validationJson: null,
          conditionJson: question.conditionJson,
          skipToQuestionId: null,
          parentQuestionId: null,
          createdAt: "",
          updatedAt: "",
        })),
        questions.flatMap((question) =>
          question.options.map((option) => ({
            id: option.id,
            questionId: question.id,
            label: option.label,
            value: "",
            isOther: false,
            order: 0,
            createdAt: "",
            updatedAt: "",
          })),
        ),
      ),
    [questions],
  );

  const [stack, setStack] = useState<number[]>([startIndex]);
  const [answers, setAnswers] = useState<Record<number, TrialValue>>({});
  const current = stack[stack.length - 1] ?? startIndex;
  const question = flow.questions[current] ?? null;

  const theme = preset ? ({ preset } as Parameters<typeof themeCssVars>[0]) : null;

  const advance = (value: TrialValue | null) => {
    const optionId = value !== null && question?.options.some((option) => option.id === value) ? value : null;
    if (value !== null) setAnswers((previous) => ({ ...previous, [question!.id]: value }));
    const answerMap = new Map<number, unknown>(
      Object.entries({ ...answers, ...(value !== null ? { [question!.id]: value } : {}) }).map(([key, val]) => [
        Number(key),
        val,
      ]),
    );
    const next = getNextQuestionAfterAnswers(flow, current, optionId, answerMap);
    setStack((previous) => [...previous, next ? flow.questions.indexOf(next) : questions.length]);
  };

  const back = () => {
    setStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous));
  };

  const finished = current >= questions.length;
  const optionPicked = (optionId: number) => {
    advance(optionId);
  };

  return (
    <div className="preview-panel">
      <div className="preview-head">
        <div>
          <div className="preview-title">
            <Flag className="h-4 w-4" />
            剧情试玩
            <span className="ml-2 rounded-full bg-[var(--survey-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--survey-primary)]">
              从第 {startIndex + 1} 题出发
            </span>
          </div>
          <div className="preview-hint">跳转与玩家完全一致（选项跳转 / 历史答案 / Flag 门槛）</div>
        </div>
        <button className="btn btn-sm btn-quiet" onClick={onExit}>
          <X className="h-4 w-4" />
          退出试玩
        </button>
      </div>
      <div className="preview-stage">
        <div
          className="phone-frame"
          data-theme={preset ?? undefined}
          style={{ ...themeCssVars(theme), ...themeBackgroundStyle(theme) }}
        >
          <div className="phone-notch">
            <span className="phone-notch-dot" />
          </div>
          <div className="phone-screen">
            {finished ? (
              <div className="grid flex-1 place-items-center text-center">
                <div>
                  <Check className="mx-auto h-10 w-10 text-[var(--survey-primary)]" />
                  <p className="mt-3 text-sm font-semibold" style={{ color: "var(--survey-heading)" }}>
                    走到了终点
                  </p>
                  <p className="mt-1 text-xs" style={{ color: "var(--survey-muted)" }}>
                    共 {stack.length} 步 · {new Set(stack).size} 个不同节点
                  </p>
                  <button type="button" className="phone-btn mt-4" onClick={onExit}>
                    退出试玩
                  </button>
                </div>
              </div>
            ) : question ? (
              <>
                <div className="phone-card">
                  {question.type === "note" ? (
                    <div className="phone-card-meta">
                      <strong>📖 剧情</strong>
                    </div>
                  ) : (
                    <div className="phone-card-meta">
                      <strong>第 {stack.length} 步</strong>
                      <span>·</span>
                      <span>{getQuestionInstruction(question)}</span>
                    </div>
                  )}
                  {question.title ? <div className="phone-card-title">{question.title}</div> : null}
                  {question.description ? (
                    <p className="phone-card-desc whitespace-pre-wrap text-[15px] leading-7">{question.description}</p>
                  ) : null}
                  {question.options.length > 0 ? (
                    <div className="mt-3 grid gap-2">
                      {question.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="phone-btn secondary w-full text-left"
                          onClick={() => optionPicked(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3">
                      <button type="button" className="phone-btn w-full" onClick={() => advance(null)}>
                        继续
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    {stack.length > 1 ? (
                      <button type="button" className="phone-btn secondary flex-1" onClick={back}>
                        <ChevronLeft className="h-4 w-4" />
                        回退
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="phone-note">
                  <History className="mr-1 inline h-3 w-3" />
                  足迹：{stack.map((step, index) => `${index + 1}#${step + 1}`).join(" → ")}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
