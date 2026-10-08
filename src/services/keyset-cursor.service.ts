const CURSOR_VERSION = 1;
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ShowcaseCursorMode = "created_at" | "legacy_feed";

export interface ShowcaseCursorPayload {
  mode: ShowcaseCursorMode;
  createdAt: string;
  id: number;
  featureRank?: number;
  sortOrder?: number;
  issuedAt: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export async function encodeShowcaseCursor(
  secret: string,
  input: Omit<ShowcaseCursorPayload, "issuedAt" | "mode"> & { mode?: ShowcaseCursorMode },
  now = Date.now(),
): Promise<string> {
  const payload = {
    v: CURSOR_VERSION,
    mode: input.mode ?? "created_at",
    createdAt: input.createdAt,
    id: input.id,
    ...(input.featureRank === undefined ? {} : { featureRank: input.featureRank }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    issuedAt: now,
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(secret, encoded);
  return `${encoded}.${signature}`;
}

export async function decodeShowcaseCursor(
  secret: string,
  cursor: string,
  now = Date.now(),
): Promise<ShowcaseCursorPayload | null> {
  if (!secret || cursor.length > 512) return null;
  const parts = cursor.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = await sign(secret, encoded);
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as Record<string, unknown>;
    const issuedAt = Number(parsed.issuedAt);
    const id = Number(parsed.id);
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const mode =
      parsed.mode === "legacy_feed"
        ? "legacy_feed"
        : parsed.mode === "created_at" || parsed.mode === undefined
          ? "created_at"
          : null;
    const featureRank = Number(parsed.featureRank);
    const sortOrder = Number(parsed.sortOrder);
    if (
      parsed.v !== CURSOR_VERSION ||
      !mode ||
      !createdAt ||
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isFinite(issuedAt) ||
      (mode === "legacy_feed" && (!Number.isFinite(featureRank) || !Number.isFinite(sortOrder)))
    )
      return null;
    if (Math.abs(now - issuedAt) > CURSOR_MAX_AGE_MS) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return {
      mode,
      createdAt,
      id,
      ...(mode === "legacy_feed" ? { featureRank, sortOrder } : {}),
      issuedAt,
    };
  } catch {
    return null;
  }
}

export const SHOWCASE_CURSOR_MAX_AGE_MS = CURSOR_MAX_AGE_MS;
