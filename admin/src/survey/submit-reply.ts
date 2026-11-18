/**
 * 投稿收件箱「回复这条评论」的纯逻辑（B2 交互死路修复）。
 *
 * 旧实现是裸 `window.prompt`：Telegram WebView 禁用 prompt（返回 null 且不
 * 提示，见 PublishOptionsDialog.tsx 顶部说明），等于点了按钮、输入凭空消失。
 * 改为行内输入框后，是否发请求收敛到这里的判定——空文本不发请求；
 * 长度上限与服务端 THREAD_TEXT_MAX_CHARS = 800（src/http/submit-api.ts）同口径。
 */

export const SUBMIT_REPLY_MAX = 800;

export interface SubmitReplyRequest {
  submissionId: number;
  commentMessageId: number;
  text: string;
}

/**
 * 草稿 → /api/submit/reply 请求体；空输入返回 null（不发请求）。
 * trim 由调用方的 maxLength=800 保证不会超过服务端上限，这里不做静默截断。
 */
export function submitReplyRequest(
  draft: string,
  submissionId: number,
  commentMessageId: number,
): SubmitReplyRequest | null {
  const text = draft.trim();
  if (!text) return null;
  return { submissionId, commentMessageId, text };
}
