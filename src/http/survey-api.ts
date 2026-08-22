import type { Env } from "../index";
import { verifyTelegramWebAppUser } from "./admin-api";
import { getUserByTelegramId, upsertUser } from "../db/repositories/user.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getSurveyFlow } from "../services/question.service";
import { verifySurveyAccessCode } from "../core/security";
import {
  createResponse,
  getActiveResponse,
  getActiveResponseBySurveyAndUser,
  getResponseBySurveyAndHash,
  listAnswersByResponseId,
  completeResponse,
  upsertDateAnswer,
  upsertJsonAnswer,
  upsertMediaAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertTextAnswer,
  upsertTimeAnswer,
} from "../db/repositories/response.repository";
import { countCompletedResponsesBySurveyAndUser } from "../db/repositories/response.repository";
import {
  createAnswerMedia,
  createMediaAsset,
  getMediaAssetById,
} from "../db/repositories/media.repository";
import type { Answer, QuestionType, SurveyQuestion } from "../db/schema";
import { getMatrixColumns } from "../survey/question-presentation";
import { getFirstQuestion, getNextQuestionAfterOption } from "../survey/engine";
import {
  countTemporaryMediaBytesForResponse,
  MAX_RESPONSE_MEDIA_BYTES,
  MAX_TEMP_IMAGE_BYTES,
  storeTemporaryMedia,
  TEMP_IMAGE_MIME_TYPES,
} from "../services/media/temporary-media.service";
import { KVMediaStore } from "../services/media/temporary-media-store";
import { enqueueReportDelivery } from "../services/report-delivery.service";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { createReportAccessToken } from "../services/report-access-token.service";

const ANONYMOUS_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function temporaryStore(env: Env): KVMediaStore {
  return new KVMediaStore(env.MEDIA_KV);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status);
}

async function loadPublishedSurvey(
  env: Env,
  surveyId: number,
): Promise<{ survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>; flow: Awaited<ReturnType<typeof getSurveyFlow>> } | Response> {
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  const flow = await getSurveyFlow(env.DB, surveyId);
  return { survey, flow };
}

interface Participant {
  kind: "telegram" | "anonymous";
  dbUserId: number | null;
  telegramUserId: number | null;
  participantKey: string | null;
  participantHash: string;
}

async function resolveParticipant(
  request: Request,
  env: Env,
): Promise<Participant | Response> {
  const initDataHeader = request.headers.get("x-telegram-init-data");
  if (initDataHeader) {
    const telegramUserId = await verifyTelegramWebAppUser(request, env.BOT_TOKEN);
    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return fail(401, "invalid_identity", "Telegram 身份验证失败");
    }
    await upsertUser(env.DB, {
      telegramUserId,
      username: null,
      firstName: null,
      lastName: null,
      languageCode: null,
      systemRole: "participant",
    });
    const user = await getUserByTelegramId(env.DB, telegramUserId);
    if (!user) {
      return fail(500, "identity_lookup_failed", "无法创建用户身份");
    }
    return {
      kind: "telegram",
      dbUserId: user.id,
      telegramUserId,
      participantKey: null,
      participantHash: `user_${user.id}`,
    };
  }

  const participantKey = request.headers.get("x-participant-key");
  if (!participantKey || !ANONYMOUS_KEY_PATTERN.test(participantKey)) {
    return fail(401, "identity_required", "缺少答卷者身份标识");
  }
  return {
    kind: "anonymous",
    dbUserId: null,
    telegramUserId: null,
    participantKey,
    participantHash: `web_${participantKey}`,
  };
}

function mediaPublicUrl(mediaId: number): string {
  return `/api/survey/media/${mediaId}`;
}

