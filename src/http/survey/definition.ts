import type { Env } from "../../index";
import type { Survey } from "../../db/schema";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { getSurveyFlow } from "../../services/question.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import { resolveSubmissionBotUrl } from "../../services/contact-links.service";
import { normalizeSurveyTheme } from "../../survey/theme";
import {
  SURVEY_DEFINITION_CACHE_TTL_SECONDS,
  SURVEY_DEFINITION_CACHE_VERSION,
} from "./catalog";
import { questionView, parseSettings } from "./presentation";
import { resolveParticipant } from "./participant";

/**
 * Builds the public survey definition (questions, options, media, pages).
 *
 * The payload is visitor-independent, so it is cached under the survey's
 * version + updated_at, which every mutating path bumps. Details that are NOT
 * visitor-independent — the submission-bot link and the gallery publish flag —
 * are applied after the cache read so they can change without invalidating it.
 */
export async function loadSurveyDefinition(
  env: Env,
  request: Request,
  survey: Survey,
): Promise<Record<string, unknown>> {
  const system = await loadSystemSettings(env.DB);
  const gallerySurveyId = Number(system.profileGallerySurveyId);
  const isGallerySurvey = Number.isInteger(gallerySurveyId) && gallerySurveyId > 0 && gallerySurveyId === survey.id;
  let canPublishProfile = false;
  if (isGallerySurvey) {
    const participant = await resolveParticipant(request, env);
    canPublishProfile = !(participant instanceof Response) && participant.kind === "telegram";
  }

  const cacheKey = `survey-definition:${SURVEY_DEFINITION_CACHE_VERSION}:${survey.id}:${survey.version}:${survey.updatedAt}`;
  let definition = await readCachedJson<Record<string, unknown>>(env.CACHE, cacheKey);
  if (!definition) {
    const flow = await getSurveyFlow(env.DB, survey.id);
    const pages = await env.DB.prepare(
      `SELECT id, title, description, "order"
         FROM survey_pages
         WHERE survey_id = ?
         ORDER BY "order" ASC, id ASC`,
    )
      .bind(survey.id)
      .all<{ id: number; title: string | null; description: string | null; order: number }>();

    const questions: unknown[] = [];
    const questionIds = flow.questions.map((question) => question.id);
    const optionMediaByOption = new Map<number, Array<{ mediaAssetId: number }>>();
    const questionMediaByQuestion = new Map<number, Array<{ mediaAssetId: number }>>();
    if (questionIds.length > 0) {
      // json_each keeps this at a single bind regardless of question count;
      // D1 rejects queries with more than 100 bound variables.
      const questionIdsJson = JSON.stringify(questionIds);
      const [questionMedia, optionMedia] = (await env.DB.batch([
        env.DB.prepare(
          `SELECT qm.question_id questionId, m.id mediaAssetId
           FROM question_media qm
           JOIN media_assets m ON m.id = qm.media_asset_id
           JOIN json_each(?) AS q ON q.value = qm.question_id
           ORDER BY qm.sort_order ASC, qm.id ASC`,
        ).bind(questionIdsJson),
        env.DB.prepare(
          `SELECT om.question_option_id optionId, m.id mediaAssetId
           FROM option_media om
           JOIN media_assets m ON m.id = om.media_asset_id
           JOIN question_options o ON o.id = om.question_option_id
           JOIN json_each(?) AS q ON q.value = o.question_id
           ORDER BY om.sort_order ASC, om.id ASC`,
        ).bind(questionIdsJson),
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

    definition = {
      id: survey.id,
      title: survey.title,
      ...(survey.description ? { description: survey.description } : {}),
      accessCodeRequired: Boolean(survey.accessCode),
      anonymous: survey.anonymous,
      allowMultiple: survey.allowMultipleResponses,
      maxResponses: survey.maxResponsesPerUser,
      theme: normalizeSurveyTheme(parseSettings(survey.settingsJson)),
      communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
      pages: (pages.results ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        description: page.description,
        order: page.order,
      })),
      questions,
    };
    await writeCachedJson(env.CACHE, cacheKey, definition, SURVEY_DEFINITION_CACHE_TTL_SECONDS);
  }

  return {
    ...definition,
    // Kept outside the cached payload so link changes do not need a cache
    // version bump.
    submissionBotUrl: resolveSubmissionBotUrl(env),
    ...(isGallerySurvey ? { galleryProfile: { enabled: true, canPublish: canPublishProfile } } : {}),
  };
}
