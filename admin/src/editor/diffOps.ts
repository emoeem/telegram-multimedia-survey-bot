// Self-contained structural types so this module stays DOM/react-free and can
// be unit-tested from the root workspace without dragging the admin tsconfig.
export interface DiffMediaRef {
  url?: string;
  mediaAssetId?: number;
  mediaType?: string;
}

export interface DiffOption {
  id: number;
  label: string;
  order: number;
  media: DiffMediaRef[];
}

export interface DiffQuestion {
  id: number;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  order: number;
  pageId: number | null;
  columns: string[];
  validation: Record<string, number | boolean> | null;
  condition: Record<string, unknown> | null;
  media: DiffMediaRef[];
  options: DiffOption[];
}

export interface DiffSurveyMeta {
  title: string;
  description: string;
  anonymous: boolean;
  allowMultipleResponses: boolean;
  maxResponsesPerUser: number;
}

export interface EditorSnapshot {
  surveyMeta: DiffSurveyMeta;
  questions: DiffQuestion[];
}

export interface DiffPendingOp {
  key: number;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown> | undefined;
  tempId: number | null;
  label: string;
}

interface KeyAndTemp {
  key(): number;
  temp(): number;
}

function cloneOptions(options: DiffOption[]): DiffOption[] {
  return options.map((option) => ({ ...option, media: [...option.media] }));
}

export function cloneQuestion(question: DiffQuestion): DiffQuestion {
  return {
    ...question,
    options: cloneOptions(question.options),
    media: [...question.media],
    validation: question.validation ? { ...question.validation } : null,
    condition: question.condition ? { ...question.condition } : null,
  };
}

export function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    surveyMeta: { ...snapshot.surveyMeta },
    questions: snapshot.questions.map(cloneQuestion),
  };
}

function questionCreateBody(question: DiffQuestion): Record<string, unknown> {
  return {
    type: question.type,
    title: question.title,
    required: question.required,
    ...(question.description ? { description: question.description } : {}),
    ...(question.pageId !== null ? { pageId: question.pageId } : {}),
    ...(question.options.length ? { options: question.options.map((option) => ({ label: option.label })) } : {}),
    ...(question.columns.length
      ? { settings: { columns: question.columns } }
      : {}),
  };
}

function questionPatch(base: DiffQuestion, target: DiffQuestion): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (base.title !== target.title) patch.title = target.title;
  if (base.description !== target.description) patch.description = target.description ?? "";
  if (base.required !== target.required) patch.required = target.required;
  if (base.type !== target.type) patch.type = target.type;
  if (JSON.stringify(base.columns) !== JSON.stringify(target.columns)) {
    patch.settings = { columns: target.columns };
  }
  if (JSON.stringify(base.validation) !== JSON.stringify(target.validation)) {
    patch.validation = target.validation;
  }
  return Object.keys(patch).length ? patch : null;
}

function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Rebuilds the pending-op queue from a snapshot by diffing it against the
 * loaded baseline, so undo/redo restores both the local state and a saveable
 * op list that brings the server back in sync.
 */
export function buildOpsFromDiff(
  baseline: EditorSnapshot,
  target: EditorSnapshot,
  surveyId: number,
  ids: KeyAndTemp,
): DiffPendingOp[] {
  const ops: DiffPendingOp[] = [];
  const baseById = new Map(baseline.questions.map((question) => [question.id, question]));
  const targetById = new Map(target.questions.map((question) => [question.id, question]));

  if (JSON.stringify(baseline.surveyMeta) !== JSON.stringify(target.surveyMeta)) {
    ops.push({
      key: ids.key(),
      method: "PATCH",
      path: `/api/admin/surveys/${surveyId}`,
      body: { ...target.surveyMeta },
      tempId: null,
      label: "问卷设置",
    });
  }

  for (const question of target.questions) {
    const base = baseById.get(question.id);
    if (!base) {
      const tempId = ids.temp();
      ops.push({
        key: ids.key(),
        method: "POST",
        path: `/api/admin/surveys/${surveyId}/questions`,
        body: questionCreateBody(question),
        tempId,
        label: "新增题目",
      });
      // The create endpoint does not accept validation/condition; replay them
      // as follow-up patches. The paths embed the same temp id the POST will
      // register in the id map, so save() rewrites them to the real id.
      const patchPath = `/api/admin/surveys/${surveyId}/questions/${tempId}`;
      if (question.validation && Object.keys(question.validation).length) {
        ops.push({
          key: ids.key(),
          method: "PATCH",
          path: patchPath,
          body: { validation: question.validation },
          tempId: null,
          label: "题目校验",
        });
      }
      if (question.condition) {
        ops.push({
          key: ids.key(),
          method: "PATCH",
          path: patchPath,
          body: { condition: question.condition },
          tempId: null,
          label: "跳题规则",
        });
      }
      continue;
    }
    const patch = questionPatch(base, question);
    if (patch) {
      ops.push({
        key: ids.key(),
        method: "PATCH",
        path: `/api/admin/surveys/${surveyId}/questions/${question.id}`,
        body: patch,
        tempId: null,
        label: "题目修改",
      });
    }
    const baseOptions = new Map(base.options.map((option) => [option.id, option]));
    for (const option of question.options) {
      const baseOption = baseOptions.get(option.id);
      if (!baseOption) {
        ops.push({
          key: ids.key(),
          method: "POST",
          path: `/api/admin/surveys/${surveyId}/questions/${question.id}/options`,
          body: { label: option.label },
          tempId: ids.temp(),
          label: "新增选项",
        });
      } else if (baseOption.label !== option.label) {
        ops.push({
          key: ids.key(),
          method: "PATCH",
          path: `/api/admin/surveys/${surveyId}/options/${option.id}`,
          body: { label: option.label },
          tempId: null,
          label: "选项文案",
        });
      }
    }
    for (const option of base.options) {
      if (!question.options.some((item) => item.id === option.id)) {
        ops.push({
          key: ids.key(),
          method: "DELETE",
          path: `/api/admin/surveys/${surveyId}/options/${option.id}`,
          body: undefined,
          tempId: null,
          label: "删除选项",
        });
      }
    }
  }

  for (const question of baseline.questions) {
    if (!targetById.has(question.id) && question.id > 0) {
      ops.push({
        key: ids.key(),
        method: "DELETE",
        path: `/api/admin/surveys/${surveyId}/questions/${question.id}`,
        body: undefined,
        tempId: null,
        label: "删除题目",
      });
    }
  }

  const targetOrder = target.questions.map((question) => question.id);
  if (!sameOrder(baseline.questions.map((question) => question.id), targetOrder)) {
    ops.push({
      key: ids.key(),
      method: "POST",
      path: `/api/admin/surveys/${surveyId}/questions/reorder`,
      body: { questionIds: targetOrder },
      tempId: null,
      label: "题目排序",
    });
  }

  return ops;
}
