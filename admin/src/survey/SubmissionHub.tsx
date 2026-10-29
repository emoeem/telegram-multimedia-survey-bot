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
 * 页面，URL 只有 /submissions 一个；旧的 /submit 与 /submit/inbox 由服务端
 * 和前端路由 302 过来，旧链接和已发出的分享不会 404。
 *
 * 页签是两个：「投稿」与「我的投稿」。金币投稿和免登录直投不再是并列页签
 * （那看起来还是两个投稿入口），而是「投稿」页签内的一次次级分段——两条
 * 流水线后端原样不动，只是入口长成了一个。
 *
 * 加载链曾经是五层纯串行（survey.js → hub chunk → 表单 chunk → form API →
 * 验证题），慢网络里每层都是一整个来回。现在 hub 一挂载就把两个表单 chunk
 * 和 /api/submit/form 并行拉起（见下方 useEffect），用户切到哪个分段都已是
 * 热的。
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Coins, Zap } from "lucide-react";

import { PageHeader } from "./PageHeader";
import { searchForTab, tabFromSearch, directEntryFromSearch, type SubmissionTab } from "./submission-tab";
import { preloadSubmitForm } from "./submit-form-preload";
import { FormSkeleton } from "./FormSkeleton";

const AccountTab = lazy(() => import("./CoinCenter").then((m) => ({ default: m.SubmissionsScreen })));
const AnonTab = lazy(() => import("./SubmitScreen").then((m) => ({ default: m.SubmitScreen })));
const InboxTab = lazy(() => import("./SubmitScreen").then((m) => ({ default: m.SubmitInboxScreen })));

/** 「投稿」页签内的表单模式：本站流水线（发金币）或免登录直投。 */
type FormMode = "coins" | "direct";

const MODE_META: { id: FormMode; label: string; hint: string }[] = [
  { id: "coins", label: "拿金币投稿", hint: "审核通过发金币，可进报告抽卡池" },
  { id: "direct", label: "免登录直投", hint: "不用注册 · 留邮箱可收审核通知" },
];

const MODE_ICON = { coins: Coins, direct: Zap } as const;

/** 切页签时改写地址栏，但**不新增历史记录**。
 *
 * 用 replaceState 而不是 pushState：页签是同一个页面的几块内容，不是几次
 * 导航。用 pushState 的话，用户在表单填到一半按浏览器后退，会被自己制造
 * 出来的历史条目困在页签之间打转，而不是离开投稿页。
 *
 * 表单模式（金币/直投）刻意不写进 URL：它只是同一页签里的一个视图切换，
 * 写进去就要回答「直投模式下刷新该不该保留草稿」这类问题，而草稿本来就不
 * 持久化。旧链接 ?tab=anon 的落点（直投）由 directEntryFromSearch 在进页
 * 时读一次。
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
  /* 从 /submit 302 过来的旧链接（?tab=anon）直奔免登录表单；其余默认金币表单。 */
  const [mode, setMode] = useState<FormMode>(() =>
    directEntryFromSearch(window.location.search) ? "direct" : "coins",
  );

  const select = useCallback((next: SubmissionTab) => {
    setTab(next);
    syncUrl(next);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  /* 加速：页签与表单 chunk、投稿机器人表单一起并行预取，不再等用户切过去
   * 才开始。import() 与上方 lazy() 声明的是同一批模块，这里只是提前触发。 */
  useEffect(() => {
    void import("./CoinCenter");
    void import("./SubmitScreen");
    void preloadSubmitForm().catch(() => {
      /* 预取失败不打断任何东西：SubmitScreen 挂载时还有一次真正的加载与重试。 */
    });
  }, []);

  /* 浏览器前进/后退也要跟上页签（replaceState 不产生条目，但用户可能是从
   * 一个带 ?tab= 的外部链接进来的，或者被别的脚本 pushState 过）。 */
  useEffect(() => {
    const onPop = () => {
      setTab(tabFromSearch(window.location.search));
      setMode(directEntryFromSearch(window.location.search) ? "direct" : "coins");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const subtitle =
    tab === "inbox" ? "进度 · 评论 · 管理员留言" : (MODE_META.find((entry) => entry.id === mode)?.hint ?? "");

  return (
    <div className="survey-glow min-h-dvh" data-submission-hub={tab}>
      <PageHeader
        title="投稿中心"
        subtitle={subtitle}
        /* 本页不渲染 BottomNav：桌面顶栏必须贴住视口顶（topNav=false），
         * 内容列与下方表单同宽（wide=false），否则标题悬在空列的左端、
         * 表单却居中，两边对不上。 */
        topNav={false}
        wide={false}
        tabs={
          <>
            {(["submit", "inbox"] as const).map((entry) => {
              const isActive = entry === tab;
              return (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => select(entry)}
                  className={`h-9 shrink-0 rounded-full px-3 text-[13px] font-semibold transition-colors ${
                    isActive
                      ? "bg-[var(--survey-primary)] text-white"
                      : "bg-[var(--survey-primary-soft)] text-[var(--survey-heading)]"
                  }`}
                >
                  {entry === "submit" ? "投稿" : "我的投稿"}
                </button>
              );
            })}
          </>
        }
      />
      <div className="mx-auto max-w-xl lg:max-w-3xl">
        {tab === "submit" ? (
          <>
            {/* 次级分段：两条投稿流水线的切换，视觉权重刻意低于顶栏页签。 */}
            <div
              className="mb-3 flex gap-1.5 rounded-full bg-[var(--survey-primary-soft)] p-1"
              role="tablist"
              aria-label="投稿方式"
            >
              {MODE_META.map((entry) => {
                const isActive = entry.id === mode;
                const ModeIcon = MODE_ICON[entry.id];
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setMode(entry.id)}
                    className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold transition-colors ${
                      isActive
                        ? "bg-[var(--survey-card-bg)] text-[var(--survey-heading)] shadow-sm"
                        : "text-[var(--survey-muted)]"
                    }`}
                  >
                    <ModeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {entry.label}
                  </button>
                );
              })}
            </div>
            <Suspense fallback={<FormSkeleton />}>
              {mode === "coins" ? <AccountTab embedded /> : null}
              {mode === "direct" ? <AnonTab embedded /> : null}
            </Suspense>
          </>
        ) : (
          <Suspense fallback={<FormSkeleton />}>
            <InboxTab embedded />
          </Suspense>
        )}
      </div>
    </div>
  );
}
