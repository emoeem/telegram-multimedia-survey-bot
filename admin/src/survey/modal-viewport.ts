/**
 * 弹窗在「软键盘弹起」时的视口换算（纯函数，便于单测）。
 *
 * 问题：Mini App 运行在 Telegram 的内置 WebView 里，iOS 上软键盘**不会**缩小
 * layout viewport（Android Chrome 在 `interactive-widget=resizes-content` 下会）。
 * 而弹窗面板是 `position: fixed` 贴在视口底部——键盘一弹，输入框就被压在键盘
 * 后面，用户看不见自己在打什么。`dvh` 也不解决：它跟的是浏览器 UI，不是键盘。
 *
 * 唯一可靠的信号是 `window.visualViewport`：键盘弹出时它的 `height` 变小、
 * `offsetTop` 变成被挤出的距离。这里把它换算成弹窗遮罩层应该占据的盒子：
 *
 *   - 键盘没弹（visual 高度 ≈ layout 高度）→ 铺满整个视口，保持原有居中布局；
 *   - 键盘弹出 → 遮罩层以 `offsetTop` 为顶、`visualHeight` 为高。
 *
 * 返回 `null` 表示"不需要改动"（交给 CSS 的默认值），避免在正常状态下用一个
 * 近似像素值覆盖布局。
 */
export interface ModalViewportBox {
  top: number;
  height: number;
}

export function resolveModalOverlayViewport(input: {
  /** 布局视口高度（window.innerHeight）。 */
  layoutHeight: number;
  /** visualViewport.height；不可用时为 null。 */
  visualHeight: number | null;
  /** visualViewport.offsetTop；不可用时为 null。 */
  visualOffsetTop: number | null;
}): ModalViewportBox | null {
  const { layoutHeight, visualHeight, visualOffsetTop } = input;
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
  if (visualHeight === null || !Number.isFinite(visualHeight) || visualHeight <= 0) return null;
  // 键盘的判定阈值 80px：与 SurveyApp 里 `viewportShrunk` 的口径一致，
  // 避免地址栏收起/展开（~50px）这种正常滚动被当成键盘。
  const keyboardOpen = layoutHeight - visualHeight > 80;
  if (!keyboardOpen) return null;
  const top = Number.isFinite(visualOffsetTop ?? NaN) ? Math.max(0, visualOffsetTop ?? 0) : 0;
  return { top, height: Math.min(visualHeight, layoutHeight) };
}

/** 供 React 组件直接展开成内联样式；`null` 时返回 undefined 交给 CSS。 */
export function modalOverlayStyle(
  box: ModalViewportBox | null,
): { top: number; height: number; bottom: "auto" } | undefined {
  if (!box) return undefined;
  return { top: box.top, height: box.height, bottom: "auto" };
}

/** 键盘弹起时面板必须让位（`max-height` 用百分比跟着遮罩层走）。 */
export function modalPanelStyle(box: ModalViewportBox | null): { maxHeight: string } | undefined {
  return box ? { maxHeight: "100%" } : undefined;
}
