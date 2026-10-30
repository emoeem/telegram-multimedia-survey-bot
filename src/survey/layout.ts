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

/**
 * 沉浸式重设计（2026-10-30）后的宽度阈值。
 *
 * `IMMERSIVE_MIN_WIDTH` 仍约束**非场景**画布题型（game/video/…）与 landscape
 * 模式的转屏语义。场景题不再受宽度阈值约束：手机竖屏上场景也上舞台
 * （galgame 全屏体验，B 任务 before 实测手机 390 竖屏场景可视面积仅 18%）。
 */
export const IMMERSIVE_MIN_WIDTH = 768;

/**
 * auto 模式下**非场景**画布题型维持旧的宽度门槛；场景题已全宽度上舞台，
 * 此常量仅为兼容保留（不再参与 scene 裁决）。
 */
export const AUTO_SCENE_MIN_WIDTH = 1024;

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
 * 布局裁决（唯一入口）。2026-10-30 沉浸式重设计版：
 *
 * - 场景题（scene）：auto / immersive 下**全宽度**上舞台（含手机竖屏）——
 *   舞台内 contain 放到最大 + 场景图模糊背景填满（StageFrame backdrop），
 *   手机竖屏从阅读窄卡 18% 可视面积提升到 ~29%（before 实测，见
 *   _review/immersive-2026-10-30/）。landscape 模式保留「竖屏提示转屏」
 *   语义（转过来之后才铺满）。
 * - 其他画布优先题型（game/video/…）：行为不变——auto 维持 reading
 *   （SurveyApp 的 isScene 门控只对 scene 实现 fill 渲染），
 *   immersive/landscape 按宽度与矮横屏裁决。
 * - 文字/选项/剧情：永远 reading。
 */
export function resolveSurveyLayout(input: {
  display: SurveyDisplayMode;
  questionType: string | null | undefined;
  viewport: ViewportSize;
}): SurveyLayout {
  if (input.questionType === "scene") {
    if (input.display === "landscape") {
      // 矮横屏必然走 stage；竖着的手机屏留给提示条引导转屏；宽屏桌面 stage。
      if (isShortLandscape(input.viewport)) return "stage";
      return input.viewport.width >= IMMERSIVE_MIN_WIDTH ? "stage" : "reading";
    }
    return "stage";
  }
  if (!isStageQuestionType(input.questionType)) return "reading";
  if (input.display === "auto") return "reading";
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
