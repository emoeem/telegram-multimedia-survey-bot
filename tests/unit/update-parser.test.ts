import { describe, expect, it } from "vitest";

import { getUpdateKind, parseTelegramUpdate } from "../../src/bot/update-parser";

describe("parseTelegramUpdate", () => {
  it("parses a message update", () => {
    const update = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 42 },
        text: "hello",
      },
    });

    expect(update?.update_id).toBe(1);
    expect(getUpdateKind(update!)).toBe("message");
  });

  it("parses a callback query update", () => {
    const update = parseTelegramUpdate({
      update_id: 2,
      callback_query: {
        id: "cb-1",
        from: { id: 42 },
        data: "pressed",
      },
    });

    expect(update?.update_id).toBe(2);
    expect(getUpdateKind(update!)).toBe("callback_query");
  });

  it("parses a channel_post update", () => {
    const update = parseTelegramUpdate({
      update_id: 3,
      channel_post: {
        message_id: 11,
        chat: { id: -1001234567890, type: "channel", title: "报告归档" },
        text: "TEST",
      },
    });

    expect(update?.update_id).toBe(3);
    expect(getUpdateKind(update!)).toBe("channel_post");
  });

  it("returns null for invalid body", () => {
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate({})).toBeNull();
  });
});
