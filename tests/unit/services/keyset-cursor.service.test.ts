import { describe, expect, it } from "vitest";
import {
  decodeShowcaseCursor,
  encodeShowcaseCursor,
  SHOWCASE_CURSOR_MAX_AGE_MS,
} from "../../../src/services/keyset-cursor.service";

describe("showcase keyset cursor", () => {
  const secret = "local-test-secret";
  const issuedAt = Date.parse("2026-10-08T00:00:00.000Z");

  it("round-trips the created_at/id anchor", async () => {
    const cursor = await encodeShowcaseCursor(secret, { createdAt: "2026-10-01T12:00:00.000Z", id: 42 }, issuedAt);
    await expect(decodeShowcaseCursor(secret, cursor, issuedAt)).resolves.toMatchObject({
      createdAt: "2026-10-01T12:00:00.000Z",
      id: 42,
      issuedAt,
    });
  });

  it("rejects forged and expired cursors", async () => {
    const cursor = await encodeShowcaseCursor(secret, { createdAt: "2026-10-01T12:00:00.000Z", id: 42 }, issuedAt);
    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(decodeShowcaseCursor(secret, forged, issuedAt)).resolves.toBeNull();
    await expect(decodeShowcaseCursor(secret, cursor, issuedAt + SHOWCASE_CURSOR_MAX_AGE_MS + 1)).resolves.toBeNull();
  });
});
