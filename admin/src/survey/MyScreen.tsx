import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileCheck2, Images, Link2, Palette, Target, UserRound, X } from "lucide-react";
import { AchievementWall } from "./AchievementWall";
import { BottomNav } from "./BottomNav";
import {
  loadGlobalPreset,
  saveGlobalPreset,
  themeBackgroundStyle,
  themeCssVars,
  ThemePickerSheet,
  useResolvedPreset,
} from "./theme-ui";
import {
  coinApi,
  createMyShowcase,
  fetchMyOverview,
  fetchMyReports,
  markAchievementsSeen,
  type CoinOverview,
  type MyOverview,
  type MyReportItem,
} from "./api";
import { safeGet } from "./storage";
import { closeWebApp } from "./navigation";


/** 金币卡片（独立取数：金币服务不可用时不影响「我的」其他区块）。 */
function CoinCard() {
  const [overview, setOverview] = useState<CoinOverview | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    coinApi
      .overview()
      .then(setOverview)
      .catch(() => undefined);
  };

  useEffect(() => {
    reload();
  }, []);

  const doCheckin = async () => {
    setBusy(true);
    try {
      await coinApi.checkin();
      reload();
    } catch {
      // 重复签到等错误静默；余额刷新即为反馈。
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="coin-balance-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">我的金币</p>
          <p className="mt-0.5 text-3xl font-black text-white">
            {overview ? overview.balance : "—"}
            <span className="ml-1.5 text-xs font-bold text-white/80">金币</span>
          </p>
          {overview ? (
            <p className="mt-0.5 text-[11px] text-white/70">
              连续签到 {overview.checkin.streak} 天 · 累计获得 {overview.totalEarned}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="coin-checkin-btn"
          disabled={busy || Boolean(overview?.checkin.checkedInToday)}
          onClick={() => void doCheckin()}
        >
          {overview?.checkin.checkedInToday ? "已签到" : busy ? "…" : "签到"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <a className="coin-entry-compact" href="/coins">
          明细 / 任务
        </a>
        <a className="coin-entry-compact" href="/gacha">
          报告抽卡
        </a>
        <a className="coin-entry-compact" href="/submissions">
          投稿中心
        </a>
      </div>
    </section>
  );
}

/**
 * 「我的报告」：已完成答卷的报告入口。
 *
 * 完成页带 token 的报告链接是一次性的——离开之后就找不回来了，用户明确反馈
 * 「填完之后无法查看自己的报告」。这里按参与者身份列出全部已完成答卷，服务端
 * 为每条现铸 30 天 token；匿名浏览器身份也适用（身份就是本机保存的 key）。
 * 与金币卡一样独立取数：报告接口出错不影响「我的」其他区块。
 */
function ReportList() {
  const [reports, setReports] = useState<MyReportItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyReports()
      .then((data) => {
        if (!cancelled) setReports(data.reports);
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 没有报告（或接口不可用）时不占版面：数据总览里的「已完成问卷」已经说了数量。
  if (!reports || reports.length === 0) return null;

  return (
    <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
        <FileCheck2 className="h-3.5 w-3.5" />
        我的报告
        <span className="font-normal">（{reports.length}）</span>
      </p>
      <ul className="mt-1 divide-y divide-[var(--survey-card-border)]">
        {reports.map((report) => (
          <li key={report.responseId} className="flex items-center gap-2 py-2.5">
            <a href={report.reportUrl} className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-[var(--survey-heading)]">
                  {report.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                  {report.completedAt ? `${report.completedAt.slice(0, 10)} 完成` : "已完成"}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
            </a>
            <a
              href={report.pdfUrl}
              download
              className="shrink-0 rounded-full border border-[var(--survey-card-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--survey-primary)]"
            >
              下载 PDF
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 「我的」个人中心（/me）：当前参与者身份下的答卷、资料卡、徽章、挑战数据与
 * 外观设置的统一入口。
 */
export function MyScreen() {
  const [overview, setOverview] = useState<MyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [showcaseBusy, setShowcaseBusy] = useState(false);
  const [showcaseError, setShowcaseError] = useState<string | null>(null);
  const [themePreset, setThemePreset] = useState<string | null>(() => loadGlobalPreset());
  const [hasTelegramIdentity] = useState<boolean>(() => safeGet("tg:linked") === "1" || Boolean(safeGet("tg:identity")));

  const resolvedPreset = useResolvedPreset(themePreset);
  const theme = resolvedPreset ? { preset: resolvedPreset } : null;
  const vars = useMemo(() => themeCssVars(theme), [theme]);
  const backgroundStyle = useMemo(() => themeBackgroundStyle(theme), [theme]);

  useEffect(() => {
    let cancelled = false;
    fetchMyOverview()
      .then((data) => {
        if (!cancelled) setOverview(data);
        // 打开「我的」即为"已读"：先渲染带小红点的数据，再清标记。
        if (data.achievements?.unseen) {
          void markAchievementsSeen().catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectTheme = (preset: string | null) => {
    setThemePreset(preset);
    saveGlobalPreset(preset);
  };

  /** 用当前资料卡生成展示页草稿；展示区是策展空间，公开与否归管理员。 */
  const generateShowcase = async () => {
    setShowcaseBusy(true);
    setShowcaseError(null);
    try {
      const result = await createMyShowcase();
      setOverview((prev) =>
        prev ? { ...prev, showcase: { personId: result.showcase.personId, published: result.showcase.published } } : prev,
      );
    } catch (err) {
      setShowcaseError(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally {
      setShowcaseBusy(false);
    }
  };

  return (
    <div className="survey-glow min-h-dvh pb-24" data-theme={theme?.preset} style={{ ...vars, ...backgroundStyle }}>
      <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-5 py-3 lg:max-w-3xl">
          <div>
            <p className="text-[15px] font-bold text-[var(--survey-heading)]">👤 我的</p>
            <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">你的答卷、资料卡与挑战记录</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="选择主题"
              title="选择主题"
              className="survey-icon-btn"
              onClick={() => setThemePickerOpen(true)}
            >
              <Palette className="h-4 w-4" />
            </button>
            <button type="button" aria-label="关闭" title="关闭" className="survey-icon-btn" onClick={() => closeWebApp()}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-3xl">
        {error ? (
          <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-center text-sm text-[var(--survey-body)]">
            {error}
          </div>
        ) : overview === null ? (
          <p className="py-16 text-center text-sm text-[var(--survey-muted)]">加载中…</p>
        ) : (
          <>
            {/* 身份 */}
            <section className="flex items-center gap-3 rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
                <UserRound className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-[var(--survey-heading)]">
                  {overview.identity.telegram ? "已绑定 Telegram" : "匿名访客身份"}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-[var(--survey-muted)]">
                  {overview.identity.telegram
                    ? "答卷、挑战与资料卡都会归属到这个身份"
                    : "从 Telegram 机器人打开可绑定身份，成绩才能上榜"}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  overview.identity.telegram
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-[var(--survey-bg)] text-[var(--survey-muted)]"
                }`}
              >
                {overview.identity.telegram ? "已认证" : "未绑定"}
              </span>
            </section>

            <CoinCard />

            <ReportList />

            {/* 数据总览 */}
            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
                  <FileCheck2 className="h-3.5 w-3.5" />
                  已完成问卷
                </p>
                <p className="mt-1.5 text-2xl font-black text-[var(--survey-heading)]">
                  {overview.completedSurveys}
                  <span className="ml-1 text-xs font-semibold text-[var(--survey-muted)]">份</span>
                </p>
              </div>
              <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
                  <Target className="h-3.5 w-3.5" />
                  挑战通关
                </p>
                <p className="mt-1.5 text-2xl font-black text-[var(--survey-heading)]">
                  {overview.trial.completed}
                  <span className="ml-1 text-xs font-semibold text-[var(--survey-muted)]">
                    / {overview.trial.runs} 局
                  </span>
                </p>
              </div>
            </section>

            {/* 我的资料卡 */}
            <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
                <Link2 className="h-3.5 w-3.5" />
                我的资料卡
              </p>
              {overview.myProfile ? (
                <a href={`/plaza/profile/${overview.myProfile.responseId}`} className="mt-2.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold text-[var(--survey-heading)]">
                      {overview.myProfile.heading ?? "未命名资料卡"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                      已发布于 {(overview.myProfile.publishedAt || "").slice(0, 10)} · 点击查看
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                </a>
              ) : overview.profileSurveyId ? (
                <a
                  href={`/s/${overview.profileSurveyId}`}
                  className="mt-3 block rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-center text-[13px] font-semibold text-[var(--survey-primary-content)]"
                >
                  填写个人资料问卷，生成我的资料卡
                </a>
              ) : (
                <p className="mt-2 text-[13px] text-[var(--survey-muted)]">
                  资料卡功能还未开放，先去逛逛<a className="text-[var(--survey-primary)] underline" href="/plaza">广场</a>吧。
                </p>
              )}

              {overview.myProfile ? (
                <div className="mt-3 border-t border-[var(--survey-card-border)] pt-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
                    <Images className="h-3.5 w-3.5" />
                    展示页
                  </p>
                  {overview.showcase?.published ? (
                    <a href={`/showcase?p=${overview.showcase.personId}`} className="mt-2 flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">我的展示页</span>
                        <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">已公开 · 点击查看</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                    </a>
                  ) : overview.showcase ? (
                    <p className="mt-2 text-[12px] leading-5 text-[var(--survey-muted)]">
                      展示页已生成（#{overview.showcase.personId}），管理员审核通过后就会公开。
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={showcaseBusy}
                      onClick={() => void generateShowcase()}
                      className="mt-2 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2.5 text-[13px] font-semibold text-[var(--survey-body)] transition hover:bg-[var(--survey-primary-soft)] disabled:opacity-60"
                    >
                      {showcaseBusy ? "生成中…" : "把我的资料卡生成展示页"}
                    </button>
                  )}
                  {showcaseError ? <p className="mt-1.5 text-[11px] text-red-500">{showcaseError}</p> : null}
                </div>
              ) : null}
            </section>

            {/* 成就徽章墙（目录与解锁状态都来自服务端） */}
            {overview.achievements?.items?.length ? <AchievementWall overview={overview.achievements} /> : null}

            {/* 入口 */}
            <a
              href="/trial"
              className="flex items-center gap-3 rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
                <Target className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">挑战任务</span>
                <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                  查看完整对局记录与排行榜
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
            </a>
          </>
        )}
      </main>

      <ThemePickerSheet
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        selected={themePreset}
        onSelect={selectTheme}
      />
      <BottomNav />
    </div>
  );
}
