import { describe, expect, it } from "vitest";

import { NOTE_POLL_BACKOFF_STEPS_MS, NOTE_POLL_BASE_MS, nextPollInterval } from "../../../admin/src/survey/note-poll";

/**
 * 纸条对话屏的轮询退避（T3）：固定 15s ≈ 240 请求/小时/人；退避后无新消息
 * 最低降到 60 请求/小时，回信到达立刻回落。这里锁的是决策本身——各级跳变
 * 与回落都由纯函数给出，组件（NoteScreen 的 ChatView）只负责调度。
 */
describe("nextPollInterval（纸条对话轮询退避）", () => {
  it("无新消息沿 15s→30s→60s 退避并在末档封顶", () => {
    expect(NOTE_POLL_BASE_MS).toBe(15_000);
    expect(nextPollInterval(15_000, false)).toBe(30_000);
    expect(nextPollInterval(30_000, false)).toBe(60_000);
    expect(nextPollInterval(60_000, false)).toBe(60_000);
  });

  it("有新消息从任意档回落最快档", () => {
    for (const step of NOTE_POLL_BACKOFF_STEPS_MS) {
      expect(nextPollInterval(step, true)).toBe(NOTE_POLL_BASE_MS);
    }
  });

  it("异常档位归类后继续退避：偏快按最快档进一档，偏慢封在末档", () => {
    expect(nextPollInterval(0, false)).toBe(30_000);
    expect(nextPollInterval(999_999, false)).toBe(60_000);
  });
});
