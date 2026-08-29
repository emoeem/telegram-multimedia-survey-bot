import { Check, ChevronLeft, ChevronRight, Maximize2, Smartphone } from "lucide-react";
import { QUESTION_TYPE_LABELS } from "../../format";
import type { EditorPreviewQuestion } from "../../editor/previewModel";
import { getQuestionInstruction } from "../../../../src/survey/question-presentation";
import { PreviewAnswer } from "./SurveyPreview";

interface LivePreviewProps {
  title: string;
  description: string;
  questions: EditorPreviewQuestion[];
  currentIndex: number;
  dirty: boolean;
  onNavigate: (index: number) => void;
  onOpenFull: () => void;
}

export function LivePreview({
  title,
  description,
  questions,
  currentIndex,
  dirty,
  onNavigate,
  onOpenFull,
}: LivePreviewProps) {
  const question = questions[currentIndex] ?? null;
  const total = questions.length;
  const progress = total ? ((currentIndex + 1) / total) * 100 : 0;

  return (
    <div className="preview-panel">
      <div className="preview-head">
        <div>
          <div className="preview-title">
            <Smartphone className="h-4 w-4" />
            实时预览
          </div>
          <div className="preview-hint">{dirty ? "包含尚未保存的修改" : "当前已保存版本"} · Telegram 每屏一题</div>
        </div>
        <button className="btn btn-sm btn-quiet" title="打开完整预览" onClick={onOpenFull}>
          <Maximize2 className="h-4 w-4" />
          完整预览
        </button>
      </div>

      <div className="preview-stage">
        <div className="phone-frame">
          <div className="phone-notch">
            <span className="phone-notch-dot" />
          </div>
          {question ? (
            <div className="phone-screen">
              <div>
                <div className="text-center" style={{ color: "var(--survey-heading)", fontSize: 15, fontWeight: 700 }}>
                  {title || "未命名问卷"}
                </div>
                {description ? (
                  <p className="mt-1 text-center text-xs" style={{ color: "var(--survey-muted)" }}>
                    {description}
                  </p>
                ) : null}
              </div>
              <div className="phone-progress-track">
                <div className="phone-progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <div className="phone-card">
                <div className="phone-card-meta">
                  <strong>
                    第 {currentIndex + 1} / {total} 题
                  </strong>
                  <span>·</span>
                  <span>{QUESTION_TYPE_LABELS[question.type] ?? question.type}</span>
                  <span>·</span>
                  <span style={{ color: question.required ? "var(--color-danger)" : "var(--survey-muted)" }}>
                    {question.required ? "必答" : "选答"}
                  </span>
                </div>
                <div className="phone-card-title">{question.title || "未填写题目标题"}</div>
                {question.description ? <p className="phone-card-desc">{question.description}</p> : null}
                <div className="mt-3" style={{ color: "var(--survey-muted)", fontSize: 12 }}>
                  {getQuestionInstruction(question)}
                </div>
                <div className="mt-3">
                  <PreviewAnswer question={question} />
                </div>
                <div className="mt-3 flex gap-2">
                  {currentIndex > 0 ? (
                    <button
                      type="button"
                      className="phone-btn secondary flex-1"
                      onClick={() => onNavigate(currentIndex - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      上一题
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="phone-btn flex-1"
                    onClick={() => {
                      if (currentIndex < total - 1) onNavigate(currentIndex + 1);
                    }}
                  >
                    {currentIndex === total - 1 ? (
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
              </div>
              <div className="phone-note">点击题目卡片即可编辑，修改实时反映在此</div>
            </div>
          ) : (
            <div className="phone-screen">
              <div
                className="grid flex-1 place-items-center rounded-2xl border border-dashed text-center text-sm"
                style={{
                  borderColor: "var(--survey-card-border)",
                  color: "var(--survey-muted)",
                }}
              >
                问卷还没有题目，点击「添加题目」开始构建
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
