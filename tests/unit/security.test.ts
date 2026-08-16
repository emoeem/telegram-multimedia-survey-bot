import { describe, expect, it } from "vitest";

import {
  decryptSurveyAccessCode,
  encryptSurveyAccessCode,
  hashSurveyAccessCode,
  isWebhookSecretValid,
  verifySurveyAccessCode,
} from "../../src/core/security";

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

  it("hashes and verifies survey access codes", async () => {
    const stored = await hashSurveyAccessCode("survey-pass");

    expect(stored).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(verifySurveyAccessCode(stored, "survey-pass")).resolves.toBe(true);
    await expect(verifySurveyAccessCode(stored, "wrong-pass")).resolves.toBe(false);
  });

  it("accepts legacy plaintext survey access codes", async () => {
    await expect(verifySurveyAccessCode("legacy-pass", "legacy-pass")).resolves.toBe(true);
    await expect(verifySurveyAccessCode("legacy-pass", "wrong-pass")).resolves.toBe(false);
  });

  it("encrypts a viewable copy of a survey access code", async () => {
    const encrypted = await encryptSurveyAccessCode("survey-pass", "bot-token");

    expect(encrypted).toMatch(/^v1:/);
    await expect(decryptSurveyAccessCode(encrypted, "bot-token")).resolves.toBe("survey-pass");
    await expect(decryptSurveyAccessCode(encrypted, "other-token")).resolves.toBeNull();
  });
});
