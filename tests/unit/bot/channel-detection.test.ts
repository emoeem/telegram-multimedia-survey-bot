import { beforeEach, describe, expect, it, vi } from "vitest";

const telegramMocks = vi.hoisted(() => ({
  getBotId: vi.fn(),
  getChatMember: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../../src/bot/telegram", () => ({
  getBotId: telegramMocks.getBotId,
  getChatMember: telegramMocks.getChatMember,
  sendMessage: telegramMocks.sendMessage,
}));

import { maybeDetectReportChannel } from "../../../src/bot/channel-detection";
import { REPORT_CHANNEL_CACHE_KEY } from "../../../src/services/report-delivery.service";
import { REPORT_CHANNEL_DETECT_REQUEST_KEY } from "../../../src/bot/channel-detection";

function makeCtx(overrides: { pending?: boolean; cache?: KVNamespace } = {}) {
  const cache = overrides.cache ?? {
    get: vi.fn(async () => (overrides.pending === false ? null : "111")),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as KVNamespace;
  return {
    botToken: "token",
    cache,
  } as never;
}

describe("report channel detection via channel_post", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegramMocks.getBotId.mockResolvedValue(12345);
    telegramMocks.getChatMember.mockResolvedValue({ status: "administrator" });
  });

  it("caches the posted channel and notifies the requesting admin", async () => {
    const cache = {
      get: vi.fn(async () => "111"),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace;
    const ctx = makeCtx({ cache });

    await maybeDetectReportChannel(ctx, {
      message_id: 1,
      chat: { id: -1001234567890, type: "channel", title: "报告归档" },
      text: "TEST",
    });

    expect(cache.put).toHaveBeenCalledWith(REPORT_CHANNEL_CACHE_KEY, "-1001234567890");
    expect(cache.delete).toHaveBeenCalledWith(REPORT_CHANNEL_DETECT_REQUEST_KEY);
    expect(telegramMocks.sendMessage).toHaveBeenCalledWith(
      "token",
      111,
      expect.stringContaining("-1001234567890"),
    );
  });

  it("warns the admin when the bot is not a channel administrator", async () => {
    telegramMocks.getChatMember.mockResolvedValue({ status: "member" });
    const cache = {
      get: vi.fn(async () => "111"),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace;
    const ctx = makeCtx({ cache });

    await maybeDetectReportChannel(ctx, {
      message_id: 1,
      chat: { id: -1001234567890, type: "channel" },
    });

    expect(cache.put).not.toHaveBeenCalled();
    expect(telegramMocks.sendMessage).toHaveBeenCalledWith(
      "token",
      111,
      expect.stringContaining("不是该频道的管理员"),
    );
  });

  it("ignores channel posts when no admin is waiting for detection", async () => {
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace;
    const ctx = makeCtx({ cache });

    await maybeDetectReportChannel(ctx, {
      message_id: 1,
      chat: { id: -1001234567890, type: "channel" },
    });

    expect(cache.put).not.toHaveBeenCalled();
    expect(telegramMocks.sendMessage).not.toHaveBeenCalled();
  });
});
