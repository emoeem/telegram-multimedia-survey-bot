import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Eye } from "lucide-react";
import { useApi } from "../hooks";
import { apiSend, type EditorData, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { DevicePreview } from "../components/editor/DevicePreview";
import { buildEditorPreviewFlow } from "../editor/previewModel";
import { formatDateTime, matrixColumns, QUESTION_TYPE_LABELS } from "../format";

// 编辑器新壳 chunk 随路由按需加载。旧壳 EditableEditor 与 ?ui=legacy 兜底已按
// 「保留两个版本周期」的承诺于 2026-11-07 删除（e527b68 起历经 10-31、11-04
// 两个发布周期）；待保存队列等编辑语义由 useSurveyEditor / editor-actions 承载。
const EditorShellNext = lazy(() =>
  import("../components/editor/next/EditorShell").then((module) => ({ default: module.EditorShellNext })),
);

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<EditorData>(id ? `/api/admin/surveys/${id}/editor` : null);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;
  if (!data.survey.editable) return <ReadOnlyEditor data={data} />;
  return (
    <Suspense fallback={<SkeletonPanel lines={6} />}>
      <EditorShellNext data={data} />
    </Suspense>
  );
}

function ReadOnlyEditor({ data }: { data: EditorData }) {
  const { survey, questions } = data;
  const navigate = useNavigate();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const previewQuestions = useMemo(
    () =>
      buildEditorPreviewFlow(
        survey.id,
        questions.map((question) => ({
          ...question,
          columns: matrixColumns(question.settings),
        })),
      ),
    [questions, survey.id],
  );
  const duplicateAsDraft = async () => {
    if (duplicating) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const duplicate = await apiSend<WriteResult>("POST", `/api/admin/surveys/${survey.id}/duplicate`, {
        baseUpdatedAt: survey.updatedAt,
      });
      if (typeof duplicate.id !== "number") throw new Error("复制成功，但未返回新问卷编号");
      navigate(`/surveys/${duplicate.id}/editor`);
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "复制失败");
      setDuplicating(false);
    }
  };
  return (
    <div className="editor-page">
      <header className="editor-topbar">
        <div className="editor-topbar-main">
          <Link to={`/surveys/${survey.id}`} className="btn btn-icon" title="返回详情">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="editor-title">
            <div className="editor-title-name">
              <span className="truncate">{survey.title || "未命名问卷"}</span>
              <StatusBadge status={survey.status} />
            </div>
            <div className="editor-title-meta">
              {survey.questionCount} 题 · 更新于 {formatDateTime(survey.updatedAt)}
            </div>
          </div>
        </div>
        <div className="editor-actions">
          <button className="btn btn-sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" />
            预览
          </button>
          <button className="btn btn-sm btn-accent" disabled={duplicating} onClick={duplicateAsDraft}>
            {duplicating ? "复制中…" : "复制为新草稿"}
          </button>
        </div>
      </header>

      <div className="alert alert-warning">
        该问卷当前不可编辑（{survey.status !== "draft" ? "非草稿状态" : `已有 ${survey.responseCount} 份答卷`}）。
        复制为新草稿后编辑的入口将在后续批次提供；当前为只读视图。
      </div>
      {duplicateError ? <div className="alert alert-error">复制失败：{duplicateError}</div> : null}

      <div className="editor-body">
        <aside className="editor-structure editor-col">
          <ReadOnlyTree questions={questions} />
        </aside>
        <main className="editor-canvas editor-col">
          <div className="settings-panel">
            <div>
              <div className="settings-panel-title">题目列表（只读）</div>
              <div className="settings-panel-sub">共 {questions.length} 题</div>
            </div>
            {questions.length ? (
              <div className="grid gap-3">
                {questions.map((question, index) => (
                  <ReadOnlyQuestion key={question.id} question={question} index={index} />
                ))}
              </div>
            ) : (
              <EmptyPanel text="这份问卷还没有题目" />
            )}
          </div>
        </main>
      </div>

      {previewOpen ? (
        <DevicePreview
          surveyId={survey.id}
          title={survey.title}
          display={data.survey.display ?? "auto"}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ReadOnlyTree({ questions }: { questions: EditorData["questions"] }) {
  return (
    <div className="structure-panel">
      <div className="structure-head">
        <span>问卷结构</span>
      </div>
      <div className="structure-tree">
        {questions.map((question, index) => (
          <div key={question.id} className="tree-question">
            <span className="tree-question-index">{index + 1}</span>
            <span className="tree-question-title">{question.title || "未命名题目"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReadOnlyQuestion({ question, index }: { question: EditorData["questions"][number]; index: number }) {
  return (
    <div className="q-editor">
      <div className="q-editor-head">
        <div className="q-badges">
          <span className="q-index">第 {index + 1} 题</span>
          <span
            className="q-chip"
            style={{
              background: "color-mix(in srgb, var(--color-primary) 13%, var(--surface))",
              color: "var(--color-primary)",
            }}
          >
            {QUESTION_TYPE_LABELS[question.type] ?? question.type}
          </span>
          <span
            className="q-chip"
            style={{
              background: question.required
                ? "color-mix(in srgb, var(--app-danger) 12%, var(--surface))"
                : "var(--surface-muted)",
              color: question.required ? "var(--app-danger)" : "var(--color-muted)",
            }}
          >
            {question.type === "note" ? "非题目" : question.required ? "必答" : "选答"}
          </span>
        </div>
      </div>
      <div className="q-body">
        <div className="q-title-input" style={{ background: "var(--surface-input)", padding: "11px 13px" }}>
          {question.title || "未填写题目标题"}
        </div>
        {question.description ? <div className="q-help">{question.description}</div> : null}
        {question.options.length ? (
          <div className="grid gap-1.5">
            {question.options.map((option, optionIndex) => (
              <div key={option.id} className="q-option-row">
                <span className="q-option-glyph round">•</span>
                <span className="q-option-input" style={{ padding: "8px 11px" }}>
                  {optionIndex + 1}. {option.label}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {matrixColumns(question.settings).length ? (
          <div className="flex flex-wrap gap-1.5">
            {matrixColumns(question.settings).map((column) => (
              <span key={column} className="q-column-chip">
                列：{column}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