function parseValidation(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseSettings(value: string | null): Record<string, unknown> | null {
  return parseValidation(value);
}

function questionView(
  question: SurveyQuestion,
  options: Array<{ id: number; label: string; media: Array<{ mediaAssetId: number }> }>,
  questionMedia: Array<{ mediaAssetId: number }>,
): Record<string, unknown> {
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    ...(question.description ? { description: question.description } : {}),
    required: question.required,
    order: question.order,
    pageId: question.pageId,
    validation: parseValidation(question.validationJson),
    settings: parseSettings(question.settingsJson),
    condition: parseValidation(question.conditionJson),
    skipToQuestionId: question.skipToQuestionId,
    media: questionMedia.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      media: option.media.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    })),
  };
}

function answerValue(answer: Answer): unknown {
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          (parsed as { kind?: unknown }).kind === "matrix") {
        return (parsed as { selections?: unknown }).selections ?? null;
      }
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" &&
          typeof (parsed as { mediaAssetId?: unknown }).mediaAssetId === "number") {
        return { mediaAssetId: (parsed as { mediaAssetId: number }).mediaAssetId };
      }
    } catch {
      // fall through to typed columns
    }
  }
  if (answer.textValue !== null) return answer.textValue;
  if (answer.numberValue !== null) return answer.numberValue;
  if (answer.booleanValue !== null) return answer.booleanValue;
  if (answer.ratingValue !== null) return answer.ratingValue;
  if (answer.dateValue !== null) return answer.dateValue;
  if (answer.timeValue !== null) return answer.timeValue;
  return null;
}

