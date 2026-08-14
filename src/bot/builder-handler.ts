import type { QuestionType } from "../db/schema";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import { assertCanManageSurvey } from "../services/permission.service";
import { getQuestionById } from "../db/repositories/question.repository";
import {
  addOption,
  finishOptions,
  finishQuestions,
  getBuilderState,
  initBuilder,
  resetBuilder,
  startImport,
  startOptionMedia,
  startEditQuestionTitle,
  builderBack,
  saveDraftSurvey,
  setQuestionTitle,
  setQuestionType,
  setSurveyDescription,
  setSurveyTitle,
  setQuestionMedia,
} from "../services/survey-builder.service";
import { parseImportedSurvey, saveImportedSurvey } from "../services/import.service";
import { createOptionMedia } from "../db/repositories/media.repository";
import { updateQuestionTitle } from "../db/repositories/question.repository";
import { registerMediaAsset } from "../services/media.service";
import { answerCallbackQuery, getTelegramFileText, sendMessage, type InlineKeyboardMarkup } from "./telegram";
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
        {
          text: "💾 保存草稿",
          callback_data: "builder:save",
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

  if (!userId) {
    return false;
  }

  if (text === "/cancel") {
    const state = await getBuilderState(ctx.builder, userId);
    if (state && state.questions.length > 0) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `⚠️ 当前草稿已有 ${state.questions.length} 道题。\n\n/save 保存草稿\n/discard 放弃\n/back 返回`,
      );
      return true;
    }

    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "已取消创建，回到主菜单。");
    return true;
  }

  if (text === "/save") {
    const state = await getBuilderState(ctx.builder, userId);
    if (!state || state.questions.length === 0) {
      await sendMessage(ctx.botToken, message.chat.id, "还没有可保存的题目。");
      return true;
    }

    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user) {
      await sendMessage(ctx.botToken, message.chat.id, "用户不存在，请先发送 /start。");
      return true;
    }

    try {
      const surveyId = await saveDraftSurvey(ctx.db, state, user.id);
      await resetBuilder(ctx.builder, userId);
      await sendMessage(ctx.botToken, message.chat.id, `✅ 草稿已保存，问卷 ID：${surveyId}`);
    } catch (error) {
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        error instanceof Error ? error.message : "保存失败。",
      );
    }
    return true;
  }

  if (text === "/discard") {
    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "已放弃当前草稿。");
    return true;
  }

  if (text === "/back") {
    const state = await builderBack(ctx.builder, userId);
    if (state.step === "survey_title") {
      await sendMessage(ctx.botToken, message.chat.id, "请输入问卷标题：");
    } else if (state.step === "survey_description") {
      await sendMessage(ctx.botToken, message.chat.id, "请输入问卷描述：");
    } else if (state.step === "question_type") {
      await sendMessage(ctx.botToken, message.chat.id, "请选择题型：", buildQuestionTypeKeyboard());
    } else if (state.step === "question_title") {
      await sendMessage(ctx.botToken, message.chat.id, "请输入题目内容：");
    } else if (state.step === "question_options") {
      await sendMessage(ctx.botToken, message.chat.id, "请输入选项，或输入 /done。");
    }
    return true;
  }

  if (text === "/create") {
    await startBuilder(ctx, message.chat.id, userId);
    return true;
  }

  if (text === "/continue") {
    const state = await getBuilderState(ctx.builder, userId);
    if (!state || (state.questions.length === 0 && state.step === "survey_title")) {
      await sendMessage(ctx.botToken, message.chat.id, "没有可继续的草稿。");
      return true;
    }

    if (state.step === "survey_title") {
      await sendMessage(ctx.botToken, message.chat.id, "继续创建：请输入问卷标题。");
    } else if (state.step === "survey_description") {
      await sendMessage(ctx.botToken, message.chat.id, "继续创建：请输入问卷描述。");
    } else if (state.step === "question_type") {
      await sendMessage(ctx.botToken, message.chat.id, "继续添加题目，请选择题型：", buildQuestionTypeKeyboard());
    } else if (state.step === "question_title") {
      await sendMessage(ctx.botToken, message.chat.id, "请输入题目内容。");
    } else if (state.step === "question_options") {
      await sendMessage(ctx.botToken, message.chat.id, "继续输入选项，或输入 /done。");
    } else {
      await sendMessage(ctx.botToken, message.chat.id, "问卷已准备好，发送 /my_surveys 查看。");
    }
    return true;
  }

  if (text === "/import") {
    await initBuilder(ctx.builder, userId);
    await startImport(ctx.builder, userId);
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      "请直接发送 survey.json 文件。\n\n不是发送 /tmp/survey.json 这段文字，而是像发文件一样把文件发给我。\n\n如果需要手输 JSON，格式如下：\n{\n  \"title\": \"问卷标题\",\n  \"description\": \"描述\",\n  \"questions\": [\n    {\"type\":\"single\",\"title\":\"题目\",\"options\":[\"A\",\"B\"]},\n    {\"type\":\"text\",\"title\":\"文本题\"}\n  ]\n}",
    );
    return true;
  }

  if (text?.startsWith("/option_media ")) {
    const optionId = Number(text.slice("/option_media ".length));
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

  if (state.step === "import") {
    if (message.document) {
      await sendMessage(ctx.botToken, message.chat.id, "正在解析文件，请稍候...");
    }

    try {
      const jsonText = message.document
        ? await getTelegramFileText(ctx.botToken, message.document.file_id)
        : text ?? "";
      const imported = parseImportedSurvey(jsonText);
      const typeCounts = new Map<string, number>();
      for (const question of imported.questions) {
        typeCounts.set(
          question.type,
          (typeCounts.get(question.type) ?? 0) + 1,
        );
      }
      const summary = [...typeCounts.entries()]
        .map(([type, count]) => `${type}: ${count}`)
        .join("\n");
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) {
        throw new Error("用户不存在，请先发送 /start");
      }
      const surveyId = await saveImportedSurvey(ctx.db, user.id, imported);
      await resetBuilder(ctx.builder, userId);
      await sendMessage(
        ctx.botToken,
        message.chat.id,
        `📥 导入完成\n\n题目：${imported.questions.length}\n\n${summary}\n\n草稿问卷 ID：${surveyId}\n发送 /my_surveys 查看并发布。`,
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

  if (state.step === "option_media") {
    if (!state.targetOptionId) {
      await sendMessage(ctx.botToken, message.chat.id, "目标选项 ID 不存在。");
      await resetBuilder(ctx.builder, userId);
      return true;
    }

    const mediaAssetId = await registerMediaAsset(ctx, message);
    if (!mediaAssetId) {
      await sendMessage(ctx.botToken, message.chat.id, "无法识别媒体，请重新发送。");
      return true;
    }

    await createOptionMedia(ctx.db, {
      questionOptionId: state.targetOptionId,
      mediaAssetId,
    });
    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "✅ 选项媒体已绑定。");
    return true;
  }

  if (state.step === "edit_question_title") {
    if (!state.targetQuestionId) {
      await sendMessage(ctx.botToken, message.chat.id, "目标题目 ID 不存在。");
      await resetBuilder(ctx.builder, userId);
      return true;
    }

    await updateQuestionTitle(ctx.db, state.targetQuestionId, text ?? "");
    await resetBuilder(ctx.builder, userId);
    await sendMessage(ctx.botToken, message.chat.id, "✅ 题目内容已更新。");
    return true;
  }

  if (!text) {
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
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) {
        throw new Error("用户不存在，请先发送 /start");
      }
      const surveyId = await saveDraftSurvey(ctx.db, finalState, user.id);
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

  if (data === "builder:save") {
    const state = await getBuilderState(ctx.builder, userId);
    if (!state || state.questions.length === 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "还没有可保存的题目");
      return true;
    }

    try {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user) {
        throw new Error("用户不存在，请先发送 /start");
      }
      const surveyId = await saveDraftSurvey(ctx.db, state, user.id);
      await resetBuilder(ctx.builder, userId);
      await sendMessage(ctx.botToken, chatId, `草稿已保存，问卷 ID：${surveyId}`);
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

  return false;
}
