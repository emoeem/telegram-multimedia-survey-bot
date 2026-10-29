/**
 * 答题页布局契约（2026-10-29）：每个题目到底用「阅读版式」还是「舞台版式」。
 *
 * 背景：`SurveyApp` 里曾有多个互相独立、各写各的「铺满视口」判断
 * （VN 的 fixed 背景层、矮横屏的 fixed hack、显示模式的宽卡片），
 * 每加一种画布类题型就要再写一遍。这里把裁决收成**一个纯函数**：
 *
 *  - `reading`：文档流里滚动，卡片限宽（现状，适合文字/选项题）
 *  - `stage`  ：整页是视口高度的 flex 列，舞台吃掉剩余空间（场景/小游戏/视频）
 *
 * 显示模式只决定「这个视口是否允许舞台版式」，题型决定「是否画布优先」。
 * 纯函数、无 DOM 依赖——视口尺寸由调用方传入，因此可以完整单测。
 */

import type { SurveyDisplayMode } from "./display";

export type SurveyLayout = "reading" | "stage";

/**
 * 画布优先的题型：内容本身就是一幅「画面」，值得铺满。
 * 与 SurveyApp 里既有的 fullBleedQuestion 判定保持一致，新增题型在此登记。
 */
export const STAGE_QUESTION_TYPES = ["scene", "game", "image", "video", "audio", "file"] as const;

const STAGE_TYPE_SET = new Set<string>(STAGE_QUESTION_TYPES);

/** 沉浸模式在窄屏（手机竖屏）退回阅读版式：窄屏放大画面没有意义。 */
export const IMMERSIVE_MIN_WIDTH = 768;

/** 矮横屏阈值：手机横过来后的常见高度，与 CSS 的 `(max-height: 560px)` 对齐。 */
export const SHORT_LANDSCAPE_MAX_HEIGHT = 560;

export interface ViewportSize {
  width: number;
  height: number;
}

export function isStageQuestionType(type: string | null | undefined): boolean {
  return typeof type === "string" && STAGE_TYPE_SET.has(type);
}

/**
 * 是否为「矮横屏」——手机横着拿的形状（宽 > 高且高度有限）。
 * 用宽高比而不是 UA：平板横放、桌面窄窗口都不该被当成手机横屏。
 */
export function isShortLandscape(viewport: ViewportSize): boolean {
  return viewport.width > viewport.height && viewport.height <= SHORT_LANDSCAPE_MAX_HEIGHT;
}

/**
 * 布局裁决（唯一入口）。
 *
 * - auto：永远 reading（存量行为，任何视口都不变）
 * - immersive：画布优先题型 + 宽度 ≥768 才 stage；手机竖屏仍 reading
 * - landscape：画布优先题型，且**只**在矮横屏 stage——竖屏由提示条引导转屏，
 *   转过来之后才铺满；桌面借此模式与 immersive 行为一致（宽屏 stage）
 */
export function resolveSurveyLayout(input: {
  display: SurveyDisplayMode;
  questionType: string | null | undefined;
  viewport: ViewportSize;
}): SurveyLayout {
  if (input.display === "auto") return "reading";
  if (!isStageQuestionType(input.questionType)) return "reading";
  if (input.display === "landscape") {
    // 矮横屏必然是走 stage；宽屏桌面（immersive 等价）也 stage，
    // 但竖着的手机屏（width < 768 且非矮横屏）留给提示条引导。
    if (isShortLandscape(input.viewport)) return "stage";
    return input.viewport.width >= IMMERSIVE_MIN_WIDTH ? "stage" : "reading";
  }
  return input.viewport.width >= IMMERSIVE_MIN_WIDTH ? "stage" : "reading";
}

/** 舞台版式是否要把底部操作条改成静态 flex 子项（避免任何遮挡）。 */
export function stageUsesStaticFooter(layout: SurveyLayout): boolean {
  return layout === "stage";
}
