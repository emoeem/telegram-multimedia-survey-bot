/**
 * 投稿中心 —— 全站唯一的投稿入口。
 *
 * 合并前有两条独立的投稿路径，用户看到的是两个「投稿中心」：
 *
 *   /submit       网页投稿。身份是 localStorage 里的一串随机令牌，表单由投稿
 *                 机器人 worker 的 /api/submit/form 下发（运营可改字段），带
 *                 验证题，审核结果在 Telegram 群里回复；**不发金币**。
 *   /submissions  投稿中心。身份是 participant（Telegram / 邮箱 / 匿名浏览器
 *                 key 都算），类型硬编码五种，走本站 /api/submissions，进
 *                 D1 的 submissions 表，审核通过发金币、可进抽卡池。
 *
 * 两套身份、两张表、两条审核流，同一个产品里两个入口。这里把它们收进一个
 * 页面、三个页签，URL 只有 /submissions 一个；旧的 /submit 与 /submit/inbox
 * 由前端路由 302 到对应页签（见 SurveyApp），旧链接和已发出的分享不会 404。
 *
 * 页签顺序按「绝大多数人会用哪个」排：账号投稿（有金币）在最左，免登录投稿
 * 居中（它服务的是没有账号的人），收件箱最右。
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { PageHeader } from "./PageHeader";
import { searchForTab, tabFromSearch, type SubmissionTab } from "./submission-tab";

const AccountTab = lazy(() => import("./CoinCenter").then((m) => ({ default: m.SubmissionsScreen })));
const AnonTab = lazy(() => import("./SubmitScreen").then((m) => ({ default: m.SubmitScreen })));
const InboxTab = lazy(() => import("./SubmitScreen").then((m) => ({ default: m.SubmitInboxScreen })));

const TAB_META: { id: SubmissionTab; label: string; hint: string }[] = [
  { id: "account", label: "账号投稿", hint: "审核通过发金币，可进报告抽卡池" },
  { id: "anon", label: "免登录投稿", hint: "不用注册 · 留邮箱可收审核通知" },
  { id: "inbox", label: "我的投稿", hint: "进度 · 评论 · 管理员留言" },
];

/** 切页签时改写地址栏，但**不新增历史记录**。
 *
 * 用 replaceState 而不是 pushState：三个页签是同一个页面的三块内容，不是三次
 * 导航。用 pushState 的话，用户在「免登录投稿」填到一半按浏览器后退，会被自
 * 己制造出来的历史条目困在两个页签之间打转，而不是离开投稿页。
 */
function syncUrl(tab: SubmissionTab): void {
  const url = new URL(window.location.href);
  /* 只动 tab 一个参数：地址上可能挂着投放来源（utm_*）或旧链接带过来的其它
   * query，整段 search 覆盖掉会把它们一起丢掉。 */
  if (searchForTab(tab) === "") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  window.history.replaceState(null, "", url.toString());
}

export function SubmissionHub() {
  const [tab, setTab] = useState<SubmissionTab>(() => tabFromSearch(window.location.search));

  const select = useCallback((next: SubmissionTab) => {
    setTab(next);
    syncUrl(next);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  /* 浏览器前进/后退也要跟上页签（replaceState 不产生条目，但用户可能是从
   * 一个带 ?tab= 的外部链接进来的，或者被别的脚本 pushState 过）。 */
  useEffect(() => {
    const onPop = () => setTab(tabFromSearch(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const active = TAB_META.find((entry) => entry.id === tab) ?? TAB_META[0]!;

  return (
    <div className="survey-glow min-h-dvh" data-submission-hub={tab}>
      <PageHeader
        title="📮 投稿中心"
        subtitle={active.hint}
        tabs={
          <>
            {TAB_META.map((entry) => {
              const isActive = entry.id === tab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => select(entry.id)}
                  className={`h-9 shrink-0 rounded-full px-3 text-[13px] font-semibold transition-colors ${
                    isActive
                      ? "bg-[var(--survey-primary)] text-white"
                      : "bg-[var(--survey-primary-soft)] text-[var(--survey-heading)]"
                  }`}
                >
                  {entry.label}
                </button>
              );
            })}
          </>
        }
      />
      <div className="mx-auto max-w-xl lg:max-w-3xl">
        <Suspense
          fallback={<div className="grid min-h-40 place-items-center text-sm text-[var(--survey-muted)]">加载中…</div>}
        >
          {tab === "account" ? <AccountTab embedded /> : null}
          {tab === "anon" ? <AnonTab embedded /> : null}
          {tab === "inbox" ? <InboxTab embedded /> : null}
        </Suspense>
      </div>
    </div>
  );
}
