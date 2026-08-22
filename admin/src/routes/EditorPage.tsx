import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { useApi } from "../hooks";
import { ApiError, apiSend, type EditorData, type PublishResult, type WriteResult } from "../api";
import { EmptyPanel, ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { QuestionCard, editableTypeList } from "../components/editor/QuestionCard";
import { SortableQuestionList } from "../components/editor/SortableQuestionList";
import { SurveyPreview } from "../components/editor/SurveyPreview";
import { useSurveyEditor } from "../editor/useSurveyEditor";
import { buildEditorPreviewFlow } from "../editor/previewModel";
import { QUESTION_TYPE_LABELS, formatDateTime, matrixColumns } from "../format";

// Phase 2.4: field edits commit on blur into a pending-op
// queue; 保存 flushes it sequentially (temp ids resolve to server ids).
// Dirty state protects browser and SPA navigation; stale writes require reload.
// Publish (2.6) stays disabled.
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
          <span className="text-red-600">
            {saveError?.stale ? "检测到其他窗口的更新：" : "保存失败："}
            {saveError?.message}
          </span>
          {!saveError?.stale ? (
            <button className="btn btn-sm" onClick={onSave}>
              重试保存
            </button>
          ) : null}
          <button className="btn btn-sm" onClick={onDiscard}>
            {saveError?.stale ? "放弃本地修改并加载最新版" : "放弃修改并刷新"}
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
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const { survey } = data;
  const editingDisabled = editor.saveState === "saving" || Boolean(editor.saveError?.stale);
  const previewQuestions = useMemo(
    () => buildEditorPreviewFlow(survey.id, editor.questions),
    [editor.questions, survey.id],
  );
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      editor.dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("有未保存的修改，确定离开？")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const handleFieldCommit = (questionId: number, patch: Record<string, unknown>, label: string) => {
    if (Object.keys(patch).length) editor.queueQuestionPatch(questionId, patch, label);
  };

  const handleOptionRename = (questionId: number, optionId: number, label: string) => {
    editor.renameOption(questionId, optionId, label);
  };

  const backWithGuard = () => {
    navigate(`/surveys/${survey.id}`);
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

  const duplicateQuestion = async (questionId: number) => {
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/questions/${questionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制题目失败");
    }
  };

  const duplicateOption = async (questionId: number, optionId: number) => {
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/options/${optionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制选项失败");
    }
  };

  const addPage = async () => {
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/pages`, {
        title: `第 ${data.pages.length + 1} 页`,
      });
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "新建分页失败");
    }
  };

  const deletePage = async (pageId: number) => {
    if (!window.confirm("删除该分页？题目不会被删除，只会变为不分页。")) return;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/pages/${pageId}`);
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "删除分页失败");
    }
  };

  const publish = async () => {
    if (editor.dirty || publishing) return;
    if (!window.confirm(`确定发布“${editor.surveyMeta.title}”？发布后需复制为新草稿才能继续编辑。`)) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await apiSend<PublishResult>("POST", `/api/admin/surveys/${survey.id}/publish`, {
        baseUpdatedAt: editor.baseUpdatedAt,
      });
      window.location.reload();
    } catch (error) {
      setPublishError((error as ApiError).message);
      setPublishing(false);
    }
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
              {editor.questions.length} 题 · 基准更新于 {formatDateTime(editor.baseUpdatedAt)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={editingDisabled || !editor.dirty}
            onClick={() => editor.save()}
          >
            💾 保存
          </button>
          <button className="btn" disabled={editor.saveState === "saving"} onClick={() => setPreviewOpen(true)}>
            👁 预览
          </button>
          <button
            className="btn"
            disabled={editingDisabled || editor.dirty || publishing || editor.questions.length === 0}
            title={editor.dirty ? "请先保存修改" : "发布后问卷将进入只读状态"}
            onClick={publish}
          >
            {publishing ? "发布中…" : "🚀 发布"}
          </button>
        </div>
      </div>
      <SaveStatusBar
        saveState={editor.saveState}
        saveError={editor.saveError}
        onSave={() => editor.save()}
        onDiscard={editor.discardAndReload}
      />
      {publishError ? (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          发布失败：{publishError}
        </div>
      ) : null}

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="mb-3 font-semibold">问卷设置</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-gray-500">标题</span>
            <input
              className="input"
              defaultValue={editor.surveyMeta.title}
              key={`survey-title-${survey.id}`}
              disabled={editingDisabled}
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
              disabled={editingDisabled}
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
              disabled={editingDisabled}
              onChange={(event) => editor.updateSurveyMeta({ anonymous: event.target.checked })}
            />
            <span className="text-gray-700">匿名填写</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editor.surveyMeta.allowMultipleResponses}
              disabled={editingDisabled}
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
                disabled={editingDisabled}
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
        {data.pages.length ? (
          <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-gray-700">分页</h4>
              <button className="btn btn-sm" disabled={editingDisabled} onClick={() => void addPage()}>
                ＋ 新分页
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.pages.map((page) => (
                <span key={page.id} className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm">
                  {page.title || `第 ${page.order + 1} 页`}
                  <button className="text-red-500" disabled={editingDisabled} onClick={() => void deletePage(page.id)}>✕</button>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-dashed border-gray-200 p-3">
            <span className="text-sm text-gray-400">还没有分页（可在题目卡片中把题目归入分页）</span>
            <button className="btn btn-sm" disabled={editingDisabled} onClick={() => void addPage()}>
              ＋ 新建分页
            </button>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">题目列表</h3>
            {editor.questions.length > 1 ? (
              <p className="mt-0.5 text-xs text-gray-400">拖动题目左侧把手排序；移动端请长按把手后拖动</p>
            ) : null}
          </div>
          <button className="btn" disabled={editingDisabled} onClick={() => setPickerOpen((open) => !open)}>
            ＋ 添加题目
          </button>
        </div>

        {pickerOpen ? (
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 sm:grid-cols-3 lg:grid-cols-5">
            {editableTypeList().map(({ type, label }) => (
              <button
                key={type}
                className="btn btn-sm"
                disabled={editingDisabled}
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
          <SortableQuestionList
            questions={editor.questions}
            editable={!editingDisabled}
            onReorder={editor.reorderQuestions}
            onFieldCommit={handleFieldCommit}
            onLocalChange={editor.patchQuestionLocal}
            onOptionRename={handleOptionRename}
            onAddOption={editor.addOption}
            onDeleteOption={editor.deleteOption}
            onDelete={editor.deleteQuestion}
            onDuplicateQuestion={(questionId) => void duplicateQuestion(questionId)}
            onDuplicateOption={(questionId, optionId) => void duplicateOption(questionId, optionId)}
            pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
          />
        ) : (
          <EmptyPanel text="这份问卷还没有题目，点击「添加题目」开始" />
        )}
      </section>
      {previewOpen ? (
        <SurveyPreview
          title={editor.surveyMeta.title}
          description={editor.surveyMeta.description}
          questions={previewQuestions}
          dirty={editor.dirty}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
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
          <button className="btn" onClick={() => setPreviewOpen(true)}>
            👁 预览
          </button>
          <button className="btn" disabled={duplicating} onClick={duplicateAsDraft}>
            {duplicating ? "复制中…" : "复制为新草稿"}
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
        该问卷当前不可编辑（{survey.status !== "draft" ? "非草稿状态" : `已有 ${survey.responseCount} 份答卷`}）。
        复制为新草稿后编辑的入口将在后续批次提供；当前为只读视图。
      </div>
      {duplicateError ? (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          复制失败：{duplicateError}
        </div>
      ) : null}

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
      {previewOpen ? (
        <SurveyPreview
          title={survey.title}
          description={survey.description ?? ""}
          questions={previewQuestions}
          dirty={false}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}
