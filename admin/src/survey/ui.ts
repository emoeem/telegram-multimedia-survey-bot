/** 问卷站公开页共用的样式常量。
 *
 * /plaza、/submit 这类页面原本各自在文件顶部写一份 `CARD` / `BTN` / `INPUT`
 * 字符串，改一处忘一处就会「两个页面不像同一个产品」。这里收成唯一来源，
 * 取值全部来自 index.css 里的 `--survey-*` 设计变量，所以换主题时两页一起变。
 *
 * 尺寸按移动优先定：默认就是窄屏可用的值（输入框 15px 字号、按钮 ≥48px 高），
 * 宽屏只靠容器 `sm:` / `lg:` 断点放宽宽度，不重排结构。
 */

/** 卡片基类（index.css 里的 .survey-card：背景 / 边框 / 圆角都走变量）。 */
export const SURVEY_CARD = "survey-card";

/** 表单控件。字号 15px 是刻意的：iOS Safari 对 <16px 的输入框会在聚焦时自动放大页面。 */
export const SURVEY_INPUT =
  "w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-3.5 py-3 text-[16px] leading-6 text-[var(--survey-heading)] outline-none transition-colors focus:border-[var(--survey-primary)]";

/** 主操作按钮：整行宽、至少 48px 高，拇指区够大。 */
export const SURVEY_PRIMARY_BTN =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-4 text-[15px] font-semibold text-[var(--survey-primary-content)] shadow-md transition disabled:opacity-60";

/** 选项胶囊：整块可点，命中区 ≥44px。 */
export const SURVEY_CHIP =
  "min-h-11 rounded-full border px-4 py-2.5 text-[13.5px] transition-colors";

/** 辅助链接（收件箱、再投一稿…）：视觉权重低于主按钮，只做文字链接。 */
export const SURVEY_AUX_LINK =
  "text-[13px] font-medium text-[var(--survey-muted)] underline-offset-4 transition-colors hover:text-[var(--survey-primary)]";

/** 页面外层容器：两页共用同一套左右留白与最大宽度。 */
export const SURVEY_PAGE = "mx-auto w-full max-w-xl px-4 lg:max-w-3xl";
