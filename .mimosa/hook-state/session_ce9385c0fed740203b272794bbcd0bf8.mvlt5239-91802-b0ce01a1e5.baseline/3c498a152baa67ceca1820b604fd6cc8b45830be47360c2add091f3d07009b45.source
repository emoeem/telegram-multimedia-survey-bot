/**
 * Stateless participant identity for the Web Survey: when a Telegram user
 * taps a survey button, the bot mints a signed token and appends it to the
 * link. The survey page sends it back so the response is attributed to the
 * real Telegram user, without forcing anyone to open Telegram WebView.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SURVEY_PARTICIPANT_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const SURVEY_PARTICIPANT_TOKEN_PARAM = "pt";

/**
 * Token payload version. Tokens are stateless HMACs — there is no way to
 * revoke one individually — so bumping this constant is the revocation
 * mechanism: on deploy every outstanding token (stored in old builds'
 * localStorage, pasted in chat history, forwarded to a friend) fails
 * verification and the holder falls back to anonymous or re-opens a fresh
 * bot link. v1 → v2: the frontend used to persist these tokens in
 * localStorage forever, so leaked links kept answering as their minter for
 * the full TTL.
 */
export const SURVEY_PARTICIPANT_TOKEN_VERSION = 2;

interface ParticipantPayload {
  u: number;
  exp: number;
  p: "participant";
  /** Payload version; verify rejects anything but the current constant. */
  v: number;
  /** Optional Telegram profile snapshot (username / names / language). */
  n?: { u?: string; f?: string; l?: string; c?: string };
}

export interface SurveyParticipantProfile {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifySignature(secret: string, payload: string, signature: string): Promise<boolean> {
  const key = await hmacKey(secret);
  const decoded = base64UrlDecode(signature);
  if (!decoded) return false;
  const signatureBytes = decoded.buffer.slice(
    decoded.byteOffset,
    decoded.byteOffset + decoded.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
}

export async function createSurveyParticipantToken(
  secret: string,
  telegramUserId: number,
  profile?: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    languageCode?: string | null;
  },
): Promise<string> {
  const n: ParticipantPayload["n"] = {};
  if (profile?.username) n.u = profile.username;
  if (profile?.firstName) n.f = profile.firstName;
  if (profile?.lastName) n.l = profile.lastName;
  if (profile?.languageCode) n.c = profile.languageCode;
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        u: telegramUserId,
        exp: Math.floor(Date.now() / 1000) + SURVEY_PARTICIPANT_TOKEN_TTL_SECONDS,
        p: "participant",
        v: SURVEY_PARTICIPANT_TOKEN_VERSION,
        ...(Object.keys(n).length ? { n } : {}),
      } satisfies ParticipantPayload),
    ),
  );
  const signature = await sign(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifySurveyParticipantToken(
  secret: string,
  token: string,
): Promise<SurveyParticipantProfile | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadPart = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!(await verifySignature(secret, payloadPart, signature))) return null;
  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as ParticipantPayload;
    if (parsed.p !== "participant" || typeof parsed.u !== "number" || typeof parsed.exp !== "number") {
      return null;
    }
    // v1 tokens (no `v` field) fail this check — that is the revocation.
    if (parsed.v !== SURVEY_PARTICIPANT_TOKEN_VERSION) return null;
    if (parsed.exp * 1000 <= Date.now()) return null;
    return {
      telegramUserId: parsed.u,
      username: parsed.n?.u ?? null,
      firstName: parsed.n?.f ?? null,
      lastName: parsed.n?.l ?? null,
      languageCode: parsed.n?.c ?? null,
    };
  } catch {
    return null;
  }
}
