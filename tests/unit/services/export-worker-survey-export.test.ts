import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendDocument,
  sendMessage,
  sendPhoto,
  sendPhotoAlbum,
  getExportRows,
  buildCsv,
  serializeExport,
  processResultVisualMessage,
  processImageGeneratorMessage,
  retryImageGeneratorJob,
} = vi.hoisted(() => ({
  sendDocument: vi.fn(),
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendPhotoAlbum: vi.fn(),
  getExportRows: vi.fn(),
  buildCsv: vi.fn(),
  serializeExport: vi.fn(),
  processResultVisualMessage: vi.fn(),
  processImageGeneratorMessage: vi.fn(),
  retryImageGeneratorJob: vi.fn(),
}));

vi.mock("../../../src/services/export.service", () => ({ getExportRows, buildCsv, serializeExport }));
vi.mock("../../../src/bot/telegram", () => ({ sendDocument, sendMessage, sendPhoto, sendPhotoAlbum }));
vi.mock("../../../src/services/result-visual-worker.service", () => ({ processResultVisualMessage }));
vi.mock("../../../src/services/image-generator-worker.service", () => ({
  isImageGeneratorJobMessage: (value: unknown) => (value as { kind?: string }).kind === "image_generator",
  processImageGeneratorMessage,
  retryImageGeneratorJob,
}));

import { handleExportQueue, processExportMessage } from "../../../src/services/export-worker.service";
import { claimExportJob } from "../../../src/db/repositories/export.repository";

type ExportRow = {
  id: number;
  survey_id: number;
  requested_by: number | null;
  format: string;
  status: string;
  r2_key: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  sending_at: string | null;
};

/**
 * export_jobs 的行内状态机 fake：UPDATE 语句按 WHERE 条件真实判定 changes，
 * 让「条件认领」「发送阶段占位」「记账后置终态」的竞争语义可被断言，
 * 与 result-visual-worker.service.test.ts 的 SQL 字符串匹配风格一致。
 */
function createExportDb(initial: { status: string; r2Key: string | null }) {
  const row: ExportRow = {
    id: 42,
    survey_id: 7,
    requested_by: 1,
    format: "csv",
    status: initial.status,
    r2_key: initial.r2Key,
    error_message: null,
    created_at: "2026-11-13T00:00:00.000Z",
    completed_at: null,
    sending_at: null,
  };
  const sqls: string[] = [];
  const batchCalls: string[][] = [];
  const applied: Array<{ sql: string; changes: number }> = [];

  const applyUpdate = (sql: string, params: unknown[]): number => {
    let changes = 0;
    if (sql.includes("SET status = 'running' WHERE id")) {
      const allowed = sql.includes("'sending', 'failed'")
        ? ["pending", "running", "sending", "failed"]
        : ["pending", "failed"];
      if (allowed.includes(row.status)) {
        row.status = "running";
        changes = 1;
      }
    } else if (sql.includes("SET status = 'sending'")) {
      if (row.status === "running") {
        row.status = "sending";
        // 0097：占位时写入 sending_at（维护扫描靠它计时）。
        row.sending_at = params[0] as string;
        changes = 1;
      }
    } else if (sql.includes("SET r2_key = ? WHERE id")) {
      if (row.status === "sending") {
        row.r2_key = params[0] as string;
        changes = 1;
      }
    } else if (sql.includes("SET status = 'completed', completed_at = ?")) {
      const requireRecorded = sql.includes("r2_key IS NOT NULL");
      if (row.status === "sending" && (!requireRecorded || row.r2_key !== null)) {
        row.status = "completed";
        row.completed_at = params[0] as string;
        changes = 1;
      }
    } else if (sql.includes("error_message = ?")) {
      row.status = params[0] as string;
      row.r2_key = params[1] as string | null;
      row.error_message = params[2] as string | null;
      row.completed_at = params[3] as string | null;
      changes = 1;
    } else {
      throw new Error(`Unhandled export_jobs SQL: ${sql}`);
    }
    applied.push({ sql, changes });
    return changes;
  };

  const db = {
    prepare: (sql: string) => {
      sqls.push(sql);
      const stmt = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params;
          return stmt;
        },
        async first() {
          return { ...row };
        },
        async run() {
          return { success: true, meta: { changes: applyUpdate(sql, stmt.params) } };
        },
        _sql: sql,
        _apply: () => applyUpdate(sql, stmt.params),
      };
      return stmt;
    },
    async batch(statements: Array<{ _sql: string; _apply: () => number }>) {
      batchCalls.push(statements.map((statement) => statement._sql));
      return statements.map((statement) => ({ success: true, meta: { changes: statement._apply() } }));
    },
  } as unknown as D1Database;
  return { db, row, sqls, batchCalls, applied };
}

