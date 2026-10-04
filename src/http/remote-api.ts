import { listAnswersByResponseId } from "../db/repositories/response.repository";
import { listAllSurveys } from "../db/repositories/survey.repository";
import { verifyRemoteAccessToken } from "../services/remote-access-token.service";

/**
 * Read-only data surface for the vendor console.
 *
 * The vendor's admin SPA runs in a browser, which — unlike a Worker — can reach
 * this instance even when it shares the center's Cloudflare account (a
 * Worker-to-Worker call over `*.workers.dev` fails with error 1042). So the
 * browser calls this endpoint directly with a short-lived token the center
 * minted, and the center never touches the customer's data.
 *
 * Everything here is SELECT-only and returns an explicitly chosen column set,
 * so adding a column elsewhere can never silently widen what leaves the
 * instance.
 */
export interface RemoteApiEnv {
  DB: D1Database;
  INSTALLATION_ID?: string;
  /** Shared with the center; signs the short-lived read tokens. */
  REMOTE_ACCESS_SECRET?: string;
  /** The center's own origin, the only one allowed by CORS. */
  LICENSE_SERVER_URL?: string;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function centerOrigin(env: RemoteApiEnv): string {
  try {
    return new URL(env.LICENSE_SERVER_URL ?? "").origin;
  } catch {
    return "";
  }
}

function corsHeaders(request: Request, env: RemoteApiEnv): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = centerOrigin(env);
  // Never fall back to `*`: this endpoint exposes customer data.
  if (!allowed || origin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function pageParams(url: URL): { limit: number; offset: number } {
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), 100_000) : 0;
  return { limit, offset };
}

async function verifyRequest(request: Request, env: RemoteApiEnv): Promise<boolean> {
  const secret = env.REMOTE_ACCESS_SECRET?.trim();
  const installationId = env.INSTALLATION_ID?.trim();
  if (!secret || !installationId) return false;
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return false;
  const claims = await verifyRemoteAccessToken(secret, token, installationId);
  return claims !== null;
}

export async function handleRemoteApiRequest(request: Request, env: RemoteApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/remote/")) return null;
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    // Answer the preflight before auth: the browser cannot attach the bearer
    // token to a preflight request.
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET") return json({ ok: false, error: "read_only" }, 405, cors);

  if (!(await verifyRequest(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }

  const { limit, offset } = pageParams(url);

  if (url.pathname === "/api/remote/summary") {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM surveys) AS surveys,
         (SELECT COUNT(*) FROM survey_responses) AS responses,
         (SELECT COUNT(*) FROM survey_responses WHERE status = 'completed') AS completed,
         (SELECT COUNT(*) FROM users) AS users`,
    ).first<{ surveys: number; responses: number; completed: number; users: number }>();
    return json({ ok: true, summary: row ?? { surveys: 0, responses: 0, completed: 0, users: 0 } }, 200, cors);
  }

  if (url.pathname === "/api/remote/surveys") {
    const surveys = await listAllSurveys(env.DB);
    const items = surveys.slice(offset, offset + limit).map((survey) => ({
      id: survey.id,
      title: survey.title,
      description: survey.description,
      status: survey.status,
      ownerId: survey.ownerId,
      createdAt: survey.createdAt,
      updatedAt: survey.updatedAt,
    }));
    return json({ ok: true, items, total: surveys.length, limit, offset }, 200, cors);
  }

  if (url.pathname === "/api/remote/responses") {
    const surveyId = Number(url.searchParams.get("surveyId") ?? "");
    const status = url.searchParams.get("status") ?? "";
    const filters: string[] = [];
    const bindings: unknown[] = [];
    if (Number.isInteger(surveyId) && surveyId > 0) {
      filters.push("r.survey_id = ?");
      bindings.push(surveyId);
    }
    if (["in_progress", "completed", "archived", "cancelled"].includes(status)) {
      filters.push("r.status = ?");
      bindings.push(status);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM survey_responses r ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();
    const rows = await env.DB.prepare(
      `SELECT r.id, r.survey_id surveyId, r.user_id userId, r.status, r.created_at createdAt,
              r.completed_at completedAt, s.title surveyTitle, u.username, u.first_name firstName
       FROM survey_responses r
       LEFT JOIN surveys s ON s.id = r.survey_id
       LEFT JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<Record<string, unknown>>();
    return json({ ok: true, items: rows.results ?? [], total: total?.total ?? 0, limit, offset }, 200, cors);
  }

  const responseMatch = url.pathname.match(/^\/api\/remote\/responses\/(\d+)$/);
  if (responseMatch) {
    const responseId = Number(responseMatch[1]);
    const response = await env.DB.prepare(
      `SELECT r.id, r.survey_id surveyId, r.user_id userId, r.status, r.created_at createdAt,
              r.completed_at completedAt, s.title surveyTitle
       FROM survey_responses r LEFT JOIN surveys s ON s.id = r.survey_id WHERE r.id = ?`,
    )
      .bind(responseId)
      .first<Record<string, unknown>>();
    if (!response) return json({ ok: false, error: "not_found" }, 404, cors);
    const answers = await listAnswersByResponseId(env.DB, responseId);
    return json({ ok: true, response, answers }, 200, cors);
  }

  if (url.pathname === "/api/remote/users") {
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 64);
    const where = search ? "WHERE username LIKE ? OR first_name LIKE ? OR CAST(telegram_user_id AS TEXT) LIKE ?" : "";
    const like = `%${search}%`;
    const bindings = search ? [like, like, like] : [];
    const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM users ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();
    const rows = await env.DB.prepare(
      `SELECT id, telegram_user_id telegramUserId, username, first_name firstName, last_name lastName,
              system_role systemRole, created_at createdAt, bot_started_at botStartedAt,
              CASE WHEN banned_at IS NULL THEN 0 ELSE 1 END banned
       FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<Record<string, unknown>>();
    return json({ ok: true, items: rows.results ?? [], total: total?.total ?? 0, limit, offset }, 200, cors);
  }

  return json({ ok: false, error: "not_found" }, 404, cors);
}
