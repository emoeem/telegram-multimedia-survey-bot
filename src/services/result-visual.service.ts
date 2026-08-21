import { getResponseById, listAnswersByResponseId } from "../db/repositories/response.repository";
import { getSurveyById } from "../db/repositories/survey.repository";
import { listQuestionsBySurvey } from "../db/repositories/question.repository";
import {
  getResultProfileByResponseId,
  getSurveyResultRuleSet,
  upsertResultProfile,
} from "../db/repositories/result-profile.repository";
import { getSurveyResultVisualSettings } from "../db/repositories/survey-result-visual-settings.repository";
import { getVisualTemplateById, getVisualTemplateVersion, listVisualTemplates } from "../db/repositories/visual-template.repository";
import type { ResultFieldType, ResultProfile } from "../db/schema";
import { calculateResultProfile, parseResultRuleSet, serializeResultProfile } from "./result-engine.service";
import { enqueueResultVisualJob, type ResultVisualEnqueueResult } from "./result-visual-queue.service";
import { normalizeAnswer } from "./answer-value-adapter.service";
import type { ResultProfileSnapshot } from "../result/schema";

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

function displayAnswer(value: unknown): string {
  if (value === null || value === undefined) return "未填写";
  if (Array.isArray(value)) return value.map(displayAnswer).filter(Boolean).join("、");
  if (typeof value === "object") return "已上传";
  return String(value);
}

function fallbackResultProfile(
  surveyTitle: string,
  questions: Awaited<ReturnType<typeof listQuestionsBySurvey>>,
  answers: Awaited<ReturnType<typeof listAnswersByResponseId>>,
): ResultProfileSnapshot {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
  const fields: ResultProfileSnapshot["fields"] = {};
  const profile: Array<{ label: string; value: string }> = [];
  const stats: ResultProfileSnapshot["stats"] = [];
  const images: ResultProfileSnapshot["images"] = {};
  const gallery: Array<{ mediaAssetId: number }> = [];
  const summary: string[] = [];
  const tags = new Set<string>();

  for (const question of questions) {
    const answer = answerMap.get(question.id);
    if (!answer) continue;
    const normalized = normalizeAnswer(answer, question.type);
    const fieldId = `question_${question.id}`;
    fields[fieldId] = { id: fieldId, type: fallbackFieldType(question.type), value: normalized.value };
    profile.push({ label: question.title, value: displayAnswer(normalized.value) });
    if (Array.isArray(normalized.value)) {
      for (const item of normalized.value) if (typeof item === "string" && item.trim()) tags.add(item.trim());
    }
    if (typeof normalized.value === "number" && Number.isFinite(normalized.value)) {
      stats.push({ id: fieldId, label: question.title, value: normalized.value, max: question.type === "rating" ? 10 : Math.max(100, normalized.value) });
    }
    if (normalized.media.length > 0) {
      const mediaValues = normalized.media.map((item) => ({ mediaAssetId: item.mediaAssetId }));
      images[`question_${question.id}`] = mediaValues[0]!;
      gallery.push(...mediaValues);
    }
    if (typeof normalized.value === "string" && normalized.value.trim()) summary.push(`${question.title}：${normalized.value.trim()}`);
  }

  return {
    resultType: "survey_result",
    title: surveyTitle,
    subtitle: "问卷完成 · 自动整理结果",
    fields,
    stats,
    tags: [...tags],
    images,
    metadata: {
      profile,
      gallery,
      status: [],
      summary: summary.join("\n\n"),
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
  const surveyTitle = (await getSurveyById(db, response.surveyId))?.title ?? "问卷结果";
  const questions = await listQuestionsBySurvey(db, response.surveyId);
  const fallback = fallbackResultProfile(surveyTitle, questions, answers);
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
  const template = templates.find((candidate) => candidate?.type === "report" && candidate.status === "published" && candidate.currentVersion &&
    (candidate.surveyId === null || candidate.surveyId === prepared.profile.surveyId));
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
