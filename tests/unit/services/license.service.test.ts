import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SoftwareLicense, SoftwareRelease } from "../../../src/db/schema";

const repositoryMocks = vi.hoisted(() => ({
  claimLicenseActivation: vi.fn(),
  createSoftwareLicense: vi.fn(),
  createSoftwareRelease: vi.fn(),
  deactivateLicenseActivation: vi.fn(),
  getLicenseActivation: vi.fn(),
  getSoftwareLicenseByKeyHash: vi.fn(),
  getSoftwareLicenseByPublicId: vi.fn(),
  getSoftwareReleaseByVersion: vi.fn(),
  listLicenseActivations: vi.fn(),
  listSoftwareLicenses: vi.fn(),
  listSoftwareReleases: vi.fn(),
  touchLicenseActivation: vi.fn(),
  updateSoftwareLicenseDates: vi.fn(),
  updateSoftwareLicenseStatus: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  createAuditLog: vi.fn(),
}));

vi.mock("../../../src/db/repositories/license.repository", () => repositoryMocks);
vi.mock("../../../src/db/repositories/audit.repository", () => auditMocks);

import {
  activateLicense,
  createLicense,
  evaluateSoftwareLicense,
  normalizeSoftwareVersion,
} from "../../../src/services/license.service";

const NOW = new Date("2026-08-15T08:00:00.000Z");

function license(
  overrides: Partial<SoftwareLicense> = {},
): SoftwareLicense {
  return {
    id: 1,
    publicId: "LIC-260815-ABCDEFGH",
    licenseKeyHash: "hash",
    customerName: "客户",
    customerContact: null,
    licenseType: "timed",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    updatesUntil: "2026-09-01T00:00:00.000Z",
    maxActivations: 1,
    notes: null,
    createdBy: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function release(
  overrides: Partial<SoftwareRelease> = {},
): SoftwareRelease {
  return {
    id: 1,
    version: "0.2.0",
    channel: "stable",
    releasedAt: "2026-08-15T00:00:00.000Z",
    minimumVersion: null,
    downloadUrl: null,
    checksumSha256: null,
    notes: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("software license service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.getSoftwareReleaseByVersion.mockResolvedValue(release());
    auditMocks.createAuditLog.mockResolvedValue(undefined);
  });

  it("accepts an active timed license for a registered version", async () => {
    const result = await evaluateSoftwareLicense(
      {} as D1Database,
      license(),
      "v0.2.0",
      NOW,
    );

    expect(result.valid).toBe(true);
    expect(result.code).toBe("valid");
    expect(result.release?.version).toBe("0.2.0");
  });

  it("rejects an expired timed license before checking a release", async () => {
    const result = await evaluateSoftwareLicense(
      {} as D1Database,
      license({ expiresAt: "2026-08-15T07:59:59.000Z" }),
      "0.2.0",
      NOW,
    );

    expect(result.code).toBe("license_expired");
    expect(repositoryMocks.getSoftwareReleaseByVersion).not.toHaveBeenCalled();
  });

  it("keeps perpetual usage but rejects versions released after updates end", async () => {
    repositoryMocks.getSoftwareReleaseByVersion.mockResolvedValue(
      release({ releasedAt: "2026-08-01T00:00:00.000Z" }),
    );

    const result = await evaluateSoftwareLicense(
      {} as D1Database,
      license({
        licenseType: "perpetual",
        expiresAt: null,
        updatesUntil: "2026-07-31T23:59:59.000Z",
      }),
      "0.2.0",
      NOW,
    );

    expect(result.valid).toBe(false);
    expect(result.code).toBe("updates_expired");
  });

  it("allows a perpetual license to run an older entitled version", async () => {
    repositoryMocks.getSoftwareReleaseByVersion.mockResolvedValue(
      release({
        version: "0.1.0",
        releasedAt: "2026-06-01T00:00:00.000Z",
      }),
    );

    const result = await evaluateSoftwareLicense(
      {} as D1Database,
      license({
        licenseType: "perpetual",
        expiresAt: null,
        updatesUntil: "2026-06-30T23:59:59.000Z",
      }),
      "0.1.0",
      NOW,
    );

    expect(result.valid).toBe(true);
  });

  it("rejects revoked licenses and unknown versions", async () => {
    const revoked = await evaluateSoftwareLicense(
      {} as D1Database,
      license({ status: "revoked" }),
      "0.2.0",
      NOW,
    );
    repositoryMocks.getSoftwareReleaseByVersion.mockResolvedValueOnce(null);
    const unknownVersion = await evaluateSoftwareLicense(
      {} as D1Database,
      license(),
      "9.9.9",
      NOW,
    );

    expect(revoked.code).toBe("license_revoked");
    expect(unknownVersion.code).toBe("version_not_registered");
  });

  it("enforces the atomic activation claim result", async () => {
    repositoryMocks.getSoftwareLicenseByKeyHash.mockResolvedValue(license());
    repositoryMocks.getLicenseActivation.mockResolvedValue(null);
    repositoryMocks.claimLicenseActivation.mockResolvedValue(null);

    const result = await activateLicense({} as D1Database, {
      licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
      installationId: "install-001",
      appVersion: "0.2.0",
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe("activation_limit_reached");
  });

  it("creates a perpetual key without storing its plaintext", async () => {
    repositoryMocks.getSoftwareLicenseByPublicId.mockResolvedValue(null);
    repositoryMocks.getSoftwareLicenseByKeyHash.mockResolvedValue(null);
    repositoryMocks.createSoftwareLicense.mockImplementation(
      async (_db: D1Database, input: { publicId: string; licenseKeyHash: string }) =>
        license({
          publicId: input.publicId,
          licenseKeyHash: input.licenseKeyHash,
          licenseType: "perpetual",
          expiresAt: null,
          updatesUntil: null,
        }),
    );

    const result = await createLicense({} as D1Database, {
      licenseType: "perpetual",
      updateDays: null,
      maxActivations: 2,
      customerName: "永久客户",
      now: NOW,
    });

    expect(result.licenseKey).toMatch(
      /^TSB-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/,
    );
    const createInput = repositoryMocks.createSoftwareLicense.mock
      .calls[0]?.[1] as { licenseKeyHash: string };
    expect(createInput.licenseKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(createInput)).not.toContain(result.licenseKey);
  });

  it("normalizes only valid semantic versions", () => {
    expect(normalizeSoftwareVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeSoftwareVersion("1.2")).toBeNull();
    expect(normalizeSoftwareVersion("01.2.3")).toBeNull();
  });
});
