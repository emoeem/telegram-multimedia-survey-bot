import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Info, Palette, RefreshCw, Sprout, X } from "lucide-react";
import { BottomNav } from "./BottomNav";
import { ShowcaseSheet } from "./ShowcaseSheet";
import { closeWebApp } from "./navigation";
import { vibrateLight } from "./haptics";
import { fetchShowcase, type ShowcasePerson } from "./showcase-api";
import { loadGlobalPreset, saveGlobalPreset, ThemePickerSheet, themeCssVars, useResolvedPreset } from "./theme-ui";

/**
 * Showcase (展示区) — the immersive person gallery.
 *
 * Mobile-first: the stage is a native, snap-scrolling carousel (one full-width
 * slide per person), so the swipe is driven by the browser's own scrolling —
 * momentum, follow-the-finger tracking and trackpad swipes all come for free
 * and never stutter the way a JS-driven carousel does under load.
 *
 * Layering gives the transition its depth:
 *   1. a background layer per person, cross-fading (opacity + slow scale)
 *   2. the illustration, which travels with the swipe inside the scroller
 *   3. a caption that fades in once its slide settles
 *   4. a tap opens the bottom sheet, which is the only theme-aware surface.
 */

const ACCENT_FALLBACK = "#7c8cff";
const SWIPE_TAP_TOLERANCE = 12;

function backdropStyle(person: ShowcasePerson): CSSProperties {
  const from = person.background.from ?? person.accentColor ?? "#182042";
  const to = person.background.to ?? "#05070d";
  const gradient = `linear-gradient(160deg, ${from}, ${to})`;
  if (person.background.imageUrl) {
    return {
      backgroundColor: from,
      backgroundImage: `url("${person.background.imageUrl}"), ${gradient}`,
    };
  }
  return { backgroundImage: gradient };
}

