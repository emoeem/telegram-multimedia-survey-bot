function constantTimeTextEquals(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);

  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }

  return diff === 0;
}

export function isWebhookSecretValid(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual) {
    return false;
  }
  return constantTimeTextEquals(expected, actual);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function legacySurveyAccessCodeHash(normalizedCode: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedCode));
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

async function surveyAccessCodeV2Digest(
  salt: Uint8Array,
  pepper: string,
  normalizedCode: string,
): Promise<string> {
  const codeBytes = new TextEncoder().encode(normalizedCode);
  const pepperBytes = new TextEncoder().encode(pepper);
  const material = new Uint8Array(salt.length + pepperBytes.length + codeBytes.length);
  material.set(salt, 0);
  material.set(pepperBytes, salt.length);
  material.set(codeBytes, salt.length + pepperBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashSurveyAccessCode(code: string, pepper: string): Promise<string> {
  const normalized = code.trim();
  if (!normalized) {
    throw new Error("访问密码不能为空");
  }
  if (!pepper) {
    throw new Error("访问密码安全配置缺失");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await surveyAccessCodeV2Digest(salt, pepper, normalized);
  return `sha256v2:${bytesToHex(salt)}$${digest}`;
}

export async function verifySurveyAccessCode(
  storedCode: string,
  submittedCode: string,
  pepper: string,
): Promise<boolean> {
  const normalized = submittedCode.trim();

  if (storedCode.startsWith("sha256v2:")) {
    if (!pepper) return false;
    const payload = storedCode.slice("sha256v2:".length).split("$");
    if (payload.length !== 2) return false;
    const salt = hexToBytes(payload[0] ?? "");
    const expectedDigest = payload[1] ?? "";

    if (!salt || salt.length !== 16 || !/^[0-9a-f]{64}$/i.test(expectedDigest)) return false;
    const submittedDigest = await surveyAccessCodeV2Digest(salt, pepper, normalized);

    return constantTimeTextEquals(expectedDigest.toLowerCase(), submittedDigest);
  }

  if (storedCode.startsWith("sha256:")) {
    const submittedHash = await legacySurveyAccessCodeHash(normalized);
    return constantTimeTextEquals(storedCode, submittedHash);
  }

  // Accept legacy plaintext values so existing protected surveys keep working.
  return constantTimeTextEquals(storedCode, normalized);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function surveyCodeEncryptionKey(botToken: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`survey-access-code:v1:${botToken}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a viewable copy; the verifier remains the SHA-256 value above. */
export async function encryptSurveyAccessCode(code: string, botToken: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await surveyCodeEncryptionKey(botToken);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(code.trim()));
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptSurveyAccessCode(encryptedCode: string, botToken: string): Promise<string | null> {
  const [version, ivEncoded, payloadEncoded] = encryptedCode.split(":");
  if (version !== "v1" || !ivEncoded || !payloadEncoded) return null;
  try {
    const key = await surveyCodeEncryptionKey(botToken);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(base64ToBytes(ivEncoded)) },
      key,
      bytesToArrayBuffer(base64ToBytes(payloadEncoded)),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
