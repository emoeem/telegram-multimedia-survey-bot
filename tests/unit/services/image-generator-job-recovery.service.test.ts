import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../../src/bot/telegram", () => ({ sendMessage }));

import { recoverStaleImageGeneratorJobs } from "../../../src/services/image-generator-job-recovery.service";

interface JobRow {
  id: number;
  chat_id: number | null;
  attempts: number;
  status: string;
  created_at: string;
}

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/**
 * image_generator_jobs 的行内状态机 fake：SELECT 按双阈值过滤，UPDATE 按
 * WHERE 条件真实判定 changes，与 result-visual-worker.service.test.ts 的
 * SQL 字符串匹配风格一致。
 */
function createJobsDb(rows: JobRow[]) {
  const sqls: string[] = [];
  const db = {
    prepare: (sql: string) => {
      sqls.push(sql);
      const stmt = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params;
          return stmt;
        },
        async all() {
          const [processingCutoff, queuedCutoff] = stmt.params as [string, string];
          return {
            results: rows
              .filter(
                (job) =>
                  (job.status === "processing" && job.created_at < processingCutoff) ||
                  (job.status === "queued" && job.created_at < queuedCutoff),
              )
              .map((job) => ({ ...job })),
          };
        },
        async run() {
          if (sql.includes("SET status = ?, error_message = ?, completed_at = ?")) {
            // processing 超时回收分支：[status, error, completedAt, id, cutoff]
            const [status, , , id, cutoff] = stmt.params as [string, string | null, string | null, number, string];
            const target = rows.find((job) => job.id === id);
            if (target && target.status === "processing" && target.created_at < cutoff) {
              target.status = status;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("SET status = 'failed', error_message = ?, completed_at = ?")) {
            // queued 行终态分支：[error, completedAt, id, cutoff]
            const [, , id, cutoff] = stmt.params as [string, string | null, number, string];
            const target = rows.find((job) => job.id === id);
            if (target && target.status === "queued" && target.created_at < cutoff) {
              target.status = "failed";
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          throw new Error(`Unhandled image_generator_jobs SQL: ${sql}`);
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, rows, sqls };
}

function sender() {
  return { send: vi.fn(async () => ({})) };
}

describe("image generator job recovery", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queued 超时未投递的任务会被重投（丢失窗口修复）", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 0, status: "queued", created_at: iso(20 * 60_000) },
    ]);
    const deliver = sender();
    const summary = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(deliver.send).toHaveBeenCalledWith({ kind: "image_generator", jobId: 1 });
    expect(summary).toEqual({ requeued: 1, failed: 0 });
    expect(rows[0]!.status).toBe("queued");
  });

  it("刚入队的 queued 行不会被重投", async () => {
    const { db } = createJobsDb([{ id: 1, chat_id: 99, attempts: 0, status: "queued", created_at: iso(2 * 60_000) }]);
    const deliver = sender();
    const summary = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(deliver.send).not.toHaveBeenCalled();
    expect(summary).toEqual({ requeued: 0, failed: 0 });
  });

  it("queued 行 attempts 到上限则置终态并通知，不再投递", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 3, status: "queued", created_at: iso(20 * 60_000) },
    ]);
    const deliver = sender();
    const summary = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(rows[0]!.status).toBe("failed");
    expect(sendMessage).toHaveBeenCalledWith("token", 99, expect.stringContaining("超时"));
    expect(deliver.send).not.toHaveBeenCalled();
    expect(summary).toEqual({ requeued: 0, failed: 1 });
  });

  it("processing 超时回收置回 queued 并投递（原行为保留）", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 0, status: "processing", created_at: iso(40 * 60_000) },
    ]);
    const deliver = sender();
    const summary = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(rows[0]!.status).toBe("queued");
    expect(deliver.send).toHaveBeenCalledWith({ kind: "image_generator", jobId: 1 });
    expect(summary).toEqual({ requeued: 1, failed: 0 });
  });

  it("回收后投递失败不再丢失：行停在 queued，下一轮接管重投（可重入）", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 0, status: "processing", created_at: iso(40 * 60_000) },
    ]);
    const deliver = sender();
    deliver.send.mockRejectedValueOnce(new Error("queue unavailable"));

    // 第一轮：回收成功、投递失败——不抛出，行停在 queued（修复前任务就此蒸发）
    const first = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(first).toEqual({ requeued: 1, failed: 0 });
    expect(rows[0]!.status).toBe("queued");

    // 第二轮：queued 扫描接管重投，重复执行无害
    const second = await recoverStaleImageGeneratorJobs(db, deliver, "token", NOW);
    expect(second).toEqual({ requeued: 1, failed: 0 });
    // 第一轮投递失败一次、第二轮重投成功一次
    expect(deliver.send).toHaveBeenCalledTimes(2);
    expect(deliver.send).toHaveBeenLastCalledWith({ kind: "image_generator", jobId: 1 });
    expect(consoleError).toHaveBeenCalled();
  });

  it("口径：本表无 started_at 列，扫描锚点回退 created_at", async () => {
    const { db, sqls } = createJobsDb([]);
    await recoverStaleImageGeneratorJobs(db, sender(), "token", NOW);
    const selectSql = sqls.find((sql) => sql.includes("FROM image_generator_jobs"));
    expect(selectSql).toContain("created_at < ?");
    expect(selectSql).not.toContain("started_at");
  });
});
