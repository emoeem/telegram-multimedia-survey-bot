import type { QuestionType } from "../db/schema";
import {
  addOption,
  finishOptions,
  finishQuestions,
  getBuilderState,
  initBuilder,
  resetBuilder,
  saveDraftSurvey,
  setQuestionTitle,
  setQuestionType,
  setSurveyDescription,
  setSurveyTitle,
  setQuestionMedia,
} from "../services/survey-builder.service";
import { registerMediaAsset } from "../services/media.service";
import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";

const questionTypes: QuestionType[] = [
  "single",
  "multiple",
  "text",
  "long_text",
  "number",
  "yes_no",
  "rating",
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
  date: "日期",
  time: "时间",
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
};

function buildQuestionTypeKeyboard(): InlineKeyboardMarkup {
  const rows = questionTypes.map((type) => [
    {
      text: questionTypeLabels[type],
      callback_data: `builder:type:${type}`,
    },
  ]);

  return {
    inline_keyboard: [
      ...rows,
      [
        {
          text: "✅ 完成问卷",
          callback_data: "builder:finish",
        },
      ],
    ],
  };
}

export async function startBuilder(
  ctx: BotContext,
  chatId: number,
  userId: number,
): Promise<void> {
  await initBuilder(ctx.builder, userId);
  await resetBuilder(ctx.builder, userId);
  await sendMessage(ctx.botToken, chatId, "创建问卷\n\n请输入问卷标题：");
}

export async function handleBuilderMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (!text || !userId) {
    return false;
  }

  if (text === "/cancel") {
    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "已取消创建，回到主菜单。");
    return true;
  }

  if (text === "/create") {
    await startBuilder(ctx, message.chat.id, userId);
    return true;
  }

  const state = await getBuilderState(ctx.builder, userId);
  if (!state || state.step === "idle") {
    return false;
  }

  if (state.step === "survey_title") {
    await setSurveyTitle(ctx.builder, userId, text);
    await sendMessage(ctx.botToken, message.chat.id, "请输入问卷描述：");
    return true;
  }

  if (state.step === "survey_description") {
    await setSurveyDescription(ctx.builder, userId, text);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "请选择题型：",
      buildQuestionTypeKeyboard(),
    );
    return true;
  }

  if (state.step === "question_title") {
    await setQuestionTitle(ctx.builder, userId, text);
    if (
      state.currentQuestionType === "single" ||
      state.currentQuestionType === "multiple"
    ) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请输入选项，每行一个。输入 /done 完成选项。",
      );
    } else if (
      state.currentQuestionType === "image" ||
      state.currentQuestionType === "video" ||
      state.currentQuestionType === "audio" ||
      state.currentQuestionType === "file"
    ) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "请上传该题的媒体文件。",
      );
    } else {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "该题型无需选项。输入 /done 继续。",
      );
    }
    return true;
  }

  if (state.step === "question_options") {
    const hasMedia = Boolean(
      message.photo ||
        message.video ||
        message.audio ||
        message.voice ||
        message.animation ||
        message.sticker ||
        message.document,
    );

    if (
      hasMedia &&
      (state.currentQuestionType === "image" ||
        state.currentQuestionType === "video" ||
        state.currentQuestionType === "audio" ||
        state.currentQuestionType === "file")
    ) {
      const mediaAssetId = await registerMediaAsset(ctx, message);
      if (!mediaAssetId) {
        await sendMessage(
          ctx.botToken,
          message.chat.id,
          "无法识别该媒体，请重新上传。",
        );
        return true;
      }

      await setQuestionMedia(ctx.builder, userId, mediaAssetId);
      await finishOptions(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "题目媒体已保存。继续添加下一题，或点击“完成问卷”。",
        buildQuestionTypeKeyboard(),
      );
      return true;
    }

    if (text === "/done") {
      await finishOptions(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        "题目已保存。继续添加下一题，或点击“完成问卷”。",
        buildQuestionTypeKeyboard(),
      );
      return true;
    }

    await addOption(ctx.builder, userId, text);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `已添加选项：${text}\n继续输入选项，或输入 /done。`,
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

  if (!data || !chatId) {
    return false;
  }

  if (data.startsWith("builder:type:")) {
    const type = data.slice("builder:type:".length) as QuestionType;
    await setQuestionType(ctx.builder, userId, type);
    await sendMessage(ctx.botToken, chatId, "请输入题目内容：");
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "builder:finish") {
    const state = await getBuilderState(ctx.builder, userId);
    if (!state) {
      await answerCallbackQuery(ctx.botToken, callback.id, "创建状态不存在");
      return true;
    }

    const finalState = await finishQuestions(ctx.builder, userId);
    try {
      const surveyId = await saveDraftSurvey(ctx.db, finalState);
      await resetBuilder(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        chatId,
        `草稿已保存，问卷 ID：${surveyId}`,
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

  return false;
}
