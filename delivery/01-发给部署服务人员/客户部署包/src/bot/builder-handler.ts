import type { QuestionType } from "../db/schema";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import {
  assertCanManageSurvey,
  canCreateSurvey,
} from "../services/permission.service";
import {
  deleteSurvey,
  setSurveyAccessCode,
} from "../db/repositories/survey.repository";
import {
  addOption,
  addMatrixColumn,
  appendBuilderQuestions,
  builderBack,
  finishOptions,
  getBuilderState,
  initBuilder,
  persistBuilderDraft,
  resetBuilder,
  restoreLatestBuilderDraft,
  resumeBuilderAfterAuxiliary,
  setQuestionMedia,
  setQuestionRequired,
  setQuestionTitle,
  setQuestionType,
  setSurveyDescription,
  setSurveyTitle,
  startBuilderDraft,
  startEditQuestionTitle,
  startImport,
  startOptionMedia,
  startQuestionMedia,
  startQuestionOptions,
} from "../services/survey-builder.service";
import {
  parseImportedSurvey,
  saveImportedSurvey,
  type ImportedMedia,
  type ImportedSurvey,
} from "../services/import.service";
import {
  createOptionMedia,
  createQuestionMedia,
} from "../db/repositories/media.repository";
import {
  createQuestionOption,
  getQuestionById,
  getQuestionOptionById,
  listOptionsForQuestions,
  updateQuestionOptionLabel,
  updateQuestionTitle,
} from "../db/repositories/question.repository";
import { registerMediaAsset } from "../services/media.service";
import { encryptSurveyAccessCode, hashSurveyAccessCode } from "../core/security";
import { assertSurveyQuestionsEditable } from "../services/survey.service";
import {
  answerCallbackQuery,
  deleteMessage,
  getTelegramFileText,
  sendLongMessage,
  sendMessage,
  type InlineKeyboardMarkup,
  uploadMediaForReuse,
} from "./telegram";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import type { SurveyBuilderState } from "../durable-objects/survey-builder";
import { showQuestionEditor } from "./question-editor";

interface ImportReviewState {
  rawJson: string;
  imported: ImportedSurvey;
}

function importReviewKey(userId: number): string {
  return `import-review:${userId}`;
}

async function showImportReview(
  ctx: BotContext,
  chatId: number,
  userId: number,
  rawJson: string,
  imported: ImportedSurvey,
): Promise<void> {
  if (!ctx.cache) throw new Error("当前部署未启用导入审核");
  await ctx.cache.put(importReviewKey(userId), JSON.stringify({ rawJson, imported } satisfies ImportReviewState), { expirationTtl: 15 * 60 });
  const preview = imported.questions.slice(0, 8).map((question, index) => `${index + 1}. ${question.title}（${question.type}）`).join("\n");
  await sendMessage(ctx.botToken, chatId, [
    "导入审核",
    "",
    `标题：${imported.title}`,
    `题目：${imported.questions.length} 道`,
    imported.importWarnings?.length ? `自动修复或需注意：${imported.importWarnings.length} 项` : "未发现自动修复项。",
    "",
    preview,
    imported.questions.length > 8
      ? `\n当前仅预览第 1-8 题。保存后会保留全部 ${imported.questions.length} 题（包含以上 8 题），可在题目编辑页查看第 9-${imported.questions.length} 题。`
      : "",
  ].filter(Boolean).join("\n"), {
    inline_keyboard: [
      [{ text: "保存为草稿", callback_data: "import_review:save" }],
      [{ text: "查看警告", callback_data: "import_review:warnings" }, { text: "取消导入", callback_data: "import_review:cancel" }],
    ],
  });
}

const questionTypes: QuestionType[] = [
  "single",
  "multiple",
  "text",
  "long_text",
  "number",
  "rating",
  "matrix",
  "yes_no",
  "date",
  "time",
  "image",
  "video",
  "audio",
  "file",
];

const questionTypeLabels: Record<QuestionType, string> = {
  single: "单选",
  multiple: "多选",
  text: "单行文本",
  long_text: "多行文本",
  number: "数字",
  yes_no: "是 / 否",
  rating: "评分",
  matrix: "矩阵题",
  date: "日期",
  time: "时间",
  image: "上传图片",
  video: "上传视频",
  audio: "上传音频",
  file: "上传文件",
};

function buildQuestionTypeKeyboard(
  appendMode = false,
): InlineKeyboardMarkup {
  const typeRows = [];
  for (let index = 0; index < questionTypes.length; index += 2) {
    const row = questionTypes.slice(index, index + 2).map((type) => ({
      text: questionTypeLabels[type],
      callback_data: `builder:type:${type}`,
    }));
    typeRows.push(row);
  }

  return {
    inline_keyboard: [
      ...typeRows,
      [
        {
          text: appendMode ? "✅ 添加题目" : "✅ 完成问卷",
          callback_data: "builder:finish",
        },
        ...(appendMode
          ? []
          : [{ text: "💾 保存草稿", callback_data: "builder:save" }]),
      ],
    ],
  };
}

