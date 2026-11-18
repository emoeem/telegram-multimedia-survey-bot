import { describe, expect, it } from "vitest";

import { submitReplyRequest, SUBMIT_REPLY_MAX } from "../../../admin/src/survey/submit-reply";

/**
 * 投稿收件箱「回复这条评论」（B2 交互死路修复）的纯逻辑。
 *
 * 旧实现是裸 window.prompt——Telegram WebView 禁用 prompt（返回 null 且不
 * 提示），点了按钮输入就凭空消失。改为行内输入框后，是否发请求收敛到
 * submitReplyRequest：空输入返回 null（不发请求），非空返回与服务端
 * /api/submit/reply（src/http/submit-api.ts）一致的请求体。DOM 交互由
 * pnpm build:admin + 浏览器人工验证兜底（同 note-chat-actions 的分工）。
 */
describe("submitReplyRequest", () => {
  it("非空输入：返回 /api/submit/reply 请求体（trim 后的文本 + 编号）", () => {
    expect(submitReplyRequest("  你好，谢谢喜欢！ ", 42, 7)).toEqual({
      submissionId: 42,
      commentMessageId: 7,
      text: "你好，谢谢喜欢！",
    });
  });

  it("空输入：返回 null，不发请求", () => {
    expect(submitReplyRequest("", 42, 7)).toBeNull();
  });

  it("纯空白输入：trim 后为空，返回 null，不发请求", () => {
    expect(submitReplyRequest("   \n\t ", 42, 7)).toBeNull();
  });

  it(`长度上限与服务端 THREAD_TEXT_MAX_CHARS 一致（${SUBMIT_REPLY_MAX}）`, () => {
    expect(SUBMIT_REPLY_MAX).toBe(800);
    // 恰好 800 字放行
    expect(submitReplyRequest("好".repeat(800), 1, 1)?.text.length).toBe(800);
  });
});
