import type { Env } from "../../index";
import { getBotUsername } from "../../bot/telegram";
import {
  getSurveyById,
  getSurveyByIdStatement,
  mapSurveyStatementResult,
} from "../../db/repositories/survey.repository";
import {
  listOptionsForSurveyStatement,
  listQuestionsBySurveyStatement,
  mapOptionRows,
  mapQuestionRows,
} from "../../db/repositories/question.repository";
import type { getSurveyFlow } from "../../services/question.service";
import { buildSurveyFlow, type SurveyFlow } from "../../survey/engine";
import { normalizeStoredSurveyTheme } from "../../survey/theme";
import { fail } from "../api-response";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { mediaPublicUrl, parseSettings } from "./presentation";
import { resolveListCoinPrices } from "../../services/coin/unlock.service";

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
 *
 * The version is part of the key and must be bumped whenever the projection
 * changes (v3 added the coin-unlock/price fields, v4 added `contentRating`),
 * or a rollout serves entries built by the previous Worker version.
 */
export const SURVEY_LIST_CACHE_VERSION = "v4";
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
 *
 * The key covers the DATA version but not the PROJECTION version, so it must be
 * bumped by hand whenever the shape of the cached payload changes (a new field
 * in the theme, a new media kind, ...). Otherwise a request handled by the
 * previous Worker version during a rollout can cache a payload that was built
 * from the new row with the old projection: the new code then reads that
 * enriched-free entry back and serves a theme missing the new fields until the
 * TTL expires. That happened once, for `theme.sprite` / `theme.audio.sfx`
 * (survey 118), which is why this constant is now "v2".
 */
export const SURVEY_DEFINITION_CACHE_VERSION = "v2";
export const SURVEY_DEFINITION_CACHE_TTL_SECONDS = 60 * 60;

/**
 * The published *flow* (questions + options as the engine consumes them) is
 * visitor-independent and immutable per survey version, exactly like the
 * definition projection above — but unlike the definition it is read on every
 * answer save: the /responses batch pulls the whole question list each time a
 * respondent clicks "next". For a 70-question story survey that is hundreds of
 * D1 rows burned per click.
 *
 * The key carries only the survey id and the version stamp lives *inside* the
 * payload. A request fires this read in parallel with its own D1 batch and
 * then validates the payload against the survey row it just read (the row is
 * always fresh, so the comparison is authoritative): match → the KV flow is
 * used; mismatch (first request after an edit) or miss → the database is read
 * once and the fresh stamp is written back, so later requests hit again. The
 * earlier design put the stamp in the key, which forced the KV read to happen
 * *after* the row was read — one extra sequential hop on the answer path
 * (measured ~100ms from the Hong Kong edge).
 *
 * Safety rests on the same assumption as the definition cache: every mutating
 * path touches `version` or `updated_at` (question/option/page edits call
 * `touchSurvey`, publish/close/archive bump `version`), and a stamp mismatch is
 * detected on the very next request — so a path that forgets the touch degrades
 * to that path's own staleness, not to an indefinitely stale flow.
 */
export const SURVEY_FLOW_CACHE_VERSION = "v2";
export const SURVEY_FLOW_CACHE_TTL_SECONDS = 60 * 60;

/** Payload of the flow cache: the flow plus the stamp it was built from. */
interface CachedSurveyFlow {
  version: number;
  updatedAt: string;
  flow: SurveyFlow;
}

/** The KV key for a survey's cached flow (id only; the stamp is validated from the payload). */
export function publishedFlowCacheKey(surveyId: number): string {
  return `published-flow:${SURVEY_FLOW_CACHE_VERSION}:${surveyId}`;
}

/**
 * Starts the flow-cache read without awaiting it. Callers run the returned
 * promise in parallel with their own D1 work and hand it to
 * {@link resolvePublishedFlow} once the survey row is in hand.
 */
export function beginPublishedFlowRead(env: Env, surveyId: number): Promise<CachedSurveyFlow | null> {
  return readCachedJson<CachedSurveyFlow>(env.CACHE, publishedFlowCacheKey(surveyId));
}

/**
 * The flow of a published survey: the (already running) cache read when its
 * stamp matches the freshly-read row, otherwise a database read followed by a
 * cache write.
 */
export async function resolvePublishedFlow(
  env: Env,
  survey: { id: number; version: number; updatedAt: string },
  cacheRead: Promise<CachedSurveyFlow | null>,
): Promise<SurveyFlow> {
  const cached = await cacheRead;
  if (cached && cached.version === survey.version && cached.updatedAt === survey.updatedAt) {
    return cached.flow;
  }
  const [questionsResult, optionsResult] = await env.DB.batch([
    listQuestionsBySurveyStatement(env.DB, survey.id),
    listOptionsForSurveyStatement(env.DB, survey.id),
  ]);
  const flow = buildSurveyFlow(mapQuestionRows(questionsResult), mapOptionRows(optionsResult));
  const payload: CachedSurveyFlow = { version: survey.version, updatedAt: survey.updatedAt, flow };
  await writeCachedJson(env.CACHE, publishedFlowCacheKey(survey.id), payload, SURVEY_FLOW_CACHE_TTL_SECONDS);
  return flow;
}

export const PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY = "participant-link-bot-username";