export async function handleSurveyApiRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/surveys") {
    const rows = await env.DB
      .prepare(
        `SELECT s.id, s.title, s.description, s.access_code accessCode,
                s.published_at publishedAt,
                (SELECT COUNT(*) FROM survey_questions q
                 WHERE q.survey_id = s.id) questionCount
         FROM surveys s
         WHERE s.status = 'published'
         ORDER BY s.published_at DESC, s.id DESC`,
      )
      .all<{
        id: number;
        title: string;
        description: string | null;
        accessCode: string | null;
        publishedAt: string | null;
        questionCount: number;
      }>();
    return json({
      surveys: (rows.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        accessCodeRequired: Boolean(row.accessCode),
        publishedAt: row.publishedAt,
        questionCount: Number(row.questionCount ?? 0),
      })),
    });
  }

  const mediaMatch = url.pathname.match(/^\/api\/survey\/media\/(\d+)$/);
  if (mediaMatch) {
    if (request.method !== "GET") return fail(405, "method_not_allowed", "仅支持 GET");
    return serveSurveyMedia(request, env, Number(mediaMatch[1]));
  }

  const surveyMatch = url.pathname.match(/^\/api\/survey\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return null;
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? "";

  if (request.method === "GET" && rest === "") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const { survey, flow } = loaded;

    const pages = await env.DB
      .prepare(
        `SELECT id, title, description, "order"
         FROM survey_pages
         WHERE survey_id = ?
         ORDER BY "order" ASC, id ASC`,
      )
      .bind(surveyId)
      .all<{ id: number; title: string | null; description: string | null; order: number }>();

    const questions: unknown[] = [];
    const questionIds = flow.questions.map((question) => question.id);
    const optionMediaByOption = new Map<number, Array<{ mediaAssetId: number }>>();
    const questionMediaByQuestion = new Map<number, Array<{ mediaAssetId: number }>>();
    if (questionIds.length > 0) {
      const [questionMedia, optionMedia] = (await env.DB.batch([
        env.DB.prepare(
          `SELECT qm.question_id questionId, m.id mediaAssetId
           FROM question_media qm
           JOIN media_assets m ON m.id = qm.media_asset_id
           WHERE qm.question_id IN (${questionIds.map(() => "?").join(",")})
           ORDER BY qm.sort_order ASC, qm.id ASC`,
        ).bind(...questionIds),
        env.DB.prepare(
          `SELECT om.question_option_id optionId, m.id mediaAssetId
           FROM option_media om
           JOIN media_assets m ON m.id = om.media_asset_id
           WHERE om.question_option_id IN (
             SELECT id FROM question_options WHERE question_id IN (${questionIds.map(() => "?").join(",")})
           )
           ORDER BY om.sort_order ASC, om.id ASC`,
        ).bind(...questionIds),
      ])) as [
        D1Result<{ questionId: number; mediaAssetId: number }>,
        D1Result<{ optionId: number; mediaAssetId: number }>,
      ];
      for (const row of questionMedia.results ?? []) {
        const list = questionMediaByQuestion.get(row.questionId) ?? [];
        list.push({ mediaAssetId: row.mediaAssetId });
        questionMediaByQuestion.set(row.questionId, list);
      }
      for (const row of optionMedia.results ?? []) {
        const list = optionMediaByOption.get(row.optionId) ?? [];
        list.push({ mediaAssetId: row.mediaAssetId });
        optionMediaByOption.set(row.optionId, list);
      }
    }
    for (const question of flow.questions) {
      questions.push(
        questionView(
          question,
          question.options.map((option) => ({
            id: option.id,
            label: option.label,
            media: optionMediaByOption.get(option.id) ?? [],
          })),
          questionMediaByQuestion.get(question.id) ?? [],
        ),
      );
    }

    return json({
      id: survey.id,
      title: survey.title,
      ...(survey.description ? { description: survey.description } : {}),
      accessCodeRequired: Boolean(survey.accessCode),
      anonymous: survey.anonymous,
      allowMultiple: survey.allowMultipleResponses,
      maxResponses: survey.maxResponsesPerUser,
      pages: (pages.results ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        description: page.description,
        order: page.order,
      })),
      questions,
    });
  }

  if (request.method === "POST" && rest === "/access") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    if (!loaded.survey.accessCode) {
      return json({ ok: true });
    }
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const valid = await verifySurveyAccessCode(loaded.survey.accessCode, code);
    if (!valid) return fail(403, "invalid_access_code", "访问密码错误");
    return json({ ok: true });
  }

  if (request.method === "POST" && rest === "/responses") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const { survey, flow } = loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;

    if (survey.accessCode) {
      const body = (await request.json().catch(() => null)) as { accessCode?: unknown } | null;
      const code = typeof body?.accessCode === "string" ? body.accessCode : "";
      const valid = await verifySurveyAccessCode(survey.accessCode, code);
      if (!valid) return fail(403, "invalid_access_code", "访问密码错误");
    }

    const active = participant.kind === "telegram"
      ? await getActiveResponseBySurveyAndUser(env.DB, surveyId, participant.dbUserId!)
      : await getActiveResponse(env.DB, surveyId, participant.participantHash);
    if (active) {
      return json({
        responseId: active.id,
        currentQuestionId: active.currentQuestionId,
        status: active.status,
        resumed: true,
      });
    }

    if (!survey.allowMultipleResponses) {
      const existing = await getResponseBySurveyAndHash(env.DB, surveyId, participant.participantHash);
      if (existing?.status === "completed") {
        return fail(409, "already_completed", "你已经完成过该问卷，不能重复提交");
      }
    } else if (participant.kind === "telegram" && participant.dbUserId !== null) {
      const completedCount = await countCompletedResponsesBySurveyAndUser(
        env.DB,
        surveyId,
        participant.dbUserId,
      );
      if (survey.maxResponsesPerUser > 0 && completedCount >= survey.maxResponsesPerUser) {
        return fail(409, "response_limit_reached", "已达到填写次数上限");
      }
    }

    const firstQuestion = getFirstQuestion(flow);
    if (!firstQuestion) {
      return fail(400, "empty_survey", "问卷还没有题目");
    }
    const response = await createResponse(env.DB, {
      surveyId,
      userId: participant.dbUserId,
      participantHash: participant.participantHash,
      currentQuestionId: firstQuestion.id,
    });
    return json({
      responseId: response.id,
      currentQuestionId: firstQuestion.id,
      status: response.status,
      resumed: false,
    }, 201);
  }

  if (request.method === "POST" && rest === "/media") {
    return handleSurveyMediaUpload(request, env, surveyId);
  }

  const responseMatch = rest.match(/^\/responses\/(\d+)(\/.*)?$/);
  if (!responseMatch) return null;
  const responseId = Number(responseMatch[1]);
  const responseRest = responseMatch[2] ?? "";

  if (request.method === "GET" && responseRest === "") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const row = await env.DB
      .prepare(
        `SELECT id FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ?
         LIMIT 1`,
      )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number }>();
    if (!row) return fail(404, "response_not_found", "答卷不存在");
    const answers = await listAnswersByResponseId(env.DB, responseId);
    return json({
      answers: Object.fromEntries(
        answers.map((answer) => [String(answer.questionId), answerValue(answer)]),
      ),
    });
  }

  if (request.method === "POST" && responseRest === "/answers") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const response = await env.DB
      .prepare(
        `SELECT id, status FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
         LIMIT 1`,
      )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number; status: string }>();
    if (!response) return fail(404, "response_not_found", "答卷不存在或已提交");

    const body = (await request.json().catch(() => null)) as {
      questionId?: unknown;
      value?: unknown;
    } | null;
    if (!body || !Number.isInteger(body.questionId)) {
      return fail(400, "invalid_body", "questionId 必须是整数");
    }
    const question = loaded.flow.questions.find(
      (item) => item.id === Number(body.questionId),
    );
    if (!question) return fail(404, "question_not_found", "题目不存在");

    const saveError = await saveWebAnswer(env, responseId, question, body.value);
    if (saveError) return saveError;
    await env.DB
      .prepare(
        "UPDATE survey_responses SET current_question_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(question.id, new Date().toISOString(), responseId)
      .run();
    return json({ ok: true });
  }

  if (request.method === "POST" && responseRest === "/submit") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const response = await env.DB
      .prepare(
        `SELECT id, status FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
         LIMIT 1`,
      )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number; status: string }>();
    if (!response) return fail(404, "response_not_found", "答卷不存在或已提交");

    const answers = await listAnswersByResponseId(env.DB, responseId);
    const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const missing = findMissingRequiredQuestion(loaded.flow.questions, answersByQuestion);
    if (missing) {
      return fail(400, "required_missing", `请完成必答题目：${missing.title}`);
    }
    await completeResponse(env.DB, responseId);
    try {
      await enqueueReportDelivery(env.DB, env.EXPORT_QUEUE, { responseId });
    } catch (error) {
      // Answer data is already committed; report archiving is retried by the
      // queue pipeline, so a transient enqueue failure must not fail submit.
      console.error("Report delivery enqueue failed", { responseId, error });
    }
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
    return json({
      ok: true,
      completed: true,
      reportUrl: `/report/${responseId}?t=${token}`,
    });
  }

  return null;
}

