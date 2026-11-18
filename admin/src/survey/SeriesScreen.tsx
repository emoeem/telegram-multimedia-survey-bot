import { useCallback, useEffect, useState } from "react";
import { BookOpen, Bell, Check, ChevronRight, Coins, Lock, Users } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, usePublicTheme, type PublicThemeState } from "./ScreenShell";
import { EmptyState, ErrorState, LoadingState, SectionHeader } from "./PublicPrimitives";
import {
  fetchNotifications,
  fetchSeriesDetail,
  fetchSeriesList,
  markNotificationsSeen,
  toggleSeriesFollow,
  type NotificationDto,
  type SeriesChapterDto,
  type SeriesDetailDto,
  type SeriesListItemDto,
} from "./api";

/**
 * 系列书架 / 连载详情（0083/0084）。
 *
 * 列表（/series）：追更入口，显示章节数与我的完成进度。
 * 详情（/series/:slug）：章节列表（✓已完成 / 继续 / 🔒金币 / 18+），续读按钮
 * 指向第一个未完成章节；关注后新章节会进站内通知（TG push 兜底）。
 */

function slugFromPath(): string | null {
  const match = window.location.pathname.match(/^\/series\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

export function SeriesScreen() {
  const slug = slugFromPath();
  const [seriesList, setSeriesList] = useState<SeriesListItemDto[] | null>(null);
  const [detail, setDetail] = useState<SeriesDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const themeState = usePublicTheme();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = slug
      ? fetchSeriesDetail(slug).then((data) => {
          if (!cancelled) setDetail(data.series);
        })
      : fetchSeriesList().then((data) => {
          if (!cancelled) setSeriesList(data.series);
        });
    load.catch(() => {
      if (!cancelled) setError("加载失败，请稍后重试");
    });
    return () => {
      cancelled = true;
    };
  }, [slug, reloadKey]);

  if (error) {
    return (
      <ScreenShell themeState={themeState}>
        <div className="mx-auto max-w-xl px-5 py-12 lg:max-w-3xl">
          <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
        </div>
      </ScreenShell>
    );
  }

  if (slug) {
    return (
      <SeriesDetailScreen detail={detail} themeState={themeState} onReload={() => setReloadKey((key) => key + 1)} />
    );
  }
  return <SeriesShelfScreen seriesList={seriesList} themeState={themeState} />;
}

