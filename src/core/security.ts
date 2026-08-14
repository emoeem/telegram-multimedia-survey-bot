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