async function saveWebAnswer(
  env: Env,
  responseId: number,
  question: Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number],
  value: unknown,
): Promise<Response | null> {
  const type = question.type as QuestionType;
  if (type === "single" || type === "yes_no" || type === "rating") {
    const optionId = Number(value);
    if (!Number.isInteger(optionId) || !question.options.some((option) => option.id === optionId)) {
      return fail(400, "invalid_answer", "选项无效");
    }
    await upsertOptionAnswer(env.DB, {
      responseId,
      questionId: question.id,
      selectedOptionIds: [optionId],
      ...(type === "yes_no"
        ? { booleanValue: question.options[0]?.id === optionId }
        : {}),
      ...(type === "rating" ? { ratingValue: ratingOptionValue(question, optionId) } : {}),
    });
    return null;
  }

  if (type === "multiple") {
    if (!Array.isArray(value) || value.some((entry) => !Number.isInteger(Number(entry)))) {
      return fail(400, "invalid_answer", "多选答案必须是选项 ID 数组");
    }
    const selectedOptionIds = value.map(Number).filter((optionId) =>
      question.options.some((option) => option.id === optionId),
    );
    if (selectedOptionIds.length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertOptionAnswer(env.DB, {
        responseId,
        questionId: question.id,
        selectedOptionIds,
      });
    }
    return null;
  }

  if (type === "matrix") {
    const selections = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    const columns = getMatrixColumns(question);
    const normalized: Record<string, number> = {};
    for (const row of question.options) {
      const raw = selections[String(row.id)];
      if (raw === undefined || raw === null) continue;
      const columnIndex = Number(raw);
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columns.length) {
        return fail(400, "invalid_answer", `矩阵题 ${row.label} 的列无效`);
      }
      normalized[String(row.id)] = columnIndex;
    }
    if (Object.keys(normalized).length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertJsonAnswer(env.DB, {
        responseId,
        questionId: question.id,
        jsonValue: JSON.stringify({ kind: "matrix", selections: normalized }),
      });
    }
    return null;
  }

  if (type === "text" || type === "long_text") {
    if (typeof value !== "string") return fail(400, "invalid_answer", "文本答案必须是字符串");
    await upsertTextAnswer(env.DB, { responseId, questionId: question.id, textValue: value });
    return null;
  }

  if (type === "number") {
    const numberValue = Number(value);
    if (typeof value !== "number" || !Number.isFinite(numberValue)) {
      return fail(400, "invalid_answer", "数字答案必须是数字");
    }
    await upsertNumberAnswer(env.DB, { responseId, questionId: question.id, numberValue });
    return null;
  }

  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "日期格式必须为 YYYY-MM-DD");
    }
    await upsertDateAnswer(env.DB, { responseId, questionId: question.id, dateValue: value });
    return null;
  }

  if (type === "time") {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "时间格式必须为 HH:MM");
    }
    await upsertTimeAnswer(env.DB, { responseId, questionId: question.id, timeValue: value });
    return null;
  }

  if (type === "image" || type === "video" || type === "audio" || type === "file") {
    const mediaAssetId = value && typeof value === "object" && !Array.isArray(value)
      ? Number((value as { mediaAssetId?: unknown }).mediaAssetId)
      : Number(value);
    if (!Number.isInteger(mediaAssetId) || mediaAssetId <= 0) {
      return fail(400, "invalid_answer", "媒体答案无效");
    }
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset || asset.scope !== "response") {
      return fail(404, "media_not_found", "媒体不存在");
    }
    const answerId = await upsertMediaAnswer(env.DB, {
      responseId,
      questionId: question.id,
      mediaAssetId,
    });
    await createAnswerMedia(env.DB, { answerId, mediaAssetId });
    return null;
  }

  return fail(400, "unsupported_type", `不支持的题型：${type}`);
}

