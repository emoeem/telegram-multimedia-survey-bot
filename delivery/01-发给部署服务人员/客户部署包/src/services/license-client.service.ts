import type { LicenseActivationDecision } from "./license.service";
import { hashLicenseKey } from "./license.service";

const VALID_CACHE_SECONDS = 6 * 60 * 60;
const INVALID_CACHE_SECONDS = 5 * 60;
const DEFAULT_GRACE_SECONDS = 24 * 60 * 60;
const MAX_GRACE_SECONDS = 7 * 24 * 60 * 60;

export interface LicenseClientEnv {
  CACHE: KVNamespace;
  ENVIRONMENT?: string;
  APP_VERSION?: string;
  LICENSE_ENFORCEMENT?: string;
  LICENSE_SERVER_URL?: string;
  LICENSE_KEY?: string;
  INSTALLATION_ID?: string;
  LICENSE_GRACE_SECONDS?: string;
}

interface CachedLicenseDecision {
  storedAt: number;
  decision: LicenseActivationDecision;
}

export interface DeploymentLicenseResult {
  allowed: boolean;
  source: "disabled" | "cache" | "server" | "grace" | "configuration";
  code: string;
  message: string;
  checkedAt: string;
  license: LicenseActivationDecision["license"];
}

function parseGraceSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_GRACE_SECONDS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GRACE_SECONDS;
  return Math.max(0, Math.min(MAX_GRACE_SECONDS, Math.floor(parsed)));
}

function resultFromDecision(
  decision: LicenseActivationDecision,
  source: DeploymentLicenseResult["source"],
): DeploymentLicenseResult {
  return {
    allowed: decision.valid,
    source,
    code: decision.code,
    message: decision.message,
    checkedAt: decision.checkedAt,
    license: decision.license,
  };
}

function contractHasExpired(
  decision: LicenseActivationDecision,
  now: number,
): boolean {
  const expiresAt = decision.license?.expiresAt;
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

async function readCache(
  cache: KVNamespace,
  key: string,
): Promise<CachedLicenseDecision | null> {
  try {
    return await cache.get<CachedLicenseDecision>(key, "json");
  } catch (error) {
    console.warn("License cache read failed", error);
    return null;
  }
}

async function writeCache(
  cache: KVNamespace,
  key: string,
  value: CachedLicenseDecision,
  expirationTtl: number,
): Promise<void> {
  try {
    await cache.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(60, Math.floor(expirationTtl)),
    });
  } catch (error) {
    console.warn("License cache write failed", error);
  }
}

function isLicenseDecision(value: unknown): value is LicenseActivationDecision {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LicenseActivationDecision>;
  return (
    typeof candidate.valid === "boolean" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.checkedAt === "string"
  );
}

async function callLicenseServer(
  serverUrl: string,
  path: "validate" | "activate",
  payload: {
    licenseKey: string;
    installationId: string;
    appVersion: string;
    metadata: Record<string, unknown>;
  },
): Promise<LicenseActivationDecision> {
  const response = await fetch(
    `${serverUrl.replace(/\/+$/, "")}/api/v1/licenses/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`授权中心返回 HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    ok?: boolean;
    valid?: unknown;
  };
  if (body.ok !== true || !isLicenseDecision(body)) {
    throw new Error("授权中心返回了无效数据");
  }
  return body;
}

function configurationError(message: string): DeploymentLicenseResult {
  return {
    allowed: false,
    source: "configuration",
    code: "configuration_error",
    message,
    checkedAt: new Date().toISOString(),
    license: null,
  };
}

export async function checkDeploymentLicense(
  env: LicenseClientEnv,
  now = new Date(),
): Promise<DeploymentLicenseResult> {
  if (env.LICENSE_ENFORCEMENT !== "required") {
    return {
      allowed: true,
      source: "disabled",
      code: "license_check_disabled",
      message: "当前部署未启用商业授权校验",
      checkedAt: now.toISOString(),
      license: null,
    };
  }

  const serverUrl = env.LICENSE_SERVER_URL?.trim();
  const licenseKey = env.LICENSE_KEY?.trim();
  const installationId = env.INSTALLATION_ID?.trim();
  const appVersion = env.APP_VERSION?.trim();
  if (!serverUrl || !/^https?:\/\//i.test(serverUrl)) {
    return configurationError("LICENSE_SERVER_URL 未正确配置");
  }
  if (!licenseKey) {
    return configurationError("LICENSE_KEY 未配置");
  }
  if (!installationId) {
    return configurationError("INSTALLATION_ID 未配置");
  }
  if (!appVersion) {
    return configurationError("APP_VERSION 未配置");
  }

  const nowTimestamp = now.getTime();
  const graceSeconds = parseGraceSeconds(env.LICENSE_GRACE_SECONDS);
  const keyHash = await hashLicenseKey(
    `${licenseKey}:${installationId}:${appVersion}`,
  );
  const cacheKey = `deployment-license:v1:${keyHash}`;
  const cached = await readCache(env.CACHE, cacheKey);
  if (cached) {
    const ageSeconds = Math.max(
      0,
      Math.floor((nowTimestamp - cached.storedAt) / 1000),
    );
    const freshFor = cached.decision.valid
      ? VALID_CACHE_SECONDS
      : INVALID_CACHE_SECONDS;
    if (ageSeconds <= freshFor) {
      if (
        cached.decision.valid &&
        contractHasExpired(cached.decision, nowTimestamp)
      ) {
        return {
          ...resultFromDecision(cached.decision, "cache"),
          allowed: false,
          code: "license_expired",
          message: "授权使用期限已到期",
        };
      }
      return resultFromDecision(cached.decision, "cache");
    }
  }

  const payload = {
    licenseKey,
    installationId,
    appVersion,
    metadata: {
      environment: env.ENVIRONMENT ?? "unknown",
      runtime: "cloudflare-worker",
    },
  };

  try {
    let decision = await callLicenseServer(serverUrl, "validate", payload);
    if (decision.code === "activation_not_found") {
      decision = await callLicenseServer(serverUrl, "activate", payload);
    }
    await writeCache(
      env.CACHE,
      cacheKey,
      { storedAt: nowTimestamp, decision },
      decision.valid
        ? VALID_CACHE_SECONDS + graceSeconds + 300
        : INVALID_CACHE_SECONDS,
    );
    return resultFromDecision(decision, "server");
  } catch (error) {
    if (
      cached?.decision.valid &&
      !contractHasExpired(cached.decision, nowTimestamp)
    ) {
      const ageSeconds = Math.max(
        0,
        Math.floor((nowTimestamp - cached.storedAt) / 1000),
      );
      if (ageSeconds <= VALID_CACHE_SECONDS + graceSeconds) {
        return {
          ...resultFromDecision(cached.decision, "grace"),
          message: `授权中心暂时不可用，正在使用离线宽限：${
            error instanceof Error ? error.message : "网络错误"
          }`,
        };
      }
    }
    return {
      allowed: false,
      source: "server",
      code: "license_server_unavailable",
      message:
        error instanceof Error ? error.message : "授权中心暂时不可用",
      checkedAt: now.toISOString(),
      license: cached?.decision.license ?? null,
    };
  }
}
