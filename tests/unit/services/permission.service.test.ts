import { describe, expect, it } from "vitest";

import {
  canCreateSurvey,
  getEffectiveRole,
  isAdmin,
} from "../../../src/services/permission.service";

describe("permission service", () => {
  const adminIds = [1, 2];

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
});
