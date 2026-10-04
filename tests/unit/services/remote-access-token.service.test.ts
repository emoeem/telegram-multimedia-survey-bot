import { describe, expect, it } from "vitest";

import {
  signRemoteAccessToken,
  verifyRemoteAccessToken,
} from "../../../src/services/remote-access-token.service";

const SECRET = "test-remote-access-secret-value";
const INSTALLATION = "install-5628d80b64e094664e388e36";
const NOW = Date.parse("2026-10-02T00:00:00.000Z");

describe("remote access tokens", () => {
  it("verifies a token it just signed", async () => {
    const { token, expiresAt } = await signRemoteAccessToken(SECRET, { installationId: INSTALLATION, now: NOW });

    const claims = await verifyRemoteAccessToken(SECRET, token, INSTALLATION, NOW + 1000);
    expect(claims).not.toBeNull();
    expect(claims?.installationId).toBe(INSTALLATION);
    expect(claims?.scope).toBe("read");
    expect(Date.parse(expiresAt)).toBeGreaterThan(NOW);
  });

  it("refuses an expired token", async () => {
    const { token } = await signRemoteAccessToken(SECRET, {
      installationId: INSTALLATION,
      now: NOW,
      ttlSeconds: 60,
    });
    // One second past expiry.
    await expect(verifyRemoteAccessToken(SECRET, token, INSTALLATION, NOW + 61_000)).resolves.toBeNull();
  });

  it("refuses a token signed with a different secret", async () => {
    const { token } = await signRemoteAccessToken("another-secret-entirely", {
      installationId: INSTALLATION,
      now: NOW,
    });
    await expect(verifyRemoteAccessToken(SECRET, token, INSTALLATION, NOW + 1000)).resolves.toBeNull();
  });

  it("refuses a tampered payload even though the signature is well formed", async () => {
    const { token } = await signRemoteAccessToken(SECRET, { installationId: INSTALLATION, now: NOW });
    const [payload, signature] = token.split(".");
    // Re-encode the claims with a far-future expiry, keeping the old signature.
    const forged = btoa(JSON.stringify({ v: 1, exp: 9_999_999_999, scope: "read", installationId: INSTALLATION }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    await expect(
      verifyRemoteAccessToken(SECRET, `${forged}.${signature}`, INSTALLATION, NOW + 1000),
    ).resolves.toBeNull();
    // Sanity: the untouched token still verifies.
    await expect(verifyRemoteAccessToken(SECRET, `${payload}.${signature}`, INSTALLATION, NOW + 1000)).resolves.not.toBeNull();
  });

  it("refuses a token minted for another installation", async () => {
    const { token } = await signRemoteAccessToken(SECRET, { installationId: INSTALLATION, now: NOW });
    await expect(
      verifyRemoteAccessToken(SECRET, token, "install-someone-elses-instance", NOW + 1000),
    ).resolves.toBeNull();
  });

  it("refuses malformed input instead of throwing", async () => {
    for (const bad of ["", ".", "no-dot", "a.b", "%%%.###", `${"a".repeat(10)}.`]) {
      await expect(verifyRemoteAccessToken(SECRET, bad, INSTALLATION, NOW)).resolves.toBeNull();
    }
  });

  it("refuses to verify when no secret is configured", async () => {
    const { token } = await signRemoteAccessToken(SECRET, { installationId: INSTALLATION, now: NOW });
    await expect(verifyRemoteAccessToken("  ", token, INSTALLATION, NOW + 1000)).resolves.toBeNull();
  });

  it("refuses to sign without a secret, and clamps an absurd TTL", async () => {
    await expect(signRemoteAccessToken("", { installationId: INSTALLATION, now: NOW })).rejects.toThrow();
    const { expiresAt } = await signRemoteAccessToken(SECRET, {
      installationId: INSTALLATION,
      now: NOW,
      ttlSeconds: 999_999,
    });
    // Clamped to the 1 hour ceiling rather than honouring a year-long token.
    expect(Date.parse(expiresAt) - NOW).toBeLessThanOrEqual(3600 * 1000);
  });
});
