import { afterEach, describe, expect, it, vi } from "vitest";

const { renderIdentityCardPng, getIdentityProfileById, sendMessage, sendPhoto } = vi.hoisted(() => ({
  renderIdentityCardPng: vi.fn(),
  getIdentityProfileById: vi.fn(),
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
}));

vi.mock("../../../src/bot/identity-card-handler", () => ({ renderIdentityCardPng }));
vi.mock("../../../src/db/repositories/identity-card.repository", () => ({ getIdentityProfileById }));
vi.mock("../../../src/bot/telegram", () => ({ sendMessage, sendPhoto }));

import {
  isIdentityCardJobMessage,
  notifyIdentityCardFailure,
  processIdentityCardMessage,
  retryIdentityCardJob,
} from "../../../src/services/identity-card-worker.service";

function workerDb() {
  const sql: string[] = [];
  const db = {
    prepare: vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (statementSql.includes("identity_profile_id")) {
            return { id: 8, identity_profile_id: 4, chat_id: 99 };
          }
          if (statementSql.includes("SELECT chat_id")) return { chat_id: 99 };
          return null;
        }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return { db, sql };
}

describe("identity card queue worker", () => {
  afterEach(() => vi.clearAllMocks());

  it("only accepts explicit identity card messages", () => {
    expect(isIdentityCardJobMessage({ kind: "identity_card", jobId: 1 })).toBe(true);
    expect(isIdentityCardJobMessage({ kind: "identity_card", jobId: 0 })).toBe(false);
    expect(isIdentityCardJobMessage({ kind: "result_visual", jobId: 1 })).toBe(false);
  });

  it("claims, renders and sends a queued identity card", async () => {
    const { db, sql } = workerDb();
    const png = new Uint8Array([1, 2, 3]);
    getIdentityProfileById.mockResolvedValue({ id: 4 });
    renderIdentityCardPng.mockResolvedValue(png);
    sendPhoto.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await processIdentityCardMessage({ DB: db, BOT_TOKEN: "token" }, { kind: "identity_card", jobId: 8 });

    expect(renderIdentityCardPng).toHaveBeenCalledWith(db, "token", { id: 4 });
    expect(sendPhoto).toHaveBeenCalledWith("token", 99, png, "🎨 你的自定义身份卡已生成");
    expect(sql.some((statement) => statement.includes("status = 'processing'"))).toBe(true);
    expect(sql.some((statement) => statement.includes("status = 'completed'"))).toBe(true);
  });

  it("releases temporary failures and notifies terminal failures", async () => {
    const { db, sql } = workerDb();
    await retryIdentityCardJob(db, 8, "renderer failed", false);
    await retryIdentityCardJob(db, 8, "renderer failed", true);
    await notifyIdentityCardFailure({ DB: db, BOT_TOKEN: "token" }, 8);

    expect(sql.some((statement) => statement.includes("status = ?"))).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("token", 99, "❌ 身份卡生成失败，请稍后重新制作。");
  });
});
