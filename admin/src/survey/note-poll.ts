/**
 * 纸条对话屏的轮询退避（T3 · 成本红线 docs/ops/COST-GUARDRAILS.md）。
 *
 * 固定 15s ≈ 240 请求/小时/人；改为可见性感知退避后，无新消息沿
 * 15s→30s→60s 退避（挂后台即暂停），回信一到立刻回落最快档保住体感。
 * 决策抽成纯函数（tests/unit/admin/note-poll.test.ts 锚点），组件只做调度。
 */

export const NOTE_POLL_BASE_MS = 15_000;
export const NOTE_POLL_BACKOFF_STEPS_MS: readonly number[] = [15_000, 30_000, 60_000];

/** 下一轮轮询间隔：有新消息回落最快档；无新消息沿阶梯退一档（封顶最后一档）。 */
export function nextPollInterval(currentMs: number, gotNewMessages: boolean): number {
  if (gotNewMessages) return NOTE_POLL_BASE_MS;
  let at = NOTE_POLL_BACKOFF_STEPS_MS.indexOf(currentMs);
  if (at === -1) {
    // 异常档位（历史值/外部改动）：归到「不慢于当前值的最小档」再退一档。
    at = NOTE_POLL_BACKOFF_STEPS_MS.findIndex((step) => step >= currentMs);
    if (at === -1) at = NOTE_POLL_BACKOFF_STEPS_MS.length - 1;
  }
  return NOTE_POLL_BACKOFF_STEPS_MS[Math.min(at + 1, NOTE_POLL_BACKOFF_STEPS_MS.length - 1)]!;
}
