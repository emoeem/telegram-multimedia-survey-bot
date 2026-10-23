/**
 * 投稿中心的页签解析 —— 纯函数，不碰 DOM、不发请求。
 *
 * 单独一个模块的理由和 `submission-target.ts` 一样：worker 的 vitest 环境没有
 * DOM，import 一个 .tsx 会把 React / lucide 一起拉进来，纯逻辑就没法直接测。
 * 这里只留「字符串进、页签出」的部分，边界情况（空值、大小写、多余参数、
 * 老链接带来的其它 tab 值）全部靠单测钉住。
 */

export type SubmissionTab = "account" | "anon" | "inbox";

export const SUBMISSION_TABS: SubmissionTab[] = ["account", "anon", "inbox"];

/** 默认页签：账号投稿。它是唯一发金币的入口，也是绝大多数人该看到的那屏。 */
export const DEFAULT_SUBMISSION_TAB: SubmissionTab = "account";

/**
 * 从 location.search（或任何 `?a=b` 形式的串）解析页签。
 *
 * 非法值一律回落到默认页签而不是报错：`?tab=` 是给分享链接和旧地址用的，
 * 用户手改、上游拼错、或者老版本留下的值都不该让页面白掉。
 */
export function tabFromSearch(search: string): SubmissionTab {
  const raw = new URLSearchParams(search).get("tab")?.trim().toLowerCase();
  if (raw === "anon" || raw === "inbox" || raw === "account") return raw;
  return DEFAULT_SUBMISSION_TAB;
}

/**
 * 页签 → 地址栏 query 串（不含 `?`）。
 *
 * 默认页签返回空串：`/submissions` 比 `/submissions?tab=account` 更适合被分享，
 * 而且少一个会和默认值冗余的显式参数。
 */
export function searchForTab(tab: SubmissionTab): string {
  return tab === DEFAULT_SUBMISSION_TAB ? "" : `?tab=${tab}`;
}

/**
 * 旧投稿路径 → 投稿中心页签。
 *
 * `/submit`（表单）和 `/submit/inbox`（收件箱）合并后不再有自己的页面，服务端
 * 302 也用这张表，避免两处各写一份判断后走偏。
 */
export function tabForLegacySubmitPath(pathname: string): SubmissionTab | null {
  if (pathname === "/submit/inbox" || pathname.startsWith("/submit/inbox/")) return "inbox";
  if (pathname === "/submit" || pathname.startsWith("/submit/")) return "anon";
  return null;
}
