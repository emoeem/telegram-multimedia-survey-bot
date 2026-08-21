import { describe, expect, it, vi } from "vitest";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../../src/bot/telegram", () => ({ sendMessage }));

import { recoverStaleIdentityCardJobs } from "../../../src/services/identity-card-job-recovery.service";

describe("identity card job recovery", () => {
  it("requeues a stale processing job through the existing queue", async () => {
    const statements: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        statements.push(sql);
        const statement = {
          bind: vi.fn(() => statement),
          all: vi.fn(async () => ({ results: [{ id: 8, chat_id: 99, attempts: 1 }] })),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
        return statement;
      }),
    } as unknown as D1Database;
    const queue = { send: vi.fn() } as unknown as Queue;

    const summary = await recoverStaleIdentityCardJobs(db, queue, "token", Date.parse("2026-08-19T00:05:00.000Z"));

    expect(summary).toEqual({ requeued: 1, failed: 0 });
    expect(queue.send).toHaveBeenCalledWith({ kind: "identity_card", jobId: 8 });
    expect(statements.some((sql) => sql.includes("processing_started_at"))).toBe(true);
  });
});
