export const SURVEY_ACCESS_GRANT_TTL_SECONDS = 10 * 60;

/**
 * Short-lived, survey-bound access grant minted by `POST /api/survey/:id/access`
 * after the access code is verified. The grant — not the raw code — is what the
 * client sends back to fetch the full definition, so the code never travels in
 * a URL or a log and expires quickly.
 */

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return hex(digest);
}

export async function createSurveyAccessGrant(
  secret: string,
  surveyId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = SURVEY_ACCESS_GRANT_TTL_SECONDS,
): Promise<string> {
  const expiresAt = nowSeconds + maxAgeSeconds;
  const signature = await sign(secret, `survey-access:${surveyId}:${expiresAt}`);
  return `${expiresAt}.${signature}`;
}

export async function verifySurveyAccessGrant(
  secret: string,
  surveyId: number,
  token: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return false;
  const expected = await sign(secret, `survey-access:${surveyId}:${expiresAt}`);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}
