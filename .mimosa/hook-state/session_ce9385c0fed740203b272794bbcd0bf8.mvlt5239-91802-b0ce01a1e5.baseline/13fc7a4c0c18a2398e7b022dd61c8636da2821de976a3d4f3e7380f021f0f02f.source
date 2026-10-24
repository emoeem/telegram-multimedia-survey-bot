import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getActiveShareByToken,
  getShareByResponse,
  revokeReportShare,
  upsertReportShare,
} from "../../../src/services/report-share.service";

/**
 * 报告分享卡（0081）的服务层行为：幂等创建、撤销后重建换新 token、
 * 撤销的链接立刻失效。
 */

const SCHEMA = `
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  completed_at TEXT
);
${readFileSync(join(__dirname, "../../../db/migrations/0081_report_shares.sql"), "utf-8")}
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
        all: async <T>() => ({ results: sqlite.prepare(sql).all() as unknown as T[], meta: {} }),
        run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
      };
    },
  };
  return wrapper as unknown as D1Database & { sqlite: DatabaseSync };
}

let db: D1Database & { sqlite: DatabaseSync };

beforeEach(() => {
  db = createDb();
  db.sqlite
    .prepare(
      "INSERT INTO survey_responses (id, survey_id, participant_hash, status, completed_at) VALUES (1, 10, 'user_7', 'completed', '2026-10-15T00:00:00Z')",
    )
    .run();
});

const BASE = {
  responseId: 1,
  participantHash: "user_7",
  surveyId: 10,
  surveyTitle: "情景-测试",
  resultType: "ending_a",
  resultTitle: "结局 A",
  contentRating: "all" as const,
};

describe("report shares", () => {
  it("creates a share and returns the same row on repeated calls (idempotent)", async () => {
    const first = await upsertReportShare(db, BASE);
    const second = await upsertReportShare(db, BASE);
    expect(second.token).toBe(first.token);
    expect(second.resultTitle).toBe("结局 A");
  });

  it("revokes: the token stops resolving, ownership-scoped", async () => {
    const share = await upsertReportShare(db, BASE);
    // 别的参与者不能撤销不是自己的分享。
    await expect(revokeReportShare(db, 1, "user_8")).resolves.toBe(false);
    await expect(revokeReportShare(db, 1, "user_7")).resolves.toBe(true);
    expect(await getActiveShareByToken(db, share.token)).toBeNull();
    expect(await getShareByResponse(db, 1)).not.toBeNull();
  });

  it("re-creating after revoke mints a NEW token and refreshes the snapshot", async () => {
    const first = await upsertReportShare(db, BASE);
    await revokeReportShare(db, 1, "user_7");
    const second = await upsertReportShare(db, { ...BASE, resultTitle: "结局 B" });
    expect(second.token).not.toBe(first.token);
    expect(second.resultTitle).toBe("结局 B");
    expect(await getActiveShareByToken(db, first.token)).toBeNull();
    expect((await getActiveShareByToken(db, second.token))?.resultTitle).toBe("结局 B");
  });

  it("keeps an r18 rating snapshot on the share row", async () => {
    const share = await upsertReportShare(db, { ...BASE, contentRating: "r18" });
    expect((await getActiveShareByToken(db, share.token))?.contentRating).toBe("r18");
  });
});
