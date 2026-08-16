export function isWebhookSecretValid(
  expected: string | undefined,
  actual: string | null,
): boolean {
  if (!expected || !actual) {
    return false;
  }

  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);

  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i += 1) {
    diff |= (expectedBytes[i] ?? 0) ^ (actualBytes[i] ?? 0);
  }

  return diff === 0;
}

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

export async function hashSurveyAccessCode(code: string): Promise<string> {
  const normalized = code.trim();
  if (!normalized) {
    throw new Error("访问密码不能为空");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  return `sha256:${hex}`;
}

export async function verifySurveyAccessCode(
  storedCode: string,
  submittedCode: string,
): Promise<boolean> {
  const normalized = submittedCode.trim();
  if (storedCode.startsWith("sha256:")) {
    const submittedHash = await hashSurveyAccessCode(normalized);
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
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function surveyCodeEncryptionKey(botToken: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`survey-access-code:v1:${botToken}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a viewable copy; the verifier remains the SHA-256 value above. */
export async function encryptSurveyAccessCode(
  code: string,
  botToken: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await surveyCodeEncryptionKey(botToken);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(code.trim()),
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptSurveyAccessCode(
  encryptedCode: string,
  botToken: string,
): Promise<string | null> {
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