function ratingOptionValue(
  question: Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number],
  optionId: number,
): number | null {
  const option = question.options.find((item) => item.id === optionId);
  const candidate = Number(option?.value ?? option?.label ?? optionId);
  return Number.isFinite(candidate) ? candidate : null;
}

async function deleteWebAnswer(
  db: D1Database,
  responseId: number,
  questionId: number,
): Promise<void> {
  const answer = await db
    .prepare("SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1")
    .bind(responseId, questionId)
    .first<{ id: number }>();
  if (!answer) return;
  await db.batch([
    db.prepare("DELETE FROM answer_media WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answer_options WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answers WHERE id = ?").bind(answer.id),
  ]);
}

function findMissingRequiredQuestion(
  flowQuestions: Awaited<ReturnType<typeof getSurveyFlow>>["questions"],
  answersByQuestion: Map<number, Answer>,
): SurveyQuestion | null {
  const visited = new Set<number>();
  let current = getFirstQuestion({ questions: flowQuestions });
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const answer = answersByQuestion.get(current.id);
    if (current.required && !isWebAnswerPresent(answer)) {
      return current;
    }
    const selectedOptionId = selectedWebOptionId(current, answer);
    current = getNextQuestionAfterOption(
      { questions: flowQuestions },
      current.id,
      selectedOptionId,
    );
  }
  return null;
}

