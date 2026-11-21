import { describe, expect, it } from "vitest";

import {
  chatTabsFor,
  filterChatByChannel,
  gameErrorText,
  mergeChatMessage,
} from "../../../admin/src/survey/game-room-logic";
import type { GameChatMessage } from "../../../src/game/multiplayer/engine-types";

/** 造一条测试消息（可覆盖字段）。 */
function chatMessage(overrides: Partial<GameChatMessage> & { seq: number }): GameChatMessage {
  return {
    channel: "all",
    kind: "text",
    from: "玩家",
    fromHash: "hash-a",
    at: 1_000,
    clientId: `c-${overrides.seq}`,
    text: "hello",
    ...overrides,
  };
}

describe("chatTabsFor（wolves 页签仅狼人可见）", () => {
  it("在座玩家：只有 all；观战者：all + dead", () => {
    expect(chatTabsFor("player")).toEqual(["all"]);
    expect(chatTabsFor("spectator")).toEqual(["all", "dead"]);
  });

  it("狼人资格点亮 wolves 页签；出局资格点亮 dead 页签（R2 批次的接入缝）", () => {
    expect(chatTabsFor("player", { wolf: true })).toEqual(["all", "wolves"]);
    expect(chatTabsFor("player", { dead: true })).toEqual(["all", "dead"]);
    // 观战者不带 dead 资格也可见 dead（观战频道语义），重复不叠加。
    expect(chatTabsFor("spectator", { wolf: true })).toEqual(["all", "wolves", "dead"]);
    expect(chatTabsFor("spectator", { dead: true })).toEqual(["all", "dead"]);
  });
});

describe("mergeChatMessage（seq 去重 + 升序稳定）", () => {
  it("新消息按 seq 追加并升序排列", () => {
    const merged = [chatMessage({ seq: 2 }), chatMessage({ seq: 1 })].reduce(mergeChatMessage, [] as GameChatMessage[]);
    expect(merged.map((message) => message.seq)).toEqual([1, 2]);
  });

  it("重复 seq 的投递被丢弃（回显与广播竞态/服务端重复帧防御）", () => {
    const prev = [chatMessage({ seq: 1 }), chatMessage({ seq: 2 })];
    expect(mergeChatMessage(prev, chatMessage({ seq: 2, text: "重复的" }))).toBe(prev);
    expect(mergeChatMessage(prev, chatMessage({ seq: 3, text: "新的" })).map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe("filterChatByChannel（页签切换过滤）", () => {
  it("只返回当前频道的消息", () => {
    const messages = [
      chatMessage({ seq: 1, channel: "all", text: "a" }),
      chatMessage({ seq: 2, channel: "wolves", text: "b" }),
      chatMessage({ seq: 3, channel: "all", text: "c" }),
      chatMessage({ seq: 4, channel: "dead", text: "d" }),
    ];
    expect(filterChatByChannel(messages, "all").map((m) => m.seq)).toEqual([1, 3]);
    expect(filterChatByChannel(messages, "wolves").map((m) => m.seq)).toEqual([2]);
    expect(filterChatByChannel(messages, "dead").map((m) => m.seq)).toEqual([4]);
  });
});

describe("聊天错误码的中文文案（gameErrorText 收敛）", () => {
  it("聊天新增码全部有可读文案，服务端 message 缺失时不裸抛英文码", () => {
    expect(gameErrorText("chat_too_long")).toBe("消息最长 500 字，请分几条发送");
    expect(gameErrorText("chat_payload_too_large")).toBe("语音/图片超过 300KB 上限，压缩后再发");
    expect(gameErrorText("chat_rate_limited")).toBe("发言太频繁了，休息一下再试");
    expect(gameErrorText("chat_channel_forbidden")).toBe("你不在该频道的可见范围内");
    expect(gameErrorText("chat_content_rejected")).toBe("内容包含不允许的字词，请修改后再试");
    // 服务端的具体 message 优先展示。
    expect(gameErrorText("chat_rate_limited", "发言太频繁了，请 42 秒后再试")).toBe("发言太频繁了，请 42 秒后再试");
  });
});
