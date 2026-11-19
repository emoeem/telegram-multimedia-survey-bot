import { useEffect, useState } from "react";
import { ArrowUpRight, FileText, Globe, LayoutGrid, MailCheck, MessagesSquare, Sparkles } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";
import { EntryRow, SectionHeader } from "./PublicPrimitives";
import { fetchWebApps, type WebAppLink } from "./web-apps";

/**
 * 「网页导航」区（应用中心四功能区之三）。
 *
 * 数据来自 GET /api/web-apps（M2 批次落地）：接口 404、空数据或网络失败都
 * 由 fetchWebApps 收敛为空列表，这里只渲染空态——M1 阶段这条文案就是
 * 该区的常态，绝不能报错或白屏。
 */
function WebAppsCard() {
  const [apps, setApps] = useState<WebAppLink[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWebApps().then((data) => {
      if (!cancelled) setApps(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="survey-card p-4">
      <SectionHeader icon={Globe} title="网页导航" />
      {apps === null ? (
        <p className="mt-2 text-[13px] text-[var(--survey-muted)]">正在加载网页导航…</p>
      ) : apps.length === 0 ? (
        /* M2 落地前的空态：接口未上线或暂无收录，一句话说明而不是报错。 */
        <p className="mt-2 py-2 text-center text-[13px] text-[var(--survey-muted)]">
          网页导航还在筹备中，收录的好站会出现在这里。
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--survey-card-border)]">
          {apps.map((app) => (
            <li key={`${app.id}-${app.url}`} className="py-2.5">
              <a href={app.url} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-[var(--survey-heading)]">
                    {app.name}
                  </span>
                  {app.description ? (
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--survey-muted)]">
                      {app.description}
                    </span>
                  ) : null}
                </span>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 应用中心（/app，2026-11-20 P0 加固批次 M1）。
 *
 * 四功能区的聚合入口：①问卷中心 → /s；②小游戏 → /trial；③网页导航 →
 * GET /api/web-apps（M2 供给数据，先落空态）；④社区 → /plaza、/notes。
 * 入口：「我的」页的应用中心入口卡。壳沿用 ScreenShell（主题 + 底部六 tab
 * 导航），不动 BottomNav 布局；本屏不加新 tab，/app 不在导航里挂角标。
 */
export function AppCenterScreen() {
  const themeState = usePublicTheme();
  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        helpKey="app"
        title="应用中心"
        subtitle="问卷、小游戏、网页导航与社区，一个页面全找到"
        titleIcon={<LayoutGrid className="h-4 w-4" />}
        backHref={null}
        wide={false}
        actions={<ThemeAction themeState={themeState} />}
      />

      <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-3xl">
        {/* ① 问卷中心 */}
        <EntryRow href="/s" icon={FileText} title="问卷中心" subtitle="选一份问卷开始回答，答完生成解读报告" />

        {/* ② 小游戏 */}
        <EntryRow href="/trial" icon={Sparkles} title="小游戏" subtitle="爬塔挑战等小游戏，查看成绩与排行榜" />

        {/* ③ 网页导航：数据由 M2 的 /api/web-apps 供给，M1 先落空态。 */}
        <WebAppsCard />

        {/* ④ 社区 */}
        <EntryRow href="/plaza" icon={MessagesSquare} title="广场" subtitle="匿名树洞，看看同路人在说什么" />
        <EntryRow href="/notes" icon={MailCheck} title="纸条聊天" subtitle="放一张纸条，抽到同路的人就开始私聊" />
      </main>
    </ScreenShell>
  );
}
