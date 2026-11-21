import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { trapFocusWithin } from "./focus-trap";
import { modalOverlayStyle, modalPanelStyle, resolveModalOverlayViewport } from "../survey/modal-viewport";

/**
 * 共享底部抽屉 / 侧边抽屉（M6 批次 6.2，docs/design/COMPONENT_MAPPING.md）。
 *
 * 背景：此前底部 Sheet 有三处手写实现（ThemePickerSheet / ShowcaseSheet /
 * TypePickerSheet），右侧抽屉只有 Layout 手写侧栏一个，行为细节（Escape、
 * 滚动锁、焦点归还、软键盘让位）各自维护。本组件把 Modal 的生命周期契约
 * （见 components/ui.tsx Modal 头注释）扩展到这两种形态，统一复用：
 *
 *   - side="bottom"：手机贴底滑出 + 抓手条；≥640px 居中悬浮卡。
 *     软键盘让位已内建（visualViewport → resolveModalOverlayViewport），
 *     调用方不再需要像 Modal 那样自行传 overlayStyle/panelStyle。
 *   - side="right"：右侧全高抽屉（min(420px, 92vw)），桌面级详情面板用。
 *
 * 生命周期与 Modal 完全一致：open=false 时不渲染（无退场动画契约）、Escape
 * 关闭、背景滚动锁、面板 tabIndex=-1 接焦 + Tab 焦点陷阱、关闭后焦点归还。
 * 渲染契约同样遵守 index.css 的 `[hidden]{display:none!important}` 纪律——
 * 本组件根本不渲染 hidden 节点，不依赖"hidden 但可见"。
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  side = "bottom",
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** bottom = 底部抽屉（移动端优先）；right = 右侧全高抽屉（桌面详情面板）。 */
  side?: "bottom" | "right";
  /** right 形态的宽度档位；bottom 忽略。 */
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [keyboardBox, setKeyboardBox] = useState<ReturnType<typeof resolveModalOverlayViewport>>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    // 软键盘让位（与 PublishOptionsDialog 同一信号源，见 survey/modal-viewport.ts）。
    const viewport = window.visualViewport;
    const sync = () => {
      setKeyboardBox(
        resolveModalOverlayViewport({
          layoutHeight: window.innerHeight,
          visualHeight: viewport?.height ?? null,
          visualOffsetTop: viewport?.offsetTop ?? null,
        }),
      );
    };
    sync();
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      setKeyboardBox(null);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const panelClass = side === "right" ? `ui-sheet-panel ui-sheet-right ui-sheet-${size}` : "ui-sheet-panel";
  return (
    <div
      className={side === "right" ? "ui-sheet ui-sheet-layer-right" : "ui-sheet"}
      style={modalOverlayStyle(keyboardBox)}
    >
      <button type="button" className="ui-modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div
        ref={panelRef}
        className={panelClass}
        style={modalPanelStyle(keyboardBox)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onKeyDown={(event) => {
          const panel = panelRef.current;
          if (panel) trapFocusWithin(panel, event.nativeEvent);
        }}
      >
        {side === "bottom" ? <div className="ui-sheet-grabber" aria-hidden="true" /> : null}
        <header className="ui-modal-head">
          <h2 className="ui-modal-title">{title}</h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="ui-modal-body">{children}</div>
        {footer ? <footer className="ui-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
