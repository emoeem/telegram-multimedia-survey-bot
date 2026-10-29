import { afterEach, describe, expect, it, vi } from "vitest";

import { vibrateFail, vibrateLight, vibrateSuccess } from "../../../admin/src/survey/haptics";

/**
 * 提交反馈的震动：两条通路（Telegram HapticFeedback + navigator.vibrate）。
 *
 * 为什么两处都写：Mini App（尤其 iOS）里 `navigator.vibrate` 根本不存在，只有
 * `HapticFeedback.notificationOccurred` 会真的震；普通浏览器里反过来。
 * 之前这两条一条都没有接进提交路径，所以"提交失败"对用户来说是彻底静默的。
 *
 * 这里钉住的是"两条都试、谁不在都别抛错"——抛错会打断 submit 的失败处理，
 * 把"提交失败"变成"页面报错"。
 */
function stubEnvironment({
  vibrate,
  haptics,
}: {
  vibrate?: (pattern: number | number[]) => boolean;
  haptics?: { notificationOccurred?: (t: string) => void; impactOccurred?: (s: string) => void };
}): { notification: ReturnType<typeof vi.fn>; impact: ReturnType<typeof vi.fn> } {
  vi.stubGlobal("navigator", vibrate ? { vibrate: vi.fn(vibrate) } : {});
  // 实现按 `globalThis.Telegram` 读取（同一份代码要在 WebWorker lib 下也编得过，
  // 那里没有 `window` 这个标识符）。
  vi.stubGlobal("Telegram", haptics ? { WebApp: { HapticFeedback: haptics } } : undefined);
  return {
    notification: (haptics?.notificationOccurred as ReturnType<typeof vi.fn>) ?? vi.fn(),
    impact: (haptics?.impactOccurred as ReturnType<typeof vi.fn>) ?? vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("提交震动反馈", () => {
  it("成功：Telegram 通知 + navigator 短震一次", () => {
    const calls: string[] = [];
    const vibrate = vi.fn(() => true);
    stubEnvironment({ vibrate, haptics: { notificationOccurred: (t) => calls.push(t) } });

    vibrateSuccess();

    expect(calls).toEqual(["success"]);
    expect(vibrate).toHaveBeenCalledWith(25);
  });

  it("失败：Telegram 错误震动 + navigator 三连震（比成功那次更明显）", () => {
    const calls: string[] = [];
    const vibrate = vi.fn(() => true);
    stubEnvironment({ vibrate, haptics: { notificationOccurred: (t) => calls.push(t) } });

    vibrateFail();

    expect(calls).toEqual(["error"]);
    expect(vibrate).toHaveBeenCalledWith([60, 40, 80]);
  });

  it("Mini App 里没有 navigator.vibrate（iOS）时仍然震动，且不抛错", () => {
    const calls: string[] = [];
    stubEnvironment({ haptics: { notificationOccurred: (t) => calls.push(t) } });

    expect(() => vibrateSuccess()).not.toThrow();
    expect(() => vibrateFail()).not.toThrow();
    expect(calls).toEqual(["success", "error"]);
  });

  it("普通浏览器里没有 Telegram WebApp 时走 navigator 兜底", () => {
    const vibrate = vi.fn(() => true);
    stubEnvironment({ vibrate });

    expect(() => vibrateFail()).not.toThrow();
    expect(vibrate).toHaveBeenCalledWith([60, 40, 80]);
  });

  it("两个都没有时是静默 no-op（不能因为没法震动就让提交路径失败）", () => {
    stubEnvironment({});

    expect(() => vibrateSuccess()).not.toThrow();
    expect(() => vibrateFail()).not.toThrow();
    expect(() => vibrateLight()).not.toThrow();
  });

  it("平台抛错（无用户手势 / 老客户端）被吞掉，不打断提交", () => {
    stubEnvironment({
      vibrate: () => {
        throw new Error("NotAllowedError");
      },
      haptics: {
        notificationOccurred: () => {
          throw new Error("unsupported");
        },
      },
    });

    expect(() => vibrateSuccess()).not.toThrow();
    expect(() => vibrateFail()).not.toThrow();
  });

  it("vibrateLight 只给轻触反馈（翻页/选择），不冒充成功或失败", () => {
    const calls: string[] = [];
    const vibrate = vi.fn(() => true);
    stubEnvironment({
      vibrate,
      haptics: { notificationOccurred: (t) => calls.push(t), impactOccurred: (s) => calls.push(s) },
    });

    vibrateLight();

    expect(calls).toEqual(["light"]);
    expect(vibrate).toHaveBeenCalledWith(15);
  });
});
