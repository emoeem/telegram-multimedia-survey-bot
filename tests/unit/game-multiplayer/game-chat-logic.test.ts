import { describe, expect, it } from "vitest";

import {
  canAccessChannel,
  chatChannelAccess,
  chatPurgeRequired,
  chatRateFilter,
  chatRingEvictionSeq,
  chatSeqKey,
  validateChatImage,
  validateChatText,
  validateChatVoice,
  visibleChatHistory,
} from "../../../src/game/multiplayer/chat-logic";
import {
  CHAT_BASE64_MAX_CHARS,
  CHAT_HISTORY_LIMIT,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  type GameChatChannel,
  type GameChatMessage,
} from "../../../src/game/multiplayer/engine-types";

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

// ---------------------------------------------------------------------------
// 频道资格矩阵（裁剪的唯一事实来源）
// ---------------------------------------------------------------------------

describe("chatChannelAccess（频道资格矩阵）", () => {
  it("在座玩家（无引擎钩子）：只有 all", () => {
    const access = chatChannelAccess({ isActivePlayer: true, isSpectator: false, hook: null });
    expect(access).toEqual({ all: true, wolves: false, dead: false });
    expect(canAccessChannel(access, "all")).toBe(true);
    expect(canAccessChannel(access, "wolves")).toBe(false);
    expect(canAccessChannel(access, "dead")).toBe(false);
  });

  it("观战者：all + dead（观战频道），绝无 wolves", () => {
    const access = chatChannelAccess({ isActivePlayer: false, isSpectator: true, hook: null });
    expect(access).toEqual({ all: true, wolves: false, dead: true });
  });

  it("狼人（引擎钩子）：all + wolves；非狼即使同房也拿不到 wolves", () => {
    const wolf = chatChannelAccess({ isActivePlayer: true, isSpectator: false, hook: { isWolf: true, isDead: false } });
    expect(wolf.wolves).toBe(true);
    const villager = chatChannelAccess({
      isActivePlayer: true,
      isSpectator: false,
      hook: { isWolf: false, isDead: false },
    });
    expect(villager.wolves).toBe(false);
  });

  it("引擎标记出局（死亡）：退到 dead 频道，失去 all（狼人杀语义：出局者退出活人讨论）", () => {
    const access = chatChannelAccess({
      isActivePlayer: true,
      isSpectator: false,
      hook: { isWolf: false, isDead: true },
    });
    expect(access).toEqual({ all: false, wolves: false, dead: true });
  });

  it("未知频道名（运行时脏数据）：一律不可访问", () => {
    const access = chatChannelAccess({ isActivePlayer: true, isSpectator: false, hook: null });
    expect(canAccessChannel(access, "submarine" as GameChatChannel)).toBe(false);
  });
});

describe("visibleChatHistory（历史按查看者裁剪）", () => {
  it("非狼查看者的历史里绝不出现 wolves 消息（泄漏断言的纯函数侧）", () => {
    const access = chatChannelAccess({
      isActivePlayer: true,
      isSpectator: false,
      hook: { isWolf: false, isDead: false },
    });
    const history = [
      chatMessage({ seq: 1, channel: "all", text: "大家好" }),
      chatMessage({ seq: 2, channel: "wolves", text: "今晚刀谁" }),
      chatMessage({ seq: 3, channel: "all", text: "再来一局" }),
    ];
    const visible = visibleChatHistory(history, access);
    expect(visible.map((message) => message.seq)).toEqual([1, 3]);
    expect(JSON.stringify(visible)).not.toContain("今晚刀谁");
  });

  it("狼人查看者能收到 wolves 历史；观战者额外收 dead 历史", () => {
    const wolfAccess = chatChannelAccess({
      isActivePlayer: true,
      isSpectator: false,
      hook: { isWolf: true, isDead: false },
    });
    const spectatorAccess = chatChannelAccess({ isActivePlayer: false, isSpectator: true, hook: null });
    const history = [
      chatMessage({ seq: 1, channel: "all" }),
      chatMessage({ seq: 2, channel: "wolves", text: "夜聊" }),
      chatMessage({ seq: 3, channel: "dead", text: "观战席" }),
    ];
    expect(visibleChatHistory(history, wolfAccess).map((m) => m.seq)).toEqual([1, 2]);
    expect(visibleChatHistory(history, spectatorAccess).map((m) => m.seq)).toEqual([1, 3]);
  });
});

// ---------------------------------------------------------------------------
// 内容校验（大小限制 → 明确错误码）
// ---------------------------------------------------------------------------

