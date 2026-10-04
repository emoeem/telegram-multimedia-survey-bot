/**
 * Short-lived, stateless read-only access tokens for the vendor console.
 *
 * Why the browser talks to the customer instance directly: a Cloudflare Worker
 * cannot reach another Worker in the SAME account over `*.workers.dev` (the
 * edge answers `error code: 1042` with a 404), so a center-side proxy only works
 * for customers deployed into their own account. The vendor console runs in a
 * browser, which is not subject to that restriction, so it can call the
 * customer's read-only API in BOTH topologies while the center stays out of the
 * data path entirely — it only mints these tokens and writes an audit entry.
 *
 * The token is a signed, self-contained claim set: no server-side session, no
 * shared database, nothing for the center to store beyond the per-instance
 * secret. Both sides hold that secret; the center signs, the customer verifies.
 */

export const REMOTE_ACCESS_SCOPE = "read";
/** Short by design: the browser holds it only long enough to load one view. */
export const REMOTE_ACCESS_TOKEN_TTL_SECONDS = 300;

export interface RemoteAccessClaims {
  /** Envelope version, so the customer can reject anything it does not know. */
  v: 1;
  /** Expiry, seconds since the epoch. */
  exp: number;
  scope: typeof REMOTE_ACCESS_SCOPE;
  /** Binds the token to one installed instance. */
  installationId: string;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Length-independent comparison: never leaks where two digests diverge. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] as number) ^ (b[index] as number);
  return diff === 0;
}

export async function signRemoteAccessToken(
  secret: string,
  input: { installationId: string; ttlSeconds?: number; now?: number },
): Promise<{ token: string; expiresAt: string }> {
  const normalized = secret?.trim();
  if (!normalized) throw new Error("REMOTE_ACCESS_SECRET 未配置");
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const ttl = Math.max(30, Math.min(input.ttlSeconds ?? REMOTE_ACCESS_TOKEN_TTL_SECONDS, 3600));
  const claims: RemoteAccessClaims = {
    v: 1,
    exp: nowSeconds + ttl,
    scope: REMOTE_ACCESS_SCOPE,
    installationId: input.installationId,
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await importHmacKey(normalized);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return { token: `${payload}.${base64UrlEncode(signature)}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/**
 * Returns the claims only when the signature verifies, the token has not
 * expired, and it is bound to `expectedInstallationId`.
 */
export async function verifyRemoteAccessToken(
  secret: string,
  token: string,
  expectedInstallationId: string,
  now = Date.now(),
): Promise<RemoteAccessClaims | null> {
  const normalized = secret?.trim();
  if (!normalized) return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const providedSignature = base64UrlDecode(token.slice(separator + 1));
  if (!providedSignature) return null;

  const key = await importHmacKey(normalized);
  const expectedSignature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  if (!timingSafeEqual(expectedSignature, providedSignature)) return null;

  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const candidate = claims as Partial<RemoteAccessClaims>;
  if (candidate.v !== 1) return null;
  if (candidate.scope !== REMOTE_ACCESS_SCOPE) return null;
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) return null;
  if (candidate.exp * 1000 <= now) return null;
  if (candidate.installationId !== expectedInstallationId) return null;
  return candidate as RemoteAccessClaims;
}
