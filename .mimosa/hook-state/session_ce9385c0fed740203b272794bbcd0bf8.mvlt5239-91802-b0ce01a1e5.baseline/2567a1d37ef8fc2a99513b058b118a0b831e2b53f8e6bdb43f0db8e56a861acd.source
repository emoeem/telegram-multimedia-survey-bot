import { getResponseById, listAnswersByResponseId } from "../db/repositories/response.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import { listOptionsForQuestions, listQuestionsBySurvey } from "../db/repositories/question.repository";
import {
  getResultProfileByResponseId,
  getSurveyResultRuleSet,
  upsertResultProfile,
} from "../db/repositories/result-profile.repository";
import { getSurveyResultVisualSettings } from "../db/repositories/survey-result-visual-settings.repository";
import {
  getVisualTemplateById,
  getVisualTemplateVersion,
  listVisualTemplates,
} from "../db/repositories/visual-template.repository";
import type { QuestionType, ResultFieldType, ResultProfile, SurveyQuestion } from "../db/schema";
import { calculateResultProfile, parseResultRuleSet, serializeResultProfile } from "./result-engine.service";
import { enqueueResultVisualJob, type ResultVisualEnqueueResult } from "./result-visual-queue.service";
import { normalizeAnswer } from "./answer-value-adapter.service";
import type { ResultProfileSnapshot } from "../result/schema";
import { getResponseSurveySnapshot } from "./survey-version.service";
import { classifyParticipantReport } from "./participant-report.service";

export interface PreparedResultProfile {
  profile: ResultProfile;
  reused: boolean;
}

function fallbackFieldType(type: string): ResultFieldType {
  if (type === "number") return "number";
  if (type === "rating") return "rating";
  if (type === "date") return "date";
  if (type === "multiple") return "tags";
  if (type === "boolean" || type === "yes_no") return "boolean";
  if (type === "long_text") return "long_text";
  if (type === "image") return "image";
  return "text";
}

