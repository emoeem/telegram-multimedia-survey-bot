import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getAgeAttestation,
  normalizeContentRating,
  setAgeVerified,
  viewerCanSeeRating,
} from "../../../src/services/content-rating.service";

/**
 * 内容分级（0080）：枚举归一、attestation 的写读，以及公开面判定。
 */

const SCHEMA = `
CREATE TABLE participant_preferences (
  participant_hash TEXT PRIMARY KEY,
  age_verified_at TEXT,
  updated_at TEXT NOT NULL
);
`;

function createDb(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const wrapper = {
    sqlite,
    prepare(sql: string) {
      return {
        bind: (...bound: unknown[]) => {
          const run = sqlite.prepare(sql);
          const params = bound as never[];
          return {
            first: async <T>() => (run.get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: run.all(...params) as unknown as T[], meta: {} }),
            run: async () => {
              const outcome = run.run(...params) as unknown as { changes: number };
              return { success: true, meta: { changes: outcome.changes, last_row_id: 0 } };
            },
          };
        },
        first: async <T>() => (sqlite.prepare(sql).get() as T | undefined) ?? null,
        run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
      };
    },
  };
  return wrapper as unknown as D1Database & { sqlite: DatabaseSync };
}

let db: D1Database & { sqlite: DatabaseSync };

beforeEach(() => {
  db = createDb();
});

describe("content rating", () => {
  it("normalizes the enum and rejects anything else", () => {
    expect(normalizeContentRating("r18")).toBe("r18");
    expect(normalizeContentRating(" ALL ")).toBe("all");
    expect(normalizeContentRating("nsfw")).toBeNull();
    expect(normalizeContentRating(42)).toBeNull();
  });

  it("r18 is invisible without attestation, visible with; all is always visible", () => {
    expect(viewerCanSeeRating(null, "r18")).toBe(false);
    expect(viewerCanSeeRating("2026-10-15T00:00:00Z", "r18")).toBe(true);
    expect(viewerCanSeeRating(null, "all")).toBe(true);
    expect(viewerCanSeeRating(null, undefined)).toBe(true);
  });

  it("records and clears the age attestation per participant", async () => {
    expect((await getAgeAttestation(db, "web_abc"))?.ageVerifiedAt ?? null).toBeNull();
    await setAgeVerified(db, "web_abc", true);
    expect((await getAgeAttestation(db, "web_abc"))?.ageVerifiedAt).toBeTruthy();
    await setAgeVerified(db, "web_abc", false);
    expect((await getAgeAttestation(db, "web_abc"))?.ageVerifiedAt ?? null).toBeNull();
  });

  it("upserts without duplicating rows", async () => {
    await setAgeVerified(db, "web_abc", true);
    await setAgeVerified(db, "web_abc", true);
    const count = db.sqlite.prepare("SELECT COUNT(*) AS n FROM participant_preferences").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