function PersonSlide({
  person,
  active,
  onPointerDown,
  onFigureClick,
}: {
  person: ShowcasePerson;
  active: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onFigureClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <article className="showcase-slide" data-active={active ? "true" : "false"} aria-hidden={!active}>
      <button
        type="button"
        className="showcase-figure"
        onPointerDown={onPointerDown}
        onClick={onFigureClick}
        aria-label={`查看 ${person.name} 的资料`}
        tabIndex={active ? 0 : -1}
      >
        {person.illustrationUrl ? (
          <img
            src={person.illustrationUrl}
            alt={`${person.name} 的立绘`}
            decoding="async"
            loading={active ? "eager" : "lazy"}
          />
        ) : (
          <span className="showcase-figure-fallback">{person.name.slice(0, 1)}</span>
        )}
      </button>
      <div className="showcase-caption">
        <p className="showcase-name">{person.name}</p>
        {person.subtitle ? <p className="showcase-subtitle">{person.subtitle}</p> : null}
        {person.tags.length > 0 ? (
          <div className="showcase-tag-row">
            {person.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="showcase-tag">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        <span className="showcase-figure-hint">
          <Info className="h-3.5 w-3.5" />
          轻点立绘查看资料
        </span>
      </div>
    </article>
  );
}

export function ShowcaseScreen() {
  const [people, setPeople] = useState<ShowcasePerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [index, setIndex] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themePreset, setThemePreset] = useState<string | null>(() => loadGlobalPreset());

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const frameRef = useRef(0);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);

  const resolvedPreset = useResolvedPreset(themePreset);
  const themeVars = useMemo(() => themeCssVars(resolvedPreset ? { preset: resolvedPreset } : null), [resolvedPreset]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPeople(null);
    setNextCursor(null);
    setLoadMoreError(null);
    fetchShowcase("", 24)
      .then((feed) => {
        if (!cancelled) {
          setPeople(feed.items);
          setNextCursor(feed.nextCursor);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "展示区加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const feed = await fetchShowcase(nextCursor, 24);
      setPeople((current) => (current ? [...current, ...feed.items] : feed.items));
      setNextCursor(feed.nextCursor);
    } catch (requestError) {
      setLoadMoreError(requestError instanceof Error ? requestError.message : "加载下一组失败");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    const root = scrollerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel || !nextCursor) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root, rootMargin: "0px 100% 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  // Open on ?p=<id> so a shared link lands on the same person.
  useEffect(() => {
    if (!people || people.length === 0) return undefined;
    const requested = Number(new URLSearchParams(window.location.search).get("p"));
    const found = Number.isInteger(requested) && requested > 0 ? people.findIndex((p) => p.id === requested) : -1;
    if (requested > 0 && found < 0 && nextCursor) {
      void loadMore();
      return undefined;
    }
    const start = found >= 0 ? found : 0;
    indexRef.current = start;
    setIndex(start);
    const frame = requestAnimationFrame(() => {
      const el = scrollerRef.current;
      // No layout yet (hidden pane): skip — realign on resize/visibility fixes it up.
      if (el && el.clientWidth > 0) el.scrollLeft = start * el.clientWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [loadMore, nextCursor, people]);

  const syncIndex = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !people?.length) return;
    const width = el.clientWidth || 1;
    const next = Math.max(0, Math.min(people.length - 1, Math.round(el.scrollLeft / width)));
    if (next === indexRef.current) return;
    indexRef.current = next;
    setIndex(next);
  }, [people]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el && nextCursor && !loadingMore && el.scrollLeft + el.clientWidth >= el.scrollWidth - el.clientWidth * 0.5) {
      void loadMore();
    }
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      syncIndex();
    });
  }, [loadMore, loadingMore, nextCursor, syncIndex]);

  // Haptic tick once a swipe settles — never on every scroll frame.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    let timer = 0;
    let last = indexRef.current;
    const handle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (indexRef.current !== last) {
          last = indexRef.current;
          vibrateLight();
        }
      }, 150);
    };
    el.addEventListener("scroll", handle, { passive: true });
    return () => {
      el.removeEventListener("scroll", handle);
      window.clearTimeout(timer);
    };
  }, [people]);

  // An orientation change re-lays the slides out; keep the same person centred.
  // A hidden pane (backgrounded WebView, collapsed window) reports a 0 clientWidth:
  // writing scrollLeft against it snaps the stage back to slide 1 and desyncs the
  // shared URL, so alignment only runs while the scroller actually has layout.
  useEffect(() => {
    const realign = () => {
      const el = scrollerRef.current;
      if (!el || el.clientWidth === 0) return;
      el.scrollLeft = indexRef.current * el.clientWidth;
    };
    window.addEventListener("resize", realign);
    window.addEventListener("orientationchange", realign);
    document.addEventListener("visibilitychange", realign);
    return () => {
      window.removeEventListener("resize", realign);
      window.removeEventListener("orientationchange", realign);
      document.removeEventListener("visibilitychange", realign);
    };
  }, []);

  // Keep the address bar in sync so the current person can be shared/copied.
  useEffect(() => {
    if (!people?.length) return;
    const person = people[index];
    if (!person) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("p") === String(person.id)) return;
    url.searchParams.set("p", String(person.id));
    window.history.replaceState(null, "", url);
  }, [index, people]);

  const goTo = useCallback(
    (next: number) => {
      const el = scrollerRef.current;
      if (!el || !people?.length) return;
      const clamped = Math.max(0, Math.min(people.length - 1, next));
      el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
      indexRef.current = clamped;
      setIndex(clamped);
    },
    [people],
  );

  useEffect(() => {
    if (sheetOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") goTo(indexRef.current + 1);
      if (event.key === "ArrowLeft") goTo(indexRef.current - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goTo, sheetOpen]);

  const onFigurePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    tapStartRef.current = { x: event.clientX, y: event.clientY };
  };
  // A swipe ends with a click on whatever is under the finger; only a real tap
  // (the pointer barely moved) may open the sheet, or every swipe would.
  const onFigureClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > SWIPE_TAP_TOLERANCE) return;
    if (Math.abs(event.clientY - start.y) > SWIPE_TAP_TOLERANCE) return;
    const el = scrollerRef.current;
    if (el && Math.abs(el.scrollLeft - indexRef.current * el.clientWidth) > SWIPE_TAP_TOLERANCE) return;
    setSheetOpen(true);
  };

  const active = people?.[index] ?? null;
  const accent = active?.accentColor ?? ACCENT_FALLBACK;
  const rootStyle = { ...themeVars, "--sc-accent": accent } as CSSProperties;

  const selectTheme = (presetId: string | null) => {
    setThemePreset(presetId);
    saveGlobalPreset(presetId);
  };

  const total = people?.length ?? 0;

  return (
    <div className="showcase-root" data-theme={resolvedPreset ?? undefined} style={rootStyle}>
      <div className="showcase-stage">
        {people && people.length > 0 ? (
          <div className="showcase-backdrop" aria-hidden="true">
            {people.map((person, position) => {
              // Only the active person and its immediate neighbours are painted:
              // a long showcase must not decode every full-bleed image at once.
              if (Math.abs(position - index) > 1) return null;
              return (
                <div
                  key={person.id}
                  className={`showcase-backdrop-layer${position === index ? " is-active" : ""}${
                    person.background.imageUrl ? " is-image" : ""
                  }`}
                  style={backdropStyle(person)}
                />
              );
            })}
            <div className="showcase-veil" />
          </div>
        ) : null}

        <header className="showcase-topbar">
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-white">✨ 展示区</p>
            <p className="mt-0.5 truncate text-[11px] text-white/60">
              {total > 0 ? `左右滑动浏览 ${total} 位创作者` : "创作者的作品展览空间"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="showcase-icon-btn"
              aria-label="选择主题"
              onClick={() => setThemePickerOpen(true)}
            >
              <Palette className="h-4 w-4" />
            </button>
            <button type="button" className="showcase-icon-btn" aria-label="关闭" onClick={closeWebApp}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {people === null && !error ? (
          <div className="showcase-state">
            <div className="showcase-skeleton" />
            <p>正在布置展台…</p>
          </div>
        ) : error ? (
          <div className="showcase-state">
            <h2>展示区暂时打不开</h2>
            <p>{error}</p>
            <button type="button" className="showcase-cta" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCw className="h-4 w-4" />
              重新加载
            </button>
          </div>
        ) : people && people.length === 0 ? (
          <div className="showcase-state">
            <h2>展台还空着</h2>
            <p>还没有公开的展示人物。管理员可以在后台「展示区」创建第一位创作者。</p>
            <a className="showcase-cta" href="/plaza">
              <Sprout className="h-4 w-4" />
              去广场看看
            </a>
          </div>
        ) : (
          <>
            <div ref={scrollerRef} className="showcase-scroller" onScroll={onScroll}>
              {people?.map((person, position) => (
                <PersonSlide
                  key={person.id}
                  person={person}
                  active={position === index}
                  onPointerDown={onFigurePointerDown}
                  onFigureClick={onFigureClick}
                />
              ))}
              {nextCursor ? (
                <div ref={loadMoreSentinelRef} className="showcase-load-sentinel" aria-live="polite">
                  {loadingMore ? <span className="showcase-load-skeleton" aria-hidden="true" /> : null}
                  {loadMoreError ? (
                    <button type="button" className="showcase-load-retry" onClick={() => void loadMore()}>
                      加载失败，点击重试
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="showcase-arrow is-prev"
              aria-label="上一位"
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="showcase-arrow is-next"
              aria-label="下一位"
              disabled={index >= total - 1}
              onClick={() => goTo(index + 1)}
            >
              <ChevronRight className="h-5 w-5" />
            </button>

            <div className="showcase-controls">
              {/* Beyond a dozen people a dot per slide stops being a control and
                  becomes noise, so the indicator switches to a counter. */}
              {total <= 12 ? (
                <div className="showcase-dots" role="tablist" aria-label="展示人物">
                  {people?.map((person, position) => (
                    <button
                      key={person.id}
                      type="button"
                      role="tab"
                      aria-selected={position === index}
                      aria-label={person.name}
                      className={`showcase-dot${position === index ? " is-active" : ""}`}
                      onClick={() => goTo(position)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[11px] font-semibold tracking-wide text-white/70">
                  {index + 1} / {total}
                </p>
              )}
              <button type="button" className="showcase-cta" onClick={() => setSheetOpen(true)}>
                <Info className="h-4 w-4" />
                查看 {active?.name ?? "资料"}
              </button>
            </div>
          </>
        )}
      </div>

      <BottomNav />

      <ShowcaseSheet person={active} open={sheetOpen && active !== null} onClose={() => setSheetOpen(false)} />

      <ThemePickerSheet
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        selected={themePreset}
        onSelect={selectTheme}
      />
    </div>
  );
}
