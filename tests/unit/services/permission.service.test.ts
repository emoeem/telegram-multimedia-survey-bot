import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  countCompletedResponsesBySurveyAndUser: vi.fn(),
  getActiveResponseBySurveyAndUser: vi.fn(),
  getResponseBySurveyAndHash: vi.fn(),
}));

vi.mock("../../../src/db/repositories/survey.repository", () => ({
  getSurveyById: repositoryMocks.getSurveyById,
}));

vi.mock("../../../src/db/repositories/response.repository", () => ({
  countCompletedResponsesBySurveyAndUser:
    repositoryMocks.countCompletedResponsesBySurveyAndUser,
  getActiveResponseBySurveyAndUser:
    repositoryMocks.getActiveResponseBySurveyAndUser,
  getResponseBySurveyAndHash: repositoryMocks.getResponseBySurveyAndHash,
}));

import {
  canFillSurvey,
  canCreateSurvey,
  getEffectiveRole,
  isAdmin,
} from "../../../src/services/permission.service";

describe("permission service", () => {
  const adminIds = [1, 2];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects admin users", () => {
    expect(isAdmin(1, adminIds)).toBe(true);
    expect(isAdmin(3, adminIds)).toBe(false);
  });

  it("resolves effective role", () => {
    expect(
      getEffectiveRole(
        {
          id: 10,
          telegramUserId: 1,
          systemRole: "participant",
        },
        { ownerId: 20 },
        adminIds,
      ),
    ).toBe("admin");

    expect(
      getEffectiveRole(
        {
          id: 20,
          telegramUserId: 3,
          systemRole: "participant",
        },
        { ownerId: 20 },
        adminIds,
      ),
    ).toBe("owner");

    expect(
      getEffectiveRole(
        {
          id: 30,
          telegramUserId: 4,
          systemRole: "participant",
        },
        { ownerId: 20 },
        adminIds,
      ),
    ).toBe("participant");
  });

  it("does not allow a normal participant to create surveys", () => {
    expect(
      canCreateSurvey(
        {
          id: 30,
          telegramUserId: 4,
          systemRole: "participant",
        },
        adminIds,
      ),
    ).toBe(false);
  });

  it("enforces the completed response limit for repeatable surveys", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      status: "published",
      allowMultipleResponses: true,
      maxResponsesPerUser: 2,
    });
    repositoryMocks.getActiveResponseBySurveyAndUser.mockResolvedValue(null);
    repositoryMocks.countCompletedResponsesBySurveyAndUser.mockResolvedValue(2);

    await expect(
      canFillSurvey({} as D1Database, 10, {
        id: 20,
        telegramUserId: 30,
      }),
    ).resolves.toBe(false);
  });

  it("allows a cancelled single-response survey to be restarted", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      status: "published",
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
    });
    repositoryMocks.getActiveResponseBySurveyAndUser.mockResolvedValue(null);
    repositoryMocks.getResponseBySurveyAndHash.mockResolvedValue({
      status: "cancelled",
    });

    await expect(
      canFillSurvey({} as D1Database, 10, {
        id: 20,
        telegramUserId: 30,
      }),
    ).resolves.toBe(true);
  });
});
