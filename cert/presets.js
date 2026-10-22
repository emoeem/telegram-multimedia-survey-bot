/* 认证卡生成器 —— 问卷主题预设调色板
 *
 * 问卷填写页（survey SPA）用 daisyUI 的 8 套预设主题，选择结果存在
 * localStorage 的 `surveyPreset` 键里（同源共享）。本文件把每套预设的
 * daisyUI 语义色（oklch 原值，取自 admin 依赖的 daisyui/theme/*.css）
 * 映射成生成器界面的设计令牌；app.js 启动时按用户在问卷页选的主题给
 * :root 换肤，两边观感保持一致。
 *
 * 色值语义：
 *   page     页面底色   = daisyUI base-200
 *   card     卡片底色   = daisyUI base-100
 *   ink      主文字     = daisyUI base-content
 *   primary  主色       = daisyUI primary
 *   onPrimary 主色上的文字 = daisyUI primary-content
 *
 * 其余派生色（边框、软底、阴影等）由 styles.css 用 color-mix 现场混合。
 */
window.CERT_UI_PRESETS = {
  light: {
    label: "明亮",
    page: "oklch(98% 0 0)",
    card: "oklch(100% 0 0)",
    ink: "oklch(21% 0.006 285.885)",
    primary: "oklch(45% 0.24 277.023)",
    onPrimary: "oklch(93% 0.034 272.788)",
  },
  dark: {
    label: "暗色",
    page: "oklch(23.26% 0.014 253.1)",
    card: "oklch(25.33% 0.016 252.42)",
    ink: "oklch(97.807% 0.029 256.847)",
    primary: "oklch(58% 0.233 277.117)",
    onPrimary: "oklch(96% 0.018 272.314)",
  },
  night: {
    label: "深蓝夜",
    page: "oklch(19.314% 0.037 265.754)",
    card: "oklch(20.768% 0.039 265.754)",
    ink: "oklch(84.153% 0.007 265.754)",
    primary: "oklch(75.351% 0.138 232.661)",
    onPrimary: "oklch(15.07% 0.027 232.661)",
  },
  luxury: {
    label: "黑金奢华",
    page: "oklch(20.219% 0.004 308.229)",
    card: "oklch(14.076% 0.004 285.822)",
    ink: "oklch(75.687% 0.123 76.89)",
    primary: "oklch(100% 0 0)",
    onPrimary: "oklch(20% 0 0)",
  },
  retro: {
    label: "复古纸张",
    page: "oklch(88.272% 0.049 91.774)",
    card: "oklch(91.637% 0.034 90.515)",
    ink: "oklch(41% 0.112 45.904)",
    primary: "oklch(80% 0.114 19.571)",
    onPrimary: "oklch(39% 0.141 25.723)",
  },
  cupcake: {
    label: "粉彩",
    page: "oklch(93.982% 0.007 61.449)",
    card: "oklch(97.788% 0.004 56.375)",
    ink: "oklch(23.574% 0.066 313.189)",
    primary: "oklch(85% 0.138 181.071)",
    onPrimary: "oklch(43% 0.078 188.216)",
  },
  synthwave: {
    label: "霓虹",
    page: "oklch(20% 0.09 281.288)",
    card: "oklch(15% 0.09 281.288)",
    ink: "oklch(78% 0.115 274.713)",
    primary: "oklch(71% 0.202 349.761)",
    onPrimary: "oklch(28% 0.109 3.907)",
  },
  black: {
    label: "纯黑",
    page: "oklch(19% 0 0)",
    card: "oklch(0% 0 0)",
    ink: "oklch(87.609% 0 0)",
    primary: "oklch(35% 0 0)",
    onPrimary: "oklch(100% 0 0)",
  },
};
