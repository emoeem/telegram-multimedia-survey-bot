import { safeGet, safeRemove, safeSet } from "./storage";

/**
 * 单槽「自动续玩」快照（2026-11）。
 *
 * 只存**当前题的未保存草稿**与位置，不存全部答案：
 *  - 服务端已经有逐题保存的答案与 current_question_id，本地再存一份全量答案
 *    只会在「读旧档」时用旧值覆盖新值；
 *  - 真正会丢的是「最后一题的输入还没点下一题就刷新/崩溃」，所以这里只保
 *    这一份草稿和它所在的位置。
 *
 * 读取快照后只恢复内存状态，不调用服务端；下一次 goNext 会走既有保存队列。
 */

const VERSION = 1;

export interface ResumeSnapshot {
  v: 1;
  responseId: number;
  questionId: number;
  index: number;
  backStack: number[];
  /** 当前题的客户端答案形态；null = 没有输入（只恢复位置）。 */
  draft: unknown | null;
  savedAt: number;
}

function storageKey(surveyId: number): string {
  return `surveyResume:${surveyId}:v1`;
}

function isValidInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function readResumeSnapshot(surveyId: number): ResumeSnapshot | null {
  const raw = safeGet(storageKey(surveyId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeSnapshot> | null;
    if (!parsed || parsed.v !== VERSION) return null;
    if (!isValidInteger(parsed.responseId) || !isValidInteger(parsed.questionId) || !isValidInteger(parsed.index)) {
      return null;
    }
    const backStack = Array.isArray(parsed.backStack) ? parsed.backStack.filter(isValidInteger) : [];
    return {
      v: VERSION,
      responseId: parsed.responseId,
      questionId: parsed.questionId,
      index: parsed.index,
      backStack,
      draft: parsed.draft ?? null,
      savedAt: isValidInteger(parsed.savedAt) ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeResumeSnapshot(
  surveyId: number,
  snapshot: Omit<ResumeSnapshot, "v" | "savedAt"> & { savedAt?: number },
): void {
  const payload: ResumeSnapshot = {
    v: VERSION,
    responseId: snapshot.responseId,
    questionId: snapshot.questionId,
    index: snapshot.index,
    backStack: snapshot.backStack,
    draft: snapshot.draft,
    savedAt: snapshot.savedAt ?? Date.now(),
  };
  safeSet(storageKey(surveyId), JSON.stringify(payload));
}

export function clearResumeSnapshot(surveyId: number): void {
  safeRemove(storageKey(surveyId));
}

/**
 * 是否向用户提示「恢复上次未提交的输入」。
 *
 * 只在同一份答卷、且本地位置不早于服务端续玩点时提示：服务端更靠后说明
 * 本地快照已经过期，恢复它会把用户拉回旧位置。
 */
export function shouldOfferResume(snapshot: ResumeSnapshot | null, responseId: number, serverIndex: number): boolean {
  if (!snapshot) return false;
  if (snapshot.responseId !== responseId) return false;
  if (snapshot.index < serverIndex) return false;
  return snapshot.index > serverIndex || snapshot.draft !== null;
}