const body = { jobId: 42, surveyId: 7, chatId: 99, format: "csv" };

function env(db: D1Database) {
  return { DB: db, BOT_TOKEN: "token" } as never;
}

function queueMessage(attempts: number) {
  return {
    id: "survey-export",
    timestamp: new Date(),
    body: { ...body },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
}

function queueBatch(message: ReturnType<typeof queueMessage>): MessageBatch<unknown> {
  return {
    messages: [message],
    queue: "telegram-survey-export",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  };
}

describe("survey export claim & idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getExportRows.mockResolvedValue({ rows: [] });
    buildCsv.mockReturnValue("a,b");
    serializeExport.mockReturnValue(new Uint8Array([1]));
    sendDocument.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 555 } })),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("认领竞争：同一 pending 任务的条件认领只有一个消费者拿到", async () => {
    const { db } = createExportDb({ status: "pending", r2Key: null });
    await expect(claimExportJob(db, 42, false)).resolves.toBe(true);
    // 第二个消费者随后到达：行已是 running，认领拿不到
    await expect(claimExportJob(db, 42, false)).resolves.toBe(false);
  });

  it("认领竞争：另一消费者持有 running 时，新到消息拿不到认领、不发送", async () => {
    const { db } = createExportDb({ status: "running", r2Key: null });
    await processExportMessage(env(db), body, { redelivered: false });
    expect(sendDocument).not.toHaveBeenCalled();
    expect(getExportRows).not.toHaveBeenCalled();
  });

  it("两个消费者先后投递同一任务：只有先到者发送文件", async () => {
    const { db } = createExportDb({ status: "pending", r2Key: null });
    await processExportMessage(env(db), body);
    await processExportMessage(env(db), body);
    expect(sendDocument).toHaveBeenCalledOnce();
  });

  it("队列重投接管死消费者遗留的 running 行并发送", async () => {
    const { db } = createExportDb({ status: "running", r2Key: null });
    await processExportMessage(env(db), body, { redelivered: true });
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(sendDocument).toHaveBeenCalledWith("token", 99, "survey-7.csv", expect.any(Uint8Array), "text/csv");
  });

  it("已完成且已记账的任务被重复投递时直接跳过发送", async () => {
    const { db, sqls, applied } = createExportDb({ status: "completed", r2Key: "tg:99:555" });
    await processExportMessage(env(db), body);
    expect(sendDocument).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
    expect(sqls.every((sql) => sql.startsWith("SELECT"))).toBe(true);
  });

  it("sending 且 message_id 已记账：只补终态，不再发送", async () => {
    const { db, row } = createExportDb({ status: "sending", r2Key: "tg:99:555" });
    await processExportMessage(env(db), body);
    expect(sendDocument).not.toHaveBeenCalled();
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
  });

  it("成功路径：先记账 message_id 再置 completed（同一 batch），r2_key 记录 tg 引用", async () => {
    const { db, row, batchCalls } = createExportDb({ status: "pending", r2Key: null });
    await processExportMessage(env(db), body);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]![0]).toContain("SET r2_key = ?");
    expect(batchCalls[0]![1]).toContain("SET status = 'completed'");
    expect(row.r2_key).toBe("tg:99:555");
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
  });

  it("message_id 解析失败仍置 completed（记账是护栏，不能把已成功的发送当失败）", async () => {
    sendDocument.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })));
    const { db, row } = createExportDb({ status: "pending", r2Key: null });
    await processExportMessage(env(db), body);
    expect(row.status).toBe("completed");
    expect(row.r2_key).toBeNull();
  });

  it("handleExportQueue 失败重试把行退回 pending（下次投递可再认领）", async () => {
    sendDocument.mockRejectedValueOnce(new Error("Telegram sendDocument failed: 500"));
    const { db, row } = createExportDb({ status: "pending", r2Key: null });
    const message = queueMessage(1);
    await handleExportQueue(queueBatch(message), env(db));
    expect(row.status).toBe("pending");
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("handleExportQueue 终态失败置 failed 并通知", async () => {
    sendDocument.mockRejectedValueOnce(new Error("Telegram sendDocument failed: 500"));
    const { db, row } = createExportDb({ status: "pending", r2Key: null });
    const message = queueMessage(3);
    await handleExportQueue(queueBatch(message), env(db));
    expect(row.status).toBe("failed");
    expect(sendMessage).toHaveBeenCalledWith("token", 99, "导出失败，请稍后重新发起导出。");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