function builderNavKeyboard(includeBack: boolean): InlineKeyboardMarkup {
  const rows = [];
  if (includeBack) {
    rows.push([
      {
        text: "⬅️ 上一步",
        callback_data: "builder:back",
      },
    ]);
  }
  rows.push([
    {
      text: "❌ 取消",
      callback_data: "builder:cancel",
    },
  ]);
  return { inline_keyboard: rows };
}

function descriptionKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "跳过说明，继续", callback_data: "builder:description:skip" }],
      [
        { text: "⬅️ 上一步", callback_data: "builder:back" },
        { text: "❌ 取消", callback_data: "builder:cancel" },
      ],
    ],
  };
}

function questionRequiredKeyboard(includeBack = true): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "✅ 必答", callback_data: "builder:required:yes" },
      { text: "可跳过", callback_data: "builder:required:no" },
    ],
  ];
  if (includeBack) {
    rows.push([
      { text: "⬅️ 上一步", callback_data: "builder:back" },
      { text: "❌ 取消", callback_data: "builder:cancel" },
    ]);
  }
  return { inline_keyboard: rows };
}

function questionMediaKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "不添加附件，继续",
          callback_data: "builder:question_media:skip",
        },
      ],
      [
        {
          text: "⬅️ 上一步",
          callback_data: "builder:back",
        },
        {
          text: "❌ 取消",
          callback_data: "builder:cancel",
        },
      ],
    ],
  };
}

function optionEntryKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ 完成选项",
          callback_data: "builder:options:finish",
        },
        {
          text: "💾 保存草稿",
          callback_data: "builder:save",
        },
      ],
      [
        {
          text: "⬅️ 上一步",
          callback_data: "builder:back",
        },
        {
          text: "❌ 取消",
          callback_data: "builder:cancel",
        },
      ],
    ],
  };
}

function messageHasMedia(message: TelegramMessage): boolean {
  return Boolean(
    message.photo ||
      message.video ||
      message.audio ||
      message.voice ||
      message.animation ||
      message.sticker ||
      message.document,
  );
}

function hasDraftContent(state: SurveyBuilderState | null): boolean {
  if (!state) {
    return false;
  }

  return Boolean(
    state.activeDraft ||
      state.draftSurveyId ||
      state.surveyTitle ||
      state.surveyDescription ||
      state.questions.length > 0 ||
      state.currentQuestionType ||
      state.currentQuestionTitle,
  );
}

