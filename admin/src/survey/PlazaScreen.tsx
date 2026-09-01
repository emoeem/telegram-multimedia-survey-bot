import { useCallback, useEffect, useState } from "react";
import { Palette, Pencil, X } from "lucide-react";
import { ThemePickerSheet, themeBackgroundStyle, themeCssVars } from "./theme-ui";
import {
  createPlazaPost,
  fetchPlazaCards,
  fetchPlazaPosts,
  ownerDisplayName,
  type PlazaCardItem,
  type PlazaPostItem,
} from "./plaza-api";

type Tab = "treehole" | "cards";

const PAGE_SIZE = 10;

function closePlaza(): void {
  if (window.Telegram?.WebApp?.close) {
    window.Telegram.WebApp.close();
    return;
  }
  window.close();
  if (window.history.length > 1) window.history.back();
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

interface FeedState<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
}

function usePlazaFeed<T>(tab: Tab, reloadKey: number): FeedState<T> & { loadMore: () => void } {
  const [state, setState] = useState<FeedState<T>>({ items: [], total: 0, loading: true, error: null });

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response =
          tab === "treehole" ? await fetchPlazaPosts(offset, PAGE_SIZE) : await fetchPlazaCards(offset, PAGE_SIZE);
        setState((current) => ({
          items: append ? [...current.items, ...(response.items as T[])] : (response.items as T[]),
          total: response.total,
          loading: false,
          error: null,
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "加载失败",
        }));
      }
    },
    [tab],
  );

  useEffect(() => {
    void load(0, false);
  }, [load, reloadKey]);

  return {
    ...state,
    loadMore: () => {
      if (!state.loading && state.items.length < state.total) void load(state.items.length, true);
    },
  };
}

