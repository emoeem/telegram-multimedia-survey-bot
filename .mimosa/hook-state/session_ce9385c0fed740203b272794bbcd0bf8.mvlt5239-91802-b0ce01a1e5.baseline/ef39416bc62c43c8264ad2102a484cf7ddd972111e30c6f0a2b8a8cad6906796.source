export const REPORT_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function importReportTokenKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function signWithKey(key: CryptoKey, responseId: number, expiresAt: number): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${responseId}:${expiresAt}`)),
  );
  return hex(digest);
}

/**
 * Stateless signed report URL: /report/{id}?t={expiresAt}.{hmac}. The token
 * proves the holder may view one completed response without requiring
 * Telegram initData or a participant header (needed for <a>/<img> navigation
 * in notifications and WebViews).
 */
export async function createReportAccessToken(
  secret: string,
  responseId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = REPORT_TOKEN_MAX_AGE_SECONDS,
): Promise<string> {
  const expiresAt = nowSeconds + maxAgeSeconds;
  const signature = await signWithKey(await importReportTokenKey(secret), responseId, expiresAt);
  return `${expiresAt}.${signature}`;
}

/**
 * Mints tokens for many responses with **one** key import.
 *
 * `crypto.subtle.importKey` dominates the cost of a single token: minting 50
 * one-by-one measured ~9.6ms of CPU, which sits right at the Workers free
 * plan's 10ms per-request CPU limit — a participant with a long report list
 * opening 「我的」 could push the request over it. Importing the key once and
 * reusing it brings the same 50 tokens down to ~1ms.
 */
export async function createReportAccessTokens(
  secret: string,
  responseIds: readonly number[],
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = REPORT_TOKEN_MAX_AGE_SECONDS,
): Promise<Map<number, string>> {
  const tokens = new Map<number, string>();
  if (responseIds.length === 0) return tokens;
  const expiresAt = nowSeconds + maxAgeSeconds;
  const key = await importReportTokenKey(secret);
  const signed = await Promise.all(
    responseIds.map(async (responseId) => `${expiresAt}.${await signWithKey(key, responseId, expiresAt)}`),
  );
  responseIds.forEach((responseId, index) => {
    tokens.set(responseId, signed[index]!);
  });
  return tokens;
}

export async function verifyReportAccessToken(
  secret: string,
  responseId: number,
  token: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return false;
  const expected = `${expiresAt}.${await signWithKey(await importReportTokenKey(secret), responseId, expiresAt)}`;
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ token.charCodeAt(index);
  }
  return diff === 0;
}
