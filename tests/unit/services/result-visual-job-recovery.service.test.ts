import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../../src/bot/telegram", () => ({ sendMessage }));

import { recoverStaleResultVisualJobs } from "../../../src/services/result-visual-job-recovery.service";

interface RenderJobRow {
  id: number;
  chat_id: number | null;
  attempts: number;
  status: string;
  started_at: string | null;
  created_at: string;
}

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** 口径锚点：统一走 COALESCE(started_at, created_at)。 */
const anchor = (job: RenderJobRow) => job.started_at ?? job.created_at;

/**
 * render_jobs 的行内状态机 fake：SELECT 按双阈值 + COALESCE 锚点过滤，
 * UPDATE 按 WHERE 条件真实判定 changes，与 result-visual-worker.service
 * .test.ts 的 SQL 字符串匹配风格一致。
 */
function createJobsDb(rows: RenderJobRow[]) {
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
                  (job.status === "processing" && anchor(job) < processingCutoff) ||
                  (job.status === "queued" && anchor(job) < queuedCutoff),
              )
              .map((job) => ({ ...job })),
          };
        },
        async run() {
          if (sql.includes("SET status = ?, error_code = ?")) {
            // processing 超时回收分支：[status, code, message, completedAt, id, cutoff]
            const [status, , , , id, cutoff] = stmt.params as [
              string,
              string | null,
              string | null,
              string | null,
              number,
              string,
            ];
            const target = rows.find((job) => job.id === id);
            if (target && target.status === "processing" && anchor(target) < cutoff) {
              target.status = status;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("SET status = 'failed', error_code = ?")) {
            // queued 行终态分支：[code, message, completedAt, id, cutoff]
            const [code, , , id, cutoff] = stmt.params as [string, string | null, string | null, number, string];
            const target = rows.find((job) => job.id === id);
            if (target && target.status === "queued" && anchor(target) < cutoff) {
              target.status = "failed";
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          throw new Error(`Unhandled render_jobs SQL: ${sql}`);
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

describe("result visual job recovery", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("口径统一：started_at 新的活任务不回收，started_at 旧才回收", async () => {
    const { db, rows } = createJobsDb([
      // 刚被认领（started_at 新）：created_at 再久也不回收，避免误杀活渲染
      {
        id: 1,
        chat_id: 99,
        attempts: 0,
        status: "processing",
        started_at: iso(5 * 60_000),
        created_at: iso(40 * 60_000),
      },
      // started_at 久：真超时，回收
      {
        id: 2,
        chat_id: 99,
        attempts: 0,
        status: "processing",
        started_at: iso(40 * 60_000),
        created_at: iso(41 * 60_000),
      },
    ]);
    const deliver = sender();
    const summary = await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(rows[0]!.status).toBe("processing");
    expect(rows[1]!.status).toBe("queued");
    expect(deliver.send).toHaveBeenCalledTimes(1);
    expect(deliver.send).toHaveBeenCalledWith({ kind: "result_visual", jobId: 2 });
    expect(summary).toEqual({ requeued: 1, failed: 0 });
  });

  it("started_at 缺失回退 created_at（COALESCE 锚点）", async () => {
    const { db, rows, sqls } = createJobsDb([
      { id: 3, chat_id: 99, attempts: 0, status: "processing", started_at: null, created_at: iso(40 * 60_000) },
    ]);
    const deliver = sender();
    await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(rows[0]!.status).toBe("queued");
    const selectSql = sqls.find((sql) => sql.includes("FROM render_jobs"));
    expect(selectSql).toContain("COALESCE(started_at, created_at)");
  });

  it("queued 超时未投递的任务会被重投（丢失窗口修复）", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 0, status: "queued", started_at: null, created_at: iso(20 * 60_000) },
    ]);
    const deliver = sender();
    const summary = await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(deliver.send).toHaveBeenCalledWith({ kind: "result_visual", jobId: 1 });
    expect(summary).toEqual({ requeued: 1, failed: 0 });
    expect(rows[0]!.status).toBe("queued");
  });

  it("回收后投递失败不再丢失：行停在 queued，下一轮接管重投（可重入）", async () => {
    const { db, rows } = createJobsDb([
      {
        id: 1,
        chat_id: 99,
        attempts: 0,
        status: "processing",
        started_at: iso(40 * 60_000),
        created_at: iso(41 * 60_000),
      },
    ]);
    const deliver = sender();
    deliver.send.mockRejectedValueOnce(new Error("queue unavailable"));

    // 第一轮：回收成功、投递失败——不抛出，行停在 queued（修复前任务就此蒸发）
    const first = await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(first).toEqual({ requeued: 1, failed: 0 });
    expect(rows[0]!.status).toBe("queued");

    // 第二轮：queued 扫描接管重投
    const second = await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(second).toEqual({ requeued: 1, failed: 0 });
    expect(deliver.send).toHaveBeenCalledTimes(2);
    expect(deliver.send).toHaveBeenLastCalledWith({ kind: "result_visual", jobId: 1 });
    expect(consoleError).toHaveBeenCalled();
  });

  it("queued 行 attempts 到上限则置终态并通知，不再投递", async () => {
    const { db, rows } = createJobsDb([
      { id: 1, chat_id: 99, attempts: 3, status: "queued", started_at: null, created_at: iso(20 * 60_000) },
    ]);
    const deliver = sender();
    const summary = await recoverStaleResultVisualJobs(db, deliver, "token", NOW);
    expect(rows[0]!.status).toBe("failed");
    expect(sendMessage).toHaveBeenCalledWith("token", 99, expect.stringContaining("超时"));
    expect(deliver.send).not.toHaveBeenCalled();
    expect(summary).toEqual({ requeued: 0, failed: 1 });
  });
});
