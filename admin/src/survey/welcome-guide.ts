/**
 * 首访欢迎卡的纯逻辑（2026-11-18，用户反馈：功能太多看不懂）。
 *
 * 拆成独立 .ts 是为了根项目单测（WebWorker lib、无 window/navigator）直接
 * 引用：这里所有判断都走注入参数，不碰浏览器全局。
 *
 * 打扰纪律：答题进行中（/s/{id}）**永不弹**——新用户最常见的入口就是 Telegram
 * 里点开一份问卷，第一屏必须还是问卷本身。欢迎卡只出现在社区/个人类页面。
 */
export const WELCOME_SEEN_KEY = "survey_welcome_seen_v1";

/** 问卷填写页：/s/123、/s/123/og.png 等。 */
const SURVEY_FILLING_RE = /^\/s\/\d+(\/|$)/;
/** 分享/资料卡直达与登录页：本来就有明确目的，不插欢迎卡。 */
const SKIP_PREFIXES = ["/r/", "/u/", "/auth", "/cert/", "/api/", "/admin", "/internal/", "/telegram/"];

export function shouldShowWelcomeOnPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/s" || pathname.startsWith("/s/")) {
    // 大厅与列表欢迎；填写中的具体问卷（/s/数字）排除。
    return !SURVEY_FILLING_RE.test(pathname);
  }
  if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  // 其余公开屏（/plaza /trial /me /coins /gacha /submissions /notes /series）欢迎。
  return true;
}

export interface WelcomeGateInput {
  pathname: string;
  /** localStorage 里是否已看过（seen 标记存在）。 */
  seen: boolean;
  /** 自动化环境（Playwright 的 navigator.webdriver）：截图基线不放这张卡。 */
  isAutomation: boolean;
}

export function shouldShowWelcome(input: WelcomeGateInput): boolean {
  if (input.seen || input.isAutomation) return false;
  return shouldShowWelcomeOnPath(input.pathname);
}