function displayAnswer(value: unknown, type: string, optionLabelById: ReadonlyMap<number, string>): string {
  if (value === null || value === undefined) return "未填写";
  if (Array.isArray(value)) {
    const isChoice = type === "single" || type === "multiple";
    return value
      .map((entry) => {
        if (isChoice) {
          const id =
            typeof entry === "number" ? entry : typeof entry === "string" && /^\d+$/.test(entry) ? Number(entry) : null;
          if (id !== null && Number.isInteger(id)) {
            return optionLabelById.get(id) ?? String(entry);
          }
        }
        return displayAnswer(entry, type, optionLabelById);
      })
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object") return "已上传";
  return String(value);
}

function fallbackResultProfile(
  surveyTitle: string,
  questions: Array<Pick<Awaited<ReturnType<typeof listQuestionsBySurvey>>[number], "id" | "type" | "title">>,
  answers: Awaited<ReturnType<typeof listAnswersByResponseId>>,
  optionRows: Awaited<ReturnType<typeof listOptionsForQuestions>>,
  hasExplicitResultRules = false,
): ResultProfileSnapshot {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
  const optionLabelById = new Map(optionRows.map((option) => [option.id, option.label]));
  const optionsByQuestion = new Map<number, Array<{ id: number; label: string }>>();
  for (const option of optionRows) {
    const list = optionsByQuestion.get(option.questionId) ?? [];
    list.push({ id: option.id, label: option.label });
    optionsByQuestion.set(option.questionId, list);
  }
  const fields: ResultProfileSnapshot["fields"] = {};
  const profile: Array<{ label: string; value: string }> = [];
  const ratingStats: ResultProfileSnapshot["stats"] = [];
  const images: ResultProfileSnapshot["images"] = {};
  const gallery: Array<{ mediaAssetId: number }> = [];
  const summary: string[] = [];
  const tags = new Set<string>();

  const selectedOptionIds = (value: unknown): Set<number> => {
    const ids = new Set<number>();
    const push = (entry: unknown) => {
      if (typeof entry === "number") ids.add(entry);
      else if (typeof entry === "string" && /^\d+$/.test(entry)) ids.add(Number(entry));
    };
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
    return ids;
  };

  for (const question of questions) {
    const answer = answerMap.get(question.id);
    if (!answer) continue;
    const normalized = normalizeAnswer(answer, question.type);
    const fieldId = `question_${question.id}`;
    fields[fieldId] = { id: fieldId, type: fallbackFieldType(question.type), value: normalized.value };
    const choiceOptions =
      question.type === "single" || question.type === "multiple" || question.type === "yes_no"
        ? (optionsByQuestion.get(question.id) ?? []).map((option) => ({
            label: option.label,
            selected: selectedOptionIds(normalized.value).has(option.id),
          }))
        : undefined;
    profile.push({
      label: question.title,
      value: displayAnswer(normalized.value, question.type, optionLabelById),
      ...(choiceOptions?.length ? { type: question.type, options: choiceOptions } : {}),
    });
    if (Array.isArray(normalized.value)) {
      for (const item of normalized.value) if (typeof item === "string" && item.trim()) tags.add(item.trim());
    }
    // Numeric profile fields such as age/height/weight are facts, not scores.
    // Only an explicit rating question contributes to the score section.
    if (question.type === "rating" && typeof normalized.value === "number" && Number.isFinite(normalized.value)) {
      ratingStats.push({
        id: fieldId,
        label: question.title,
        value: normalized.value,
        max: 10,
      });
    }
    if (normalized.media.length > 0) {
      const mediaValues = normalized.media.map((item) => ({ mediaAssetId: item.mediaAssetId }));
      images[`question_${question.id}`] = mediaValues[0]!;
      gallery.push(...mediaValues);
    }
    const displayValue = displayAnswer(normalized.value, question.type, optionLabelById);
    if (displayValue && displayValue !== "未填写") {
      summary.push(`${question.title}：${displayValue}`);
    }
  }

  const classification = classifyParticipantReport(questions, hasExplicitResultRules);
  const isPersonalProfile = classification.kind === "personal_profile";
  const nameQuestion = questions.find((question) => /姓名|昵称/.test(question.title));
  const identityQuestion = questions.find((question) => /职业|身份/.test(question.title));
  const locationQuestion = questions.find((question) => /所在城市|城市/.test(question.title));
  const answerValueText = (question?: (typeof questions)[number]) => {
    if (!question) return "";
    const answer = answerMap.get(question.id);
    if (!answer) return "";
    return displayAnswer(normalizeAnswer(answer, question.type).value, question.type, optionLabelById);
  };
  const profileTitle = answerValueText(nameQuestion);
  const profileSubtitle = [answerValueText(identityQuestion), answerValueText(locationQuestion)].filter(Boolean).join(" · ");

  return {
    resultType: isPersonalProfile ? "identity_card" : classification.kind,
    title: isPersonalProfile && profileTitle ? profileTitle : classification.resultTitle,
    subtitle: isPersonalProfile ? profileSubtitle || "个人档案 · 本次填写结果" : `${surveyTitle} · ${classification.label}`,
    fields,
    stats: ratingStats,
    tags: [...tags],
    images,
    metadata: {
      profile,
      gallery,
      status: [],
      summary: isPersonalProfile
        ? [
            profileSubtitle ? `身份：${profileSubtitle}` : "",
            tags.size ? `兴趣与标签：${[...tags].slice(0, 8).join("、")}` : "",
          ].filter(Boolean).join("\n\n")
        : summary.join("\n\n"),
      reportKind: classification.kind,
      reportLabel: classification.label,
      reportConfidence: classification.confidence,
      answerSectionTitle: classification.answerSectionTitle,
      summaryTitle: classification.summaryTitle,
    },
    schemaVersion: 1,
  };
}

export async function prepareResultProfileForResponse(
  db: D1Database,
  responseId: number,
  options: { forceRecalculate?: boolean } = {},
): Promise<PreparedResultProfile | null> {
  const existing = await getResultProfileByResponseId(db, responseId);
  if (existing && !options.forceRecalculate) return { profile: existing, reused: true };

  const response = await getResponseById(db, responseId);
  if (!response) throw new Error("Response not found");
  if (response.status !== "completed") throw new Error("ResultProfile requires a completed response");
  const ruleSetRecord = await getSurveyResultRuleSet(db, response.surveyId);
  const answers = await listAnswersByResponseId(db, response.id);
  let surveyTitle = (await getSurveyById(db, response.surveyId))?.title ?? "问卷结果";
  let questions: Array<Pick<SurveyQuestion, "id" | "type" | "title">> = await listQuestionsBySurvey(
    db,
    response.surveyId,
  );
  const versionSnapshot = await getResponseSurveySnapshot(db, response.id);
  if (versionSnapshot && versionSnapshot.questionOrderIds.length > 0) {
    const snapshotQuestions = versionSnapshot.questionOrderIds
      .map((questionId, index) => {
        const schemaQuestion = versionSnapshot.schema.survey.questions[index];
        if (!schemaQuestion) return null;
        return {
          id: questionId,
          type: schemaQuestion.type as QuestionType,
          title: schemaQuestion.title,
        };
      })
      .filter((question): question is { id: number; type: QuestionType; title: string } => question !== null);
    if (snapshotQuestions.length > 0) {
      questions = snapshotQuestions;
      surveyTitle = versionSnapshot.schema.survey.title ?? surveyTitle;
    }
  }
  const optionRows = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  const fallback = fallbackResultProfile(surveyTitle, questions, answers, optionRows, Boolean(ruleSetRecord));
  const snapshot = ruleSetRecord
    ? (() => {
        const calculated = calculateResultProfile({ answers, ruleSet: parseResultRuleSet(ruleSetRecord.rulesJson) });
        const profile = Array.isArray(calculated.metadata.profile) ? calculated.metadata.profile : [];
        const fallbackProfile = Array.isArray(fallback.metadata.profile) ? fallback.metadata.profile : [];
        const gallery = Array.isArray(calculated.metadata.gallery) ? calculated.metadata.gallery : [];
        const fallbackGallery = Array.isArray(fallback.metadata.gallery) ? fallback.metadata.gallery : [];
        return {
          ...calculated,
          fields: { ...fallback.fields, ...calculated.fields },
          images: { ...fallback.images, ...calculated.images },
          metadata: {
            ...fallback.metadata,
            ...calculated.metadata,
            profile: [...fallbackProfile, ...profile],
            gallery: [...fallbackGallery, ...gallery],
          },
        };
      })()
    : fallback;
  const serialized = serializeResultProfile(snapshot);
  return {
    profile: await upsertResultProfile(db, {
      surveyId: response.surveyId,
      responseId: response.id,
      ...serialized,
    }),
    reused: false,
  };
}

export async function requestConfiguredResultVisual(
  db: D1Database,
  queue: Queue,
  input: {
    responseId: number;
    chatId: number | null;
    requestedBy: number | null;
    templateId?: number;
    forceRecalculate?: boolean;
    forceRegenerate?: boolean;
  },
): Promise<ResultVisualEnqueueResult | null> {
  const prepared = await prepareResultProfileForResponse(
    db,
    input.responseId,
    input.forceRecalculate === undefined ? {} : { forceRecalculate: input.forceRecalculate },
  );
  if (!prepared) return null;
  const settings = await getSurveyResultVisualSettings(db, prepared.profile.surveyId);
  const templates = input.templateId
    ? [await getVisualTemplateById(db, input.templateId)]
    : settings.enabled && settings.templateId
      ? [await getVisualTemplateById(db, settings.templateId)]
      : await listVisualTemplates(db, 100);
  const template = templates.find(
    (candidate) =>
      candidate?.type === "report" &&
      candidate.status === "published" &&
      candidate.currentVersion &&
      (candidate.surveyId === null || candidate.surveyId === prepared.profile.surveyId),
  );
  if (!template) return null;
  if (!template || template.status !== "published" || !template.currentVersion) {
    throw new Error("Configured result visual template is not published");
  }
  const version = await getVisualTemplateVersion(db, template.id, template.currentVersion);
  if (!version) throw new Error("Configured result visual template version is missing");

  return enqueueResultVisualJob(db, queue, {
    resultProfileId: prepared.profile.id,
    templateId: template.id,
    templateVersion: version.version,
    chatId: input.chatId,
    requestedBy: input.requestedBy,
    ...(input.forceRegenerate === undefined ? {} : { forceRegenerate: input.forceRegenerate }),
  });
}
