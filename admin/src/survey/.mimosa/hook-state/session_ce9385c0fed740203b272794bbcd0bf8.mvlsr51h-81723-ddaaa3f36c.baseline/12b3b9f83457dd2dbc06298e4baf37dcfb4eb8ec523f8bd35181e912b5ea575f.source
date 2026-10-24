/**
 * 投稿中心的页签解析 —— 纯函数，不碰 DOM、不发请求。
 *
 * 单独一个模块的理由和 `submission-target.ts` 一样：worker 的 vitest 环境没有
 * DOM，import 一个 .tsx 会把 React / lucide 一起拉进来，纯逻辑就没法直接测。
 * 这里只留「字符串进、页签出」的部分，边界情况（空值、大小写、多余参数、
 * 老链接带来的其它 tab 值）全部靠单测钉住。
 *
 * 页签模型经历过一次收拢：最初合并时是三个页签（账号投稿 / 免登录投稿 /
 * 我的投稿），但「账号投稿」本来就接受匿名浏览器身份，两个投稿页签的差别
 * 只是「走本站流水线拿金币」还是「免登录直投」——对用户来说是同一个动作，
 * 三个页签反而像两个投稿中心。现在收成两个页签（投稿 / 我的投稿），「投稿」
 * 页签内部再用一个次级分段切金币/直投两种表单。
 */

export type SubmissionTab = "submit" | "inbox";

export const SUBMISSION_TABS: SubmissionTab[] = ["submit", "inbox"];

/** 默认页签：投稿。绝大多数人进投稿中心就是为了投稿。 */
export const DEFAULT_SUBMISSION_TAB: SubmissionTab = "submit";

/**
 * 从 location.search（或任何 `?a=b` 形式的串）解析页签。
 *
 * `account` 与 `anon` 是三页签时代的旧值：前者就是现在的默认页签，后者语义
 * 是「免登录直投」——页签层面归到投稿，是否展开直投表单由
 * {@link directEntryFromSearch} 决定。非法值一律回落到默认页签而不是报错：
 * `?tab=` 是给分享链接和旧地址用的，用户手改、上游拼错都不该让页面白掉。
 */
export function tabFromSearch(search: string): SubmissionTab {
  const raw = new URLSearchParams(search).get("tab")?.trim().toLowerCase();
  if (raw === "inbox") return "inbox";
  return DEFAULT_SUBMISSION_TAB;
}

/**
 * 页签 → 地址栏 query 串（不含 `?`）。
 *
 * 默认页签返回空串：`/submissions` 比 `/submissions?tab=submit` 更适合被分享，
 * 而且少一个和默认值冗余的显式参数。
 */
export function searchForTab(tab: SubmissionTab): string {
  return tab === DEFAULT_SUBMISSION_TAB ? "" : `?tab=${tab}`;
}

/**
 * 旧链接是否要展开「免登录直投」表单。
 *
 * `?tab=anon` 由两条路径产生：服务端对 `/submit` 的 302，和前端对旧路由的
 * RedirectTo。它们都是「从免登录投稿页过来的」用户，落进投稿页签时应该直接
 * 看到他们在找的那张表单，而不是金币表单。
 */
export function directEntryFromSearch(search: string): boolean {
  return new URLSearchParams(search).get("tab")?.trim().toLowerCase() === "anon";
}

/**
 * 旧投稿路径 → 302 的 query 目标。
 *
 * `/submit`（表单）和 `/submit/inbox`（收件箱）合并后不再有自己的页面，服务端
 * 302 和前端 RedirectTo 都用这张表，避免两处各写一份判断后走偏。返回的是
 * **query 值**而不是页签类型：`anon` 会再由 directEntryFromSearch 解释成
 * 「投稿页签 + 直投表单」。
 */
export type LegacySubmitTarget = "anon" | "inbox";

export function tabForLegacySubmitPath(pathname: string): LegacySubmitTarget | null {
  if (pathname === "/submit/inbox" || pathname.startsWith("/submit/inbox/")) return "inbox";
  if (pathname === "/submit" || pathname.startsWith("/submit/")) return "anon";
  return null;
}
