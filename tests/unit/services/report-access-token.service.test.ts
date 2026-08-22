import { describe, expect, it } from "vitest";

import {
  createReportAccessToken,
  verifyReportAccessToken,
} from "../../../src/services/report-access-token.service";

describe("report access token", () => {
  it("round-trips a signed token", async () => {
    const token = await createReportAccessToken("secret", 42, 1_700_000_000);
    await expect(verifyReportAccessToken("secret", 42, token, 1_700_000_000)).resolves.toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const token = await createReportAccessToken("secret", 42, 1_700_000_000);
    const tampered = `${token.slice(0, -2)}00`;
    await expect(verifyReportAccessToken("secret", 42, tampered, 1_700_000_000)).resolves.toBe(false);
  });

  it("rejects tokens bound to another response", async () => {
    const token = await createReportAccessToken("secret", 42, 1_700_000_000);
    await expect(verifyReportAccessToken("secret", 43, token, 1_700_000_000)).resolves.toBe(false);
  });

  it("rejects expired tokens", async () => {
    const token = await createReportAccessToken("secret", 42, 1_700_000_000, 30);
    await expect(verifyReportAccessToken("secret", 42, token, 1_700_000_100)).resolves.toBe(false);
  });
});
