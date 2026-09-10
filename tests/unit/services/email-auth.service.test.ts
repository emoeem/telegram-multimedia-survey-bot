import { describe, expect, it } from "vitest";
import {
  createEmailSessionToken,
  hashPassword,
  isValidEmail,
  isValidPassword,
  verifyEmailSessionToken,
  verifyPassword,
} from "../../../src/services/email-auth.service";

describe("email auth service", () => {
  it("hashes and verifies passwords with per-hash salts", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^pbkdf2:100000:/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    // A second hash must use a different salt.
    const second = await hashPassword("correct horse battery");
    expect(second).not.toBe(hash);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2:abc:!!!:!!!")).toBe(false);
  });

  it("round-trips session tokens and rejects tampering", async () => {
    const token = await createEmailSessionToken("secret", 42);
    expect(await verifyEmailSessionToken("secret", token)).toEqual({ accountId: 42 });
    expect(await verifyEmailSessionToken("other-secret", token)).toBeNull();
    expect(await verifyEmailSessionToken("secret", `${token}x`)).toBeNull();
    expect(await verifyEmailSessionToken("secret", "garbage")).toBeNull();
  });

  it("validates emails and passwords", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidPassword("12345678")).toBe(true);
    expect(isValidPassword("short")).toBe(false);
  });
});
