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
