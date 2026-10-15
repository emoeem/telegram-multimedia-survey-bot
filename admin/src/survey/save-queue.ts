/**
 * 答案保存队列 —— 乐观翻题的后台持久化层。
 *
 * 导航不再等待保存往返：点击「下一题/上一题」立即切题，答案进入这个队列按序
 * 落库。语义约束（每一条都对应一个曾经的 bug 或一次评审关注点）：
 *
 * - 串行：同一时刻只有一个在途请求，后一条等前一条 settle。服务端按
 *   (responseId, questionId) upsert 并把 current_question_id 指到刚写的题，
 *   串行发送保证了服务端看到的写入顺序与用户作答顺序一致。
 * - 只合并同题可替代更新：队列里同一题的未发送旧值被新值覆盖（服务端本来
 *   就是按题 upsert，中间值无意义）；不同题的条目绝不互相吞并。在途请求不动，
 *   新值排在其后发送，最终态仍以最新值为准。
 * - 失败保留：发送失败（API 层重试耗尽后）的条目记入 failures，不静默丢弃；
 *   同题后续的重新作答会清掉失败记录并重新排队。flushSaves 会先重发全部失败
 *   条目再等待队列排空，供提交前调用。
 *
 * 本模块不触碰 DOM / React：发送函数由调用方注入，便于单测。
 */

export interface SaveTask {
  questionId: number;
  value: unknown;
}

export type SaveSender = (task: SaveTask) => Promise<unknown>;

export interface SaveQueueOptions {
  /** 队列状态变化的回调（等待发送的条数），用于界面上的「同步中」指示。 */
  onPendingChange?: (pendingCount: number) => void;
  /** 出现第一条保存失败时回调（参数为失败的题）；恢复后以 null 回调。 */
  onFailureChange?: (failedQuestionId: number | null) => void;
}

export class AnswerSaveQueue {
  private tasks: SaveTask[] = [];

  private running = false;

  private readonly failures = new Map<number, unknown>();

  private readonly drainWaiters: Array<() => void> = [];

  constructor(private readonly sender: SaveSender, private readonly options: SaveQueueOptions = {}) {}

  /** 等待发送的条数（不含在途请求）。 */
  get pendingCount(): number {
    return this.tasks.length;
  }

  /** 是否有请求正在发送。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 当前失败的题（至多跟踪一条，供界面提示）；无失败时为 null。 */
  get failedQuestionId(): number | null {
    const first = this.failures.keys().next();
    return first.done ? null : first.value;
  }

  /** 是否还有未落库的内容（排队中、在途或失败）。 */
  get hasUnsaved(): boolean {
    return this.tasks.length > 0 || this.running || this.failures.size > 0;
  }

  /**
   * 追加一条保存。同题的排队中旧值被替换；同题的失败记录被清除（本次发送
   * 若再失败会重新记入）。同一题正在在途时不做任何特殊处理——新值排在后面，
   * 最终以最新值为准。
   */
  enqueue(task: SaveTask): void {
    const existingIndex = this.tasks.findIndex((entry) => entry.questionId === task.questionId);
    if (existingIndex >= 0) this.tasks[existingIndex] = task;
    else this.tasks.push(task);
    if (this.failures.delete(task.questionId) && this.failures.size === 0) {
      this.options.onFailureChange?.(null);
    }
    this.emitPending();
    void this.pump();
  }

  /**
   * 把当前全部失败条目重新入队（保留原值），并等待队列完全排空。
   * 返回 false 表示排空后仍有失败条目（调用方应阻止提交并提示重试）。
   */
  async flushSaves(): Promise<boolean> {
    for (const [questionId, value] of this.failures) {
      this.failures.delete(questionId);
      this.tasks.push({ questionId, value });
    }
    if (this.tasks.length > 0 || this.running) {
      this.emitPending();
      // 泵可能处于空闲（失败条目不占队列）：重排后必须显式踢一脚，
      // 否则没有在途循环来唤醒下面的等待者。
      void this.pump();
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    return this.failures.size === 0;
  }

  /** 丢弃一切未发送/失败的任务（开始新答卷或整卷重载时调用）。 */
  reset(): void {
    this.tasks = [];
    // 注意不动 running：在途请求让它自然收尾——它的 sender 已在调用时捕获了
    // 旧答卷标识，写入旧答卷是正确语义；清空 running 反而可能让新任务在旧泵
    // 还没退出时再起一个泵，破坏串行保证。新任务会被收尾中的泵接管，并在
    // 发送时读取到更新后的答卷标识。
    const hadFailures = this.failures.size > 0;
    this.failures.clear();
    if (hadFailures) this.options.onFailureChange?.(null);
    this.emitPending();
    this.resolveWaiters();
  }

  private emitPending(): void {
    this.options.onPendingChange?.(this.tasks.length + (this.running ? 1 : 0));
  }

  private resolveWaiters(): void {
    while (this.drainWaiters.length > 0) this.drainWaiters.pop()?.();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift()!;
        this.emitPending();
        try {
          await this.sender(task);
          if (this.failures.delete(task.questionId) && this.failures.size === 0) {
            this.options.onFailureChange?.(null);
          }
        } catch {
          // API 层的瞬时重试已耗尽：记住该题的最新失败值，等用户重试或
          // 重新作答；绝不静默丢弃。
          this.failures.set(task.questionId, task.value);
          this.options.onFailureChange?.(task.questionId);
        }
      }
    } finally {
      this.running = false;
      this.emitPending();
      // 排空即唤醒 flush 等待者；是否仍有失败由 flushSaves 自行判断。
      this.resolveWaiters();
    }
  }
}
