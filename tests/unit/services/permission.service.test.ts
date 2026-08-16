import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getSurveyById: vi.fn(),
  countCompletedResponsesBySurveyAndUser: vi.fn(),
  getActiveResponseBySurveyAndUser: vi.fn(),
  getResponseBySurveyAndHash: vi.fn(),
  hasActiveCreatorTrial: vi.fn(),
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

vi.mock("../../../src/db/repositories/creator-trial.repository", () => ({
  hasActiveCreatorTrial: repositoryMocks.hasActiveCreatorTrial,
}));

import {
  canFillSurvey,
  canCreateSurvey,
  getEffectiveRole,
  isAdmin,
  assertCanFillSurvey,
} from "../../../src/services/permission.service";

describe("permission service", () => {
  const adminIds = [1, 2];

  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.hasActiveCreatorTrial.mockResolvedValue(false);
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

  it("does not allow a normal participant to create surveys", async () => {
    await expect(
      canCreateSurvey(
        {} as D1Database,
        {
          id: 30,
          telegramUserId: 4,
          systemRole: "participant",
        },
        adminIds,
      ),
    ).resolves.toBe(false);
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

  it("explains that a completed response does not close the survey", async () => {
    repositoryMocks.getSurveyById.mockResolvedValue({
      status: "published",
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
    });
    repositoryMocks.getActiveResponseBySurveyAndUser.mockResolvedValue(null);
    repositoryMocks.getResponseBySurveyAndHash.mockResolvedValue({
      status: "completed",
    });

    await expect(
      assertCanFillSurvey({} as D1Database, 10, {
        id: 20,
        telegramUserId: 30,
      }),
    ).rejects.toThrow("问卷仍在发布中，其他用户可以继续填写");
  });
});
