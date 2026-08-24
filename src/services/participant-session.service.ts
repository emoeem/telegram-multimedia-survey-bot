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

interface ParticipantPayload {
  u: number;
  exp: number;
  p: "participant";
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
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

async function verifySignature(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
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
): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        u: telegramUserId,
        exp: Math.floor(Date.now() / 1000) + SURVEY_PARTICIPANT_TOKEN_TTL_SECONDS,
        p: "participant",
      } satisfies ParticipantPayload),
    ),
  );
  const signature = await sign(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifySurveyParticipantToken(
  secret: string,
  token: string,
): Promise<number | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadPart = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!(await verifySignature(secret, payloadPart, signature))) return null;
  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as ParticipantPayload;
    if (
      parsed.p !== "participant" ||
      typeof parsed.u !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp * 1000 <= Date.now()) return null;
    return parsed.u;
  } catch {
    return null;
  }
}
