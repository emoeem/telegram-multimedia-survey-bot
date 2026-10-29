import { describe, expect, it } from "vitest";

import {
  modalOverlayStyle,
  modalPanelStyle,
  resolveModalOverlayViewport,
} from "../../../admin/src/survey/modal-viewport";

/**
 * 弹窗在软键盘弹起时的视口换算。
 *
 * 这段数学算错的后果全是"看不见"：输入框被压在键盘后面，用户以为点不动。
 * 而 iOS 上 `dvh` 不跟键盘、`window.innerHeight` 也不变——只有
 * `visualViewport` 会说实话，所以边界条件必须逐条钉住。
 */
describe("弹窗软键盘视口", () => {
  it("没有 visualViewport（老浏览器/桌面）时不做任何覆盖", () => {
    expect(resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: null, visualOffsetTop: null })).toBeNull();
  });

  it("键盘没弹（高度差在地址栏范围内）时保持默认布局", () => {
    // 地址栏收起/展开约 50px，不能被当成键盘——否则弹窗会莫名跳一下。
    expect(resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 800, visualOffsetTop: 0 })).toBeNull();
    expect(resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 844, visualOffsetTop: 0 })).toBeNull();
  });

  it("键盘弹起时收缩到可视视口，并跟着 offsetTop 下移", () => {
    const box = resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 420, visualOffsetTop: 120 });
    expect(box).toEqual({ top: 120, height: 420 });
  });

  it("负的 offsetTop（iOS 橡皮筋回弹）夹到 0，不会把弹窗推到屏幕外", () => {
    const box = resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 420, visualOffsetTop: -30 });
    expect(box).toEqual({ top: 0, height: 420 });
  });

  it("可视高度大于布局高度（旋转瞬间的中间帧）时取布局高度", () => {
    const box = resolveModalOverlayViewport({ layoutHeight: 400, visualHeight: 900, visualOffsetTop: 0 });
    // 高度差为负 → 不算键盘，走默认布局。
    expect(box).toBeNull();
  });

  it("非法输入一律退回默认布局（宁可遮挡也不要把弹窗算成 0 高）", () => {
    expect(resolveModalOverlayViewport({ layoutHeight: 0, visualHeight: 420, visualOffsetTop: 0 })).toBeNull();
    expect(resolveModalOverlayViewport({ layoutHeight: Number.NaN, visualHeight: 420, visualOffsetTop: 0 })).toBeNull();
    expect(resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 0, visualOffsetTop: 0 })).toBeNull();
  });

  it("换算成内联样式：只在键盘弹起时覆盖 top/height，其余交给 CSS", () => {
    expect(modalOverlayStyle(null)).toBeUndefined();
    expect(modalPanelStyle(null)).toBeUndefined();
    const box = resolveModalOverlayViewport({ layoutHeight: 844, visualHeight: 400, visualOffsetTop: 0 });
    expect(modalOverlayStyle(box)).toEqual({ top: 0, height: 400, bottom: "auto" });
    expect(modalPanelStyle(box)).toEqual({ maxHeight: "100%" });
  });
});