function SeriesShelfScreen({
  seriesList,
  themeState,
}: {
  seriesList: SeriesListItemDto[] | null;
  themeState: PublicThemeState;
}) {
  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        helpKey="series"
        title="系列书架"
        subtitle="追一部连载，按章节慢慢读"
        titleIcon={<BookOpen className="h-4 w-4" />}
        backHref="/me"
        backLabel="我的"
        wide={false}
      />
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4 lg:max-w-3xl">
        {seriesList === null ? (
          <LoadingState label="正在加载系列" rows={3} />
        ) : seriesList.length === 0 ? (
          <EmptyState icon={BookOpen} title="还没有连载作品" description="等第一部连载开坑，这里就会出现。" />
        ) : (
          <ul className="flex flex-col gap-3">
            {seriesList.map((series) => (
              <li key={series.id}>
                <a
                  href={`/series/${series.slug}`}
                  className="survey-card block p-4 transition-[transform,box-shadow] duration-[var(--fx-dur)] ease-[var(--fx-ease)] hover:-translate-y-0.5 hover:shadow-[var(--fx-glow-md)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-[16px] font-semibold text-[var(--color-ink)]">{series.title}</h2>
                      {series.description ? (
                        <p className="mt-1 line-clamp-2 text-xs text-[var(--color-muted)]">{series.description}</p>
                      ) : null}
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                  </div>
                  <div className="mt-2.5 flex items-center gap-2 text-[11px]">
                    <span className="chip">{series.chapterCount} 章</span>
                    {series.completedCount > 0 ? (
                      <span className="chip text-[var(--survey-primary)]">
                        已读 {series.completedCount}/{series.chapterCount}
                      </span>
                    ) : null}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </ScreenShell>
  );
}

/** 章节卡主体：解锁（<a> 跳填写页）与锁定（<button> 展开引导）两分支共用。 */
function ChapterCardBody({ chapter, index }: { chapter: SeriesChapterDto; index: number }) {
  return (
    <>
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
          chapter.completed
            ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
            : "bg-[var(--survey-bg)] text-[var(--survey-muted)]"
        }`}
      >
        {chapter.completed ? <Check className="h-4 w-4" /> : chapter.order || index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-[var(--survey-heading)]">{chapter.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--survey-muted)]">
          {chapter.completed ? "已读完" : chapter.locked ? "需解锁" : "未开始"}
          {chapter.coinPrice !== null && chapter.coinPrice > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Lock className="h-3 w-3" />
              <Coins className="h-3 w-3" aria-hidden="true" />
              {chapter.coinPrice}
            </span>
          ) : null}
          {chapter.contentRating === "r18" ? <span className="font-semibold text-[var(--app-danger)]">18+</span> : null}
        </span>
      </span>
    </>
  );
}

function SeriesDetailScreen({
  detail,
  themeState,
  onReload,
}: {
  detail: SeriesDetailDto | null;
  themeState: PublicThemeState;
  onReload: () => void;
}) {
  const [followBusy, setFollowBusy] = useState(false);
  /* 锁定章节的解锁引导展开态：记录当前展开引导的 chapter.surveyId（null = 全部收起）。 */
  const [unlockHintId, setUnlockHintId] = useState<number | null>(null);
  const follow = useCallback(async () => {
    if (!detail || followBusy) return;
    setFollowBusy(true);
    try {
      await toggleSeriesFollow(detail.id);
      onReload();
    } catch {
      // 失败静默：按钮回位，用户可重试。
    } finally {
      setFollowBusy(false);
    }
  }, [detail, followBusy, onReload]);

  if (!detail) {
    return (
      <ScreenShell themeState={themeState}>
        <div className="mx-auto max-w-xl px-5 py-12 lg:max-w-3xl">
          <LoadingState label="正在加载连载详情" rows={4} />
        </div>
      </ScreenShell>
    );
  }

  const nextChapter = detail.chapters.find((chapter) => chapter.surveyId === detail.nextChapterId);
  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        title={detail.title}
        subtitle={detail.description ?? undefined}
        titleIcon={<BookOpen className="h-4 w-4" />}
        backHref="/series"
        backLabel="书架"
        wide={false}
      />
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4 lg:max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary px-5" disabled={followBusy} onClick={follow}>
            <Bell className="h-4 w-4" />
            {detail.following ? "已关注追更" : "关注追更"}
          </button>
          <span className="chip text-xs">
            <Users className="mr-1 inline h-3 w-3" />
            {detail.followerCount} 人在追
          </span>
          {nextChapter ? (
            <a className="btn px-4 text-sm" href={`/s/${nextChapter.surveyId}`}>
              {detail.chapters.some((chapter) => chapter.completed) ? "继续阅读" : "开始阅读"}
            </a>
          ) : null}
        </div>
        <ol className="flex flex-col gap-2">
          {detail.chapters.map((chapter, index) => (
            <li key={chapter.surveyId}>
              {chapter.locked ? (
                <>
                  {/* 锁定章节（B2 死路修复）：旧实现 href=undefined + pointer-events-none，
                     显示「需解锁+🔒N金币」却点不动，用户卡住。现在点击展开解锁引导——
                     金币门就长在本章填写页（/s/{id} 的 CoinGateScreen），进页确认即可。 */}
                  <button
                    type="button"
                    aria-expanded={unlockHintId === chapter.surveyId}
                    className="survey-card flex w-full items-center gap-3 px-4 py-3 text-left opacity-80"
                    onClick={() => setUnlockHintId(unlockHintId === chapter.surveyId ? null : chapter.surveyId)}
                  >
                    <ChapterCardBody chapter={chapter} index={index} />
                    <Lock className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                  </button>
                  {unlockHintId === chapter.surveyId ? (
                    <div className="survey-card mt-2 p-3">
                      <p className="text-[12px] leading-5 text-[var(--survey-body)]">
                        {chapter.coinPrice !== null && chapter.coinPrice > 0
                          ? `本章需 ${chapter.coinPrice} 金币解锁：点「去本章解锁」进入填写页，页面会弹出金币解锁面板，确认后立即放行（解锁后可永久填写）。`
                          : "本章可免费领取：点「去本章解锁」进入填写页，按提示领取后即可填写。"}
                        {chapter.coinPrice !== null && chapter.coinPrice > 0
                          ? "金币不够时，先去金币中心签到或做任务。"
                          : ""}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <a className="btn btn-primary px-4 text-xs" href={`/s/${chapter.surveyId}`}>
                          <Lock className="h-3.5 w-3.5" />
                          去本章解锁
                        </a>
                        <a className="btn px-4 text-xs" href="/coins">
                          <Coins className="h-3.5 w-3.5" />
                          金币中心
                        </a>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <a
                  href={`/s/${chapter.surveyId}`}
                  className="survey-card flex items-center gap-3 px-4 py-3 transition-[transform,box-shadow] duration-[var(--fx-dur)] ease-[var(--fx-ease)] hover:-translate-y-0.5 hover:shadow-[var(--fx-glow-md)]"
                >
                  <ChapterCardBody chapter={chapter} index={index} />
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                </a>
              )}
            </li>
          ))}
        </ol>
      </main>
    </ScreenShell>
  );
}

/** 「我的」页的通知区块：未读红点 + 列表，打开即清未读。 */
export function NotificationCenter() {
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchNotifications()
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setUnread(data.unread);
        if (data.unread > 0) void markNotificationsSeen().catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (items === null) return null;
  return (
    <section className="survey-card p-4">
      <SectionHeader
        icon={Bell}
        title="通知"
        action={
          unread > 0 ? (
            <span className="rounded-full bg-[var(--app-danger)] px-1.5 py-0.5 text-[10px] font-bold text-white">
              {unread}
            </span>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--survey-muted)]">还没有通知。关注系列后，更新会出现在这里。</p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--survey-card-border)]">
          {items.slice(0, 8).map((item) => (
            <li key={item.id} className="py-2.5">
              <a href={item.link || "/series"} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[13px] ${item.readAt ? "text-[var(--survey-muted)]" : "font-semibold text-[var(--survey-heading)]"}`}
                  >
                    {item.title}
                  </span>
                  {item.body ? (
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--survey-muted)]">{item.body}</span>
                  ) : null}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
