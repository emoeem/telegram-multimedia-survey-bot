import { describe, expect, it } from "vitest";
import {
  createAdminSessionValue,
  createBrowserLoginToken,
  verifyAdminSessionValue,
  verifyBrowserLoginToken,
} from "../../../src/services/admin-session.service";

const SECRET = "test-secret";

describe("admin browser session service", () => {
  it("issues and verifies one-time login tokens", async () => {
    const token = await createBrowserLoginToken(SECRET, 42);
    expect(await verifyBrowserLoginToken(SECRET, token)).toBe(42);
  });

  it("issues and verifies long-lived session values", async () => {
    const session = await createAdminSessionValue(SECRET, 7);
    expect(await verifyAdminSessionValue(SECRET, session)).toBe(7);
  });

  it("rejects tampered tokens", async () => {
    const token = await createBrowserLoginToken(SECRET, 42);
    const [payload] = token.split(".");
    expect(await verifyBrowserLoginToken(SECRET, `${payload}.AAAA`)).toBeNull();
  });

  it("rejects a login token used as a session and vice versa", async () => {
    const login = await createBrowserLoginToken(SECRET, 42);
    const session = await createAdminSessionValue(SECRET, 42);
    expect(await verifyAdminSessionValue(SECRET, login)).toBeNull();
    expect(await verifyBrowserLoginToken(SECRET, session)).toBeNull();
  });
});