function isWebAnswerPresent(answer: Answer | undefined): boolean {
  if (!answer) return false;
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === "object" &&
          (parsed as { kind?: unknown }).kind === "matrix") {
        const selections = (parsed as { selections?: Record<string, unknown> }).selections ?? {};
        return Object.keys(selections).length > 0;
      }
    } catch {
      return true;
    }
    return true;
  }
  return (
    answer.textValue !== null ||
    answer.numberValue !== null ||
    answer.booleanValue !== null ||
    answer.ratingValue !== null ||
    answer.dateValue !== null ||
    answer.timeValue !== null
  );
}

function selectedWebOptionId(
  question: SurveyQuestion,
  answer: Answer | undefined,
): number | null {
  if (question.type !== "single" && question.type !== "yes_no" && question.type !== "rating") {
    return null;
  }
  if (!answer?.jsonValue) return null;
  try {
    const parsed = JSON.parse(answer.jsonValue) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const optionId = Number(parsed[0]);
      return Number.isInteger(optionId) && optionId > 0 ? optionId : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function serveSurveyMedia(
  request: Request,
  env: Env,
  mediaId: number,
): Promise<Response> {
  const asset = await getMediaAssetById(env.DB, mediaId);
  if (!asset) return fail(404, "media_not_found", "媒体不存在");

  if (asset.scope === "survey") {
    const linked = await env.DB
      .prepare(
        `SELECT s.id FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_media qm ON qm.question_id = q.id
         WHERE s.status = 'published' AND qm.media_asset_id = ?
         UNION
         SELECT s.id FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_options o ON o.question_id = q.id
         JOIN option_media om ON om.question_option_id = o.id
         WHERE s.status = 'published' AND om.media_asset_id = ?`,
      )
      .bind(mediaId, mediaId)
      .first<{ id: number }>();
    if (!linked) return fail(404, "media_not_found", "媒体不属于已发布问卷");
  } else if (asset.scope === "response") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const owned = await env.DB
      .prepare(
        `SELECT r.id FROM survey_responses r
         JOIN answers a ON a.response_id = r.id
         JOIN answer_media am ON am.answer_id = a.id
         WHERE am.media_asset_id = ? AND r.participant_hash = ?
         LIMIT 1`,
      )
      .bind(mediaId, participant.participantHash)
      .first<{ id: number }>();
    if (!owned) return fail(403, "media_forbidden", "无权访问该媒体");
  } else {
    return fail(403, "media_forbidden", "媒体不可公开访问");
  }

  const mediaResponse = await buildMediaResponse(env, asset);
  if (!mediaResponse) {
    return fail(404, "media_unavailable", "媒体不可用");
  }
  return mediaResponse;
}

export async function handleSurveyMediaUpload(
  request: Request,
  env: Env,
  surveyId: number,
): Promise<Response> {
  const loaded = await loadPublishedSurvey(env, surveyId);
  if (loaded instanceof Response) return loaded;
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const response = await env.DB
    .prepare(
      `SELECT id FROM survey_responses
       WHERE survey_id = ? AND participant_hash = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(surveyId, participant.participantHash)
    .first<{ id: number }>();
  if (!response) return fail(404, "response_not_found", "请先开始填写问卷");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid_upload", "上传内容无效");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail(400, "invalid_upload", "缺少 file 字段");
  }
  const mimeType = file.type.toLowerCase();
  if (!TEMP_IMAGE_MIME_TYPES.has(mimeType)) {
    return fail(400, "invalid_image_type", "仅支持 JPEG / PNG / WebP 图片");
  }
  if (file.size > MAX_TEMP_IMAGE_BYTES) {
    return fail(413, "upload_too_large", "单张图片不能超过 10MB");
  }
  const currentBytes = await countTemporaryMediaBytesForResponse(env.DB, response.id);
  if (currentBytes + file.size > MAX_RESPONSE_MEDIA_BYTES) {
    return fail(413, "response_media_limit", "单份答卷图片总量不能超过 50MB");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = await storeTemporaryMedia(env.DB, temporaryStore(env), {
    responseId: response.id,
    bytes,
    mimeType,
    fileName: file.name || null,
  });
  return json({ ok: true, mediaAssetId: asset.id, url: mediaPublicUrl(asset.id) }, 201);
}
