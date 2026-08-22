export const REPORT_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
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
  const signature = await signReportToken(secret, responseId, expiresAt);
  return `${expiresAt}.${signature}`;
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
  const expected = await signReportToken(secret, responseId, expiresAt);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}

async function signReportToken(
  secret: string,
  responseId: number,
  expiresAt: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${responseId}:${expiresAt}`),
    ),
  );
  return hex(digest);
}
