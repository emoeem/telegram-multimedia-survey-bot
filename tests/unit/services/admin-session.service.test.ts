import { describe, expect, it } from "vitest";
import { createAdminSessionValue, verifyAdminSessionValue } from "../../../src/services/admin-session.service";

const SECRET = "test-secret";

describe("admin browser session service", () => {
  it("issues and verifies long-lived session values", async () => {
    const session = await createAdminSessionValue(SECRET, 7, 0);
    expect(await verifyAdminSessionValue(SECRET, session, 0)).toBe(7);
  });

  it("rejects tampered session values", async () => {
    const session = await createAdminSessionValue(SECRET, 42, 0);
    const [payload] = session.split(".");
    expect(await verifyAdminSessionValue(SECRET, `${payload}.AAAA`, 0)).toBeNull();
  });

  it("rejects sessions minted under an older epoch", async () => {
    const session = await createAdminSessionValue(SECRET, 42, 1);
    expect(await verifyAdminSessionValue(SECRET, session, 2)).toBeNull();
  });
});
