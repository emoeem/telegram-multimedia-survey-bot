/**
 * 新建题目的默认稿与三套内置模板（S2 从 EditorPage 抽出为纯函数）。
 * 两套壳共用：旧壳的 TypePickerSheet / 模板弹层与新壳的物料区走同一份数据，
 * 保证插入行为一致（都是 editor.addQuestion 的同一条待保存队列，可撤销）。
 */

export interface QuestionDraft {
  type: string;
  title: string;
  options?: { label: string }[];
  columns?: string[];
  settings?: Record<string, unknown>;
}

/** 按题型给出默认标题/选项（与旧壳 addDefaultQuestion 的表一致）。 */
export function defaultQuestionDraft(type: string): QuestionDraft {
  const defaults: Record<string, QuestionDraft> = {
    single: { type, title: "新的单选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
    multiple: { type, title: "新的多选题", options: [{ label: "选项 1" }, { label: "选项 2" }] },
    yes_no: { type, title: "新的是非题", options: [{ label: "是" }, { label: "否" }] },
    rating: { type, title: "新的评分题", options: [{ label: "1 星" }, { label: "5 星" }] },
    matrix: { type, title: "新的矩阵题", options: [{ label: "行 1" }], columns: ["列 1", "列 2"] },
    text: { type, title: "新的文本题" },
    long_text: { type, title: "新的长文本题" },
    number: { type, title: "新的数字题" },
    date: { type, title: "新的日期题" },
    time: { type, title: "新的时间题" },
    image: { type, title: "上传照片（资料卡图片题）" },
    video: { type, title: "上传视频题" },
    audio: { type, title: "上传音频题" },
    file: { type, title: "上传文件题" },
    note: { type, title: "剧情" },
    game: { type, title: "小游戏挑战" },
  };
  return defaults[type] ?? { type, title: "新题目" };
}

export type TemplateId = "survey" | "single-game" | "mixed";

export const TEMPLATE_OPTIONS: Array<{ id: TemplateId; title: string; desc: string }> = [
  { id: "survey", title: "问卷基础", desc: "称呼 + 单选 + 长文本，适合普通问卷" },
  { id: "single-game", title: "单题小游戏", desc: "开场文段 + 一道小游戏题" },
  { id: "mixed", title: "混合互动", desc: "热身单选 + 小游戏 + 感受长文本" },
];

interface TemplateInserter {
  addQuestion: (draft: QuestionDraft) => number;
}

/** 模板：按顺序插入一组组件（含小游戏配置）。整批走同一条待保存队列。 */
export function insertTemplate(editor: TemplateInserter, templateId: TemplateId): void {
  const insert = (draft: QuestionDraft) => {
    editor.addQuestion(draft);
  };
  if (templateId === "survey") {
    insert({ type: "text", title: "你的称呼（可选）" });
    insert({ type: "single", title: "你最喜欢哪种放松方式？", options: [{ label: "散步" }, { label: "听歌" }, { label: "发呆" }] });
    insert({ type: "long_text", title: "还有什么想补充的吗？" });
  } else if (templateId === "single-game") {
    insert({ type: "note", title: "挑战开始前", settings: {} });
    insert({ type: "game", title: "小游戏挑战" });
  } else {
    insert({ type: "single", title: "先热个身：今天心情如何？", options: [{ label: "不错" }, { label: "一般" }, { label: "糟糕" }] });
    insert({ type: "game", title: "来玩一局" });
    insert({ type: "long_text", title: "玩完感觉怎么样？" });
  }
}
