/**
 * 问卷显示模式（2026-10-29）：答题端在不同设备上的版式取向。
 *
 * 存在 surveys.settings_json 的根级 `display` 键（与 theme 并列）——**不能
 * 放进 theme**：答题者自选主题预设时会用 `{ preset }` 整体替换 theme，显示
 * 模式随之丢失。缺省（键不存在）= auto，存量问卷行为零变化。
 *
 * - auto       现状：问题卡 max-w-xl / lg:max-w-3xl 居中
 * - immersive  PC 宽屏沉浸：场景/图片类题卡片放宽到近全宽、场景图按视口
 *              高度适配；文字题仍限宽（行太长难读）
 * - landscape  在 immersive 基础上，手机竖屏给可关闭的横屏提示 + 全屏按钮，
 *              横屏时场景铺满视口（短横屏最省纵向空间）
 */

export const SURVEY_DISPLAY_MODES = ["auto", "immersive", "landscape"] as const;

export type SurveyDisplayMode = (typeof SURVEY_DISPLAY_MODES)[number];

const DISPLAY_MODE_SET = new Set<string>(SURVEY_DISPLAY_MODES);

/** 校验外部输入；非法值返回 null（调用方决定是报错还是丢弃）。 */
export function normalizeSurveyDisplayMode(value: unknown): SurveyDisplayMode | null {
  return typeof value === "string" && DISPLAY_MODE_SET.has(value) ? (value as SurveyDisplayMode) : null;
}

/**
 * 从 settings_json 读显示模式（宽容版：脏值/缺省一律按 auto）。
 * 公开端与编辑器共用——读侧永远能拿到一个合法值。
 */
export function readSurveyDisplayMode(settings: unknown): SurveyDisplayMode {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "auto";
  return normalizeSurveyDisplayMode((settings as Record<string, unknown>).display) ?? "auto";
}

/** 需要宽版式（放宽卡片/场景适配视口高度）的模式。 */
export function isWideDisplayMode(mode: SurveyDisplayMode): boolean {
  return mode === "immersive" || mode === "landscape";
}

/** 各模式在编辑器里的展示文案（设置面板与预览徽标共用）。 */
export const SURVEY_DISPLAY_MODE_LABELS: Record<SurveyDisplayMode, { title: string; hint: string }> = {
  auto: {
    title: "自动（默认）",
    hint: "所有设备一致：题目卡片窄居中，适合以文字题为主的问卷",
  },
  immersive: {
    title: "PC 沉浸",
    hint: "电脑上场景图与图片题铺满宽屏，文字题保持易读宽度；手机上不受影响",
  },
  landscape: {
    title: "手机横屏优先",
    hint: "含 PC 沉浸的全部效果；手机竖屏时提示横屏并提供全屏按钮，横屏后场景铺满屏幕",
  },
};
