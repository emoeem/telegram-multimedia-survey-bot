import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiSend, type ApiError, type EditorData, type EditorQuestion, type WriteResult } from "../api";

// Phase 2.2 editing model: every mutation appends an operation to a queue with
// a temporary negative id; 保存 flushes the queue sequentially against the
// real API, mapping temp ids to the ids the server returns. Field edits commit
// on blur, so one user edit produces exactly one queued op.

export interface EditableOption {
  id: number;
  label: string;
  order: number;
  media: EditorQuestion["media"];
}

export interface EditableQuestion {
  id: number;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  order: number;
  columns: string[];
  validation: Record<string, number | boolean> | null;
  condition: Record<string, unknown> | null;
  media: EditorQuestion["media"];
  options: EditableOption[];
}

interface PendingOp {
  key: number;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown> | undefined;
  // tempId < 0 的实体在该创建操作成功后映射为服务端返回的真实 ID
  tempId: number | null;
  label: string;
}

export type SaveState = "saved" | "dirty" | "saving" | "error";

export function useSurveyEditor(data: EditorData) {
  const [surveyMeta, setSurveyMeta] = useState(() => ({
    title: data.survey.title,
    description: data.survey.description ?? "",
    anonymous: data.survey.anonymous,
    allowMultipleResponses: data.survey.allowMultipleResponses,
    maxResponsesPerUser: data.survey.maxResponsesPerUser,
  }));
  const [questions, setQuestions] = useState<EditableQuestion[]>(() =>
    data.questions.map((question) => ({
      id: question.id,
      type: question.type,
      title: question.title,
      description: question.description,
      required: question.required,
      order: question.order,
      columns: Array.isArray(question.settings?.columns)
        ? (question.settings!.columns as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
      validation: (question.validation as Record<string, number | boolean> | null) ?? null,
      condition: question.condition,
      media: question.media,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        order: option.order,
        media: option.media,
      })),
    })),
  );
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(data.survey.updatedAt);
  const baseUpdatedAtRef = useRef(baseUpdatedAt);
  const [ops, setOps] = useState<PendingOp[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; stale: boolean } | null>(null);
  const opKeyRef = useRef(1);
  const tempIdRef = useRef(-1);
  const surveyId = data.survey.id;

  const dirty = ops.length > 0;

  useEffect(() => {
    baseUpdatedAtRef.current = baseUpdatedAt;
  }, [baseUpdatedAt]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const pushOp = useCallback(
    (op: Omit<PendingOp, "key">) => {
      const key = opKeyRef.current++;
      setOps((current) => [...current, { ...op, key }]);
      setSaveError(null);
    },
    [],
  );

  // ---- survey meta（合并为单个 PATCH） ----
  const updateSurveyMeta = useCallback(
    (patch: Partial<typeof surveyMeta>) => {
      setSurveyMeta((current) => ({ ...current, ...patch }));
      setOps((current) => {
        const existingIndex = current.findIndex((op) => op.method === "PATCH" && op.path === `/api/admin/surveys/${surveyId}`);
        const fields = { ...(current[existingIndex]?.body ?? {}), ...patch };
        const op: PendingOp = {
          key: existingIndex >= 0 ? current[existingIndex]!.key : opKeyRef.current++,
          method: "PATCH",
          path: `/api/admin/surveys/${surveyId}`,
          body: fields,
          tempId: null,
          label: "问卷设置",
        };
        if (existingIndex >= 0) {
          const next = [...current];
          next[existingIndex] = op;
          return next;
        }
        return [...current, op];
      });
      setSaveError(null);
    },
    [surveyId],
  );

  // ---- question helpers ----
  const patchQuestionLocal = useCallback((questionId: number, patch: Partial<EditableQuestion>) => {
    setQuestions((current) => current.map((q) => (q.id === questionId ? { ...q, ...patch } : q)));
  }, []);

  const queueQuestionPatch = useCallback(
    (questionId: number, body: Record<string, unknown>, label: string) => {
      pushOp({
        method: "PATCH",
        path: `/api/admin/surveys/${surveyId}/questions/${questionId}`,
        body,
        tempId: null,
        label,
      });
    },
    [pushOp, surveyId],
  );

  const addQuestion = useCallback(
    (draft: { type: string; title: string; options?: { label: string }[]; columns?: string[] }) => {
      const tempId = tempIdRef.current--;
      setQuestions((current) => [
        ...current,
        {
          id: tempId,
          type: draft.type,
          title: draft.title,
          description: null,
          required: true,
          order: current.length,
          columns: draft.columns ?? [],
          validation: null,
          condition: null,
          media: [],
          options: (draft.options ?? []).map((option, index) => ({
            id: tempIdRef.current--,
            label: option.label,
            order: index,
            media: [],
          })),
        },
      ]);
      pushOp({
        method: "POST",
        path: `/api/admin/surveys/${surveyId}/questions`,
        body: {
          type: draft.type,
          title: draft.title,
          required: true,
          ...(draft.options?.length ? { options: draft.options } : {}),
          ...(draft.type === "matrix" && draft.columns?.length
            ? { settings: { columns: draft.columns } }
            : {}),
        },
        tempId,
        label: "新增题目",
      });
    },
    [pushOp, surveyId],
  );

  const deleteQuestion = useCallback(
    (questionId: number) => {
      setQuestions((current) => current.filter((q) => q.id !== questionId));
      if (questionId < 0) {
        // 本地未保存的题目：同时丢弃其创建操作与后续操作
        setOps((current) =>
          current.filter((op) => op.tempId !== questionId && !op.path.includes(`questions/${questionId}`)),
        );
        return;
      }
      pushOp({
        method: "DELETE",
        path: `/api/admin/surveys/${surveyId}/questions/${questionId}`,
        body: undefined,
        tempId: null,
        label: "删除题目",
      });
    },
    [pushOp, surveyId],
  );

  const addOption = useCallback(
    (questionId: number, label: string) => {
      const tempOptionId = tempIdRef.current--;
      setQuestions((current) =>
        current.map((q) =>
          q.id === questionId
            ? { ...q, options: [...q.options, { id: tempOptionId, label, order: q.options.length, media: [] }] }
            : q,
        ),
      );
      pushOp({
        method: "POST",
        path: `/api/admin/surveys/${surveyId}/questions/${questionId}/options`,
        body: { label },
        tempId: tempOptionId,
        label: "新增选项",
      });
    },
    [pushOp, surveyId],
  );

  const deleteOption = useCallback(
    (questionId: number, optionId: number) => {
      setQuestions((current) =>
        current.map((q) =>
          q.id === questionId ? { ...q, options: q.options.filter((o) => o.id !== optionId) } : q,
        ),
      );
      if (optionId < 0) {
        setOps((current) => current.filter((op) => op.tempId !== optionId));
        return;
      }
      pushOp({
        method: "DELETE",
        path: `/api/admin/surveys/${surveyId}/options/${optionId}`,
        body: undefined,
        tempId: null,
        label: "删除选项",
      });
    },
    [pushOp, surveyId],
  );

  const renameOption = useCallback(
    (questionId: number, optionId: number, label: string) => {
      setQuestions((current) =>
        current.map((q) =>
          q.id === questionId
            ? { ...q, options: q.options.map((o) => (o.id === optionId ? { ...o, label } : o)) }
            : q,
        ),
      );
      pushOp({
        method: "PATCH",
        path: `/api/admin/surveys/${surveyId}/options/${optionId}`,
        body: { label },
        tempId: null,
        label: "选项文案",
      });
    },
    [pushOp, surveyId],
  );

  // ---- 保存 ----
  const resolveRef = useCallback((value: string | number, idMap: Map<number, number>): string => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(numeric) && idMap.has(numeric)) return String(idMap.get(numeric));
    return String(value);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    setSaveError(null);
    const idMap = new Map<number, number>();
    let remaining = [...ops];
    let failed: ApiError | null = null;
    while (remaining.length) {
      const op = remaining[0]!;
      const path = op.path.replace(/questions\/(-?\d+)/g, (match, id) => `questions/${resolveRef(id, idMap)}`)
        .replace(/options\/(-?\d+)/g, (match, id) => `options/${resolveRef(id, idMap)}`);
      try {
        const result = await apiSend<WriteResult>(op.method, path, op.body
          ? { ...op.body, baseUpdatedAt: baseUpdatedAtRef.current }
          : undefined);
        if (op.tempId !== null && typeof result.id === "number") idMap.set(op.tempId, result.id);
        if (typeof result.updatedAt === "string") {
          baseUpdatedAtRef.current = result.updatedAt;
          setBaseUpdatedAt(result.updatedAt);
        }
        remaining = remaining.slice(1);
        setOps([...remaining]);
      } catch (error) {
        failed = error as ApiError;
        break;
      }
    }
    // 用映射后的真实 ID 刷新本地题目/选项
    if (idMap.size) {
      setQuestions((current) =>
        current.map((question) => {
          const questionId = idMap.get(question.id) ?? question.id;
          return {
            ...question,
            id: questionId,
            options: question.options.map((option) => ({
              ...option,
              id: idMap.get(option.id) ?? option.id,
            })),
          };
        }),
      );
    }
    setSaving(false);
    if (failed) {
      setSaveError({
        message: failed.message,
        stale: failed.status === 409,
      });
      return false;
    }
    return true;
  }, [ops, resolveRef, saving]);

  const discardAndReload = useCallback(() => {
    setOps([]);
    setSaveError(null);
    window.location.reload();
  }, []);

  const saveState: SaveState = saving ? "saving" : saveError ? "error" : dirty ? "dirty" : "saved";

  return useMemo(
    () => ({
      surveyMeta,
      updateSurveyMeta,
      questions,
      patchQuestionLocal,
      queueQuestionPatch,
      addQuestion,
      deleteQuestion,
      addOption,
      deleteOption,
      renameOption,
      save,
      saveState,
      saveError,
      discardAndReload,
      dirty,
    }),
    [surveyMeta, updateSurveyMeta, questions, patchQuestionLocal, queueQuestionPatch, addQuestion,
      deleteQuestion, addOption, deleteOption, renameOption, save, saveState, saveError, discardAndReload, dirty],
  );
}
