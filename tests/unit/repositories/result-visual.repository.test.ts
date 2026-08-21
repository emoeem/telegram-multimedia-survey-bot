import { describe, expect, it, vi } from "vitest";

import {
  claimRenderJob,
  completeRenderJob,
  createRenderJob,
  failRenderJob,
  releaseRenderJobForRetry,
} from "../../../src/db/repositories/result-visual.repository";

const jobRow = {
  id: 9,
  result_profile_id: 4,
  template_id: 5,
  template_version: 2,
  chat_id: 123,
  requested_by: 6,
  status: "queued",
  attempts: 0,
  force_regenerate: 0,
  error_code: null,
  error_message: null,
  created_at: "2026-08-19T00:00:00.000Z",
  started_at: null,
  completed_at: null,
};

function createD1Mock(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare: vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async () => ({ success: true, meta: { last_row_id: 9, changes: 1 } })),
        first: vi.fn(async () => statementSql.includes("render_jobs") ? jobRow : null),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return { db, sql };
}

describe("result visual repository", () => {
  it("creates a queued job and claims it atomically", async () => {
    const { db, sql } = createD1Mock();
    const job = await createRenderJob(db, {
      resultProfileId: 4,
      templateId: 5,
      templateVersion: 2,
      chatId: 123,
      requestedBy: 6,
      forceRegenerate: false,
    });
    const claimed = await claimRenderJob(db, job.id);

    expect(job.status).toBe("queued");
    expect(claimed).toBe(true);
    expect(sql.some((entry) => entry.includes("INSERT INTO render_jobs"))).toBe(true);
    expect(sql.some((entry) => entry.includes("WHERE id = ? AND status = 'queued'"))).toBe(true);
  });

  it("records retryable and terminal failures without storing image output", async () => {
    const { db, sql } = createD1Mock();
    await releaseRenderJobForRetry(db, 9, { code: "render_retry", message: "temporary failure" });
    await failRenderJob(db, 9, { code: "render_failed", message: "safe failure" });
    await completeRenderJob(db, 9);

    expect(sql.some((entry) => entry.includes("status = 'queued'"))).toBe(true);
    expect(sql.some((entry) => entry.includes("status = 'failed'"))).toBe(true);
    expect(sql.some((entry) => entry.includes("status = 'completed'"))).toBe(true);
  });
});
