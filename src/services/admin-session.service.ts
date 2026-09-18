/**
 * Stateless browser-login for the Web Admin: an admin asks the Telegram bot
 * for a short-lived login link, the link mints a signed 7-day session cookie
 * (HMAC over the webhook secret). No database or KV state required.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const ADMIN_SESSION_COOKIE = "admin_session";

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

interface SessionPayload {
  u: number;
  exp: number;
  p: "login" | "session";
}

async function issueToken(
  secret: string,
  userId: number,
  ttlSeconds: number,
  purpose: SessionPayload["p"],
): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        u: userId,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        p: purpose,
        // Keep independently issued login links unique even when Telegram
        // generates two links for the same user within the same second.
        // Without a nonce the signed payload was deterministic, so the
        // one-time-use KV guard treated a freshly generated link as the old
        // link that had already been consumed.
        jti: crypto.randomUUID(),
      }),
    ),
  );
  const signature = await sign(secret, payload);
  return `${payload}.${signature}`;
}

async function verifyToken(secret: string, token: string, purpose: SessionPayload["p"]): Promise<number | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadPart = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!(await verifySignature(secret, payloadPart, signature))) return null;
  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as SessionPayload;
    if (parsed.p !== purpose || typeof parsed.u !== "number" || typeof parsed.exp !== "number") {
      return null;
    }
    if (parsed.exp * 1000 <= Date.now()) return null;
    return parsed.u;
  } catch {
    return null;
  }
}

export async function createAdminSessionValue(secret: string, userId: number): Promise<string> {
  return issueToken(secret, userId, ADMIN_SESSION_TTL_SECONDS, "session");
}

export async function verifyAdminSessionValue(secret: string, value: string): Promise<number | null> {
  return verifyToken(secret, value, "session");
}
