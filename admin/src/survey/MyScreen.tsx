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
import { createMyShowcase, fetchMyOverview, markAchievementsSeen, type MyOverview } from "./api";
import { safeGet } from "./storage";

function closeMyPage(): void {
  const w = window as Window & { Telegram?: { WebApp?: { close?: () => void } } };
  if (w.Telegram?.WebApp?.close) {
    w.Telegram.WebApp.close();
    return;
  }
  window.close();
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = "/s";
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
            <button type="button" aria-label="关闭" title="关闭" className="survey-icon-btn" onClick={closeMyPage}>
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
