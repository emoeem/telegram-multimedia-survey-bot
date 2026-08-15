import { afterEach, describe, expect, it, vi } from "vitest";

import type { LicenseActivationDecision } from "../../../src/services/license.service";
import { checkDeploymentLicense } from "../../../src/services/license-client.service";

class MemoryKv {
  values = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? (JSON.parse(value) as T) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const BASE_TIME = new Date("2026-08-15T08:00:00.000Z");

function decision(
  overrides: Partial<LicenseActivationDecision> = {},
): LicenseActivationDecision {
  return {
    valid: true,
    code: "valid",
    message: "授权有效",
    checkedAt: BASE_TIME.toISOString(),
    license: {
      publicId: "LIC-260815-ABCDEFGH",
      licenseType: "timed",
      status: "active",
      startsAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      updatesUntil: "2026-09-01T00:00:00.000Z",
      maxActivations: 1,
    },
    release: {
      version: "0.2.0",
      releasedAt: "2026-08-15T00:00:00.000Z",
    },
    activation: {
      installationId: "install-001",
      active: true,
      firstSeenAt: BASE_TIME.toISOString(),
      lastSeenAt: BASE_TIME.toISOString(),
    },
    ...overrides,
  };
}

function env(cache: MemoryKv) {
  return {
    CACHE: cache as unknown as KVNamespace,
    ENVIRONMENT: "production",
    APP_VERSION: "0.2.0",
    LICENSE_ENFORCEMENT: "required",
    LICENSE_SERVER_URL: "https://license.example.test",
    LICENSE_KEY: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    INSTALLATION_ID: "install-001",
    LICENSE_GRACE_SECONDS: "86400",
  };
}

function response(value: LicenseActivationDecision): Response {
  return Response.json({ ok: true, ...value });
}

describe("deployment license client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does no network work when enforcement is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkDeploymentLicense({
      CACHE: new MemoryKv() as unknown as KVNamespace,
      LICENSE_ENFORCEMENT: "disabled",
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("activates once, then serves a fresh result from KV", async () => {
    const cache = new MemoryKv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          decision({
            valid: false,
            code: "activation_not_found",
            message: "当前安装尚未激活",
            activation: null,
          }),
        ),
      )
      .mockResolvedValueOnce(response(decision()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await checkDeploymentLicense(env(cache), BASE_TIME);
    const second = await checkDeploymentLicense(
      env(cache),
      new Date(BASE_TIME.getTime() + 60 * 60 * 1000),
    );

    expect(first.allowed).toBe(true);
    expect(first.source).toBe("server");
    expect(second.source).toBe("cache");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/validate");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/activate");
  });

  it("uses a valid stale cache only inside the offline grace period", async () => {
    const cache = new MemoryKv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(decision()))
      .mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await checkDeploymentLicense(env(cache), BASE_TIME);
    const grace = await checkDeploymentLicense(
      env(cache),
      new Date(BASE_TIME.getTime() + 7 * 60 * 60 * 1000),
    );
    const denied = await checkDeploymentLicense(
      env(cache),
      new Date(BASE_TIME.getTime() + 31 * 60 * 60 * 1000),
    );

    expect(grace.allowed).toBe(true);
    expect(grace.source).toBe("grace");
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("license_server_unavailable");
  });

  it("never lets a cached timed license run past its contract expiry", async () => {
    const cache = new MemoryKv();
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        decision({
          license: {
            ...decision().license!,
            expiresAt: "2026-08-15T08:30:00.000Z",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await checkDeploymentLicense(env(cache), BASE_TIME);
    const result = await checkDeploymentLicense(
      env(cache),
      new Date("2026-08-15T09:00:00.000Z"),
    );

    expect(result.allowed).toBe(false);
    expect(result.code).toBe("license_expired");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caches an explicit revocation as a denial", async () => {
    const cache = new MemoryKv();
    const revoked = decision({
      valid: false,
      code: "license_revoked",
      message: "授权已被永久吊销",
      activation: null,
      license: {
        ...decision().license!,
        status: "revoked",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response(revoked));
    vi.stubGlobal("fetch", fetchMock);

    const first = await checkDeploymentLicense(env(cache), BASE_TIME);
    const second = await checkDeploymentLicense(
      env(cache),
      new Date(BASE_TIME.getTime() + 60 * 1000),
    );

    expect(first.allowed).toBe(false);
    expect(first.code).toBe("license_revoked");
    expect(second.source).toBe("cache");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
