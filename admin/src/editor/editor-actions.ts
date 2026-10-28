import { useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiSend, apiUpload, type EditorData, type PublishResult } from "../api";
import { useDialogs } from "../components/Dialogs";
import type { useSurveyEditor } from "./useSurveyEditor";
import { deletionConfirmMessage, planQuestionDeletion } from "./delete-with-cascade";
import { defaultQuestionDraft, insertTemplate, type TemplateId } from "./templates";

type Editor = ReturnType<typeof useSurveyEditor>;

/**
 * 编辑器动作集（S2 从旧壳 EditableEditor 原样搬出）：结构操作（复制/删除/分页/场景/发布）、
 * 六个媒体挂载动作、模板与默认题稿。旧壳与新壳共用同一份实现——
 * 删除的依赖感知级联、先保存再结构操作等语义只有一套，不会漂移。
 *
 * 返回的 handler 与拆分前逐字一致；壳只负责选中态与弹层开关。
 */
export function useEditorActions(data: EditorData, editor: Editor) {
  const { survey } = data;
  const navigate = useNavigate();
  const { confirm } = useDialogs();
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);

  const flushDraft = async (): Promise<boolean> => {
    if (editor.dirty && !(await editor.save())) return false;
    return true;
  };

  // Structural actions hit the server directly and then reload, so any
  // pending ops must be flushed first — silently reloading would drop them.
  const duplicateQuestion = async (questionId: number) => {
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/questions/${questionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制题目失败");
    }
  };

  const duplicateOption = async (questionId: number, optionId: number) => {
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/options/${optionId}/duplicate`, {});
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制选项失败");
    }
  };

  // 场景题走独立编辑器：先把 builder 里的待保存修改落库，再跳转。
  const openSceneEditor = async (questionId: number) => {
    if (!(await flushDraft())) return;
    navigate(`/surveys/${survey.id}/scene/${questionId}`);
  };

  // 新建空 scene 题（settings 为空，场景配置在编辑器里写入）。
  // insertQuestionWithOptions 只为 matrix 持久化 settings，所以这里不传场景配置。
  const addSceneQuestion = async (pageId: number | null) => {
    if (sceneBusy) return;
    if (!(await flushDraft())) return;
    setSceneBusy(true);
    setPublishError(null);
    try {
      const created = await apiSend<{ id: number }>("POST", `/api/admin/surveys/${survey.id}/questions`, {
        type: "scene",
        title: "互动场景",
        required: true,
        pageId,
      });
      if (!created?.id) throw new Error("创建互动场景题失败");
      navigate(`/surveys/${survey.id}/scene/${created.id}`);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "创建互动场景题失败");
    } finally {
      setSceneBusy(false);
    }
  };

  /**
   * 删除题目：先算影响面。有跳转指向它时，确认框逐条列出，确认后级联清掉
   * 这些引用（作为同一批待保存操作入队，撤销可整体回退）。
   */
  const requestDeleteQuestion = async (questionId: number) => {
    const target = editor.questions.find((question) => question.id === questionId);
    const snapshot = editor.questions.map((question) => ({
      id: question.id,
      title: question.title,
      condition: question.condition,
    }));
    const plan = planQuestionDeletion(snapshot, questionId);
    if (plan.dependents.length > 0) {
      const ok = await confirm({
        title: "删除会影响跳转",
        message: deletionConfirmMessage(plan, target?.title || `第 ${questionId} 题`),
        confirmLabel: "删除并清除跳转",
        variant: "danger",
      });
      if (!ok) return;
      for (const patch of plan.patches) {
        editor.patchQuestionLocal(patch.id, { condition: patch.condition });
        editor.queueQuestionPatch(patch.id, { condition: patch.condition }, "清除指向已删除题目的跳转");
      }
    }
    editor.deleteQuestion(questionId);
  };

  /** 模板：按顺序插入一组组件（含小游戏配置）。整批走同一条待保存队列。 */
  const applyTemplate = (templateId: TemplateId) => {
    insertTemplate(editor, templateId);
  };

  /** 按题型插入默认稿，返回临时 id（选中与弹层关闭由壳处理）。 */
  const addQuestionOfType = (type: string) => editor.addQuestion(defaultQuestionDraft(type));

  const attachQuestionMedia = async (questionId: number, file: File): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${survey.id}/questions/${questionId}/media`, file);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传题面附件失败");
      return false;
    }
  };

  /** 从素材库选择：只建关联（JSON {assetId}），不重传文件。 */
  const attachQuestionMediaFromLibrary = async (questionId: number, assetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/questions/${questionId}/media`, { assetId });
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "引用素材失败");
      return false;
    }
  };

  const removeQuestionMedia = async (questionId: number, mediaAssetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/questions/${questionId}/media/${mediaAssetId}`);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除题面附件失败");
      return false;
    }
  };

  /** 从素材库为选项挂已有素材（与题目附件同一套 JSON {assetId} 分支）。 */
  const attachOptionMediaFromLibrary = async (optionId: number, assetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("POST", `/api/admin/surveys/${survey.id}/options/${optionId}/media`, { assetId });
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "引用素材失败");
      return false;
    }
  };

  const attachOptionMedia = async (optionId: number, file: File): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${survey.id}/options/${optionId}/media`, file);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传选项媒体失败");
      return false;
    }
  };

  const removeOptionMedia = async (optionId: number, mediaAssetId: number): Promise<boolean> => {
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/options/${optionId}/media/${mediaAssetId}`);
      setPublishError(null);
      editor.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除选项媒体失败");
      return false;
    }
  };

  const addPage = async () => {
    if (editor.dirty && !(await editor.save())) return;
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
    if (!(await confirm({ message: "删除该分页？题目不会被删除，只会变为不分页。" }))) return;
    if (editor.dirty && !(await editor.save())) return;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${survey.id}/pages/${pageId}`);
      editor.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "删除分页失败");
    }
  };

  const moveQuestion = (questionId: number, direction: -1 | 1) => {
    const ids = editor.questions.map((question) => question.id);
    const index = ids.indexOf(questionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    const current = next[index]!;
    const swap = next[target]!;
    next[index] = swap;
    next[target] = current;
    editor.reorderQuestions(next);
  };

  const publish = async () => {
    if (editor.dirty || publishing) return;
    if (!(await confirm({ message: `确定发布“${editor.surveyMeta.title}”？发布后需复制为新草稿才能继续编辑。` })))
      return;
    setPublishing(true);
    setPublishError(null);
    try {
      await apiSend<PublishResult>("POST", `/api/admin/surveys/${survey.id}/publish`, {});
      window.location.reload();
    } catch (error) {
      setPublishError((error as ApiError).message);
      setPublishing(false);
    }
  };

  return {
    publishing,
    publishError,
    setPublishError,
    sceneBusy,
    flushDraft,
    duplicateQuestion,
    duplicateOption,
    openSceneEditor,
    addSceneQuestion,
    requestDeleteQuestion,
    applyTemplate,
    addQuestionOfType,
    attachQuestionMedia,
    attachQuestionMediaFromLibrary,
    removeQuestionMedia,
    attachOptionMedia,
    attachOptionMediaFromLibrary,
    removeOptionMedia,
    addPage,
    deletePage,
    moveQuestion,
    publish,
  };
}
