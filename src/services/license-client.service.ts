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
  /**
   * Service binding to the authorization center (see `callLicenseCenter`).
   * Present when the customer instance shares the vendor's Cloudflare account.
   */
  LICENSE_CENTER?: Fetcher;
  LICENSE_KEY?: string;
  INSTALLATION_ID?: string;
  LICENSE_GRACE_SECONDS?: string;
}

/**
 * Calls the authorization center.
 *
 * A Worker must NOT reach another Worker in the same Cloudflare account over
 * `*.workers.dev`: the edge answers `error code: 1042` with a **404**, and the
 * request never arrives. That check is what silently killed every customer
 * instance — the client read the 404 as "center unreachable", the webhook
 * answered 503, and the bot stopped replying (the heartbeat died the same way,
 * which is why `last_seen_at` never advanced).
 *
 * A Service Binding reaches the target Worker directly without touching the
 * network, so same-account instances use it. `LICENSE_SERVER_URL` remains the
 * transport for a customer deployed into its own account, where a binding
 * cannot exist.
 */
export async function callLicenseCenter(
  env: { LICENSE_CENTER?: Fetcher; LICENSE_SERVER_URL?: string },
  path: string,
  init: RequestInit,
): Promise<Response> {
  const base = (env.LICENSE_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  // The host is irrelevant to a service binding; it only needs a valid URL.
  const url = /^https?:\/\//i.test(base) ? `${base}${path}` : `https://license-center.invalid${path}`;
  if (env.LICENSE_CENTER) {
    return env.LICENSE_CENTER.fetch(new Request(url, init));
  }
  return fetch(url, init);
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

function contractHasExpired(decision: LicenseActivationDecision, now: number): boolean {
  const expiresAt = decision.license?.expiresAt;
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

async function readCache(cache: KVNamespace, key: string): Promise<CachedLicenseDecision | null> {
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
  env: LicenseClientEnv,
  path: "validate" | "activate",
  payload: {
    licenseKey: string;
    installationId: string;
    appVersion: string;
    metadata: Record<string, unknown>;
  },
): Promise<LicenseActivationDecision> {
  const response = await callLicenseCenter(env, `/api/v1/licenses/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
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
  // A service binding reaches the center without a URL; only require the URL
  // when this deployment has no binding.
  if (!env.LICENSE_CENTER && (!serverUrl || !/^https?:\/\//i.test(serverUrl))) {
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
  const keyHash = await hashLicenseKey(`${licenseKey}:${installationId}:${appVersion}`);
  const cacheKey = `deployment-license:v1:${keyHash}`;
  const cached = await readCache(env.CACHE, cacheKey);
  if (cached) {
    const ageSeconds = Math.max(0, Math.floor((nowTimestamp - cached.storedAt) / 1000));
    const freshFor = cached.decision.valid ? VALID_CACHE_SECONDS : INVALID_CACHE_SECONDS;
    if (ageSeconds <= freshFor) {
      if (cached.decision.valid && contractHasExpired(cached.decision, nowTimestamp)) {
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
    let decision = await callLicenseServer(env, "validate", payload);
    if (decision.code === "activation_not_found") {
      decision = await callLicenseServer(env, "activate", payload);
    }
    await writeCache(
      env.CACHE,
      cacheKey,
      { storedAt: nowTimestamp, decision },
      decision.valid ? VALID_CACHE_SECONDS + graceSeconds + 300 : INVALID_CACHE_SECONDS,
    );
    return resultFromDecision(decision, "server");
  } catch (error) {
    if (cached?.decision.valid && !contractHasExpired(cached.decision, nowTimestamp)) {
      const ageSeconds = Math.max(0, Math.floor((nowTimestamp - cached.storedAt) / 1000));
      if (ageSeconds <= VALID_CACHE_SECONDS + graceSeconds) {
        return {
          ...resultFromDecision(cached.decision, "grace"),
          message: `授权中心暂时不可用，正在使用离线宽限：${error instanceof Error ? error.message : "网络错误"}`,
        };
      }
    }
    return {
      allowed: false,
      source: "server",
      code: "license_server_unavailable",
      message: error instanceof Error ? error.message : "授权中心暂时不可用",
      checkedAt: now.toISOString(),
      license: cached?.decision.license ?? null,
    };
  }
}
