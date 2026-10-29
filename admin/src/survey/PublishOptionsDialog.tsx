import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, MessageSquareQuote, Send, UserRoundX } from "lucide-react";

import { Modal } from "../components/ui";
import {
  PUBLISH_MESSAGE_MAX,
  clampPublishMessage,
  fromPublishDraft,
  publishMessageLength,
  toPublishDraft,
  type PublishChoice,
  type PublishVisibility,
} from "./publish-choice";
import { modalOverlayStyle, modalPanelStyle, resolveModalOverlayViewport } from "./modal-viewport";

/**
 * 「公开发布到 Telegram」前的三项选择弹窗。
 *
 * 为什么不是 `window.prompt` / 连点两个 confirm：
 *   1. `prompt` 在 Telegram 的 WebView 里被禁用（返回 null 且不提示），等于
 *      悄悄丢掉用户的选择；
 *   2. 三项选择互相有关（"仅自己可见"时匿名与留言都没有意义），必须一次看全。
 *
 * 键盘遮挡是这里的头号可用性问题：输入框在底部弹窗里，iOS 键盘弹出后整块面板
 * 会被压到键盘后面。处理方式见 `modal-viewport.ts`——把遮罩层收缩到
 * visualViewport 的盒子，面板用 `max-height: 100%` 跟着让位，再在聚焦时把输入框
 * 滚进可见区。
 */
export function PublishOptionsDialog({
  open,
  initial,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initial: PublishChoice;
  /** 提交进行中：不允许在提交途中改设置（否则界面与实际发出的报文会不一致）。 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (choice: PublishChoice) => void;
}) {
  const [draft, setDraft] = useState(() => toPublishDraft(initial));
  const [keyboardBox, setKeyboardBox] = useState<ReturnType<typeof resolveModalOverlayViewport>>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);

  // 每次打开都从当前生效的选择重新开始：取消过的改动不该被记住。
  useEffect(() => {
    if (!open) return;
    setDraft(toPublishDraft(initial));
    // initial 只在打开时作为起点，不让它成为每次渲染的重置源。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 软键盘：visualViewport 是唯一可靠信号（见 modal-viewport.ts）。
  useEffect(() => {
    if (!open) return undefined;
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const sync = () => {
      setKeyboardBox(
        resolveModalOverlayViewport({
          layoutHeight: window.innerHeight,
          visualHeight: viewport.height,
          visualOffsetTop: viewport.offsetTop,
        }),
      );
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      setKeyboardBox(null);
    };
  }, [open]);

  const messageLength = publishMessageLength(draft.message);
  const visibility: PublishVisibility = draft.visibility;

  const setVisibility = (next: PublishVisibility) => setDraft((current) => ({ ...current, visibility: next }));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="公开发布设置"
      size="sm"
      overlayStyle={modalOverlayStyle(keyboardBox)}
      panelStyle={modalPanelStyle(keyboardBox)}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onConfirm(fromPublishDraft(draft))}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {visibility === "public" ? "确定公开" : "仅自己可见"}
          </button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">是否公布</h3>
          <div className="mt-2 grid gap-2">
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 ${
                visibility === "public"
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--color-edge)]"
              }`}
            >
              <input
                type="radio"
                className="mt-1 shrink-0"
                name="publish-visibility"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--survey-heading)]">
                  <Eye className="h-4 w-4" aria-hidden="true" />
                  公开
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">
                  报告图片会以相册形式发到频道/群组，所有人可见。发布后无法撤回，只能由管理员删除。
                </span>
              </span>
            </label>
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 ${
                visibility === "private"
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--color-edge)]"
              }`}
            >
              <input
                type="radio"
                className="mt-1 shrink-0"
                name="publish-visibility"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--survey-heading)]">
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                  仅自己可见（取消发布）
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">
                  只保存到你的报告里，不会发到任何频道或群组。
                </span>
              </span>
            </label>
          </div>
        </section>

        <section className={visibility === "public" ? "" : "opacity-60"}>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-edge)] px-3.5 py-3">
            <input
              type="checkbox"
              className="checkbox checkbox-primary mt-0.5 shrink-0"
              checked={draft.anonymous}
              onChange={(event) => setDraft((current) => ({ ...current, anonymous: event.target.checked }))}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-semibold text-[var(--survey-heading)]">
                <UserRoundX className="h-4 w-4" aria-hidden="true" />
                匿名发布
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-[var(--survey-muted)]">
                {draft.anonymous
                  ? "发布内容里不会出现你的 Telegram 用户名、姓名、ID 或头像。"
                  : "关闭后，频道里会显示你的 Telegram 用户名与姓名。"}
              </span>
            </span>
          </label>
        </section>

        <section>
          <label className="block">
            <span className="flex items-center justify-between gap-2 text-[13px] font-semibold text-[var(--color-ink)]">
              <span className="flex items-center gap-1.5">
                <MessageSquareQuote className="h-4 w-4" aria-hidden="true" />
                想说的话
              </span>
              <span className="text-xs font-normal text-[var(--survey-muted)]">
                {messageLength}/{PUBLISH_MESSAGE_MAX}
              </span>
            </span>
            <textarea
              ref={messageRef}
              className="mt-2 w-full resize-y rounded-xl border border-[var(--color-edge)] bg-[var(--survey-card-bg)] px-3 py-2.5 text-[16px] leading-6 text-[var(--survey-heading)] outline-none focus:border-[var(--survey-primary)]"
              rows={3}
              // 16px 是刻意的：iOS 对 <16px 的输入框会在聚焦时自动放大页面。
              value={draft.message}
              disabled={visibility !== "public"}
              placeholder={visibility === "public" ? "会作为发布消息的配文（可空）" : "仅公开时可用"}
              onChange={(event) => {
                const next = clampPublishMessage(event.target.value);
                setDraft((current) => ({ ...current, message: next }));
              }}
              // 键盘弹起后把输入框滚进可见区（面板已经跟着 visualViewport 让位了，
              // 这里只是让光标那一行也落在可见范围内）。
              onFocus={() => {
                const node = messageRef.current;
                if (!node) return;
                window.requestAnimationFrame(() => node.scrollIntoView({ block: "nearest" }));
              }}
            />
          </label>
          <p className="mt-1.5 text-xs leading-5 text-[var(--survey-muted)]">
            留言会和「问卷名称 + 填写时间」一起发在频道的同一条消息里。
          </p>
        </section>
      </div>
    </Modal>
  );
}
