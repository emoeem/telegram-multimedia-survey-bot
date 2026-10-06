import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getUserByTelegramId: vi.fn(),
  canCreateSurvey: vi.fn(),
  upsertDefaultPublicationTarget: vi.fn(),
}));

vi.mock("../../../src/bot/telegram", () => ({ sendMessage: mocks.sendMessage }));

vi.mock("../../../src/db/repositories/user.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/repositories/user.repository")>()),
  getUserByTelegramId: mocks.getUserByTelegramId,
}));

vi.mock("../../../src/services/permission.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/permission.service")>()),
  canCreateSurvey: mocks.canCreateSurvey,
}));

vi.mock("../../../src/db/repositories/publication-target.repository", () => ({
  upsertDefaultPublicationTarget: mocks.upsertDefaultPublicationTarget,
}));

import { maybeHandlePublishTargetCommand } from "../../../src/bot/publish-target";

const GROUP_CHAT_ID = -1009876543210;

/**
 * 复制 router 的行为：把本条 update 所在的会话写进 ctx.incoming，handler 再据此
 * 决定回复要不要带话题（见 src/bot/reply.ts）。测试直接调用 handler，所以必须
 * 自己补上这一步，否则就绕过了真实的话题来源。
 */
function makeCtx(incoming: { chatId: number; threadId?: number } = { chatId: GROUP_CHAT_ID }) {
  return { botToken: "token", db: {} as never, adminIds: [42], incoming } as never;
}

function groupMessage(overrides: Partial<Parameters<typeof maybeHandlePublishTargetCommand>[1]> = {}) {
  return {
    message_id: 1,
    chat: { id: -1009876543210, type: "supergroup", title: "测试发布群" },
    from: { id: 42, first_name: "Owner" },
    text: "/set_publish_target",
    ...overrides,
  };
}

describe("set_publish_target command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getUserByTelegramId.mockResolvedValue({ id: 7, telegramUserId: 42, systemRole: "participant" });
    mocks.canCreateSurvey.mockResolvedValue(true);
    mocks.upsertDefaultPublicationTarget.mockResolvedValue({
      id: 2,
      name: "测试发布群",
      chatId: "-1009876543210",
      threadId: null,
      enabled: true,
      isDefault: true,
    });
  });

  it("binds the group as default publication target when the sender is allowed", async () => {
    const handled = await maybeHandlePublishTargetCommand(makeCtx(), groupMessage());

    expect(handled).toBe(true);
    expect(mocks.upsertDefaultPublicationTarget).toHaveBeenCalledWith(expect.anything(), {
      name: "测试发布群",
      chatId: "-1009876543210",
      threadId: null,
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "token",
      -1009876543210,
      expect.stringContaining("-1009876543210"),
      undefined,
    );
  });

  it("binds the forum topic thread when the command is posted inside one", async () => {
    await maybeHandlePublishTargetCommand(makeCtx(), groupMessage({ message_thread_id: 77 }));

    expect(mocks.upsertDefaultPublicationTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 77 }),
    );
  });

  it("sends every group reply inside the original forum topic (TOPIC_CLOSED regression)", async () => {
    await maybeHandlePublishTargetCommand(
      makeCtx({ chatId: GROUP_CHAT_ID, threadId: 77 }),
      groupMessage({ message_thread_id: 77 }),
    );

    const groupReplies = mocks.sendMessage.mock.calls.filter((call) => call[1] === -1009876543210);
    expect(groupReplies.length).toBeGreaterThan(0);
    for (const call of groupReplies) {
      expect(call[4]).toBe(77);
    }
  });

  it("forwards the topic on the permission refusal too", async () => {
    mocks.canCreateSurvey.mockResolvedValue(false);

    await maybeHandlePublishTargetCommand(
      makeCtx({ chatId: GROUP_CHAT_ID, threadId: 77 }),
      groupMessage({ from: { id: 999, first_name: "Random" }, message_thread_id: 77 }),
    );

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "token",
      -1009876543210,
      expect.stringContaining("只有管理员或创作者"),
      undefined,
      77,
    );
  });

  it("explains a genuinely closed topic when Telegram answers TOPIC_CLOSED", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("Telegram sendMessage failed: 400 Bad Request: TOPIC_CLOSED"));

    await maybeHandlePublishTargetCommand(
      makeCtx({ chatId: GROUP_CHAT_ID, threadId: 77 }),
      groupMessage({ message_thread_id: 77 }),
    );

    expect(mocks.upsertDefaultPublicationTarget).not.toHaveBeenCalled();
    // 私聊通知属于另一个会话，带上群话题会被 Telegram 拒绝（message thread not found）。
    expect(mocks.sendMessage).toHaveBeenCalledWith("token", 42, expect.stringContaining("话题已被关闭"), undefined);
  });

  it("rejects senders without creator or admin rights", async () => {
    mocks.canCreateSurvey.mockResolvedValue(false);

    const handled = await maybeHandlePublishTargetCommand(
      makeCtx(),
      groupMessage({ from: { id: 999, first_name: "Random" } }),
    );

    expect(handled).toBe(true);
    expect(mocks.upsertDefaultPublicationTarget).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "token",
      -1009876543210,
      expect.stringContaining("只有管理员或创作者"),
      undefined,
    );
  });

  it("does not bind a group the bot cannot post in", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("Telegram sendMessage failed: 403 bot was blocked"));

    await maybeHandlePublishTargetCommand(makeCtx(), groupMessage());

    expect(mocks.upsertDefaultPublicationTarget).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith("token", 42, expect.stringContaining("发布目标设置失败"), undefined);
  });

  it("answers the usage hint in private chat without touching the target table", async () => {
    const handled = await maybeHandlePublishTargetCommand(
      makeCtx({ chatId: 42 }),
      groupMessage({ chat: { id: 42, type: "private" } }),
    );

    expect(handled).toBe(true);
    expect(mocks.upsertDefaultPublicationTarget).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith("token", 42, expect.stringContaining("目标群组"), undefined);
  });

  it("ignores unrelated messages", async () => {
    const handled = await maybeHandlePublishTargetCommand(makeCtx(), groupMessage({ text: "大家好" }));

    expect(handled).toBe(false);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
