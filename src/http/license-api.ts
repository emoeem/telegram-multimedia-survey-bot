import {
  activateLicense,
  deactivateLicense,
  validateLicense,
} from "../services/license.service";

const MAX_BODY_LENGTH = 16_384;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

interface LicenseRequestBody {
  licenseKey: string;
  installationId: string;
  installationName?: string;
  appVersion: string;
  metadata?: Record<string, unknown>;
}

class LicenseApiInputError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_LENGTH) {
    throw new LicenseApiInputError("请求内容过大");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_LENGTH) {
    throw new LicenseApiInputError("请求内容过大");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LicenseApiInputError("请求必须是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LicenseApiInputError("请求内容必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new LicenseApiInputError(`${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw new LicenseApiInputError(
      `${field} 长度必须在 ${minLength} 到 ${maxLength} 个字符之间`,
    );
  }
  return trimmed;
}

function parseLicenseRequest(body: Record<string, unknown>): LicenseRequestBody {
  const installationId = requiredString(body, "installationId", 6, 128);
  if (!/^[A-Za-z0-9._:@/-]+$/.test(installationId)) {
    throw new LicenseApiInputError("installationId 包含不支持的字符");
  }
  const appVersion = requiredString(body, "appVersion", 5, 64);
  const licenseKey = requiredString(body, "licenseKey", 20, 128);
  const installationNameValue = body.installationName;
  let installationName: string | undefined;
  if (installationNameValue !== undefined) {
    if (typeof installationNameValue !== "string") {
      throw new LicenseApiInputError("installationName 必须是字符串");
    }
    installationName = installationNameValue.trim();
    if (!installationName || installationName.length > 100) {
      throw new LicenseApiInputError(
        "installationName 长度必须在 1 到 100 个字符之间",
      );
    }
  }

  const metadataValue = body.metadata;
  let metadata: Record<string, unknown> | undefined;
  if (metadataValue !== undefined) {
    if (
      !metadataValue ||
      typeof metadataValue !== "object" ||
      Array.isArray(metadataValue)
    ) {
      throw new LicenseApiInputError("metadata 必须是 JSON 对象");
    }
    if (JSON.stringify(metadataValue).length > 2_048) {
      throw new LicenseApiInputError("metadata 内容过大");
    }
    metadata = metadataValue as Record<string, unknown>;
  }

  return {
    licenseKey,
    installationId,
    appVersion,
    ...(installationName === undefined ? {} : { installationName }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseDeactivateRequest(
  body: Record<string, unknown>,
): Pick<LicenseRequestBody, "licenseKey" | "installationId"> {
  const installationId = requiredString(body, "installationId", 6, 128);
  if (!/^[A-Za-z0-9._:@/-]+$/.test(installationId)) {
    throw new LicenseApiInputError("installationId 包含不支持的字符");
  }
  return {
    licenseKey: requiredString(body, "licenseKey", 20, 128),
    installationId,
  };
}

export async function handleLicenseApiRequest(
  request: Request,
  db: D1Database,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const supportedPaths = new Set([
    "/api/v1/licenses/activate",
    "/api/v1/licenses/validate",
    "/api/v1/licenses/deactivate",
  ]);
  if (!supportedPaths.has(path)) return null;
  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: "method_not_allowed" },
      405,
    );
  }

  try {
    const rawBody = await readJsonObject(request);
    if (path === "/api/v1/licenses/deactivate") {
      const body = parseDeactivateRequest(rawBody);
      const deactivated = await deactivateLicense(db, body);
      return jsonResponse({ ok: true, deactivated });
    }

    const body = parseLicenseRequest(rawBody);
    if (path === "/api/v1/licenses/activate") {
      const decision = await activateLicense(db, body);
      return jsonResponse({ ok: true, ...decision });
    }
    if (path === "/api/v1/licenses/validate") {
      const decision = await validateLicense(db, body);
      return jsonResponse({ ok: true, ...decision });
    }
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求处理失败";
    if (!(error instanceof LicenseApiInputError)) {
      console.error("License API request failed", error);
      return jsonResponse(
        { ok: false, error: "internal_error" },
        500,
      );
    }
    const status = message === "请求内容过大" ? 413 : 400;
    return jsonResponse(
      { ok: false, error: "invalid_request", message },
      status,
    );
  }
}
