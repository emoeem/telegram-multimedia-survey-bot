import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 共享 Sheet/Drawer（M6 批次 6.2，docs/design/COMPONENT_MAPPING.md §3）的接线守护。
 *
 * 仓库没有 @testing-library（同 multiplayer-game-entry.test.ts 惯例）：
 * 组件渲染断言降级为「静态读源码」的结构守卫。生命周期契约与
 * components/ui.tsx Modal 一致——本测试锁定这些契约不被后续改动悄悄丢掉。
 */

const sheet = readFileSync(join(process.cwd(), "admin", "src", "components", "Sheet.tsx"), "utf8");
const indexCss = readFileSync(join(process.cwd(), "admin", "src", "index.css"), "utf8");

describe("Sheet 组件生命周期契约（与 Modal 同款）", () => {
  it("打开时锁背景滚动、Escape 关闭、关闭后焦点归还", () => {
    expect(sheet).toContain('document.body.style.overflow = "hidden"');
    expect(sheet).toContain('event.key === "Escape"');
    expect(sheet).toContain("restoreFocusRef.current?.focus?.()");
  });

  it("关闭时不渲染（return null），不依赖 hidden-but-visible 的反模式", () => {
    expect(sheet).toContain("if (!open) return null;");
    expect(sheet).not.toMatch(/hidden=\{/);
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal="true"');
  });

  it("Tab 焦点陷阱走共享 focus-trap，关闭按钮带可访问名", () => {
    expect(sheet).toContain('from "./focus-trap"');
    expect(sheet).toContain("trapFocusWithin(panel, event.nativeEvent)");
    expect(sheet).toContain('aria-label="关闭"');
  });

  it("软键盘让位在组件内建（visualViewport → resolveModalOverlayViewport），调用方无需传 overlayStyle", () => {
    expect(sheet).toContain('from "../survey/modal-viewport"');
    expect(sheet).toContain("resolveModalOverlayViewport({");
    expect(sheet).toContain('viewport?.addEventListener("resize", sync)');
    expect(sheet).not.toMatch(/overlayStyle\?\s*:/);
  });

  it("两种形态：bottom 抓手条 + right 全高抽屉，宽度档位类名拼接", () => {
    expect(sheet).toContain('side = "bottom"');
    expect(sheet).toContain('side === "right"');
    expect(sheet).toContain("ui-sheet-grabber");
    expect(sheet).toContain("ui-sheet-${size}");
  });
});

describe("index.css 的配套纪律", () => {
  it("[hidden] 全局显隐纪律存在且带例外指引注释（M2 教训）", () => {
    expect(indexCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(indexCss).toContain("visibility/opacity + aria-hidden");
  });

  it("ui-sheet 样式块：≤639px 贴底安全区、≥640px 居中、reduced-motion 停动画", () => {
    expect(indexCss).toContain(".ui-sheet-panel {");
    expect(indexCss).toContain("padding-bottom: env(safe-area-inset-bottom);");
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(indexCss).toContain(".ui-sheet-right {");
  });
});
