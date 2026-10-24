import { useCallback, useEffect, useState } from "react";
import { BookOpen, Bell, Check, ChevronRight, Coins, Lock, RefreshCw, Users } from "lucide-react";
import {
  fetchNotifications,
  fetchSeriesDetail,
  fetchSeriesList,
  markNotificationsSeen,
  toggleSeriesFollow,
  type NotificationDto,
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
      <div className="min-h-dvh bg-[var(--survey-bg,#f7f8fb)] px-5 py-16 text-center">
        <p className="text-sm text-[var(--app-danger)]">{error}</p>
        <button type="button" className="btn btn-primary mt-4 px-6" onClick={() => setReloadKey((key) => key + 1)}>
          <RefreshCw className="h-4 w-4" />
          重试
        </button>
      </div>
    );
  }

  if (slug) {
    return <SeriesDetailScreen detail={detail} onReload={() => setReloadKey((key) => key + 1)} />;
  }
  return <SeriesShelfScreen seriesList={seriesList} />;
}

function SeriesShelfScreen({ seriesList }: { seriesList: SeriesListItemDto[] | null }) {
  return (
    <div className="min-h-dvh bg-[var(--survey-bg,#f7f8fb)]">
      <header className="mx-auto flex max-w-xl items-center justify-between px-5 pt-6">
        <h1 className="flex items-center gap-2 text-xl font-bold text-[var(--color-ink)]">
          <BookOpen className="h-5 w-5 text-[var(--survey-primary)]" />
          系列书架
        </h1>
        <a href="/me" className="text-xs font-semibold text-[var(--survey-primary)]">
          我的 →
        </a>
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        {seriesList === null ? (
          <p className="py-16 text-center text-sm text-[var(--color-muted)]">加载中…</p>
        ) : seriesList.length === 0 ? (
          <p className="py-16 text-center text-sm text-[var(--color-muted)]">还没有连载作品</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {seriesList.map((series) => (
              <li key={series.id}>
                <a
                  href={`/series/${series.slug}`}
                  className="block rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg,#fff)] p-4 transition hover:shadow-md"
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
    </div>
  );
}

function SeriesDetailScreen({ detail, onReload }: { detail: SeriesDetailDto | null; onReload: () => void }) {
  const [followBusy, setFollowBusy] = useState(false);
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
      <div className="min-h-dvh bg-[var(--survey-bg,#f7f8fb)] px-5 py-16 text-center text-sm text-[var(--color-muted)]">
        加载中…
      </div>
    );
  }

  const nextChapter = detail.chapters.find((chapter) => chapter.surveyId === detail.nextChapterId);
  return (
    <div className="min-h-dvh bg-[var(--survey-bg,#f7f8fb)]">
      <header className="mx-auto max-w-xl px-5 pt-6">
        <a href="/series" className="text-xs font-semibold text-[var(--survey-primary)]">
          ← 书架
        </a>
        <h1 className="mt-2 text-xl font-bold text-[var(--color-ink)]">{detail.title}</h1>
        {detail.description ? <p className="mt-1.5 text-sm text-[var(--color-muted)]">{detail.description}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-5">
        <ol className="flex flex-col gap-2">
          {detail.chapters.map((chapter, index) => (
            <li key={chapter.surveyId}>
              <div
                role={chapter.locked ? undefined : "link"}
                className={`flex items-center gap-3 rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg,#fff)] px-4 py-3 ${
                  chapter.locked ? "opacity-60" : "cursor-pointer transition hover:shadow-md"
                }`}
                onClick={() => {
                  if (!chapter.locked) window.location.href = `/s/${chapter.surveyId}`;
                }}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
                    chapter.completed
                      ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                      : "bg-black/5 text-[var(--color-muted)]"
                  }`}
                >
                  {chapter.completed ? <Check className="h-4 w-4" /> : chapter.order || index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-[var(--color-ink)]">
                    {chapter.title}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                    {chapter.completed ? "已读完" : chapter.locked ? "需解锁" : "未开始"}
                    {chapter.coinPrice !== null && chapter.coinPrice > 0 ? (
                      <span className="inline-flex items-center gap-0.5">
                        <Lock className="h-3 w-3" />
                        <Coins className="h-3 w-3" aria-hidden="true" />
                        {chapter.coinPrice}
                      </span>
                    ) : null}
                    {chapter.contentRating === "r18" ? <span className="font-semibold text-red-600">18+</span> : null}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
              </div>
            </li>
          ))}
        </ol>
      </main>
    </div>
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
    <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
        <Bell className="h-3.5 w-3.5" />
        通知
        {unread > 0 ? (
          <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{unread}</span>
        ) : null}
      </p>
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
