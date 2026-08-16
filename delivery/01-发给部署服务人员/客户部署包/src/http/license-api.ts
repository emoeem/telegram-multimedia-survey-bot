import {
  activateLicense,
  createLicense,
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

function constantTimeEquals(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.length !== actualBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |=
      (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }
  return difference === 0;
}

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

function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new LicenseApiInputError(`${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new LicenseApiInputError(
      `${field} 不能超过 ${maxLength} 个字符`,
    );
  }
  return trimmed || null;
}

function positiveInteger(
  body: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = body[field] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new LicenseApiInputError(`${field} 必须是正整数`);
  }
  return value;
}

function parseCreateLicenseRequest(body: Record<string, unknown>): {
  licenseType: "timed" | "perpetual";
  usageDays?: number;
  updateDays?: number | null;
  maxActivations: number;
  customerName: string | null;
  customerContact: string | null;
  notes: string | null;
} {
  const period = body["period"];
  const maxActivations = positiveInteger(body, "maxActivations", 1);
  const customerName = optionalString(body, "customerName", 200);
  if (!customerName) {
    throw new LicenseApiInputError("customerName 不能为空");
  }

  if (
    typeof period === "string" &&
    period.trim().toLowerCase() === "forever"
  ) {
    return {
      licenseType: "perpetual",
      updateDays: null,
      maxActivations,
      customerName,
      customerContact: optionalString(body, "customerContact", 200),
      notes: optionalString(body, "notes", 1000),
    };
  }

  const usageDays =
    typeof period === "number"
      ? period
      : typeof period === "string" && /^\d+$/.test(period.trim())
        ? Number(period)
        : Number.NaN;
  if (
    !Number.isInteger(usageDays) ||
    usageDays <= 0 ||
    usageDays > 36_500
  ) {
    throw new LicenseApiInputError(
      "period 必须是 1 到 36500 之间的天数或 forever",
    );
  }
  return {
    licenseType: "timed",
    usageDays,
    maxActivations,
    customerName,
    customerContact: optionalString(body, "customerContact", 200),
    notes: optionalString(body, "notes", 1000),
  };
}

function readAdminToken(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("X-License-Admin-Token")?.trim() ?? "";
}

export async function handleLicenseApiRequest(
  request: Request,
  db: D1Database,
  adminToken?: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const supportedPaths = new Set([
    "/api/v1/licenses/create",
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
    if (path === "/api/v1/licenses/create") {
      const expectedToken = adminToken?.trim() ?? "";
      const submittedToken = readAdminToken(request);
      if (
        !expectedToken ||
        !submittedToken ||
        !constantTimeEquals(expectedToken, submittedToken)
      ) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      const body = parseCreateLicenseRequest(await readJsonObject(request));
      const created = await createLicense(db, body);
      return jsonResponse({
        ok: true,
        license: {
          publicId: created.license.publicId,
          licenseType: created.license.licenseType,
          startsAt: created.license.startsAt,
          expiresAt: created.license.expiresAt,
          updatesUntil: created.license.updatesUntil,
          maxActivations: created.license.maxActivations,
          customerName: created.license.customerName,
        },
        licenseKey: created.licenseKey,
      });
    }

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
