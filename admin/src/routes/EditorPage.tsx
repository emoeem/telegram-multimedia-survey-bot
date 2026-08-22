import { useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../hooks";
import type { EditorData } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { QuestionCard, editableTypeList } from "../components/editor/QuestionCard";
import { useSurveyEditor } from "../editor/useSurveyEditor";
import { QUESTION_TYPE_LABELS, formatDateTime, matrixColumns } from "../format";

// Phase 2.2: question editing. Field edits commit on blur into a pending-op
// queue; 保存 flushes it sequentially (temp ids resolve to server ids).
// Reorder (2.3), preview (2.5) and publish (2.6) stay disabled.
export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<EditorData>(
    id ? `/api/admin/surveys/${id}/editor` : null,
  );

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;
  if (!data.survey.editable) return <ReadOnlyEditor data={data} />;
  return <EditableEditor data={data} />;
}

function SaveStatusBar({
  saveState,
  saveError,
  onSave,
  onDiscard,
}: {
  saveState: "saved" | "dirty" | "saving" | "error";
  saveError: { message: string; stale: boolean } | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      {saveState === "saving" ? (
        <span className="text-blue-600">保存中…</span>
      ) : saveState === "error" ? (
        <>
          <span className="text-red-600">保存失败：{saveError?.message}</span>
          <button className="btn btn-sm" onClick={onSave}>
            重试保存
          </button>
          <button className="btn btn-sm" onClick={onDiscard}>
            放弃修改并刷新
          </button>
        </>
      ) : saveState === "dirty" ? (
        <span className="text-amber-600">有未保存的修改</span>
      ) : (
        <span className="text-green-600">已保存</span>
      )}
    </div>
  );
}

