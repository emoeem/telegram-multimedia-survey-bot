import { describe, expect, it } from "vitest";

import { describeDatabaseError, describePublicDatabaseError, isDatabaseCapacityError } from "../../../src/db/errors";

// The exact wording Cloudflare returned on 2026-09-14, when the daily
// maintenance sweep burned the account's rows-read budget and every later
// query failed with this message.
const QUOTA_ERROR = new Error(
  "A request to the Cloudflare API failed. Your account has exceeded D1's free tier daily row read limit. " +
    "Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. [code: 7500]",
);

describe("database error classification", () => {
  it("recognises the D1 daily row limit failure", () => {
    expect(isDatabaseCapacityError(QUOTA_ERROR)).toBe(true);
    expect(isDatabaseCapacityError(new Error("D1_ERROR: no such table: nope"))).toBe(true);
  });

  it("leaves ordinary failures alone", () => {
    expect(isDatabaseCapacityError(new Error("Network connection lost"))).toBe(false);
    expect(isDatabaseCapacityError(null)).toBe(false);
  });

  it("keeps plan advice out of the message end users see", () => {
    expect(describeDatabaseError(QUOTA_ERROR)).toContain("Cloudflare 套餐");
    expect(describePublicDatabaseError(QUOTA_ERROR)).toContain("明天早上");
    expect(describePublicDatabaseError(QUOTA_ERROR)).not.toContain("套餐");
    expect(describePublicDatabaseError(new Error("boom"))).not.toContain("额度");
  });
});
