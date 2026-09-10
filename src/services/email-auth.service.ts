/**
 * Email account credentials: PBKDF2 password hashing, 6-digit verification
 * codes (KV-backed, hashed at rest) and HMAC session tokens. Workers-native
 * via WebCrypto; no external auth dependency.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const EMAIL_SESSION_TTL_SECONDS = 30 * 24 * 3600;
const PBKDF2_ITERATIONS = 100_000;
const CODE_TTL_SECONDS = 600;
const CODE_MAX_ATTEMPTS = 5;

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

export function isValidPassword(value: string): boolean {
  return value.length >= 8 && value.length <= 128;
}

/* ---------------------------- passwords ---------------------------- */

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64(salt)}:${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = fromBase64(parts[2] ?? "");
  const expected = fromBase64(parts[3] ?? "");
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index += 1) diff |= actual[index]! ^ expected[index]!;
  return diff === 0;
}

/* ---------------------------- codes ---------------------------- */

export interface EmailCodeStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export async function issueEmailCode(
  store: EmailCodeStore,
  email: string,
  purpose: "register" | "reset",
): Promise<string> {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  await store.put(`email-code:${purpose}:${email.toLowerCase()}`, `${toBase64(new Uint8Array(digest))}:0`, {
    expirationTtl: CODE_TTL_SECONDS,
  });
  return code;
}

export async function verifyEmailCode(
  store: EmailCodeStore,
  email: string,
  purpose: "register" | "reset",
  code: string,
): Promise<boolean> {
  const key = `email-code:${purpose}:${email.toLowerCase()}`;
  const stored = await store.get(key);
  if (!stored) return false;
  const [hashB64, attemptsRaw] = stored.split(":");
  const attempts = Number(attemptsRaw ?? "0");
  if (!Number.isInteger(attempts) || attempts >= CODE_MAX_ATTEMPTS) {
    await store.delete(key);
    return false;
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  if (toBase64(new Uint8Array(digest)) !== hashB64) {
    await store.put(key, `${hashB64}:${attempts + 1}`, { expirationTtl: CODE_TTL_SECONDS });
    return false;
  }
  await store.delete(key);
  return true;
}

/* ---------------------------- sessions ---------------------------- */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    return fromBase64(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes as BufferSource)
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

/** Mints `payload.signature`; the DB stores only the SHA-256 of the token. */
export async function createEmailSessionToken(secret: string, accountId: number): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ a: accountId, exp: Math.floor(Date.now() / 1000) + EMAIL_SESSION_TTL_SECONDS, p: "email" }),
    ),
  );
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyEmailSessionToken(secret: string, token: string): Promise<{ accountId: number } | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadPart = token.slice(0, dot);
  const signature = base64UrlDecode(token.slice(dot + 1));
  if (!signature) return null;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, encoder.encode(payloadPart));
  if (!valid) return null;
  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as { a?: unknown; exp?: unknown; p?: unknown };
    if (parsed.p !== "email" || typeof parsed.a !== "number" || typeof parsed.exp !== "number") return null;
    if (parsed.exp * 1000 <= Date.now()) return null;
    return { accountId: parsed.a };
  } catch {
    return null;
  }
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(encoder.encode(token));
}