function EditableEditor({ data }: { data: EditorData }) {
  const editor = useSurveyEditor(data);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { survey } = data;

  const handleFieldCommit = (questionId: number, patch: Record<string, unknown>, label: string) => {
    if (Object.keys(patch).length) editor.queueQuestionPatch(questionId, patch, label);
  };

  const handleOptionRename = (questionId: number, optionId: number, label: string) => {
    editor.renameOption(questionId, optionId, label);
  };

  const backWithGuard = () => {
    if (editor.dirty && !window.confirm("有未保存的修改，确定离开？")) return;
    window.location.assign(`/admin/surveys/${survey.id}`);
  };

  const addDefaultQuestion = (type: string) => {
    const defaults: Record<string, { title: string; options?: { label: string }[]; columns?: string[] }> = {
      single: { title: "新的单选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
      multiple: { title: "新的多选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
      yes_no: { title: "新的是非题", options: [{ label: "是" }, { label: "否" }] },
      rating: { title: "新的评分题", options: [{ label: "1 星" }, { label: "5 星" }] },
      matrix: { title: "新的矩阵题", options: [{ label: "行 1" }], columns: ["列 1", "列 2"] },
      text: { title: "新的文本题" },
      long_text: { title: "新的长文本题" },
      number: { title: "新的数字题" },
      date: { title: "新的日期题" },
      time: { title: "新的时间题" },
    };
    const draft = defaults[type] ?? { title: "新题目" };
    editor.addQuestion({ type, ...draft });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <button className="btn" title="返回详情（有未保存修改时会确认）" onClick={backWithGuard}>
            ←
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{editor.surveyMeta.title || "未命名问卷"}</h2>
              <StatusBadge status={survey.status} />
            </div>
            <div className="text-xs text-gray-500">
              {editor.questions.length} 题 · 基准更新于 {formatDateTime(survey.updatedAt)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={editor.saveState === "saving" || !editor.dirty}
            onClick={() => editor.save()}
          >
            💾 保存
          </button>
          <button className="btn" disabled title="Phase 2.5 提供共享渲染预览">
            👁 预览
          </button>
          <button className="btn" disabled title="Phase 2.6 提供发布流程">
            🚀 发布
          </button>
        </div>
      </div>
      <SaveStatusBar
        saveState={editor.saveState}
        saveError={editor.saveError}
        onSave={() => editor.save()}
        onDiscard={editor.discardAndReload}
      />

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="mb-3 font-semibold">问卷设置</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-gray-500">标题</span>
            <input
              className="input"
              defaultValue={editor.surveyMeta.title}
              key={`survey-title-${survey.id}`}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next && next !== editor.surveyMeta.title) editor.updateSurveyMeta({ title: next });
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-gray-500">描述</span>
            <input
              className="input"
              defaultValue={editor.surveyMeta.description}
              key={`survey-description-${survey.id}`}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next !== editor.surveyMeta.description) editor.updateSurveyMeta({ description: next });
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editor.surveyMeta.anonymous}
              onChange={(event) => editor.updateSurveyMeta({ anonymous: event.target.checked })}
            />
            <span className="text-gray-700">匿名填写</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editor.surveyMeta.allowMultipleResponses}
              onChange={(event) =>
                editor.updateSurveyMeta({ allowMultipleResponses: event.target.checked })
              }
            />
            <span className="text-gray-700">允许重复填写</span>
          </label>
          {editor.surveyMeta.allowMultipleResponses ? (
            <label className="grid gap-1 text-sm">
              <span className="text-gray-500">每人填写上限（0 = 不限）</span>
              <input
                type="number"
                min={0}
                max={999}
                className="input w-32"
                defaultValue={editor.surveyMeta.maxResponsesPerUser}
                key={`survey-max-${survey.id}`}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next !== editor.surveyMeta.maxResponsesPerUser) {
                    editor.updateSurveyMeta({ maxResponsesPerUser: next });
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">题目列表</h3>
          <button className="btn" onClick={() => setPickerOpen((open) => !open)}>
            ＋ 添加题目
          </button>
        </div>

        {pickerOpen ? (
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 sm:grid-cols-3 lg:grid-cols-5">
            {editableTypeList().map(({ type, label }) => (
              <button
                key={type}
                className="btn btn-sm"
                onClick={() => {
                  addDefaultQuestion(type);
                  setPickerOpen(false);
                }}
              >
                {label}
              </button>
            ))}
            <div className="col-span-2 text-xs text-gray-400 sm:col-span-3 lg:col-span-5">
              图片 / 视频 / 音频 / 文件题请在 Bot 内创建后回到此处编辑文字部分。
            </div>
          </div>
        ) : null}

        {editor.questions.length ? (
          <div className="grid gap-3">
            {editor.questions.map((question, index) => (
              <QuestionCard
                key={question.id}
                question={question}
                index={index}
                editable
                onFieldCommit={handleFieldCommit}
                onLocalChange={editor.patchQuestionLocal}
                onOptionRename={handleOptionRename}
                onAddOption={editor.addOption}
                onDeleteOption={editor.deleteOption}
                onDelete={editor.deleteQuestion}
              />
            ))}
          </div>
        ) : (
          <EmptyPanel text="这份问卷还没有题目，点击「添加题目」开始" />
        )}
      </section>
    </div>
  );
}

function ReadOnlyEditor({ data }: { data: EditorData }) {
  const { survey, questions } = data;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Link to={`/surveys/${survey.id}`} className="btn" title="返回详情">
            ←
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{survey.title || "未命名问卷"}</h2>
              <StatusBadge status={survey.status} />
            </div>
            <div className="text-xs text-gray-500">
              {survey.questionCount} 题 · 更新于 {formatDateTime(survey.updatedAt)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
        该问卷当前不可编辑（{survey.status !== "draft" ? "非草稿状态" : `已有 ${survey.responseCount} 份答卷`}）。
        复制为新草稿后编辑的入口将在后续批次提供；当前为只读视图。
      </div>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="mb-3 font-semibold">题目列表（只读）</h3>
        {questions.length ? (
          <div className="grid gap-3">
            {questions.map((question, index) => (
              <div key={question.id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                    第 {index + 1} 题
                  </span>
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
                    {QUESTION_TYPE_LABELS[question.type] ?? question.type}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-semibold ${
                      question.required ? "bg-red-50 text-red-600" : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {question.required ? "必答" : "选答"}
                  </span>
                </div>
                <div className="mt-2 font-medium">{question.title}</div>
                {question.description ? (
                  <div className="mt-1 text-sm text-gray-500">{question.description}</div>
                ) : null}
                {question.options.length ? (
                  <ul className="mt-2 space-y-1 text-sm text-gray-700">
                    {question.options.map((option, optionIndex) => (
                      <li key={option.id}>
                        {optionIndex + 1}. {option.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {matrixColumns(question.settings).length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {matrixColumns(question.settings).map((column) => (
                      <span key={column} className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs text-amber-700">
                        列：{column}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel text="这份问卷还没有题目" />
        )}
      </section>
    </div>
  );
}
