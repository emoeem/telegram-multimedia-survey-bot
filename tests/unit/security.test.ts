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

  it("creates salted v2 hashes and verifies them only with the matching pepper", async () => {
    const stored = await hashSurveyAccessCode("survey-pass", "pepper-one");

    expect(stored).toMatch(/^sha256v2:[0-9a-f]{32}\$[0-9a-f]{64}$/);
    await expect(verifySurveyAccessCode(stored, "survey-pass", "pepper-one")).resolves.toBe(true);
    await expect(verifySurveyAccessCode(stored, "wrong-pass", "pepper-one")).resolves.toBe(false);
    await expect(verifySurveyAccessCode(stored, "survey-pass", "pepper-two")).resolves.toBe(false);

    const other = await hashSurveyAccessCode("survey-pass", "pepper-two");
    expect(other).not.toBe(stored);
  });

  it("keeps sha256 legacy hashes and plaintext values verifiable", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("legacy-hash"));
    const legacyHash = `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

    await expect(verifySurveyAccessCode(legacyHash, "legacy-hash", "ignored-pepper")).resolves.toBe(true);
    await expect(verifySurveyAccessCode(legacyHash, "wrong-pass", "ignored-pepper")).resolves.toBe(false);
    await expect(verifySurveyAccessCode("legacy-pass", "legacy-pass", "ignored-pepper")).resolves.toBe(true);
    await expect(verifySurveyAccessCode("legacy-pass", "wrong-pass", "ignored-pepper")).resolves.toBe(false);
  });

  it("encrypts a viewable copy of a survey access code", async () => {
    const encrypted = await encryptSurveyAccessCode("survey-pass", "bot-token");

    expect(encrypted).toMatch(/^v1:/);
    await expect(decryptSurveyAccessCode(encrypted, "bot-token")).resolves.toBe("survey-pass");
    await expect(decryptSurveyAccessCode(encrypted, "other-token")).resolves.toBeNull();
  });
});
