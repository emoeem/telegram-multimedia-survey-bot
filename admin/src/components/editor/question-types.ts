import { QUESTION_TYPE_LABELS } from "../../format";

// 题型集合从 QuestionCard 拆出（S1）：QuestionForm（表单体）与 QuestionCard
// （卡片头部）都要用，新壳的物料区也按这份清单生成物料。
export const EDITABLE_TYPES = new Set([
  "single",
  "multiple",
  "yes_no",
  "rating",
  "matrix",
  "text",
  "long_text",
  "number",
  "date",
  "time",
  "image",
  "video",
  "audio",
  "file",
  "note",
  // 小游戏题：settings.game.packId 已建模为 gamePackId 字段（快照可回滚），
  // 提交模式与矩阵列/说话人一致（整包替换 settings）。scene 不在此列是另一
  // 回事——它的 settings_json 由场景编辑器维护、未建模进快照。
  "game",
]);

export const CHOICE_TYPES = new Set(["single", "multiple", "yes_no", "rating"]);
// 跳转只在"选一个"的题型上生效：引擎按选中项匹配规则，
// 多选/矩阵没有单一选中项，配了也不会触发。
export const JUMPABLE_TYPES = new Set(["single", "yes_no", "rating"]);
export const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);

export function isEditableType(type: string): boolean {
  return EDITABLE_TYPES.has(type);
}

export function editableTypeList(): { type: string; label: string }[] {
  return [...EDITABLE_TYPES].map((type) => ({ type, label: QUESTION_TYPE_LABELS[type] ?? type }));
}
