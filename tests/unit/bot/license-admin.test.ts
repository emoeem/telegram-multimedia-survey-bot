import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
  createLicense: vi.fn(),
  getSoftwareLicenseByPublicId: vi.fn(),
  setLicenseStatus: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  deleteSurvey: vi.fn(),
  getSurveyById: vi.fn(),
  listAllSurveys: vi.fn(),
  updateSurveyStatus: vi.fn(),
}));

vi.mock("../../../src/services/license.service", () => ({
  createLicense: mocks.createLicense,
  deactivateLicenseInstallation: vi.fn(),
  extendLicenseUpdates: vi.fn(),
  extendTimedLicense: vi.fn(),
  getSoftwareLicenseByPublicId: mocks.getSoftwareLicenseByPublicId,
  listLicenseActivations: vi.fn(),
  listSoftwareLicenses: vi.fn(),
  listSoftwareReleases: vi.fn(),
  registerSoftwareRelease: vi.fn(),
  setLicenseStatus: mocks.setLicenseStatus,
}));

import {
  handleAdminCallback,
  handleAdminMessage,
} from "../../../src/bot/admin-handler";
import type { BotContext } from "../../../src/bot/types";
import type { SurveySessionNamespace } from "../../../src/services/session.service";
import type { SurveyBuilderNamespace } from "../../../src/services/survey-builder.service";

function context(): BotContext {
  return {
    botToken: "token",
    db: {} as D1Database,
    session: {} as SurveySessionNamespace,
    builder: {} as SurveyBuilderNamespace,
    adminIds: [99],
    exportQueue: {} as Queue,
  };
}

const LICENSE = {
  id: 1,
  publicId: "LIC-260815-ABCDEFGH",
  licenseKeyHash: "hash",
  customerName: "测试客户",
  customerContact: null,
  licenseType: "timed" as const,
  status: "active" as const,
  startsAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2026-09-14T00:00:00.000Z",
  updatesUntil: "2026-09-14T00:00:00.000Z",
  maxActivations: 1,
  notes: null,
  createdBy: 1,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  revokedAt: null,
};

describe("license admin commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserByTelegramId.mockResolvedValue({
      id: 1,
      telegramUserId: 99,
      systemRole: "admin",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a timed license and displays the key once", async () => {
    mocks.createLicense.mockResolvedValue({
      license: LICENSE,
      licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    });

    await handleAdminMessage(context(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/license_create timed 30 1 测试客户",
    });

    expect(mocks.createLicense).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        licenseType: "timed",
        usageDays: 30,
        maxActivations: 1,
        customerName: "测试客户",
        actorUserId: 1,
      }),
    );
    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toContain(
      "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    );
  });

  it("supports the simple duration and customer syntax", async () => {
    mocks.createLicense.mockResolvedValue({
      license: LICENSE,
      licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    });

    await handleAdminMessage(context(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/license_create 30 测试客户",
    });

    expect(mocks.createLicense).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        licenseType: "timed",
        usageDays: 30,
        maxActivations: 1,
        customerName: "测试客户",
      }),
    );
  });

  it("supports a simple permanent license", async () => {
    mocks.createLicense.mockResolvedValue({
      license: {
        ...LICENSE,
        licenseType: "perpetual",
        expiresAt: null,
        updatesUntil: null,
      },
      licenseKey: "TSB-AAAAA-BBBBB-CCCCC-DDDDD",
    });

    await handleAdminMessage(context(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: "/license_create forever 永久客户",
    });

    expect(mocks.createLicense).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        licenseType: "perpetual",
        updateDays: null,
        maxActivations: 1,
        customerName: "永久客户",
      }),
    );
  });

  it("requires a second action before revoking a license", async () => {
    mocks.getSoftwareLicenseByPublicId.mockResolvedValue(LICENSE);

    await handleAdminMessage(context(), {
      message_id: 1,
      chat: { id: 2 },
      from: { id: 99 },
      text: `/license_revoke ${LICENSE.publicId}`,
    });

    expect(mocks.setLicenseStatus).not.toHaveBeenCalled();
    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toContain("license:revoke_confirm:");
  });

  it("revokes after the confirmation callback", async () => {
    mocks.setLicenseStatus.mockResolvedValue({
      ...LICENSE,
      status: "revoked",
    });

    const handled = await handleAdminCallback(context(), {
      id: "callback-1",
      from: { id: 99 },
      message: {
        message_id: 1,
        chat: { id: 2 },
      },
      data: `license:revoke_confirm:${LICENSE.publicId}`,
    });

    expect(handled).toBe(true);
    expect(mocks.setLicenseStatus).toHaveBeenCalledWith(
      expect.anything(),
      LICENSE.publicId,
      "revoked",
      1,
    );
  });
});
