const encoder = new TextEncoder();

export const ADMIN_PASSWORD_SETTING_KEY = "admin_password_hash";
export const ADMIN_PASSWORD_ITERATIONS = 100_000;
export const DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2$100000$81UZTs4WYTOFnad_QaPUdg$Edl9BrqhB8YrN0w9l7ImX5gcl-R4MCMa6cEH4BI9HiM";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ADMIN_PASSWORD_ITERATIONS);
  return `pbkdf2$${ADMIN_PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = base64UrlToBytes(parts[2] ?? "");
  const expected = base64UrlToBytes(parts[3] ?? "");
  if (!Number.isInteger(iterations) || iterations < 100_000 || !salt || !expected || expected.length !== 32) return false;
  const actual = await derive(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export function isValidAdminPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 256;
}
