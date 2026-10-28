import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * 壳只负责选中态与弹层开关。
 *
 * 动作身份是稳定的（E4）：全部 handler 用 `useCallback([])` 包裹，闭包依赖
 * 经 latest-ref 读取。原因：`editor`/`survey` 每次键击都是新对象，直接闭包
 * 会让 handler 身份每键击刷新，下游 QuestionSummaryRow 的 memo 与
 * PropertiesPanel 的 memo 全部失效——135 题画布上这正是打字热路径。
 */
export function useEditorActions(data: EditorData, editor: Editor) {
  const { survey } = data;
  const navigate = useNavigate();
  const { confirm } = useDialogs();
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);

  // latest-ref：渲染后同步最新依赖，动作体在调用时才解引用，身份永不漂移。
  // （写入只能在 effect 里做——渲染期写 ref 会破坏并发渲染的一致性保证。）
  const depsRef = useRef({ data, survey, editor, navigate, confirm });
  useEffect(() => {
    depsRef.current = { data, survey, editor, navigate, confirm };
  });
  const publishingRef = useRef(publishing);
  useEffect(() => {
    publishingRef.current = publishing;
  });
  const sceneBusyRef = useRef(sceneBusy);
  useEffect(() => {
    sceneBusyRef.current = sceneBusy;
  });

  const flushDraft = useCallback(async (): Promise<boolean> => {
    const { editor: current } = depsRef.current;
    if (current.dirty && !(await current.save())) return false;
    return true;
  }, []);

  // Structural actions hit the server directly and then reload, so any
  // pending ops must be flushed first — silently reloading would drop them.
  const duplicateQuestion = useCallback(async (questionId: number) => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (current.dirty && !(await current.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${currentSurvey.id}/questions/${questionId}/duplicate`, {});
      current.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制题目失败");
    }
  }, []);

  const duplicateOption = useCallback(async (questionId: number, optionId: number) => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (current.dirty && !(await current.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${currentSurvey.id}/options/${optionId}/duplicate`, {});
      current.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "复制选项失败");
    }
  }, []);

  // 场景题走独立编辑器：先把 builder 里的待保存修改落库，再跳转。
  const openSceneEditor = useCallback(async (questionId: number) => {
    if (!(await flushDraft())) return;
    const { survey: currentSurvey, navigate: currentNavigate } = depsRef.current;
    currentNavigate(`/surveys/${currentSurvey.id}/scene/${questionId}`);
  }, [flushDraft]);

  // 新建空 scene 题（settings 为空，场景配置在编辑器里写入）。
  // insertQuestionWithOptions 只为 matrix 持久化 settings，所以这里不传场景配置。
  // openInShell：P3 新壳传「打开壳内浮层」回调（创建后不跳页）；旧壳缺省导航。
  const addSceneQuestion = useCallback(async (pageId: number | null, openInShell?: (questionId: number) => void) => {
    const { survey: currentSurvey, navigate: currentNavigate } = depsRef.current;
    if (sceneBusyRef.current) return;
    if (!(await flushDraft())) return;
    setSceneBusy(true);
    setPublishError(null);
    try {
      const created = await apiSend<{ id: number }>("POST", `/api/admin/surveys/${currentSurvey.id}/questions`, {
        type: "scene",
        title: "互动场景",
        required: true,
        pageId,
      });
      if (!created?.id) throw new Error("创建互动场景题失败");
      if (openInShell) openInShell(created.id);
      else currentNavigate(`/surveys/${currentSurvey.id}/scene/${created.id}`);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "创建互动场景题失败");
    } finally {
      setSceneBusy(false);
    }
  }, [flushDraft]);

  /**
   * 删除题目：先算影响面。有跳转指向它时，确认框逐条列出，确认后级联清掉
   * 这些引用（作为同一批待保存操作入队，撤销可整体回退）。
   */
  const requestDeleteQuestion = useCallback(async (questionId: number) => {
    const { editor: current, confirm: currentConfirm } = depsRef.current;
    const target = current.questions.find((question) => question.id === questionId);
    const snapshot = current.questions.map((question) => ({
      id: question.id,
      title: question.title,
      condition: question.condition,
    }));
    const plan = planQuestionDeletion(snapshot, questionId);
    if (plan.dependents.length > 0) {
      const ok = await currentConfirm({
        title: "删除会影响跳转",
        message: deletionConfirmMessage(plan, target?.title || `第 ${questionId} 题`),
        confirmLabel: "删除并清除跳转",
        variant: "danger",
      });
      if (!ok) return;
      for (const patch of plan.patches) {
        current.patchQuestionLocal(patch.id, { condition: patch.condition });
        current.queueQuestionPatch(patch.id, { condition: patch.condition }, "清除指向已删除题目的跳转");
      }
    }
    current.deleteQuestion(questionId);
  }, []);

  /** 模板：按顺序插入一组组件（含小游戏配置）。整批走同一条待保存队列。 */
  const applyTemplate = useCallback((templateId: TemplateId) => {
    insertTemplate(depsRef.current.editor, templateId);
  }, []);

  /** 按题型插入默认稿，返回临时 id（选中与弹层关闭由壳处理）。 */
  const addQuestionOfType = useCallback((type: string) => depsRef.current.editor.addQuestion(defaultQuestionDraft(type)), []);

  const attachQuestionMedia = useCallback(async (questionId: number, file: File): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${currentSurvey.id}/questions/${questionId}/media`, file);
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传题面附件失败");
      return false;
    }
  }, [flushDraft]);

  /** 从素材库选择：只建关联（JSON {assetId}），不重传文件。 */
  const attachQuestionMediaFromLibrary = useCallback(async (questionId: number, assetId: number): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiSend("POST", `/api/admin/surveys/${currentSurvey.id}/questions/${questionId}/media`, { assetId });
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "引用素材失败");
      return false;
    }
  }, [flushDraft]);

  const removeQuestionMedia = useCallback(async (questionId: number, mediaAssetId: number): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${currentSurvey.id}/questions/${questionId}/media/${mediaAssetId}`);
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除题面附件失败");
      return false;
    }
  }, [flushDraft]);

  /** 从素材库为选项挂已有素材（与题目附件同一套 JSON {assetId} 分支）。 */
  const attachOptionMediaFromLibrary = useCallback(async (optionId: number, assetId: number): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiSend("POST", `/api/admin/surveys/${currentSurvey.id}/options/${optionId}/media`, { assetId });
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "引用素材失败");
      return false;
    }
  }, [flushDraft]);

  const attachOptionMedia = useCallback(async (optionId: number, file: File): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiUpload(`/api/admin/surveys/${currentSurvey.id}/options/${optionId}/media`, file);
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "上传选项媒体失败");
      return false;
    }
  }, [flushDraft]);

  const removeOptionMedia = useCallback(async (optionId: number, mediaAssetId: number): Promise<boolean> => {
    const { survey: currentSurvey, editor: current } = depsRef.current;
    if (!(await flushDraft())) return false;
    try {
      await apiSend("DELETE", `/api/admin/surveys/${currentSurvey.id}/options/${optionId}/media/${mediaAssetId}`);
      setPublishError(null);
      current.discardAndReload();
      return true;
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "移除选项媒体失败");
      return false;
    }
  }, [flushDraft]);

  const addPage = useCallback(async () => {
    const { data: currentData, survey: currentSurvey, editor: current } = depsRef.current;
    if (current.dirty && !(await current.save())) return;
    try {
      await apiSend("POST", `/api/admin/surveys/${currentSurvey.id}/pages`, {
        title: `第 ${currentData.pages.length + 1} 页`,
      });
      current.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "新建分页失败");
    }
  }, []);

  const deletePage = useCallback(async (pageId: number) => {
    const { editor: current, confirm: currentConfirm } = depsRef.current;
    if (!(await currentConfirm({ message: "删除该分页？题目不会被删除，只会变为不分页。" }))) return;
    if (current.dirty && !(await current.save())) return;
    try {
      const { survey: currentSurvey } = depsRef.current;
      await apiSend("DELETE", `/api/admin/surveys/${currentSurvey.id}/pages/${pageId}`);
      current.discardAndReload();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "删除分页失败");
    }
  }, []);

  const moveQuestion = useCallback((questionId: number, direction: -1 | 1) => {
    const { editor: current } = depsRef.current;
    const ids = current.questions.map((question) => question.id);
    const index = ids.indexOf(questionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    const currentId = next[index]!;
    const swap = next[target]!;
    next[index] = swap;
    next[target] = currentId;
    current.reorderQuestions(next);
  }, []);

  const publish = useCallback(async () => {
    const { editor: current, survey: currentSurvey, confirm: currentConfirm } = depsRef.current;
    if (current.dirty || publishingRef.current) return;
    if (!(await currentConfirm({ message: `确定发布“${current.surveyMeta.title}”？发布后需复制为新草稿才能继续编辑。` })))
      return;
    setPublishing(true);
    setPublishError(null);
    try {
      await apiSend<PublishResult>("POST", `/api/admin/surveys/${currentSurvey.id}/publish`, {});
      window.location.reload();
    } catch (error) {
      setPublishError((error as ApiError).message);
      setPublishing(false);
    }
  }, []);

  return useMemo(
    () => ({
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
    }),
    // 动作身份全部稳定；这里只让 busy/publish 状态的翻转传给消费者。
    [publishing, publishError, sceneBusy, flushDraft, duplicateQuestion, duplicateOption, openSceneEditor,
      addSceneQuestion, requestDeleteQuestion, applyTemplate, addQuestionOfType, attachQuestionMedia,
      attachQuestionMediaFromLibrary, removeQuestionMedia, attachOptionMedia, attachOptionMediaFromLibrary,
      removeOptionMedia, addPage, deletePage, moveQuestion, publish],
  );
}
