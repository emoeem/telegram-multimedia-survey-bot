import { safeRemove, safeSessionGet, safeSessionRemove, safeSessionSet } from "./storage";
// Value import (same pattern as SurveyApp → src/survey/theme): the service is
// plain WebCrypto + JSON, safe to bundle client-side, and sharing the constant
// keeps the client-side pre-check in lockstep with the server's revocation.
import { SURVEY_PARTICIPANT_TOKEN_VERSION } from "../../../src/services/participant-session.service";

/**
 * The bot's buttons append `pt=<signed token>` to survey links — a 30-day
 * Telegram identity minted by the server (participant-session.service).
 *
 * The token is a bearer credential, so it must stay session-scoped. The old
 * implementation wrote it to localStorage and reused it forever: one forwarded
 * or copied link then turned every later visitor of that browser into the
 * token's owner, and each of them resumed — and answered into — the same
 * in-progress response. Now the token lives in memory + sessionStorage: a
 * mid-survey reload in the same tab keeps the identity (resume keeps working),
 * closing the tab drops it, and once captured the parameter is stripped from
 * the address bar so a URL copied for sharing carries no identity at all.
 */

const TOKEN_PARAM = "pt";
/**
 * Legacy key the old build persisted the token under (localStorage). Only used
 * for the one-time migration wipe; nothing reads or writes it anymore.
 */
const LEGACY_PERSISTENT_KEY = "webSurveyParticipantToken";
/** Session-scope storage key. Same name as the legacy key, different area. */
const SESSION_KEY = "webSurveyParticipantToken";

/**
 * Just the browser surface this module touches, resolved off `globalThis` so
 * the file typechecks under the root tsconfig too (WebWorker lib has no
 * `window`), and so unit tests can stub it. Null outside a browser.
 */
interface BrowserContext {
  location: { search: string; href: string };
  history: {
    state?: unknown;
    replaceState(state: unknown, title: string, url: string): void;
  };
}

function browserContext(): BrowserContext | null {
  const scope = globalThis as unknown as { window?: Partial<BrowserContext> | undefined };
  const location = scope.window?.location;
  const history = scope.window?.history;
  if (!location || !history?.replaceState) return null;
  return { location, history };
}

/** Only the fields the client acts on (server re-verifies signature+exp+version). */
interface ParticipantTokenPayload {
  u?: number;
  exp?: number;
  v?: number;
  n?: { u?: string; f?: string; l?: string };
}

/** Who this tab answers as via a captured pt link (display only). */
export interface SessionParticipantIdentity {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
}

let sessionToken: string | null = null;
let captured = false;

/** Decodes the token's payload JSON (UTF-8 — profile snapshots carry CJK names). */
function decodePayload(token: string): ParticipantTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const base64 = token.slice(0, dot).replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as ParticipantTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Client-side pre-check so an expired or revoked-version token is never sent:
 * the server would 401 every request with "登录状态已失效" — degrading to the
 * anonymous key (and the registration wall) is the recoverable outcome. The
 * server remains authoritative; this only avoids shipping a token known to be
 * dead (v1 payloads fail the version check — that is how a version bump shows
 * up client-side as immediate fallback instead of a wall of 401s).
 */
function isTokenLive(token: string): boolean {
  const payload = decodePayload(token);
  return (
    payload !== null &&
    typeof payload.exp === "number" &&
    payload.exp * 1000 > Date.now() &&
    payload.v === SURVEY_PARTICIPANT_TOKEN_VERSION
  );
}

/** Runs at most once per page load, on the first identityHeaders() call. */
function capture(browser: BrowserContext): void {
  if (captured) return;
  captured = true;
  // Migration: pre-fix deployments persisted the token in localStorage, which
  // is exactly the cross-person contamination this module removes.
  safeRemove(LEGACY_PERSISTENT_KEY);
  const fromUrl = new URLSearchParams(browser.location.search).get(TOKEN_PARAM);
  if (fromUrl) {
    sessionToken = isTokenLive(fromUrl) ? fromUrl : null;
    if (sessionToken) safeSessionSet(SESSION_KEY, sessionToken);
    else safeSessionRemove(SESSION_KEY);
    // Strip before anything can copy or share the URL. history.state is passed
    // through so client-side routing state (React Router) survives untouched.
    try {
      const url = new URL(browser.location.href);
      url.searchParams.delete(TOKEN_PARAM);
      browser.history.replaceState(browser.history.state, "", url.toString());
    } catch {
      /* history unavailable in rare WebViews — identity is already in session
       * storage, answering is unaffected */
    }
    return;
  }
  // Same-tab reload: the URL no longer carries the parameter, but the tab's
  // session storage still does.
  const stored = safeSessionGet(SESSION_KEY);
  sessionToken = stored && isTokenLive(stored) ? stored : null;
}

/**
 * The participant token for this page session, or null when the page was
 * opened without one, the token expired, or the tab was restarted.
 */
export function sessionParticipantToken(): string | null {
  const browser = browserContext();
  if (!browser) return null;
  capture(browser);
  return sessionToken;
}

/**
 * Display identity for the "who will this answer be filed under" notice: the
 * profile snapshot carried by the session's token, or null when answering
 * anonymously (no token, expired, or stripped). Never a trust decision — the
 * server re-verifies everything.
 */
export function sessionParticipantIdentity(): SessionParticipantIdentity | null {
  const token = sessionParticipantToken();
  if (!token) return null;
  const payload = decodePayload(token);
  if (!payload || typeof payload.u !== "number") return null;
  return {
    telegramUserId: payload.u,
    username: payload.n?.u ?? null,
    firstName: payload.n?.f ?? null,
  };
}

/**
 * Opt out of the captured link identity for this tab: drop the session token
 * so every later request falls back to the browser's own anonymous key. The
 * address bar is already pt-free (capture strips it), so a reload cannot
 * re-capture the identity.
 */
export function abandonSessionParticipantToken(): void {
  sessionToken = null;
  safeSessionRemove(SESSION_KEY);
}
