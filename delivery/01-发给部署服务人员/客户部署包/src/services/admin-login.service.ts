const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ADMIN_LOGIN_REQUEST_TTL_SECONDS = 5 * 60;
export const ADMIN_LOGIN_COOKIE = "admin_login_request";
export const ADMIN_LOGIN_RATE_LIMIT = 5;
export const ADMIN_LOGIN_RATE_WINDOW_SECONDS = 300;
const REQUEST_PREFIX = "admin-login-request:";

interface LoginRequest {
  status: "pending" | "approved" | "cancelled" | "completed";
  createdAt: number;
  userId?: number;
  approvedAt?: number;
}
interface CookiePayload {
  id: string;
  exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  const secretBytes = encoder.encode(secret);
  return crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function sign(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}
async function verify(secret: string, value: string, signature: string): Promise<boolean> {
  const decoded = base64UrlDecode(signature);
  if (!decoded) return false;
  const signatureBytes = decoded.buffer.slice(
    decoded.byteOffset,
    decoded.byteOffset + decoded.byteLength,
  ) as ArrayBuffer;
  const valueBytes = encoder.encode(value);
  const valueBuffer = valueBytes.buffer.slice(
    valueBytes.byteOffset,
    valueBytes.byteOffset + valueBytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, valueBuffer);
}
function randomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createAdminLoginRequest(
  cache: KVNamespace,
  secret: string,
): Promise<{ id: string; cookie: string }> {
  const id = randomId();
  const exp = Math.floor(Date.now() / 1000) + ADMIN_LOGIN_REQUEST_TTL_SECONDS;
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ id, exp } satisfies CookiePayload)));
  const signature = await sign(secret, payload);
  await cache.put(
    REQUEST_PREFIX + id,
    JSON.stringify({ status: "pending", createdAt: Date.now() } satisfies LoginRequest),
    { expirationTtl: ADMIN_LOGIN_REQUEST_TTL_SECONDS },
  );
  return {
    id,
    cookie: `${ADMIN_LOGIN_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${ADMIN_LOGIN_REQUEST_TTL_SECONDS}`,
  };
}
export async function verifyAdminLoginCookie(secret: string, value: string): Promise<string | null> {
  const dot = value.indexOf(".");
  if (dot <= 0 || !(await verify(secret, value.slice(0, dot), value.slice(dot + 1)))) return null;
  const bytes = base64UrlDecode(value.slice(0, dot));
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as CookiePayload;
    return parsed.id && typeof parsed.exp === "number" && parsed.exp * 1000 > Date.now() ? parsed.id : null;
  } catch {
    return null;
  }
}
export async function getAdminLoginRequest(cache: KVNamespace, id: string): Promise<LoginRequest | null> {
  const value = await cache.get(REQUEST_PREFIX + id);
  if (!value) return null;
  try {
    return JSON.parse(value) as LoginRequest;
  } catch {
    return null;
  }
}
export async function approveAdminLoginRequest(cache: KVNamespace, id: string, userId: number): Promise<boolean> {
  const current = await getAdminLoginRequest(cache, id);
  if (!current || current.status !== "pending") return false;
  await cache.put(
    REQUEST_PREFIX + id,
    JSON.stringify({ ...current, status: "approved", userId, approvedAt: Date.now() } satisfies LoginRequest),
    { expirationTtl: ADMIN_LOGIN_REQUEST_TTL_SECONDS },
  );
  return true;
}
export async function cancelAdminLoginRequest(cache: KVNamespace, id: string): Promise<boolean> {
  const current = await getAdminLoginRequest(cache, id);
  if (!current || current.status !== "pending") return false;
  await cache.put(REQUEST_PREFIX + id, JSON.stringify({ ...current, status: "cancelled" } satisfies LoginRequest), {
    expirationTtl: ADMIN_LOGIN_REQUEST_TTL_SECONDS,
  });
  return true;
}
export async function consumeAdminLoginRequest(
  db: D1Database,
  cache: KVNamespace,
  id: string,
  userId: number,
): Promise<boolean> {
  const current = await getAdminLoginRequest(cache, id);
  if (!current || current.status !== "approved" || current.userId !== userId) return false;

  // KV has no compare-and-swap primitive. The unique D1 row is the atomic
  // redemption gate: concurrent status polls can observe `approved`, but only
  // one INSERT can win and receive an admin session.
  const result = await db
    .prepare(
      `INSERT INTO admin_login_consumptions (login_request_id, telegram_user_id, consumed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(login_request_id) DO NOTHING`,
    )
    .bind(id, userId, new Date().toISOString())
    .run();
  if ((result.meta?.changes ?? 0) !== 1) return false;

  await cache.put(REQUEST_PREFIX + id, JSON.stringify({ ...current, status: "completed" } satisfies LoginRequest), {
    expirationTtl: 30,
  });
  return true;
}
