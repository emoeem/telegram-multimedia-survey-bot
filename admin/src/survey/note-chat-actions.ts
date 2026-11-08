/**
 * 纸条会话用户端动作（0094 举报/拉黑）的纯逻辑：理由校验与输入条只读判定。
 *
 * DOM 交互（长按菜单 / 理由弹层 / 确认弹层 / toast）留在 NoteScreen 的
 * ChatView；这里保持零 React 依赖（同 note-poll.ts 的做法），单测直接断言
 * 分支，不虚装 DOM。
 */

/** 服务端对理由做 String(reason).slice(0, 200)（note-chat.service.ts 的
 * reportMessage / reportNote），客户端提交前同口径校验：超长直接拦截，
 * 不静默截断。 */
export const REPORT_REASON_MAX = 200;

export type ReportReasonProblem = "empty" | "too_long";

/** 举报理由校验：trim 后为空 → "empty"；超过 REPORT_REASON_MAX → "too_long"；合法 → null。 */
export function validateReportReason(reason: string): ReportReasonProblem | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > REPORT_REASON_MAX) return "too_long";
  return null;
}

export type ChatInputGateReason = "blocked" | "peer-gone";

export interface ChatInputGate {
  /** 输入条是否只读（true 时不渲染输入框，渲染提示卡） */
  readonly: boolean;
  /** 只读原因；null 表示正常可输入 */
  reason: ChatInputGateReason | null;
  /** 是否展示「解除拉黑」动作——仅本地 blocked 态（解除是列表读侧双向过滤下唯一的恢复入口） */
  unblockable: boolean;
}

/**
 * 输入条只读判定：本地拉黑 > 纸条下架（peerGone）> 正常。
 * blocked 即便叠加 peerGone 也允许解除拉黑——解除后是否恢复可见由服务端
 * isBlockedPair（双向）决定，本地不预判。
 */
export function chatInputGate(input: { blocked: boolean; peerGone: boolean }): ChatInputGate {
  if (input.blocked) return { readonly: true, reason: "blocked", unblockable: true };
  if (input.peerGone) return { readonly: true, reason: "peer-gone", unblockable: false };
  return { readonly: false, reason: null, unblockable: false };
}
