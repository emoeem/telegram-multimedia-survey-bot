import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  activateLicense: vi.fn(),
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
