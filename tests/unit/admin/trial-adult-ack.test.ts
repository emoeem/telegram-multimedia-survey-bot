import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRIAL_AGREEMENT_GLOBAL_KEY,
  TRIAL_PACK_ACKS_KEY,
  ackAdultPackLocally,
  isAdultPackAckedLocally,
  isAdultPackAckedIn,
  parseTrialPackAcks,
  readTrialPackAcks,
  removeAdultPackAckLocally,
  withPackAck,
  withoutPackAck,
} from "../../../admin/src/survey/trial-adult-ack";

/**
 * /trial 包级 18+ ack 的客户端语义（0104，语义选定见 trial-adult-ack.ts 头注释）：
 * ① 包级键为权威且**绝不回写**全局键 trialAdultAgreement:v1；
 * ② 全局键 === '1' 单向兼容视为已 ack 所有包（存量用户零回归）；
 * ③ 解析/写入对脏数据与重复确认健壮。
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

describe("trial-adult-ack（/trial 包级 18+ ack 语义 0104）", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("① 包级 ack 只写包级键，绝不回写全局键（未设置时保持不存在）", () => {
    ackAdultPackLocally(5);
    expect(store.has(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe(false);
    expect(store.get(TRIAL_PACK_ACKS_KEY)).toBe("[5]");
    expect(readTrialPackAcks()).toEqual([5]);
    expect(isAdultPackAckedLocally(5)).toBe(true);
    // 包级粒度：ack 了 5 不等于 ack 了 6。
    expect(isAdultPackAckedLocally(6)).toBe(false);
  });

  it("① 全局键已存在时包级 ack 也不改写它（不同值都不写）", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "0");
    ackAdultPackLocally(5);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("0");
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    ackAdultPackLocally(6);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("1");
  });

  it("② 全局键 '1' 单向兼容视为已 ack 所有包；非 '1' 值不算", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    expect(isAdultPackAckedLocally(1)).toBe(true);
    expect(isAdultPackAckedLocally(999)).toBe(true);
    expect(isAdultPackAckedIn("0", [], 1)).toBe(false);
    expect(isAdultPackAckedIn(null, [], 1)).toBe(false);
  });

  it("② 既有全局键用户确认新包后仍是全局 '1'（/s 侧读取不受影响）", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    ackAdultPackLocally(7);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("1");
    // 全局键用户对任意包都不再被询问。
    expect(isAdultPackAckedLocally(7)).toBe(true);
    expect(isAdultPackAckedLocally(8)).toBe(true);
  });

  it("③ 重复确认幂等、列表升序；解析容忍脏数据", () => {
    ackAdultPackLocally(9);
    ackAdultPackLocally(2);
    ackAdultPackLocally(9);
    expect(readTrialPackAcks()).toEqual([2, 9]);
    expect(withPackAck([2, 9], 9)).toEqual([2, 9]);
    expect(parseTrialPackAcks(null)).toEqual([]);
    expect(parseTrialPackAcks("not-json")).toEqual([]);
    expect(parseTrialPackAcks('{"a":1}')).toEqual([]);
    expect(parseTrialPackAcks('[3,"x",0,-1,1.5,5]')).toEqual([3, 5]);
    store.set(TRIAL_PACK_ACKS_KEY, "[1,2,3]");
    expect(withPackAck([1, 2, 3], 4)).toEqual([1, 2, 3, 4]);
  });

  it("451 自愈：removeAdultPackAckLocally 只清该包包级键，全局键零改写", () => {
    store.set(TRIAL_AGREEMENT_GLOBAL_KEY, "1");
    ackAdultPackLocally(5);
    ackAdultPackLocally(6);
    // 清掉 5：包级列表收回、6 保留；全局键原样（语义①在自愈路径同样成立）。
    expect(removeAdultPackAckLocally(5)).toEqual([6]);
    expect(readTrialPackAcks()).toEqual([6]);
    expect(store.get(TRIAL_AGREEMENT_GLOBAL_KEY)).toBe("1");
    expect(isAdultPackAckedLocally(5)).toBe(true); // 仍由全局键兼容放行
    // 清掉不在列表里的包是 no-op。
    expect(removeAdultPackAckLocally(7)).toEqual([6]);
    removeAdultPackAckLocally(6);
    // 全局键用户清完全部包级 ack 后仍被全局键放行。
    expect(isAdultPackAckedLocally(6)).toBe(true);
    // 全局键不存在时：自愈后该包回到未 ack（下次交互重弹按包确认）。
    store.delete(TRIAL_AGREEMENT_GLOBAL_KEY);
    expect(isAdultPackAckedLocally(6)).toBe(false);
    expect(parseTrialPackAcks(store.get(TRIAL_PACK_ACKS_KEY) ?? null)).toEqual([]);
  });

  it("withoutPackAck 纯移除：缺席 no-op、存在则剔除", () => {
    expect(withoutPackAck([2, 9], 9)).toEqual([2]);
    expect(withoutPackAck([2, 9], 5)).toEqual([2, 9]);
    expect(withoutPackAck([], 1)).toEqual([]);
  });

  it("localStorage 不可用时静默降级（不抛错、按未 ack 处理）", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(isAdultPackAckedLocally(1)).toBe(false);
    expect(() => ackAdultPackLocally(1)).not.toThrow();
    expect(() => removeAdultPackAckLocally(1)).not.toThrow();
  });
});