function normalizeOptionLabels(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function getEditableQuestion(
  ctx: BotContext,
  telegramUserId: number,
  questionId: number,
) {
  const [question, user] = await Promise.all([
    getQuestionById(ctx.db, questionId),
    getUserByTelegramId(ctx.db, telegramUserId),
  ]);
  if (!question || !user) {
    throw new Error("题目不存在或用户不存在");
  }

  await assertCanManageSurvey(
    ctx.db,
    user,
    question.surveyId,
    ctx.adminIds,
  );
  await assertSurveyQuestionsEditable(ctx.db, question.surveyId);
  return question;
}

async function getEditableOption(
  ctx: BotContext,
  telegramUserId: number,
  optionId: number,
) {
  const option = await getQuestionOptionById(ctx.db, optionId);
  if (!option) {
    throw new Error("选项不存在");
  }
  const question = await getEditableQuestion(
    ctx,
    telegramUserId,
    option.questionId,
  );
  return { option, question };
}

async function showBuilderStep(
  ctx: BotContext,
  chatId: number,
  state: SurveyBuilderState,
): Promise<void> {
  if (state.step === "survey_title") {
    await sendMessage(
      ctx.botToken,
      chatId,
      "问卷设置 1/2 · 问卷标题\n\n请输入问卷标题：",
      builderNavKeyboard(false),
    );
  } else if (state.step === "survey_description") {
    await sendMessage(
      ctx.botToken,
      chatId,
      "问卷设置 2/2 · 问卷说明\n\n可输入问卷描述，也可以直接跳过：",
      descriptionKeyboard(),
    );
  } else if (state.step === "question_type") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 1/4 选择题型\n\n已完成 ${state.questions.length} 题，请选择下一道题的题型：`,
      buildQuestionTypeKeyboard(Boolean(state.appendSurveyId)),
    );
  } else if (state.step === "question_title") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 2/4 设置题干\n\n请输入题目内容。也可以直接发送带说明文字的媒体，说明文字将作为题目：`,
      builderNavKeyboard(true),
    );
  } else if (state.step === "question_required") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 3/4 是否必答？\n\n选择“可跳过”后，填写者可不回答这道题。`,
      questionRequiredKeyboard(),
    );
  } else if (state.step === "question_media") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 4/4 题目附件（可选）\n\n${state.currentMediaAssetId ? "已附加媒体；可继续，或发送新的媒体替换它。" : "可发送一张图片、视频、音频或文件作为题目附件；不需要附件就点击继续。"}`,
      questionMediaKeyboard(),
    );
  } else if (state.step === "question_options") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 4/4 填写选项\n\n输入选项，每行一个；也可发送带说明文字的媒体，说明文字会作为该选项。至少需要两个选项。`,
      optionEntryKeyboard(),
    );
  } else if (state.step === "matrix_columns") {
    await sendMessage(
      ctx.botToken,
      chatId,
      `第 ${state.questions.length + 1} 题 · 4/4 设置矩阵列\n\n请输入可选列，每行一个，例如：满意\n一般\n不满意。至少两个列。`,
      optionEntryKeyboard(),
    );
  } else if (state.step === "import") {
    await sendMessage(ctx.botToken, chatId, "请发送 survey.json 文件。");
  } else {
    await sendMessage(
      ctx.botToken,
      chatId,
      "当前创建步骤已结束。发送 /continue 继续草稿，或 /create 新建问卷。",
    );
  }
}

async function completeQuestionSetup(
  ctx: BotContext,
  chatId: number,
  userId: number,
  state: SurveyBuilderState,
): Promise<void> {
  if (
    state.currentQuestionType === "single" ||
    state.currentQuestionType === "multiple" ||
    state.currentQuestionType === "matrix"
  ) {
    await startQuestionOptions(ctx.builder, userId);
    await sendMessage(
      ctx.botToken,
      chatId,
      state.currentQuestionType === "matrix"
        ? "请输入矩阵的行，每行一个，例如：服务态度、响应速度、解决效果。"
        : "请输入选项，每行一个；也可发送带说明文字的图片、音频、视频或文件，直接创建带媒体的选项。",
      optionEntryKeyboard(),
    );
    return;
  }

  if (state.currentQuestionType === "yes_no") {
    await addOption(ctx.builder, userId, "是");
    await addOption(ctx.builder, userId, "否");
  } else if (state.currentQuestionType === "rating") {
    for (let rating = 1; rating <= 10; rating += 1) {
      await addOption(ctx.builder, userId, String(rating));
    }
  }

  const nextState = await finishOptions(ctx.builder, userId);
  await sendMessage(
    ctx.botToken,
    chatId,
    `第 ${nextState.questions.length} 题已保存。请选择下一道题的题型，或${nextState.appendSurveyId ? "添加题目" : "完成问卷"}。`,
    buildQuestionTypeKeyboard(Boolean(nextState.appendSurveyId)),
  );
}

async function saveCurrentDraft(
  ctx: BotContext,
  userId: number,
  state: SurveyBuilderState,
): Promise<number> {
  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user) {
    throw new Error("用户不存在，请先发送 /start");
  }

  if (state.appendSurveyId) {
    await assertCanManageSurvey(ctx.db, user, state.appendSurveyId, ctx.adminIds);
    await assertSurveyQuestionsEditable(ctx.db, state.appendSurveyId);
    await appendBuilderQuestions(ctx.db, state.appendSurveyId, state.questions);
    return state.appendSurveyId;
  }

  return persistBuilderDraft(ctx.db, ctx.builder, state, user.id);
}

async function discardCurrentDraft(
  ctx: BotContext,
  userId: number,
  state: SurveyBuilderState,
): Promise<void> {
  if (state.draftSurveyId) {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (user) {
      await assertCanManageSurvey(ctx.db, user, state.draftSurveyId, ctx.adminIds);
      await deleteSurvey(ctx.db, state.draftSurveyId);
    }
  }
  await resetBuilder(ctx.builder, userId);
}

function cancelDraftKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "💾 保存草稿", callback_data: "builder:save" }],
      [{ text: "🗑 放弃创建", callback_data: "builder:discard_confirm" }],
      [{ text: "继续创建", callback_data: "builder:continue" }],
    ],
  };
}

export async function startBuilder(
  ctx: BotContext,
  chatId: number,
  userId: number,
): Promise<void> {
  const state = await initBuilder(ctx.builder, userId);
  if (hasDraftContent(state) && state.step !== "idle") {
    await sendMessage(
      ctx.botToken,
      chatId,
      "你已有未完成的问卷草稿。请选择继续或放弃后再新建：",
      cancelDraftKeyboard(),
    );
    return;
  }

  await startBuilderDraft(ctx.builder, userId);
  await sendMessage(
    ctx.botToken,
    chatId,
    "问卷设置 1/2 · 问卷标题\n\n请输入问卷标题：",
    builderNavKeyboard(false),
  );
}

export async function handleBuilderMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const inputText = text ?? message.caption?.trim();
  const userId = message.from?.id;

  if (!userId) {
    return false;
  }

  if (
    text === "/create" ||
    text === "/continue" ||
    text === "/import"
  ) {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "你没有创建或导入问卷的权限。",
      );
      return true;
    }
  }

  if (text === "/create") {
    await startBuilder(ctx, message.chat.id, userId);
    return true;
  }

  if (text === "/continue") {
    await initBuilder(ctx.builder, userId);
    let state = await getBuilderState(ctx.builder, userId);
    if (!hasDraftContent(state) || state?.step === "idle") {
      const user = await getUserByTelegramId(ctx.db, userId);
      state = user
        ? await restoreLatestBuilderDraft(
            ctx.db,
            ctx.builder,
            userId,
            user.id,
          )
        : null;
    }

    if (!state) {
      await sendMessage(ctx.botToken, message.chat.id, "没有可继续的草稿。");
      return true;
    }

    await showBuilderStep(ctx, message.chat.id, state);
    return true;
  }

  if (text === "/import") {
    const state = await initBuilder(ctx.builder, userId);
    if (hasDraftContent(state) && state.step !== "idle") {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "当前还有未完成草稿，请先 /save 保存或 /discard 放弃。",
      );
      return true;
    }
    await startImport(ctx.builder, userId);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "请直接发送 survey.json 文件。\n\n不是发送文件路径，而是像发送普通文件一样上传。",
    );
    return true;
  }

  if (text?.startsWith("/option_media ")) {
    const optionId = Number(text.slice("/option_media ".length));
    if (!Number.isInteger(optionId) || optionId <= 0) {
      await sendMessage(ctx.botToken, message.chat.id, "选项 ID 无效。");
      return true;
    }
    const optionRow = await ctx.db
      .prepare(
        `SELECT q.survey_id
         FROM question_options o
         JOIN survey_questions q ON q.id = o.question_id
         WHERE o.id = ? LIMIT 1`,
      )
      .bind(optionId)
      .first<{ survey_id: number }>();
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!optionRow || !user) {
      await sendMessage(ctx.botToken, message.chat.id, "选项不存在或用户不存在。");
      return true;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, optionRow.survey_id, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权管理该选项。",
      );
      return true;
    }

    await initBuilder(ctx.builder, userId);
    await startOptionMedia(ctx.builder, userId, optionId);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `请发送要绑定到选项 #${optionId} 的媒体文件。`,
    );
    return true;
  }

  if (text?.startsWith("/question_media ")) {
    const questionId = Number(text.slice("/question_media ".length));
    const question = await getQuestionById(ctx.db, questionId);
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!question || !user) {
      await sendMessage(ctx.botToken, message.chat.id, "题目不存在或用户不存在。");
      return true;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, question.surveyId, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权管理该题目。",
      );
      return true;
    }

    await initBuilder(ctx.builder, userId);
    await startQuestionMedia(ctx.builder, userId, questionId);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `请发送要绑定到题目 #${questionId} 的媒体文件。`,
    );
    return true;
  }

  if (text?.startsWith("/edit_question_title ")) {
    const questionId = Number(text.slice("/edit_question_title ".length));
    const question = await getQuestionById(ctx.db, questionId);
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!question || !user) {
      await sendMessage(ctx.botToken, message.chat.id, "题目不存在或用户不存在。");
      return true;
    }
    try {
      await assertCanManageSurvey(ctx.db, user, question.surveyId, ctx.adminIds);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "无权编辑该题目。",
      );
      return true;
    }

    await initBuilder(ctx.builder, userId);
    await startEditQuestionTitle(ctx.builder, userId, questionId);
    await sendMessage(ctx.botToken, message.chat.id, "请输入新的题目内容：");
    return true;
  }

  const state = await getBuilderState(ctx.builder, userId);
  if (!state || state.step === "idle") {
    return false;
  }

  if (text === "/cancel") {
    if (state.suspendedStep !== null) {
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await sendMessage(ctx.botToken, message.chat.id, "已取消当前操作。");
      return true;
    }

    if (hasDraftContent(state)) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `当前草稿已有 ${state.questions.length} 道完整题目。请选择下一步：`,
        cancelDraftKeyboard(),
      );
      return true;
    }

    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "已取消创建。");
    return true;
  }

  if (text === "/discard") {
    await discardCurrentDraft(ctx, userId, state);
    await sendMessage(ctx.botToken, message.chat.id, "已放弃当前草稿。");
    return true;
  }

  if (text === "/save") {
    if (state.questions.length === 0) {
      await sendMessage(ctx.botToken, message.chat.id, "还没有可保存的完整题目。");
      return true;
    }

    try {
      const surveyId = await saveCurrentDraft(ctx, userId, state);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `✅ 草稿已保存，内部编号：${surveyId}\n可继续添加题目，稍后也能用 /continue 恢复。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "保存失败。",
      );
    }
    return true;
  }

  if (text === "/back") {
    const previousState = await builderBack(ctx.builder, userId);
    await showBuilderStep(ctx, message.chat.id, previousState);
    return true;
  }

  if (state.step === "import") {
    const importingUser = await getUserByTelegramId(ctx.db, userId);
    if (!importingUser || !(await canCreateSurvey(ctx.db, importingUser, ctx.adminIds))) {
      await resetBuilder(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "你没有导入问卷的权限，导入操作已取消。",
      );
      return true;
    }

    if (message.document) {
      await sendMessage(ctx.botToken, message.chat.id, "正在解析文件，请稍候...");
    }

    try {
      const jsonText = message.document
        ? await getTelegramFileText(ctx.botToken, message.document.file_id)
        : inputText ?? "";
      const imported = parseImportedSurvey(jsonText);
      if (message.document) {
        await showImportReview(ctx, message.chat.id, userId, jsonText, imported);
        return true;
      }
      const temporaryMediaMessageIds: number[] = [];
      let surveyId: number;
      try {
        surveyId = await saveImportedSurvey(
          ctx.db,
          importingUser.id,
          imported,
          async (media) => {
            if (media.type === "sticker") {
              throw new Error("暂不支持从 JSON 内嵌导入贴纸");
            }
            const uploadInput = {
              type: media.type,
              ...(media.url ? { url: media.url } : {}),
              ...(media.telegramFileId
                ? { telegramFileId: media.telegramFileId }
                : {}),
              ...(media.telegramFileUniqueId
                ? {
                    telegramFileUniqueId:
                      media.telegramFileUniqueId,
                  }
                : {}),
              ...(media.mimeType ? { mimeType: media.mimeType } : {}),
              ...(media.fileName ? { fileName: media.fileName } : {}),
              ...(media.width !== undefined ? { width: media.width } : {}),
              ...(media.height !== undefined ? { height: media.height } : {}),
              ...(media.duration !== undefined
                ? { duration: media.duration }
                : {}),
              ...(media.size !== undefined ? { size: media.size } : {}),
            };
            const uploaded = await uploadMediaForReuse(
              ctx.botToken,
              message.chat.id,
              uploadInput,
            );
            if (uploaded.messageId !== null) {
              temporaryMediaMessageIds.push(uploaded.messageId);
            }
            const resolvedMedia: ImportedMedia = {
              ...media,
              source: "telegram",
              telegramFileId: uploaded.file.file_id,
              telegramFileUniqueId: uploaded.file.file_unique_id,
            };
            const mimeType = uploaded.file.mime_type ?? media.mimeType;
            const fileName = uploaded.file.file_name ?? media.fileName;
            const size = uploaded.file.file_size ?? media.size;
            const width = uploaded.file.width ?? media.width;
            const height = uploaded.file.height ?? media.height;
            const duration = uploaded.file.duration ?? media.duration;
            if (mimeType) resolvedMedia.mimeType = mimeType;
            if (fileName) resolvedMedia.fileName = fileName;
            if (size !== undefined) resolvedMedia.size = size;
            if (width !== undefined) resolvedMedia.width = width;
            if (height !== undefined) resolvedMedia.height = height;
            if (duration !== undefined) resolvedMedia.duration = duration;
            return resolvedMedia;
          },
        );
      } finally {
        for (const messageId of temporaryMediaMessageIds) {
          try {
            await deleteMessage(ctx.botToken, message.chat.id, messageId);
          } catch (error) {
            console.warn("Failed to clean up imported media message", error);
          }
        }
      }
      await resetBuilder(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        [
          "📥 导入完成",
          "",
          `题目：${imported.questions.length}`,
          `内部编号：${surveyId}`,
          ...(imported.importWarnings?.length
            ? [
                "",
                `自动修复：${imported.importWarnings.length} 项`,
                ...imported.importWarnings,
              ]
            : []),
          "",
          "发送 /my_surveys 查看并发布。",
        ].join("\n"),
        {
          inline_keyboard: [
            [{ text: "逐题检查与编辑", callback_data: `owner:questions:${surveyId}` }],
            [{ text: "查看发布前检查", callback_data: `owner:publish_ask:${surveyId}` }],
          ],
        },
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `导入失败：${error instanceof Error ? error.message : "JSON 格式错误"}`,
      );
    }
    return true;
  }

  if (state.step === "add_question_option") {
    if (!state.targetQuestionId || !inputText) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请输入选项名称。也可以发送带说明文字的媒体，直接创建带附件的选项。",
      );
      return true;
    }

    try {
      const question = await getEditableQuestion(
        ctx,
        userId,
        state.targetQuestionId,
      );
      if (
        question.type !== "single" &&
        question.type !== "multiple"
      ) {
        throw new Error("只有单选题和多选题可以新增选项");
      }

      const hasMedia = messageHasMedia(message);
      const labels = hasMedia
        ? [inputText]
        : normalizeOptionLabels(inputText);
      if (labels.length === 0) {
        throw new Error("请输入有效的选项名称");
      }

      const options = await listOptionsForQuestions(ctx.db, [question.id]);
      let mediaAssetId: number | null = null;
      if (hasMedia) {
        mediaAssetId = await registerMediaAsset(ctx, message);
        if (!mediaAssetId) {
          throw new Error("无法识别该媒体，请重新上传");
        }
      }

      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index];
        if (!label) continue;
        const optionId = await createQuestionOption(ctx.db, {
          questionId: question.id,
          label,
          value: label,
          order: options.length + index,
        });
        if (index === 0 && mediaAssetId) {
          await createOptionMedia(ctx.db, {
            questionOptionId: optionId,
            mediaAssetId,
          });
        }
      }

      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await showQuestionEditor(
        ctx,
        message.chat.id,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "新增选项失败。",
      );
    }
    return true;
  }

  if (state.step === "option_media") {
    if (!state.targetOptionId) {
      await sendMessage(ctx.botToken, message.chat.id, "目标选项 ID 不存在。");
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      return true;
    }

    try {
      const { question } = await getEditableOption(
        ctx,
        userId,
        state.targetOptionId,
      );
      const mediaAssetId = await registerMediaAsset(ctx, message);
      if (!mediaAssetId) {
        throw new Error("无法识别媒体，请重新发送");
      }

      await createOptionMedia(ctx.db, {
        questionOptionId: state.targetOptionId,
        mediaAssetId,
      });
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await showQuestionEditor(
        ctx,
        message.chat.id,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "绑定选项附件失败。",
      );
    }
    return true;
  }

  if (state.step === "question_media_existing") {
    if (!state.targetQuestionId) {
      await sendMessage(ctx.botToken, message.chat.id, "目标题目 ID 不存在。");
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      return true;
    }

    try {
      const question = await getEditableQuestion(
        ctx,
        userId,
        state.targetQuestionId,
      );
      const mediaAssetId = await registerMediaAsset(ctx, message);
      if (!mediaAssetId) {
        throw new Error("无法识别媒体，请重新发送");
      }

      await createQuestionMedia(ctx.db, {
        questionId: question.id,
        mediaAssetId,
      });
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await showQuestionEditor(
        ctx,
        message.chat.id,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "绑定题目附件失败。",
      );
    }
    return true;
  }

  if (state.step === "edit_question_title") {
    if (!state.targetQuestionId || !inputText) {
      await sendMessage(ctx.botToken, message.chat.id, "请输入有效的题目内容。");
      return true;
    }

    try {
      const question = await getEditableQuestion(
        ctx,
        userId,
        state.targetQuestionId,
      );
      await updateQuestionTitle(ctx.db, question.id, inputText);
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await showQuestionEditor(
        ctx,
        message.chat.id,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "更新题目失败。",
      );
    }
    return true;
  }

  if (state.step === "edit_option_label") {
    if (!state.targetOptionId || !inputText) {
      await sendMessage(ctx.botToken, message.chat.id, "请输入有效的选项名称。");
      return true;
    }

    try {
      const { question } = await getEditableOption(
        ctx,
        userId,
        state.targetOptionId,
      );
      await updateQuestionOptionLabel(
        ctx.db,
        state.targetOptionId,
        inputText,
      );
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await showQuestionEditor(
        ctx,
        message.chat.id,
        userId,
        question.id,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "更新选项失败。",
      );
    }
    return true;
  }

  if (state.step === "set_survey_access_code") {
    if (!state.targetSurveyId || !inputText) {
      await sendMessage(ctx.botToken, message.chat.id, "请输入至少 4 个字符的密码，或发送 /clear。");
      return true;
    }

    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户不存在。");
      return true;
    }

    try {
      await assertCanManageSurvey(
        ctx.db,
        user,
        state.targetSurveyId,
        ctx.adminIds,
      );
      if (text === "/clear") {
        await setSurveyAccessCode(ctx.db, state.targetSurveyId, null);
      } else {
        if (inputText.length < 4 || inputText.length > 64) {
          throw new Error("密码长度必须为 4 到 64 个字符");
        }
        await setSurveyAccessCode(
          ctx.db,
          state.targetSurveyId,
          await hashSurveyAccessCode(inputText),
          await encryptSurveyAccessCode(inputText, ctx.botToken),
        );
      }
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        text === "/clear"
          ? "访问密码已移除。"
          : `访问密码已保存。请复制并妥善保存：\n\n${inputText}\n\n以后可在“问卷访问密码”中查看或更换。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "设置密码失败。",
      );
    }
    return true;
  }

  if (state.step === "survey_access_code") {
    return false;
  }

  if (!inputText && !messageHasMedia(message)) {
    return false;
  }

  if (state.step === "survey_title" && inputText) {
    await setSurveyTitle(ctx.builder, userId, inputText);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "问卷设置 2/2 · 问卷说明\n\n可输入问卷描述，也可以直接跳过：",
      descriptionKeyboard(),
    );
    return true;
  }

  if (state.step === "survey_description" && inputText) {
    await setSurveyDescription(ctx.builder, userId, inputText);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `创建进度 3/4 · 已完成 ${state.questions.length} 题\n\n请选择下一题题型：`,
      buildQuestionTypeKeyboard(Boolean(state.appendSurveyId)),
    );
    return true;
  }

  if (state.step === "question_title") {
    if (!inputText) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "媒体需要附带说明文字，该说明文字会作为题目内容。",
      );
      return true;
    }

    let nextState = await setQuestionTitle(ctx.builder, userId, inputText);
    if (messageHasMedia(message)) {
      const mediaAssetId = await registerMediaAsset(ctx, message);
      if (mediaAssetId) {
        nextState = await setQuestionMedia(ctx.builder, userId, mediaAssetId);
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          `第 ${nextState.questions.length + 1} 题 · 3/4 是否必答？\n\n已添加题目附件。请选择填写者是否必须回答这道题。`,
          questionRequiredKeyboard(),
        );
        return true;
      }
    }

    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "第 3/4 步：请选择这道题是否必答。",
      questionRequiredKeyboard(),
    );
    return true;
  }

  if (state.step === "question_media") {
    if (!messageHasMedia(message)) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请发送媒体附件，或点击“不添加附件，继续”。",
        questionMediaKeyboard(),
      );
      return true;
    }

    const mediaAssetId = await registerMediaAsset(ctx, message);
    if (!mediaAssetId) {
      await sendMessage(ctx.botToken, message.chat.id, "无法识别该媒体，请重新上传。");
      return true;
    }

    const nextState = await setQuestionMedia(ctx.builder, userId, mediaAssetId);
    await completeQuestionSetup(ctx, message.chat.id, userId, nextState);
    return true;
  }

  if (state.step === "question_options" || state.step === "matrix_columns") {
    if (text === "/done") {
      try {
        const nextState = await finishOptions(ctx.builder, userId);
        if (nextState.step === "matrix_columns") await showBuilderStep(ctx, message.chat.id, nextState);
        else await sendMessage(ctx.botToken, message.chat.id, `第 ${nextState.questions.length} 题已保存。请选择下一道题的题型，或${nextState.appendSurveyId ? "添加题目" : "完成问卷"}。`, buildQuestionTypeKeyboard(Boolean(nextState.appendSurveyId)));
      } catch (error) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          error instanceof Error ? error.message : "选项尚未填写完整。",
          optionEntryKeyboard(),
        );
      }
      return true;
    }

    if (state.step === "matrix_columns") {
      const labels = inputText ? normalizeOptionLabels(inputText) : [];
      if (labels.length === 0) {
        await sendMessage(ctx.botToken, message.chat.id, "请输入有效的矩阵列名称。");
        return true;
      }
      let nextState = state;
      for (const label of labels) nextState = await addMatrixColumn(ctx.builder, userId, label);
      await sendMessage(ctx.botToken, message.chat.id, `已添加 ${labels.length} 个列，当前共 ${nextState.currentMatrixColumns?.length ?? 0} 个。\n至少两个列后点击“完成选项”。`, optionEntryKeyboard());
      return true;
    }

    if (messageHasMedia(message)) {
      if (!message.caption?.trim()) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          "请给媒体添加说明文字，说明文字会作为选项名称。",
        );
        return true;
      }
      const mediaAssetId = await registerMediaAsset(ctx, message);
      if (!mediaAssetId) {
        await sendMessage(ctx.botToken, message.chat.id, "无法识别该媒体，请重新上传。");
        return true;
      }
      const nextState = await addOption(
        ctx.builder,
        userId,
        message.caption.trim(),
        mediaAssetId,
      );
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `已添加带媒体选项：${message.caption.trim()}\n当前共 ${nextState.currentOptions.length} 个选项。`,
        optionEntryKeyboard(),
      );
      return true;
    }

    const labels = inputText ? normalizeOptionLabels(inputText) : [];
    if (labels.length === 0) {
      await sendMessage(ctx.botToken, message.chat.id, "请输入有效选项。");
      return true;
    }

    let nextState = state;
    for (const label of labels) {
      nextState = await addOption(ctx.builder, userId, label);
    }
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `已添加 ${labels.length} 个选项，当前共 ${nextState.currentOptions.length} 个。`,
      optionEntryKeyboard(),
    );
    return true;
  }

  return false;
}

