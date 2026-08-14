import { describe, expect, it } from "vitest";

import { isWebhookSecretValid } from "../../src/core/security";

describe("isWebhookSecretValid", () => {
  it("accepts matching secrets", () => {
    expect(isWebhookSecretValid("abc123", "abc123")).toBe(true);
  });

  it("rejects different secrets", () => {
    expect(isWebhookSecretValid("abc123", "abc124")).toBe(false);
  });

  it("rejects missing secrets", () => {
    expect(isWebhookSecretValid("abc123", null)).toBe(false);
    expect(isWebhookSecretValid(undefined, "abc123")).toBe(false);
  });
});