export interface PublishedSurveyListItem {
  id: number;
  title: string;
  description?: string;
  /** 内容分级（0080）：列表缓存始终含全量条目，r18 的服务侧过滤在 handler。 */
  contentRating: "all" | "r18";
  accessCodeRequired: boolean;
  /**
   * 金币解锁信息（仅作者启用了金币解锁的问卷才有）。列表页据此显示
   * 「🪙 N 金币解锁」，并把按钮改成「解锁填写」，避免用户点进去才发现要付费。
   */
  coinUnlock?: { price: number };
  publishedAt: string | null;
  closedAt: string | null;
  anonymous: boolean;
  questionCount: number;
  responseCount: number;
  coverUrl?: string;
  theme: unknown;
}

export async function loadPublishedSurveyListStamp(db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS updatedAt
         FROM surveys
        WHERE status = 'published' AND deleted_at IS NULL`,
    )
    .first<{ total: number; updatedAt: string }>();
  return `${Number(row?.total ?? 0)}:${row?.updatedAt ?? ""}`;
}

export async function loadPublishedSurveyList(env: Env, q: string): Promise<PublishedSurveyListItem[]> {
  const conditions = ["s.status = 'published'", "s.deleted_at IS NULL"];
  const binds: string[] = [];
  if (q) {
    conditions.push("(lower(s.title) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)");
    binds.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  const rows = await env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.access_code accessCode,
              s.published_at publishedAt, s.closed_at closedAt, s.anonymous anonymous,
              s.content_rating contentRating,
              s.settings_json settingsJson,
              m.id coverMediaId, m.url coverUrl,
              (SELECT COUNT(*) FROM survey_questions q
               WHERE q.survey_id = s.id) questionCount,
              (SELECT COUNT(*) FROM survey_responses r
               WHERE r.survey_id = s.id AND r.status = 'completed') responseCount
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
      contentRating: string | null;
      publishedAt: string | null;
      closedAt: string | null;
      anonymous: number;
      questionCount: number;
      responseCount: number;
      settingsJson: string | null;
      coverMediaId: number | null;
      coverUrl: string | null;
    }>();
  const items = (rows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    accessCodeRequired: Boolean(row.accessCode),
    contentRating: row.contentRating === "r18" ? ("r18" as const) : ("all" as const),
    publishedAt: row.publishedAt,
    closedAt: row.closedAt,
    anonymous: Boolean(row.anonymous),
    questionCount: Number(row.questionCount ?? 0),
    responseCount: Number(row.responseCount ?? 0),
    // Always serve the cover through the media endpoint so KV/R2/data-URL
    // covers share one path and the public list stays small.
    ...(typeof row.coverMediaId === "number" ? { coverUrl: mediaPublicUrl(Number(row.coverMediaId)) } : {}),
    theme: normalizeStoredSurveyTheme(parseSettings(row.settingsJson)),
  }));
  // 金币解锁信息：没有问卷启用时这里零额外查询（免费问卷的列表行为不变）。
  const prices = await resolveListCoinPrices(
    env.DB,
    items.map((item) => item.id),
  );
  if (prices.size === 0) return items;
  return items.map((item) => {
    const price = prices.get(item.id);
    return price === undefined ? item : { ...item, coinUnlock: { price } };
  });
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
 * The reads {@link loadPublishedSurvey} performs, as a statement group.
 *
 * Exposed separately so a caller that needs more reads for the same request can
 * append them and still pay a single D1 round trip.
 */
export function publishedSurveyStatements(db: D1Database, surveyId: number): D1PreparedStatement[] {
  return [
    getSurveyByIdStatement(db, surveyId),
    listQuestionsBySurveyStatement(db, surveyId),
    listOptionsForSurveyStatement(db, surveyId),
  ];
}

/** Turns the three results of {@link publishedSurveyStatements} into a loader result. */
export function readPublishedSurveyResults(
  results: D1Result<unknown>[],
): { survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>; flow: SurveyFlow } | Response {
  const survey = mapSurveyStatementResult(results[0]);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  return { survey, flow: buildSurveyFlow(mapQuestionRows(results[1]), mapOptionRows(results[2])) };
}

/**
 * Loads a published survey plus its flow, or the exact error response.
 *
 * The survey row, its questions and its options arrive as one `db.batch()`:
 * the statements are independent, and sending them separately costs one round
 * trip to the database's region each (~90ms a piece from the Hong Kong edge).
 * Every write path on the survey API goes through here — start, answer, submit,
 * media upload — so this is the cheapest way to keep a request to a single read
 * round trip.
 */
export async function loadPublishedSurvey(
  env: Env,
  surveyId: number,
): Promise<
  | { survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>; flow: Awaited<ReturnType<typeof getSurveyFlow>> }
  | Response
> {
  const results = await env.DB.batch(publishedSurveyStatements(env.DB, surveyId));
  return readPublishedSurveyResults(results);
}

/**
 * The published survey with its flow, where the flow comes from the parallel
 * edge KV read when its stamp matches the freshly-read survey row
 * (see {@link beginPublishedFlowRead}). {@link surveyResult} is the already-read
 * survey row (statement index 0 of {@link publishedSurveyStatements}).
 *
 * Convenience wrapper for callers whose flow use is deferred (submit, media
 * upload): it fires the cache read immediately, so it still overlaps with the
 * caller's own awaited D1 work where possible.
 */
export async function readPublishedSurveyWithCachedFlow(
  env: Env,
  surveyId: number,
  surveyResult: D1Result<unknown> | undefined,
): Promise<{
  survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>;
  flow: Awaited<ReturnType<typeof getSurveyFlow>>;
} | Response> {
  const cacheRead = beginPublishedFlowRead(env, surveyId);
  const survey = mapSurveyStatementResult(surveyResult);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  return { survey, flow: await resolvePublishedFlow(env, survey, cacheRead) };
}
