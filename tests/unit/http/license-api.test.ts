import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  activateLicense: vi.fn(),
  createLicense: vi.fn(),
  deactivateLicense: vi.fn(),
  validateLicense: vi.fn(),
}));

vi.mock("../../../src/services/license.service", () => serviceMocks);

import { handleLicenseApiRequest } from "../../../src/http/license-api";

function post(path: string, body: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("license API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores unrelated paths", async () => {
    await expect(
      handleLicenseApiRequest(
        post("/other", {}),
        {} as D1Database,
      ),
    ).resolves.toBeNull();
  });

  it("rejects malformed activation input", async () => {
    const response = await handleLicenseApiRequest(
      post("/api/v1/licenses/activate", {
        licenseKey: "short",
        installationId: "bad id",
      }),
      {} as D1Database,
    );

    expect(response?.status).toBe(400);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(serviceMocks.activateLicense).not.toHaveBeenCalled();
  });

  it("deactivates without requiring an app version", async () => {
    serviceMocks.deactivateLicense.mockResolvedValue(true);

    const response = await handleLicenseApiRequest(
      post("/api/v1/licenses/deactivate", {
        licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
        installationId: "install-001",
      }),
      {} as D1Database,
    );
    const body = (await response?.json()) as {
      ok: boolean;
      deactivated: boolean;
    };

    expect(response?.status).toBe(200);
    expect(body).toEqual({ ok: true, deactivated: true });
  });

  it("creates a timed license with the admin token", async () => {
    serviceMocks.createLicense.mockResolvedValue({
      license: {
        publicId: "LIC-260815-ABCDEFGH",
        licenseType: "timed",
        startsAt: "2026-08-15T00:00:00.000Z",
        expiresAt: "2026-09-14T00:00:00.000Z",
        updatesUntil: "2026-09-14T00:00:00.000Z",
        maxActivations: 1,
        customerName: "客户甲",
      },
      licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    });

    const request = post("/api/v1/licenses/create", {
      customerName: "客户甲",
      period: 30,
      maxActivations: 1,
    });
    request.headers.set("Authorization", "Bearer vendor-admin-secret");
    const response = await handleLicenseApiRequest(
      request,
      {} as D1Database,
      "vendor-admin-secret",
    );
    const body = (await response?.json()) as {
      ok: boolean;
      licenseKey: string;
    };

    expect(response?.status).toBe(200);
    expect(body.licenseKey).toBe("TSB-AAAAA-BBBBB-CCCCC-DDDDD");
    expect(serviceMocks.createLicense).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        licenseType: "timed",
        usageDays: 30,
        maxActivations: 1,
        customerName: "客户甲",
      }),
    );
  });

  it("rejects license creation without the admin token", async () => {
    const response = await handleLicenseApiRequest(
      post("/api/v1/licenses/create", {
        customerName: "客户甲",
        period: "forever",
      }),
      {} as D1Database,
      "vendor-admin-secret",
    );

    expect(response?.status).toBe(401);
    expect(serviceMocks.createLicense).not.toHaveBeenCalled();
  });

  it("does not expose internal database errors", async () => {
    serviceMocks.validateLicense.mockRejectedValue(
      new Error("D1 connection details"),
    );

    const response = await handleLicenseApiRequest(
      post("/api/v1/licenses/validate", {
        licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
        installationId: "install-001",
        appVersion: "0.2.0",
      }),
      {} as D1Database,
    );
    const body = (await response?.json()) as {
      error: string;
      message?: string;
    };

    expect(response?.status).toBe(500);
    expect(body.error).toBe("internal_error");
    expect(body.message).toBeUndefined();
  });
});
