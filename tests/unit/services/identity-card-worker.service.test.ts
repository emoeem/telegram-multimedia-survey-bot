import { afterEach, describe, expect, it, vi } from "vitest";

const {
  renderIdentityCardReportPng,
  storeIdentityCardPng,
  getIdentityProfileById,
  setIdentityProfileCardAsset,
  sendMessage,
  sendPhoto,
} = vi.hoisted(() => ({
  renderIdentityCardReportPng: vi.fn(),
  storeIdentityCardPng: vi.fn(),
  getIdentityProfileById: vi.fn(),
  setIdentityProfileCardAsset: vi.fn(),
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
}));

vi.mock("../../../src/services/identity-card-report.service", () => ({
  renderIdentityCardReportPng,
  storeIdentityCardPng,
}));
vi.mock("../../../src/db/repositories/identity-card.repository", () => ({
  getIdentityProfileById,
  setIdentityProfileCardAsset,
}));
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

const browserBinding = { fetch: vi.fn() } as unknown as import("@cloudflare/puppeteer").BrowserWorker;

describe("identity card queue worker", () => {
  afterEach(() => vi.clearAllMocks());

  it("only accepts explicit identity card messages", () => {
    expect(isIdentityCardJobMessage({ kind: "identity_card", jobId: 1 })).toBe(true);
    expect(isIdentityCardJobMessage({ kind: "identity_card", jobId: 0 })).toBe(false);
    expect(isIdentityCardJobMessage({ kind: "result_visual", jobId: 1 })).toBe(false);
  });

  it("claims, renders through the report pipeline, stores and sends a queued card", async () => {
    const { db, sql } = workerDb();
    const png = new Uint8Array([1, 2, 3]);
    getIdentityProfileById.mockResolvedValue({ id: 4, galleryPublished: true });
    renderIdentityCardReportPng.mockResolvedValue(png);
    storeIdentityCardPng.mockResolvedValue(77);
    sendPhoto.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await processIdentityCardMessage(
      { DB: db, BOT_TOKEN: "token", BROWSER: browserBinding },
      { kind: "identity_card", jobId: 8 },
    );

    expect(renderIdentityCardReportPng).toHaveBeenCalledWith(
      { DB: db, BOT_TOKEN: "token", BROWSER: browserBinding },
      { id: 4, galleryPublished: true },
    );
    expect(storeIdentityCardPng).toHaveBeenCalledWith({ DB: db, BOT_TOKEN: "token", BROWSER: browserBinding }, 4, png);
    expect(setIdentityProfileCardAsset).toHaveBeenCalledWith(db, 4, 77);
    expect(sendPhoto).toHaveBeenCalledWith("token", 99, png, "🎨 你的资料卡已生成，并已发布到资料卡画廊。");
    expect(sql.some((statement) => statement.includes("status = 'processing'"))).toBe(true);
    expect(sql.some((statement) => statement.includes("status = 'completed'"))).toBe(true);
  });

  it("sends a private caption for unpublished cards and fails without a browser binding", async () => {
    const { db } = workerDb();
    getIdentityProfileById.mockResolvedValue({ id: 4, galleryPublished: false });
    renderIdentityCardReportPng.mockResolvedValue(new Uint8Array([9]));
    storeIdentityCardPng.mockResolvedValue(null);
    sendPhoto.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await processIdentityCardMessage(
      { DB: db, BOT_TOKEN: "token", BROWSER: browserBinding },
      { kind: "identity_card", jobId: 8 },
    );
    expect(sendPhoto).toHaveBeenCalledWith("token", 99, expect.any(Uint8Array), "🎨 你的资料卡已生成（仅自己可见）。");

    await expect(
      processIdentityCardMessage({ DB: db, BOT_TOKEN: "token" }, { kind: "identity_card", jobId: 8 }),
    ).rejects.toThrow("BROWSER 未配置");
  });

  it("releases temporary failures and notifies terminal failures", async () => {
    const { db, sql } = workerDb();
    await retryIdentityCardJob(db, 8, "renderer failed", false);
    await retryIdentityCardJob(db, 8, "renderer failed", true);
    await notifyIdentityCardFailure({ DB: db, BOT_TOKEN: "token" }, 8);

    expect(sql.some((statement) => statement.includes("status = ?"))).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("token", 99, "❌ 资料卡生成失败，请稍后重新制作。");
  });
});
