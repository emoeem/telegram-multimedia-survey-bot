import { useEffect, useState } from "react";
import { ArrowUpRight, FileText, Globe, LayoutGrid, MailCheck, MessagesSquare, Sparkles, Swords } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";
import { EntryRow, SectionHeader } from "./PublicPrimitives";
import { FALLBACK_GAME_TYPES, gameEntryHref, type GameTypeInfo } from "./game-lobby-logic";
import { fetchGameTypes } from "./game-room-client";
import { fetchWebApps, type WebAppLink } from "./web-apps";
import { openWebAppLink } from "./web-app-open";
import { currentWebApp } from "../telegram";

/**
 * 「网页导航」区（应用中心四功能区之三）。
 *
 * 数据来自 GET /api/web-apps（M2 批次落地）：接口 404、空数据或网络失败都
 * 由 fetchWebApps 收敛为空列表，这里只渲染空态——绝不能报错或白屏。
 *
 * 打开（M4 收口）：不用 <a href>（中键/新标签会绕过校验），统一走用户点击
 * 回调 openWebAppLink——先按公开 API 下发的 allowed_domains 二次校验目标
 * host（纵深防御，管理端数据异常/被篡改时不盲目打开并提示），再按环境与
 * open_mode 三分支打开（Telegram 内 openLink、普通浏览器新标签
 * noopener,noreferrer）；绝不把第三方站点塞 iframe。
 */
function WebAppsCard() {
  const [apps, setApps] = useState<WebAppLink[] | null>(null);
  const [blockedHint, setBlockedHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWebApps().then((data) => {
      if (!cancelled) setApps(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 打开入口（M4）：只由本点击回调触发，点击前无任何网络请求副作用。 */
  const handleOpen = (app: WebAppLink) => {
    const outcome = openWebAppLink(app, { telegramWebApp: currentWebApp() });
    if (outcome === "blocked:not-allowed") {
      setBlockedHint(`「${app.name}」的链接未通过域名白名单校验，已停止打开。`);
      return;
    }
    setBlockedHint(null);
  };

  return (
    <section className="survey-card p-4">
      <SectionHeader icon={Globe} title="网页导航" />
      {apps === null ? (
        <p className="mt-2 text-[13px] text-[var(--survey-muted)]">正在加载网页导航…</p>
      ) : apps.length === 0 ? (
        /* 空态：接口未上线或暂无收录，一句话说明而不是报错。 */
        <p className="mt-2 py-2 text-center text-[13px] text-[var(--survey-muted)]">
          网页导航还在筹备中，收录的好站会出现在这里。
        </p>
      ) : (
        <>
          <ul className="mt-1 divide-y divide-[var(--survey-card-border)]">
            {apps.map((app) => (
              <li key={`${app.id}-${app.url}`} className="py-2.5">
                <button
                  type="button"
                  onClick={() => handleOpen(app)}
                  className="flex w-full items-center gap-2 text-left"
                >
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
                </button>
              </li>
            ))}
          </ul>
          {blockedHint ? (
            <p
              role="alert"
              className="mt-2 rounded-lg bg-[color-mix(in_srgb,var(--app-danger)_12%,transparent)] px-3 py-2 text-[12px] leading-5 text-[var(--app-danger)]"
            >
              {blockedHint}
            </p>
          ) : null}
        </>
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
  // 联机对战入口卡（批次 X2）：读 GET /api/game/types 渲染已注册玩法
  // （五子棋/象棋各一卡），失败/未升级部署回退静态列表——入口在任何部署
  // 下都不消失，与 /trial 小游戏区同一套数据面。
  const [gameEntries, setGameEntries] = useState<GameTypeInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchGameTypes().then((result) => {
      if (!cancelled) setGameEntries(result.ok ? result.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        {/* 联机对战（批次 X2）：读 /api/game/types 渲染每款已注册玩法一卡
            （五子棋→/game、象棋→/game?type=xiangqi）；拉取失败回退静态
            五子棋卡，入口在任何部署下都不消失。 */}
        {(gameEntries ?? FALLBACK_GAME_TYPES).map((game) => (
          <EntryRow
            key={game.name}
            href={gameEntryHref(game.name)}
            icon={Swords}
            title={`${game.displayName} · 联机对战`}
            subtitle={game.description || "创建房间或输入房间码，和好友实时对弈"}
          />
        ))}

        {/* ③ 网页导航：数据由 M2 的 /api/web-apps 供给，M1 先落空态。 */}
        <WebAppsCard />

        {/* ④ 社区 */}
        <EntryRow href="/plaza" icon={MessagesSquare} title="广场" subtitle="匿名树洞，看看同路人在说什么" />
        <EntryRow href="/notes" icon={MailCheck} title="纸条聊天" subtitle="放一张纸条，抽到同路的人就开始私聊" />
      </main>
    </ScreenShell>
  );
}