export function PlazaScreen() {
  const [tab, setTab] = useState<Tab>("treehole");
  const [reloadKey, setReloadKey] = useState(0);
  const [userThemePreset, setUserThemePreset] = useState<string | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [content, setContent] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [composerMessage, setComposerMessage] = useState<string | null>(null);

  const posts = usePlazaFeed<PlazaPostItem>("treehole", reloadKey);
  const cards = usePlazaFeed<PlazaCardItem>("cards", reloadKey);

  useEffect(() => {
    const stored = localStorage.getItem("plazaTheme");
    setUserThemePreset(stored && stored.length > 0 ? stored : null);
  }, []);

  const selectTheme = (presetId: string | null) => {
    setUserThemePreset(presetId);
    if (presetId) localStorage.setItem("plazaTheme", presetId);
    else localStorage.removeItem("plazaTheme");
  };

  const theme = userThemePreset ? { preset: userThemePreset } : null;
  const vars = themeCssVars(theme);
  const backgroundStyle = themeBackgroundStyle(theme);

  const openComposer = () => {
    setComposerMessage(null);
    setComposerOpen(true);
  };

  const submitPost = async () => {
    if (submitting) return;
    setSubmitting(true);
    setComposerMessage(null);
    try {
      await createPlazaPost(content.trim(), anonymous);
      setComposerOpen(false);
      setContent("");
      setReloadKey((key) => key + 1);
      setTab("treehole");
    } catch (error) {
      setComposerMessage(error instanceof Error ? error.message : "发布失败");
    } finally {
      setSubmitting(false);
    }
  };

  const activeFeed = tab === "treehole" ? posts : cards;

  return (
    <div className="min-h-dvh" data-theme={theme?.preset} style={{ ...vars, ...backgroundStyle }}>
      <div className="relative">
        <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
          <div className="mx-auto max-w-xl px-5 py-3 lg:max-w-3xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[15px] font-bold text-[var(--survey-heading)]">🏛 广场</p>
                <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">展示自己的资料卡，也听听大家的心里话</p>
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
                <button type="button" aria-label="关闭" title="关闭" className="survey-icon-btn" onClick={closePlaza}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-2.5 flex gap-1.5 pb-0.5">
              {(
                [
                  { id: "treehole", label: "🌳 树洞" },
                  { id: "cards", label: "🖼 资料卡" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex-1 rounded-[var(--survey-button-radius)] border px-3 py-2 text-[13px] font-medium transition-colors ${
                    tab === item.id
                      ? "border-transparent bg-[var(--survey-primary)] text-white"
                      : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-xl px-5 pb-28 pt-4 lg:max-w-3xl">
          {activeFeed.error ? (
            <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-center text-sm text-[var(--survey-body)]">
              {activeFeed.error}
            </div>
          ) : !activeFeed.loading && activeFeed.items.length === 0 ? (
            <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-8 text-center">
              <p className="text-sm font-medium text-[var(--survey-heading)]">
                {tab === "treehole" ? "树洞还没有内容" : "资料卡画廊还没有内容"}
              </p>
              <p className="mt-1.5 text-xs text-[var(--survey-muted)]">
                {tab === "treehole"
                  ? "点击右下角 ✏️ 说出第一句心里话（可以匿名）。"
                  : "制作一张资料卡并选择「发布到画廊」，它就会出现在这里。"}
              </p>
            </div>
          ) : tab === "treehole" ? (
            <div className="flex flex-col gap-3">
              {posts.items.map((post) => (
                <article
                  key={post.id}
                  className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4"
                >
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[var(--survey-body)]">
                    {post.content}
                  </p>
                  <p className="mt-3 text-xs text-[var(--survey-muted)]">
                    —— {post.anonymous ? "匿名" : ownerDisplayName(post.owner)} · {formatDay(post.createdAt)}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {cards.items.map((card) => (
                <article
                  key={card.id}
                  className="overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                >
                  <img
                    src={card.imageUrl}
                    alt={`${card.name} 的资料卡`}
                    loading="lazy"
                    className="w-full object-contain"
                  />
                  <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--survey-heading)]">
                        {card.name}
                        {card.identityLabel ? (
                          <span className="ml-1.5 text-xs font-normal text-[var(--survey-muted)]">
                            {card.identityLabel}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-[var(--survey-muted)]">by {ownerDisplayName(card.owner)}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {activeFeed.items.length < activeFeed.total ? (
            <button
              type="button"
              onClick={activeFeed.loadMore}
              disabled={activeFeed.loading}
              className="mt-4 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] py-2.5 text-[13px] font-medium text-[var(--survey-body)] disabled:opacity-50"
            >
              {activeFeed.loading ? "加载中…" : `加载更多（${activeFeed.items.length}/${activeFeed.total}）`}
            </button>
          ) : null}
        </main>

        <button
          type="button"
          aria-label="投稿树洞"
          onClick={openComposer}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+18px)] right-5 z-20 flex items-center justify-center rounded-full bg-[var(--survey-primary)] p-4 text-white shadow-lg"
        >
          <Pencil className="h-5 w-5" />
        </button>

        {composerOpen ? (
          <div className="fixed inset-0 z-30">
            <button
              aria-label="关闭投稿"
              className="absolute inset-0 bg-black/40"
              onClick={() => setComposerOpen(false)}
            />
            <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-[0_-12px_40px_-16px_rgba(15,23,42,.3)]">
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-semibold text-[var(--survey-heading)]">✏️ 投稿树洞</span>
                <button
                  type="button"
                  className="survey-icon-btn h-8 w-8"
                  aria-label="关闭"
                  onClick={() => setComposerOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value.slice(0, 500))}
                rows={4}
                placeholder="写下你想说的话（5-500 字）…"
                className="mt-3 w-full resize-none rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] p-3 text-sm text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)]"
              />
              <div className="mt-2 flex items-center justify-between">
                <div className="flex gap-1.5">
                  {(
                    [
                      { id: true, label: "🎭 匿名" },
                      { id: false, label: "👤 署名" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={String(option.id)}
                      type="button"
                      onClick={() => setAnonymous(option.id)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${
                        anonymous === option.id
                          ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
                          : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-[var(--survey-muted)]">{content.trim().length}/500</span>
              </div>
              {composerMessage ? <p className="mt-2 text-xs text-red-500">{composerMessage}</p> : null}
              <button
                type="button"
                disabled={submitting || content.trim().length < 5}
                onClick={() => void submitPost()}
                className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {submitting ? "发布中…" : "发布到树洞广场"}
              </button>
            </div>
          </div>
        ) : null}

        <ThemePickerSheet
          open={themePickerOpen}
          onClose={() => setThemePickerOpen(false)}
          selected={userThemePreset}
          onSelect={selectTheme}
        />
      </div>
    </div>
  );
}