export async function handleBuilderCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
): Promise<boolean> {
  const data = callback.data;
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;

  if (!data || !chatId || (!data.startsWith("builder:") && !data.startsWith("import_review:"))) {
    return false;
  }

  if (data.startsWith("import_review:")) {
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !(await canCreateSurvey(ctx.db, user, ctx.adminIds))) {
      await answerCallbackQuery(ctx.botToken, callback.id, "你没有导入问卷的权限");
      return true;
    }
    const raw = await ctx.cache?.get(importReviewKey(userId));
    const review = raw ? JSON.parse(raw) as ImportReviewState : null;
    if (!review) {
      await answerCallbackQuery(ctx.botToken, callback.id, "导入审核已过期，请重新上传文件");
      return true;
    }
    if (data === "import_review:cancel") {
      await ctx.cache?.delete(importReviewKey(userId));
      await resetBuilder(ctx.builder, userId);
      await sendMessage(ctx.botToken, chatId, "已取消导入，未创建任何问卷。");
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "import_review:warnings") {
      await sendLongMessage(ctx.botToken, chatId, review.imported.importWarnings?.length ? `导入提示：\n${review.imported.importWarnings.map((warning) => `- ${warning}`).join("\n")}` : "未发现导入提示。", {
        inline_keyboard: [[{ text: "返回审核", callback_data: "import_review:back" }]],
      });
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "import_review:back") {
      await showImportReview(ctx, chatId, userId, review.rawJson, review.imported);
      await answerCallbackQuery(ctx.botToken, callback.id);
      return true;
    }
    if (data === "import_review:save") {
      await ctx.cache?.delete(importReviewKey(userId));
      await answerCallbackQuery(ctx.botToken, callback.id, "正在保存草稿");
      await handleBuilderMessage(ctx, { message_id: callback.message?.message_id ?? 0, chat: { id: chatId }, from: callback.from, text: review.rawJson });
      return true;
    }
  }

  const state = await getBuilderState(ctx.builder, userId);

  if (data === "builder:cancel") {
    if (state?.suspendedStep !== null && state?.suspendedStep !== undefined) {
      await resumeBuilderAfterAuxiliary(ctx.builder, userId);
      await sendMessage(ctx.botToken, chatId, "已取消当前操作。");
    } else if (hasDraftContent(state)) {
      await sendMessage(
        ctx.botToken,
        chatId,
        `当前草稿已有 ${state?.questions.length ?? 0} 道完整题目。请选择下一步：`,
        cancelDraftKeyboard(),
      );
    } else {
      await resetBuilder(ctx.builder, userId);
      await sendMessage(ctx.botToken, chatId, "已取消创建。");
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:discard_confirm") {
    if (!state) {
      await answerCallbackQuery(ctx.botToken, callback.id, "创建状态已结束");
      return true;
    }
    await discardCurrentDraft(ctx, userId, state);
    await sendMessage(ctx.botToken, chatId, "已放弃当前草稿。");
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:continue") {
    if (!state || state.step === "idle") {
      await answerCallbackQuery(ctx.botToken, callback.id, "创建状态已结束");
      return true;
    }
    await showBuilderStep(ctx, chatId, state);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (!state || state.step === "idle") {
    await answerCallbackQuery(ctx.botToken, callback.id, "创建状态已结束");
    return true;
  }

  if (data === "builder:back") {
    const previousState = await builderBack(ctx.builder, userId);
    await showBuilderStep(ctx, chatId, previousState);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:description:skip") {
    if (state.step !== "survey_description") {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前步骤已变化");
      return true;
    }
    const nextState = await setSurveyDescription(ctx.builder, userId, "");
    await showBuilderStep(ctx, chatId, nextState);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("builder:type:")) {
    if (state.step !== "question_type") {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前步骤已变化");
      return true;
    }
    const type = data.slice("builder:type:".length) as QuestionType;
    if (!questionTypes.includes(type)) {
      await answerCallbackQuery(ctx.botToken, callback.id, "不支持的题型");
      return true;
    }
    const nextState = await setQuestionType(ctx.builder, userId, type);
    await showBuilderStep(ctx, chatId, nextState);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("builder:required:")) {
    if (state.step !== "question_required") {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前步骤已变化");
      return true;
    }
    const selected = data.slice("builder:required:".length);
    if (selected !== "yes" && selected !== "no") {
      await answerCallbackQuery(ctx.botToken, callback.id, "选项无效");
      return true;
    }
    const nextState = await setQuestionRequired(ctx.builder, userId, selected === "yes");
    await showBuilderStep(ctx, chatId, nextState);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:question_media:skip") {
    if (state.step !== "question_media") {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前步骤已变化");
      return true;
    }
    await completeQuestionSetup(ctx, chatId, userId, state);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:options:finish") {
    if (state.step !== "question_options" && state.step !== "matrix_columns") {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前步骤已变化");
      return true;
    }
    try {
      const nextState = await finishOptions(ctx.builder, userId);
      if (nextState.step === "matrix_columns") {
        await showBuilderStep(ctx, chatId, nextState);
      } else {
      await sendMessage(
        ctx.botToken,
        chatId,
        `第 ${nextState.questions.length} 题已保存。请选择下一道题的题型，或${nextState.appendSurveyId ? "添加题目" : "完成问卷"}。`,
        buildQuestionTypeKeyboard(Boolean(nextState.appendSurveyId)),
      );
      }
      await answerCallbackQuery(ctx.botToken, callback.id);
    } catch (error) {
      await answerCallbackQuery(
        ctx.botToken,
        callback.id,
        error instanceof Error ? error.message : "选项尚未填写完整",
      );
    }
    return true;
  }

  if (data === "builder:finish") {
    if (state.step !== "question_type" && state.step !== "ready") {
      await answerCallbackQuery(ctx.botToken, callback.id, "请先完成当前题目");
      return true;
    }
    if (state.questions.length === 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "至少需要一道题");
      return true;
    }

    try {
      const surveyId = await saveCurrentDraft(ctx, userId, state);
      await resetBuilder(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        chatId,
        state.appendSurveyId
          ? `已向问卷 #${surveyId} 添加 ${state.questions.length} 道题。`
          : `问卷创建完成，已保存为草稿。\n内部编号：${surveyId}\n发送 /my_surveys 可设置密码、编辑或发布。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        `保存失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:save") {
    if (state.questions.length === 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "还没有可保存的完整题目");
      return true;
    }

    try {
      const surveyId = await saveCurrentDraft(ctx, userId, state);
      await sendMessage(
        ctx.botToken,
        chatId,
        `草稿已保存，内部编号：${surveyId}\n创建状态已保留，可继续添加题目。`,
      );
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        chatId,
        error instanceof Error ? error.message : "保存草稿失败",
      );
    }
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  await answerCallbackQuery(ctx.botToken, callback.id, "未知创建操作");
  return true;
}
