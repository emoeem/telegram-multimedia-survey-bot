import type { Env } from "../../index";
import { getBotUsername } from "../../bot/telegram";
import { getSurveyById } from "../../db/repositories/survey.repository";
import { getSurveyFlow } from "../../services/question.service";
import { normalizeSurveyTheme } from "../../survey/theme";
import { fail } from "../api-response";
import { mediaPublicUrl, parseSettings } from "./presentation";

/**
 * The public survey list is the most expensive read in the product: its
 * question-count subquery runs once per published survey, so 200 surveys of 74
 * questions each costs roughly 15,000 rows read — on every page load, out of a
 * free-tier budget of 5,000,000 rows/day for the whole account.
 *
 * The payload is identical for every visitor and only changes when someone
 * edits a published survey, and every edit bumps `surveys.updated_at`. So the
 * list is cached under a stamp derived from the published surveys themselves:
 * the stamp probe costs a couple of hundred rows and a cache hit costs none.
 *
 * Freshness comes from the stamp, not from the TTL, so the TTL only bounds how
 * much KV storage the stale entries occupy. Keeping it long is deliberate: KV's
 * free plan allows 1,000 writes/day for the whole account, and a short TTL
 * would spend that budget re-writing the same payload.
 */
export const SURVEY_LIST_CACHE_VERSION = "v1";
export const SURVEY_LIST_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * The published survey definition (questions, options, media, pages) costs
 * roughly 500 rows read per load and is identical for every visitor. It is
 * cached per survey under its `version`/`updated_at`, which every mutation
 * touches: question, option, page and cover edits call `touchSurvey`, while
 * publish/close/archive bump `version` too. So the key turns over the moment a
 * creator saves something.
 *
 * The TTL therefore only bounds KV usage, and is set to an hour rather than
 * something longer so that a mutation path which forgets to touch the survey
 * row cannot serve stale questions indefinitely.
 */
export const SURVEY_DEFINITION_CACHE_VERSION = "v1";
export const SURVEY_DEFINITION_CACHE_TTL_SECONDS = 60 * 60;

export const PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY = "participant-link-bot-username";

export interface PublishedSurveyListItem {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  publishedAt: string | null;
  questionCount: number;
  coverUrl?: string;
  theme: unknown;
}

export async function loadPublishedSurveyListStamp(db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS updatedAt
         FROM surveys
        WHERE status = 'published'`,
    )
    .first<{ total: number; updatedAt: string }>();
  return `${Number(row?.total ?? 0)}:${row?.updatedAt ?? ""}`;
}

export async function loadPublishedSurveyList(env: Env, q: string): Promise<PublishedSurveyListItem[]> {
  const conditions = ["s.status = 'published'"];
  const binds: string[] = [];
  if (q) {
    conditions.push("(lower(s.title) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)");
    binds.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  const rows = await env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.access_code accessCode,
              s.published_at publishedAt, s.settings_json settingsJson,
              m.id coverMediaId, m.url coverUrl,
              (SELECT COUNT(*) FROM survey_questions q
               WHERE q.survey_id = s.id) questionCount
       FROM surveys s
       LEFT JOIN media_assets m ON m.id = s.cover_media_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.published_at DESC, s.id DESC
       LIMIT 200`,
  )
    .bind(...binds)
    .all<{
      id: number;
      title: string;
      description: string | null;
      accessCode: string | null;
      publishedAt: string | null;
      questionCount: number;
      settingsJson: string | null;
      coverMediaId: number | null;
      coverUrl: string | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    accessCodeRequired: Boolean(row.accessCode),
    publishedAt: row.publishedAt,
    questionCount: Number(row.questionCount ?? 0),
    // Always serve the cover through the media endpoint so KV/R2/data-URL
    // covers share one path and the public list stays small.
    ...(typeof row.coverMediaId === "number" ? { coverUrl: mediaPublicUrl(Number(row.coverMediaId)) } : {}),
    theme: normalizeSurveyTheme(parseSettings(row.settingsJson)),
  }));
}

export async function resolveParticipantLinkBotUsername(env: Env): Promise<string | null> {
  try {
    const cached = await env.CACHE.get(PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY);
    if (cached) return cached;
    const username = await getBotUsername(env.BOT_TOKEN);
    if (!username) return null;
    await env.CACHE.put(PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY, username, {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    return username;
  } catch (error) {
    console.warn("Resolve participant-link bot username failed", error);
    return null;
  }
}

/**
 * Loads a published survey plus its flow, or the exact error response.
 *
 * The survey is read once and passed down instead of being re-fetched by each
 * step, which is what keeps `/responses` and `/submit` to a single survey read.
 */
export async function loadPublishedSurvey(
  env: Env,
  surveyId: number,
): Promise<
  | { survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>; flow: Awaited<ReturnType<typeof getSurveyFlow>> }
  | Response
> {
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  const flow = await getSurveyFlow(env.DB, surveyId);
  return { survey, flow };
}
