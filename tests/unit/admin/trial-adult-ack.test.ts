import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRIAL_AGREEMENT_GLOBAL_KEY,
  TRIAL_PACK_ACK_PREFIX,
  ackAdultPackLocally,
  isAdultPackAckedIn,
  isAdultPackAckedLocally,
  readGlobalAdultAck,
  trialPackAckKey,
} from "../../../admin/src/survey/trial-adult-ack";

/**
 * /trial 包级 18+ ack 的客户端键语义（0106，语义选定见 trial-adult-ack.ts 头注释）：
 * ① 包级确认存 localStorage，键含 pack id（trialAdultPackAck:v1:<packId>），
 *    绝不回写全局键 trialAdultAgreement:v1；
 * ② 全局键 '1' 只读单向兼容视为已 ack 所有包（存量用户零回归）；
 * ③ localStorage 不可用时静默降级（按未 ack 处理，不抛错）。
 * localStorage 用 Map 桩（storage.ts 走 globalThis["localStorage"]）。
 */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

describe("trial-adult-ack（0106 包级 18+ ack 键）", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("① 键含 pack id：不同包不同键", () => {
    expect(trialPackAckKey(5)).toBe(`${TRIAL_PACK_ACK_PREFIX}5`);
    expect(trialPackAckKey(6)).toBe(`${TRIAL_PACK_ACK_PREFIX}6`);
    expect(trialPackAckKey(5)).not.toBe(trialPackAckKey(6));
  });

  it("① 包级 ack 只写该包的包级键，绝不回写全局键（未设置时保持不存在）", () => {
    ackAdultPackLocally(5);
    expect(store.has(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe(false);
    expect(store.get(trialPackAckKey(5))).toBe("1");
    expect(isAdultPackAckedLocally(5)).toBe(true);
    // 包级粒度：ack 了 5 不等于 ack 了 6。
    expect(store.has(trialPackAckKey(6))).toBe(false);
    expect(isAdultPackAckedLocally(6)).toBe(false);
  });

  it("① 全局键已存在时包级 ack 也不改写它（语义①在兼容路径同样成立）", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "0");
    ackAdultPackLocally(5);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("0");
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    ackAdultPackLocally(6);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("1");
    expect(readGlobalAdultAck()).toBe("1");
  });

  it("② 纯判定：全局键 '1' 单向兼容放行所有包；非 '1' 值与 null 只看包级键", () => {
    expect(isAdultPackAckedIn("1", null)).toBe(true);
    expect(isAdultPackAckedIn("1", "0")).toBe(true);
    expect(isAdultPackAckedIn("0", null)).toBe(false);
    expect(isAdultPackAckedIn(null, "1")).toBe(true);
    expect(isAdultPackAckedIn(null, null)).toBe(false);
    expect(isAdultPackAckedIn(null, "0")).toBe(false);
    // 脏值（非 '1'）不算已 ack：全局脏值 + 无包级键 → 未 ack。
    expect(isAdultPackAckedIn("yes", null)).toBe(false);
    // 包级键有效时与全局脏值无关（包级键 own 判定）。
    expect(isAdultPackAckedIn("yes", "1")).toBe(true);
  });

  it("② 既有全局键用户确认新包后仍是全局 '1'（/s 侧读取不受影响）", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    ackAdultPackLocally(7);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("1");
    // 全局键用户对任意包都不再被询问（存量零回归）。
    expect(isAdultPackAckedLocally(7)).toBe(true);
    expect(isAdultPackAckedLocally(8)).toBe(true);
  });

  it("③ 重复确认幂等（重写同一包级键）", () => {
    ackAdultPackLocally(9);
    ackAdultPackLocally(9);
    expect(store.get(trialPackAckKey(9))).toBe("1");
    expect(isAdultPackAckedLocally(9)).toBe(true);
  });

  it("③ localStorage 不可用时静默降级（不抛错、按未 ack 处理）", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(isAdultPackAckedLocally(1)).toBe(false);
    expect(() => ackAdultPackLocally(1)).not.toThrow();
    expect(readGlobalAdultAck()).toBeNull();
  });
});
