import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  hashAdminPassword,
  isValidAdminPassword,
  verifyAdminPassword,
} from "../../../src/services/admin-password.service";

describe("admin password service", () => {
  it("accepts the default password and rejects incorrect passwords", async () => {
    expect(await verifyAdminPassword("emoemoemo", DEFAULT_ADMIN_PASSWORD_HASH)).toBe(true);
    expect(await verifyAdminPassword("wrong-password", DEFAULT_ADMIN_PASSWORD_HASH)).toBe(false);
  });

  it("hashes passwords with a random salt", async () => {
    const first = await hashAdminPassword("test-password");
    const second = await hashAdminPassword("test-password");
    expect(first).not.toBe(second);
    expect(await verifyAdminPassword("test-password", first)).toBe(true);
    expect(await verifyAdminPassword("wrong-password", first)).toBe(false);
  });

  it("validates password length", () => {
    expect(isValidAdminPassword("1234567")).toBe(false);
    expect(isValidAdminPassword("12345678")).toBe(true);
    expect(isValidAdminPassword("a".repeat(256))).toBe(true);
    expect(isValidAdminPassword("a".repeat(257))).toBe(false);
  });
});
