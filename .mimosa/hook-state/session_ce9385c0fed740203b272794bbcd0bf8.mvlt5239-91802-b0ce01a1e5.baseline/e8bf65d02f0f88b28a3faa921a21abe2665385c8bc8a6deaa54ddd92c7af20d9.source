import { describe, expect, it } from "vitest";

import {
  createReportAccessToken,
  createReportAccessTokens,
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

  it("batch-mints verifiable tokens per response with one key import", async () => {
    const tokens = await createReportAccessTokens("secret", [7, 8, 9], 1_700_000_000);
    expect(tokens.size).toBe(3);
    for (const responseId of [7, 8, 9]) {
      const token = tokens.get(responseId);
      expect(token).toBeDefined();
      await expect(verifyReportAccessToken("secret", responseId, token ?? null, 1_700_000_000)).resolves.toBe(true);
    }
    // 批量结果与逐个铸造完全一致（同一算法、同一过期时间）。
    const single = await createReportAccessToken("secret", 7, 1_700_000_000);
    expect(tokens.get(7)).toBe(single);
    await expect(createReportAccessTokens("secret", [])).resolves.toEqual(new Map());
  });
});
