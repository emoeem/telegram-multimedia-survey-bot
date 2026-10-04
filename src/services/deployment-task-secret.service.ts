const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptDeploymentTaskPayload(secret: string | undefined, payload: Record<string, unknown>): Promise<string> {
  const normalized = secret?.trim();
  if (!normalized) throw new Error("CONTROL_PLANE_RUNNER_SECRET 未配置，无法创建自动部署任务");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(normalized);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return JSON.stringify({
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptDeploymentTaskPayload(secret: string | undefined, encoded: string): Promise<Record<string, unknown>> {
  const normalized = secret?.trim();
  if (!normalized) throw new Error("CONTROL_PLANE_RUNNER_SECRET 未配置");
  const envelope = JSON.parse(encoded) as { version?: number; iv?: string; ciphertext?: string };
  if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) throw new Error("部署任务凭据格式无效");
  const key = await deriveKey(normalized);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  );
  const payload = JSON.parse(decoder.decode(plaintext)) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("部署任务凭据内容无效");
  return payload as Record<string, unknown>;
}
