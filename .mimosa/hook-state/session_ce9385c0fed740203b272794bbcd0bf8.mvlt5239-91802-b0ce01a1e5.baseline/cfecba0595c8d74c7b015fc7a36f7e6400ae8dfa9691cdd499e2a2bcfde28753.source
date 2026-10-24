import { describe, expect, it, vi } from "vitest";

import { AnswerSaveQueue, type SaveTask } from "../../../admin/src/survey/save-queue";

/** 手动时钟的 deferred：测试用它精确控制在途请求的完成顺序。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AnswerSaveQueue", () => {
  it("按入队顺序串行发送，不并发", async () => {
    const sent: number[] = [];
    // 容器绕开 TS 对闭包赋值的控制流收窄（直接用 let 会被收窄成 never）。
    const gate: { release: (() => void) | null } = { release: null };
    const queue = new AnswerSaveQueue(async (task: SaveTask) => {
      sent.push(task.questionId);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    });
    queue.enqueue({ questionId: 3, value: "a" });
    queue.enqueue({ questionId: 5, value: "b" });
    queue.enqueue({ questionId: 7, value: "c" });
    await vi.waitFor(() => expect(sent).toEqual([3]));
    gate.release?.();
    await vi.waitFor(() => expect(sent).toEqual([3, 5]));
    gate.release?.();
    await vi.waitFor(() => expect(sent).toEqual([3, 5, 7]));
    gate.release?.();
    await vi.waitFor(() => expect(queue.hasUnsaved).toBe(false));
  });

  it("同题的排队旧值被新值覆盖，不同题互不吞并", async () => {
    const sent: SaveTask[] = [];
    const gate = deferred<void>();
    const queue = new AnswerSaveQueue(async (task) => {
      sent.push(task);
      if (sent.length === 1) await gate.promise;
    });
    queue.enqueue({ questionId: 3, value: "v1" });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // Q3 在途，Q4/Q3/Q4 排队：Q3 的 v2 覆盖 v1，Q4 只发一份。
    queue.enqueue({ questionId: 4, value: "x1" });
    queue.enqueue({ questionId: 3, value: "v2" });
    queue.enqueue({ questionId: 4, value: "x2" });
    expect(queue.pendingCount).toBe(2);
    gate.resolve();
    await vi.waitFor(() => expect(sent.length).toBe(3));
    expect(sent.map((task) => [task.questionId, task.value])).toEqual([
      [3, "v1"],
      [4, "x2"],
      [3, "v2"],
    ]);
    await vi.waitFor(() => expect(queue.hasUnsaved).toBe(false));
  });

  it("发送失败保留条目并回调，重新作答同题会清掉失败", async () => {
    const failures: Array<number | null> = [];
    let shouldFail = true;
    const queue = new AnswerSaveQueue(
      async (task) => {
        if (shouldFail && task.questionId === 9) throw new Error("network");
      },
      { onFailureChange: (id) => failures.push(id) },
    );
    queue.enqueue({ questionId: 9, value: "z" });
    await vi.waitFor(() => expect(queue.failedQuestionId).toBe(9));
    expect(queue.hasUnsaved).toBe(true);
    expect(failures).toEqual([9]);

    // 用户改了同一题的答案并再次翻题：失败被清除，新值重新排队且成功。
    shouldFail = false;
    queue.enqueue({ questionId: 9, value: "z2" });
    await vi.waitFor(() => expect(queue.hasUnsaved).toBe(false));
    expect(queue.failedQuestionId).toBeNull();
    expect(failures).toEqual([9, null]);
  });

  it("flushSaves 重发失败条目：全部成功返回 true", async () => {
    let attempts = 0;
    const queue = new AnswerSaveQueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("flaky");
    });
    queue.enqueue({ questionId: 2, value: 42 });
    await vi.waitFor(() => expect(queue.failedQuestionId).toBe(2));
    const ok = await queue.flushSaves();
    expect(ok).toBe(true);
    expect(attempts).toBe(2);
    expect(queue.hasUnsaved).toBe(false);
  });

  it("flushSaves 在重发仍失败时返回 false，不丢答案", async () => {
    const queue = new AnswerSaveQueue(async () => {
      throw new Error("down");
    });
    queue.enqueue({ questionId: 2, value: 42 });
    await vi.waitFor(() => expect(queue.failedQuestionId).toBe(2));
    const ok = await queue.flushSaves();
    expect(ok).toBe(false);
    expect(queue.failedQuestionId).toBe(2);
    expect(queue.hasUnsaved).toBe(true);
  });

  it("reset 丢弃未发送与失败任务并回调清零", async () => {
    const failures: Array<number | null> = [];
    const queue = new AnswerSaveQueue(
      async () => {
        throw new Error("down");
      },
      { onFailureChange: (id) => failures.push(id) },
    );
    queue.enqueue({ questionId: 1, value: "a" });
    queue.enqueue({ questionId: 2, value: "b" });
    await vi.waitFor(() => expect(queue.failedQuestionId).not.toBeNull());
    queue.reset();
    expect(queue.pendingCount).toBe(0);
    expect(queue.hasUnsaved).toBe(false);
    expect(queue.failedQuestionId).toBeNull();
    expect(failures.at(-1)).toBeNull();
  });
});
