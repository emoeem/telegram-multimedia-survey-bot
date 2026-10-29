import { describe, expect, it } from "vitest";

import {
  atomicRateLimitCount,
  readAtomicRateLimitCountFromBatch,
  skipAtomicRateLimitStatement,
} from "../../../src/services/rate-limit.service";

/**
 * skipAtomicRateLimitStatement 的读取契约（曾真实出错：旧哨兵是 `SELECT 0`，
 * 而 atomicRateLimitCount 的兜底把非正数钳成 1——注释说「读回 0」，实际全站
 * 调用方看到的都是 1。只要有人写出一个 `count >= 1` 形态的闸门，「跳过限流」
 * 就变成「第一发即中」。-1 哨兵 + 显式处理把两条路都堵死，这里的三个用例就是
 * 那份契约）。
 */
describe("skipAtomicRateLimitStatement 哨兵契约", () => {
  it("哨兵语句返回 -1，读回 0（never counted）", () => {
    const db = {
      prepare(sql: string) {
        expect(sql).toBe("SELECT -1 AS count");
        return { sql };
      },
    } as unknown as D1Database;
    const statement = skipAtomicRateLimitStatement(db);
    expect(atomicRateLimitCount({ count: -1 })).toBe(0);
    expect(statement).toBeDefined();
  });

  it("batch 里的哨兵结果读回 0；真实计数原样读回", () => {
    expect(readAtomicRateLimitCountFromBatch({ results: [{ count: -1 }] } as never)).toBe(0);
    expect(readAtomicRateLimitCountFromBatch({ results: [{ count: 7 }] } as never)).toBe(7);
    expect(readAtomicRateLimitCountFromBatch({ results: [{ count: 1 }] } as never)).toBe(1);
  });

  it("结果缺失（语句没执行/行不存在）保守回 1，不是 0", () => {
    expect(atomicRateLimitCount(null)).toBe(1);
    expect(atomicRateLimitCount(undefined)).toBe(1);
    expect(atomicRateLimitCount({})).toBe(1);
    expect(readAtomicRateLimitCountFromBatch(undefined)).toBe(1);
  });
});