describe("validateChatText（500 字上限 + 词表审核）", () => {
  it("边界：500 字放行（trim 后），501 字拒绝 chat_too_long", () => {
    const ok = validateChatText(`  ${"好".repeat(CHAT_TEXT_MAX_CHARS)}  `);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe("好".repeat(CHAT_TEXT_MAX_CHARS));
    const tooLong = validateChatText("好".repeat(CHAT_TEXT_MAX_CHARS + 1));
    expect(tooLong).toMatchObject({ ok: false, code: "chat_too_long" });
  });

  it("空串/纯空白/非字符串拒绝 invalid_payload", () => {
    expect(validateChatText("")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatText("   ")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatText(123)).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("接入仓库现有词表审核：命中敏感词返回 chat_content_rejected", () => {
    expect(validateChatText("加我进刷单群")).toMatchObject({ ok: false, code: "chat_content_rejected" });
    expect(validateChatText("今天天气不错")).toMatchObject({ ok: true });
  });
});

describe("validateChatVoice / validateChatImage（300KB base64 上限）", () => {
  it("语音：≤300KB 且时长在卫生区间内放行；超限 chat_payload_too_large", () => {
    const ok = validateChatVoice("a".repeat(1024), 1_500, "audio/webm;codecs=opus");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.mimeType).toBe("audio/webm;codecs=opus");
    const tooLarge = validateChatVoice("a".repeat(CHAT_BASE64_MAX_CHARS + 1), 1_500, "audio/webm");
    expect(tooLarge).toMatchObject({ ok: false, code: "chat_payload_too_large" });
  });

  it("语音：mime 缺省兜底 audio/webm；时长非法（0/负/NaN/超卫生上限）拒绝 invalid_payload", () => {
    expect(validateChatVoice("abc", 1_000, undefined)).toMatchObject({ ok: true });
    expect(validateChatVoice("abc", 0, "audio/webm")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatVoice("abc", -5, "audio/webm")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatVoice("abc", Number.NaN, "audio/webm")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatVoice("abc", 120_000, "audio/webm")).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("图片：必须 data:image/ 前缀；超 300KB 拒 chat_payload_too_large", () => {
    expect(validateChatImage("data:image/png;base64,AAAA")).toMatchObject({ ok: true });
    expect(validateChatImage("data:text/html;base64,AAAA")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatImage("<script>")).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(validateChatImage(`data:image/jpeg;base64,${"A".repeat(CHAT_BASE64_MAX_CHARS)}`)).toMatchObject({
      ok: false,
      code: "chat_payload_too_large",
    });
  });
});

// ---------------------------------------------------------------------------
// 速率（每参与者滑动窗口）
// ---------------------------------------------------------------------------

describe("chatRateFilter（10 条/分钟滑动窗口）", () => {
  const LIMIT = CHAT_RATE_LIMIT;
  const WINDOW = CHAT_RATE_WINDOW_MS;

  it("窗口内第 11 条被拒，建议等待时间指向最早一条过期", () => {
    const now = 1_000_000;
    let window: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) {
      const decision = chatRateFilter(window, now + i, LIMIT, WINDOW);
      expect(decision.allowed).toBe(true);
      window = decision.next;
    }
    const rejected = chatRateFilter(window, now + LIMIT, LIMIT, WINDOW);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(WINDOW);
  });

  it("滑动：窗口滑过后放行（60s 之前的记录不再计数）", () => {
    const now = 2_000_000;
    const full = Array.from({ length: LIMIT }, (_, i) => now - WINDOW - 1 - i); // 全部已滑出窗口
    const decision = chatRateFilter(full, now, LIMIT, WINDOW);
    expect(decision.allowed).toBe(true);
    expect(decision.next).toEqual([now]);
  });

  it("被拒的尝试不占窗口（next 原样返回，不会越拒越久）", () => {
    const now = 3_000_000;
    const window = Array.from({ length: LIMIT }, (_, i) => now - i * 100);
    const first = chatRateFilter(window, now, LIMIT, WINDOW);
    expect(first.allowed).toBe(false);
    const second = chatRateFilter(first.next, now + 1_000, LIMIT, WINDOW);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBe(first.retryAfterMs - 1_000);
  });
});

// ---------------------------------------------------------------------------
// 环形上限与键序
// ---------------------------------------------------------------------------

describe("chatRingEvictionSeq / chatSeqKey（环形 50 条）", () => {
  it("未满 cap 不淘汰；第 cap+1 条淘汰第 1 条；此后追随 latest-cap", () => {
    expect(chatRingEvictionSeq(CHAT_HISTORY_LIMIT, CHAT_HISTORY_LIMIT)).toBeNull();
    expect(chatRingEvictionSeq(CHAT_HISTORY_LIMIT + 1, CHAT_HISTORY_LIMIT)).toBe(1);
    expect(chatRingEvictionSeq(100, 50)).toBe(50);
    expect(chatRingEvictionSeq(1, 50)).toBeNull();
  });

  it("零填充键保证字典序 = 数值序（storage.list 前缀读出即时间序）", () => {
    expect(chatSeqKey(9) < chatSeqKey(10)).toBe(true);
    expect(chatSeqKey(99) < chatSeqKey(100)).toBe(true);
    expect(chatSeqKey(1)).toBe("chat:m:000000000001");
  });
});

// ---------------------------------------------------------------------------
// 即焚时机
// ---------------------------------------------------------------------------

describe("chatPurgeRequired（settle / close 即焚；回收由 deleteAll 兜底）", () => {
  it("settled 与 closed 必须焚毁；lobby 与 playing 不焚", () => {
    expect(chatPurgeRequired("settled")).toBe(true);
    expect(chatPurgeRequired("closed")).toBe(true);
    expect(chatPurgeRequired("lobby")).toBe(false);
    expect(chatPurgeRequired("playing")).toBe(false);
  });
});
