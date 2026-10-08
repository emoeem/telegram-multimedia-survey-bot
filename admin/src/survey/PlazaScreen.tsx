import type { SyntheticEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ImagePlus, Palette, Pencil, Send, Users, X } from "lucide-react";
import {
  loadGlobalPreset,
  saveGlobalPreset,
  ThemePickerSheet,
  themeBackgroundStyle,
  themeCssVars,
  useResolvedPreset,
} from "./theme-ui";
import { BottomNav } from "./BottomNav";
import {
  botHandleFromUrl,
  createPlazaPost,
  createPlazaComment,
  fetchPlazaComments,
  fetchPlazaPosts,
  fetchPlazaProfiles,
  fetchPlazaProfile,
  fetchPlazaTopics,
  ownerDisplayName,
  uploadPlazaImage,
  type PlazaCommentItem,
  type PlazaPostItem,
  type PlazaProfileItem,
  type PlazaTopic,
} from "./plaza-api";

type Tab = "treehole" | "profiles";

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

const TRIAL_GRADE_CHIP: Record<string, string> = {
  S: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  A: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  B: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  C: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

function TreeHolePost({ post, onSelectTopic }: { post: PlazaPostItem; onSelectTopic: (topic: string) => void }) {
  const [open, setOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [comments, setComments] = useState<PlazaCommentItem[] | null>(null);
  const [total, setTotal] = useState(post.commentCount);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Anonymous by default: the API defaults to it too, and a reader who wants to
  // sign a comment can opt in explicitly.
  const [anonymous, setAnonymous] = useState(true);

  const toggleComments = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setCommentsError(null);
    if (comments === null) {
      try {
        const response = await fetchPlazaComments(post.id);
        setComments(response.items);
        setTotal(response.total);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : "评论加载失败");
      }
    }
  };

  const loadMoreComments = async () => {
    if (comments === null || commentsLoadingMore) return;
    setCommentsLoadingMore(true);
    setCommentsError(null);
    try {
      const response = await fetchPlazaComments(post.id, comments.length);
      setComments((current) => [...(current ?? []), ...response.items]);
      setTotal(response.total);
    } catch (error) {
      setCommentsError(error instanceof Error ? error.message : "评论加载失败");
    } finally {
      setCommentsLoadingMore(false);
    }
  };

  const submitComment = async () => {
    const trimmed = content.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(null);
    setCommentsError(null);
    try {
      const response = await createPlazaComment(post.id, trimmed, anonymous);
      setComments((current) => [...(current ?? []), response.comment]);
      setTotal((current) => current + 1);
      setContent("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "评论失败");
    } finally {
      setBusy(false);
    }
  };

  const payload = post.kind === "trial" ? post.payload : null;
  const modeLabel = payload?.mode === "hell" ? "地狱" : "普通";
  const personaLabel = payload?.persona === "male" ? "公" : "母";

  return (
    <article className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
      {payload ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--survey-primary-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--survey-primary)]">
            🎯 挑战晒卡
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-black ${TRIAL_GRADE_CHIP[payload.grade] ?? TRIAL_GRADE_CHIP.C}`}
          >
            {payload.grade} 级 · {payload.gradeTitle}
          </span>
          <span className="rounded-full bg-[var(--survey-bg)] px-2.5 py-0.5 text-[11px] text-[var(--survey-muted)]">
            {payload.packName} · {modeLabel} · {personaLabel} · 积分 {payload.score}
          </span>
        </div>
      ) : null}
      <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[var(--survey-body)]">{post.content}</p>
      {post.imageUrl ? (
        <button
          type="button"
          onClick={() => setLightboxUrl(post.imageUrl)}
          className="mt-2.5 block w-full overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)]"
        >
          <img
            src={post.imageUrl}
            alt="树洞配图"
            loading="lazy"
            onError={hideBrokenImage}
            className="max-h-80 w-full bg-[var(--survey-bg)] object-cover"
          />
        </button>
      ) : null}
      {post.topic ? (
        <button
          type="button"
          onClick={() => onSelectTopic(post.topic as string)}
          className="mt-2.5 rounded-full bg-[var(--survey-primary-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--survey-primary)]"
        >
          #{post.topic}#
        </button>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--survey-card-border)]/60 pt-2.5">
        <p className="min-w-0 truncate text-xs text-[var(--survey-muted)]">
          —— {post.anonymous ? "匿名" : ownerDisplayName(post.owner)} · {formatDay(post.createdAt)}
        </p>
        <button
          type="button"
          onClick={() => void toggleComments()}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--survey-muted)]"
        >
          💬 {total}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open ? (
        <div className="mt-3 space-y-2.5 border-t border-[var(--survey-card-border)]/60 pt-3">
          {commentsError ? <p className="text-xs text-red-500">{commentsError}</p> : null}
          {comments === null ? (
            <p className="text-xs text-[var(--survey-muted)]">加载评论…</p>
          ) : comments.length === 0 ? (
            <p className="text-xs text-[var(--survey-muted)]">还没有评论，来抢沙发</p>
          ) : (
            comments.map((comment) => (
              <div key={comment.id} className="rounded-xl bg-[var(--survey-bg)] px-3 py-2.5">
                <p className="text-xs font-semibold text-[var(--survey-heading)]">
                  {ownerDisplayName(comment.owner)} · {formatDay(comment.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--survey-body)]">
                  {comment.content}
                </p>
              </div>
            ))
          )}
          {comments !== null && comments.length < total ? (
            <button
              type="button"
              disabled={commentsLoadingMore}
              onClick={() => void loadMoreComments()}
              className="w-full rounded-xl border border-[var(--survey-card-border)] py-2 text-xs font-semibold text-[var(--survey-muted)] disabled:opacity-50"
            >
              {commentsLoadingMore ? "加载中…" : `加载更多评论（${comments.length}/${total}）`}
            </button>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAnonymous((current) => !current)}
              aria-pressed={anonymous}
              className={`shrink-0 rounded-full border px-2.5 py-2 text-[11px] font-medium ${
                anonymous
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
                  : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
              }`}
            >
              {anonymous ? "🎭 匿名" : "👤 署名"}
            </button>
            <input
              value={content}
              maxLength={300}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitComment();
              }}
              placeholder="写下你的评论（默认匿名，需从 Telegram 打开）"
              className="min-w-0 flex-1 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] px-3 py-2 text-[13px] text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)]"
            />
            <button
              type="button"
              disabled={busy || content.trim().length === 0}
              onClick={() => void submitComment()}
              className="shrink-0 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-4 py-2 text-xs font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
            >
              {busy ? "发送中…" : "发送"}
            </button>
          </div>
          {message ? <p className="text-xs text-red-500">{message}</p> : null}
        </div>
      ) : null}
      {lightboxUrl ? <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} /> : null}
    </article>
  );
}

function hideBrokenImage(event: SyntheticEvent<HTMLImageElement>): void {
  // 公开页的破图比没有图更糟：媒体过期（410）时直接隐藏占位。
  event.currentTarget.style.display = "none";
}

/** 0 依赖的全屏看图：点击/Esc 关闭，深色遮罩，图片按原比例适配视口。 */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
      <img src={url} alt="查看大图" className="max-h-full max-w-full rounded-lg object-contain" />
      <button
        type="button"
        aria-label="关闭大图"
        className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/15 text-white"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

function ProfileCard({ profile }: { profile: PlazaProfileItem }) {
  const headingIndex = profile.fields.findIndex((field) => /姓名|名字|昵称|称呼|name/i.test(field.title));
  const headingField = headingIndex >= 0 ? profile.fields[headingIndex] : undefined;
  const detailFields = headingField ? profile.fields.filter((field, index) => index !== headingIndex) : profile.fields;
  const [expanded, setExpanded] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const visibleDetailFields = expanded ? detailFields : detailFields.slice(0, 4);
  const [cover, ...moreImages] = profile.images;

  return (
    <article className="overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]">
      {cover ? (
        <button
          type="button"
          aria-label="查看大图"
          onClick={() => setLightboxUrl(cover.url)}
          className="block w-full"
        >
          <img
            src={cover.url}
            alt="个人资料照片"
            loading="lazy"
            onError={hideBrokenImage}
            className="max-h-[460px] w-full object-cover"
          />
        </button>
      ) : (
        <div className="grid h-36 place-items-center bg-[var(--survey-card-border)]/40 text-xs text-[var(--survey-muted)]">
          暂无照片
        </div>
      )}
      {moreImages.length > 0 ? (
        <div className="grid grid-cols-2 gap-0.5 border-t border-[var(--survey-card-border)]/60">
          {moreImages.map((image) => (
            <button
              key={image.mediaAssetId}
              type="button"
              aria-label="查看大图"
              onClick={() => setLightboxUrl(image.url)}
              className="block"
            >
              <img
                src={image.url}
                alt="个人资料照片"
                loading="lazy"
                onError={hideBrokenImage}
                className="h-36 w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
      <div className="space-y-2.5 px-4 py-4">
        <p className="text-xs font-medium text-[var(--survey-muted)]">
          {ownerDisplayName(profile.owner)} · 发布于 {formatDay(profile.publishedAt ?? profile.createdAt)}
        </p>
        <h2 className="text-2xl font-bold tracking-tight text-[var(--survey-heading)]">
          {headingField?.value ?? ownerDisplayName(profile.owner)}
        </h2>
        {visibleDetailFields.map((field) => (
          <div key={field.questionId} className="flex items-baseline gap-x-3 text-[15px] leading-6">
            <span className="w-20 shrink-0 text-[13px] text-[var(--survey-muted)]">{field.title}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words font-medium text-[var(--survey-body)]">
              {field.value}
            </span>
          </div>
        ))}
        {detailFields.length > 4 ? (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 pt-1 text-sm font-medium text-[var(--color-primary)]"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起详细资料" : `查看全部资料（${detailFields.length} 项）`}
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        ) : null}
        <a
          href={`/plaza/profile/${profile.id}`}
          className="flex w-full items-center justify-center gap-1 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2 text-[13px] font-semibold text-[var(--survey-primary)]"
        >
          查看资料卡
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
      {lightboxUrl ? <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} /> : null}
    </article>
  );
}

interface FeedState<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
}

function usePlazaFeed(
  reloadKey: number,
  active: boolean,
  topic: string | null,
): FeedState<PlazaPostItem> & { loadMore: () => void } {
  const [state, setState] = useState<FeedState<PlazaPostItem>>({ items: [], total: 0, loading: true, error: null });

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetchPlazaPosts(offset, PAGE_SIZE, topic);
        setState((current) => ({
          items: append ? [...current.items, ...response.items] : response.items,
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
    [topic],
  );

  useEffect(() => {
    // 只拉取当前 tab 的信息流：切到该 tab 时才请求，避免挂载即双倍请求。
    // 话题变化时必须回到第 0 页，"全部" 与某个话题是两份不同的流。
    if (!active) return;
    void load(0, false);
  }, [load, reloadKey, active]);

  return {
    ...state,
    loadMore: () => {
      if (!state.loading && state.items.length < state.total) void load(state.items.length, true);
    },
  };
}

function useProfileFeed(reloadKey: number, active: boolean) {
  const [items, setItems] = useState<PlazaProfileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [surveyId, setSurveyId] = useState<number | null>(null);
  const [communityGroupUrl, setCommunityGroupUrl] = useState<string | null>(null);
  const [submissionBotUrl, setSubmissionBotUrl] = useState<string | null>(null);

  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchPlazaProfiles(offset, PAGE_SIZE);
      setItems((current) => (append ? [...current, ...response.items] : response.items));
      setTotal(response.total);
      setSurveyId(response.surveyId);
      setCommunityGroupUrl(response.communityGroupUrl);
      setSubmissionBotUrl(response.submissionBotUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load(0, false);
  }, [load, reloadKey, active]);

  return {
    items,
    total,
    loading,
    error,
    surveyId,
    communityGroupUrl,
    submissionBotUrl,
    loadMore: () => {
      if (!loading && items.length < total) void load(items.length, true);
    },
  };
}

/** 资料卡详情页（/plaza/profile/:id）：完整资料 + 大图浏览，可分享直达。 */
function ProfileDetailScreen({ profileId }: { profileId: number }) {
  const [profile, setProfile] = useState<PlazaProfileItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [userThemePreset] = useState<string | null>(() => loadGlobalPreset());
  const resolvedPreset = useResolvedPreset(userThemePreset);
  const theme = resolvedPreset ? { preset: resolvedPreset } : null;

  useEffect(() => {
    let cancelled = false;
    fetchPlazaProfile(profileId)
      .then((response) => {
        if (!cancelled) setProfile(response.profile);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "资料加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const headingIndex = profile
    ? profile.fields.findIndex((field) => /姓名|名字|昵称|称呼|name/i.test(field.title))
    : -1;
  const headingField = headingIndex >= 0 && profile ? profile.fields[headingIndex] : undefined;
  const restFields =
    profile && headingField ? profile.fields.filter((field, index) => index !== headingIndex) : profile?.fields ?? [];

  return (
    <div className="survey-glow min-h-dvh pb-24" data-theme={theme?.preset} style={{ ...themeCssVars(theme), ...themeBackgroundStyle(theme) }}>
      <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-5 py-3 lg:max-w-3xl">
          <a href="/plaza" className="flex items-center gap-1.5 text-sm font-semibold text-[var(--survey-heading)]">
            <ArrowLeft className="h-4 w-4" />
            返回广场
          </a>
          <p className="text-[13px] font-semibold text-[var(--survey-muted)]">个人资料卡</p>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-5 py-5 lg:max-w-3xl">
        {loading ? (
          <p className="py-16 text-center text-sm text-[var(--survey-muted)]">加载中…</p>
        ) : error || !profile ? (
          <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-8 text-center">
            <p className="text-sm text-[var(--survey-body)]">{error ?? "资料不存在或未公开"}</p>
            <a
              href="/plaza"
              className="mt-4 inline-block rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-6 py-2.5 text-sm font-semibold text-[var(--survey-primary-content)]"
            >
              回广场逛逛
            </a>
          </div>
        ) : (
          <article className="overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]">
            {profile.images.length > 0 ? (
              <div className="grid gap-0.5 bg-[var(--survey-card-border)]/40">
                {profile.images.map((image, index) => (
                  <button
                    key={image.mediaAssetId}
                    type="button"
                    aria-label="查看大图"
                    onClick={() => setLightboxUrl(image.url)}
                    className="block"
                  >
                    <img
                      src={image.url}
                      alt="个人资料照片"
                      loading={index === 0 ? "eager" : "lazy"}
                      onError={hideBrokenImage}
                      className={`w-full object-cover ${index === 0 ? "max-h-[520px]" : "h-48"}`}
                    />
                  </button>
                ))}
              </div>
            ) : null}
            <div className="space-y-3 px-5 py-5">
              <p className="text-xs font-medium text-[var(--survey-muted)]">
                {ownerDisplayName(profile.owner)} · 发布于 {formatDay(profile.publishedAt ?? profile.createdAt)}
              </p>
              <h1 className="text-3xl font-black tracking-tight text-[var(--survey-heading)]">
                {headingField?.value ?? ownerDisplayName(profile.owner)}
              </h1>
              {restFields.map((field) => (
                <div key={field.questionId} className="flex items-baseline gap-x-3 border-t border-[var(--survey-card-border)]/60 pt-3 text-[15px] leading-6">
                  <span className="w-24 shrink-0 text-[13px] text-[var(--survey-muted)]">{field.title}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words font-medium text-[var(--survey-body)]">
                    {field.value}
                  </span>
                </div>
              ))}
              {profile.fields.length === 0 ? (
                <p className="pt-2 text-sm text-[var(--survey-muted)]">这位参与者还没有公开更多资料。</p>
              ) : null}
            </div>
          </article>
        )}
      </main>
      {lightboxUrl ? <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} /> : null}
      <BottomNav />
    </div>
  );
}

export function PlazaScreen() {
  const profileRoute = window.location.pathname.match(/^\/plaza\/profile\/(\d+)$/);
  if (profileRoute) {
    return <ProfileDetailScreen profileId={Number(profileRoute[1])} />;
  }
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get("tab") === "treehole" ? "treehole" : "profiles",
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [userThemePreset, setUserThemePreset] = useState<string | null>(() => loadGlobalPreset());
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [content, setContent] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [composerMessage, setComposerMessage] = useState<string | null>(null);
  // 配图先上传拿到 mediaAssetId，发布时再随帖子提交；预览用本地 object URL。
  const [imageAssetId, setImageAssetId] = useState<number | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [topics, setTopics] = useState<PlazaTopic[]>([]);

  const posts = usePlazaFeed(reloadKey, tab === "treehole", topicFilter);
  const profiles = useProfileFeed(reloadKey, tab === "profiles");

  useEffect(() => {
    if (tab !== "treehole") return;
    let cancelled = false;
    fetchPlazaTopics()
      .then((response) => {
        if (!cancelled) setTopics(response.topics);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey]);

  const selectTheme = (presetId: string | null) => {
    setUserThemePreset(presetId);
    saveGlobalPreset(presetId);
  };

  const resolvedPreset = useResolvedPreset(userThemePreset);
  const theme = resolvedPreset ? { preset: resolvedPreset } : null;
  const vars = themeCssVars(theme);
  const backgroundStyle = themeBackgroundStyle(theme);

  const openComposer = () => {
    setComposerMessage(null);
    setComposerOpen(true);
  };

  const selectImage = async (file: File | null) => {
    if (!file) return;
    setComposerMessage(null);
    setImageBusy(true);
    try {
      const uploaded = await uploadPlazaImage(file);
      setImageAssetId(uploaded.mediaAssetId);
      setImagePreview((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(file);
      });
    } catch (error) {
      setComposerMessage(error instanceof Error ? error.message : "图片上传失败");
    } finally {
      setImageBusy(false);
    }
  };

  const clearImage = () => {
    setImageAssetId(null);
    setImagePreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  };

  const submitPost = async () => {
    if (submitting) return;
    const trimmed = content.trim();
    // 带图可以只配图不写字；不带图仍然要求 5 个字以上。
    if (!imageAssetId && trimmed.length < 5) {
      setComposerMessage("写下至少 5 个字，或者配一张图");
      return;
    }
    setSubmitting(true);
    setComposerMessage(null);
    try {
      await createPlazaPost(trimmed, anonymous, {
        imageAssetId,
        topic: topicInput.trim() || null,
      });
      setComposerOpen(false);
      setContent("");
      setTopicInput("");
      clearImage();
      // 新帖子可能不属于当前筛选的话题，回到「全部」才看得到自己刚发的内容。
      setTopicFilter(null);
      setReloadKey((key) => key + 1);
      setTab("treehole");
    } catch (error) {
      setComposerMessage(error instanceof Error ? error.message : "发布失败");
    } finally {
      setSubmitting(false);
    }
  };

  const activeFeed = tab === "treehole" ? posts : profiles;

  return (
    <div className="survey-glow min-h-dvh pb-24" data-theme={theme?.preset} style={{ ...vars, ...backgroundStyle }}>
      <div className="relative">
        <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
          <div className="mx-auto max-w-xl px-5 py-3 lg:max-w-3xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[15px] font-bold text-[var(--survey-heading)]">🏛 广场</p>
                <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">展示自己的个人资料，也听听大家的心里话</p>
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
                  { id: "profiles", label: "🧑 个人资料" },
                  { id: "treehole", label: "🌳 树洞" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex-1 rounded-[var(--survey-button-radius)] border px-3 py-2 text-[13px] font-medium transition-colors ${
                    tab === item.id
                      ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
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
          {tab === "treehole" && (topics.length > 0 || topicFilter) ? (
            <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setTopicFilter(null)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold ${
                  topicFilter === null
                    ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                }`}
              >
                全部
              </button>
              {topics.map((entry) => (
                <button
                  key={entry.topic}
                  type="button"
                  onClick={() => setTopicFilter(entry.topic)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold ${
                    topicFilter === entry.topic
                      ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                      : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                  }`}
                >
                  #{entry.topic}# {entry.count}
                </button>
              ))}
            </div>
          ) : null}
          {profiles.communityGroupUrl ? (
            <a
              href={profiles.communityGroupUrl}
              target="_blank"
              rel="noreferrer"
              className="mb-3 flex items-center gap-3 rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
                <Users className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">加入 Telegram 群聊</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">
                  认识更多参与者，交流个人资料卡和问卷内容
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
            </a>
          ) : null}
          {profiles.submissionBotUrl ? (
            <a
              href={profiles.submissionBotUrl}
              target="_blank"
              rel="noreferrer"
              className="mb-3 flex items-center gap-3 rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-4 py-3 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
                <Send className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">投稿机器人</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">
                  通过 {botHandleFromUrl(profiles.submissionBotUrl)} 投稿你的内容
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
            </a>
          ) : null}
          {tab === "profiles" && profiles.surveyId !== null ? (
            <a
              href={`/s/${profiles.surveyId}`}
              className="mb-4 flex items-center justify-center gap-2 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-4 py-3 text-sm font-semibold text-[var(--survey-primary-content)] shadow-md"
            >
              ✍️ 填写我的个人资料
            </a>
          ) : null}
          {activeFeed.error ? (
            <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-center text-sm text-[var(--survey-body)]">
              {activeFeed.error}
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-[13px] font-semibold text-[var(--survey-primary-content)]"
              >
                重新加载
              </button>
            </div>
          ) : !activeFeed.loading && activeFeed.items.length === 0 ? (
            <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-8 text-center">
              <p className="text-sm font-medium text-[var(--survey-heading)]">
                {tab === "treehole" ? "树洞还没有内容" : "个人画廊还没有内容"}
              </p>
              <p className="mt-1.5 text-xs text-[var(--survey-muted)]">
                {tab === "treehole"
                  ? "点击右下角 ✏️ 说出第一句心里话（可以匿名）。"
                  : profiles.surveyId
                    ? "填写一份个人介绍问卷，提交时选择「发布到个人画廊」，就会出现在这里。"
                    : "还没有人发布个人资料，先去逛逛树洞吧。"}
              </p>
            </div>
          ) : tab === "treehole" ? (
            <div className="flex flex-col gap-3">
              {posts.items.map((post) => (
                <TreeHolePost key={post.id} post={post} onSelectTopic={setTopicFilter} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {profiles.items.map((profile) => (
                <ProfileCard key={profile.id} profile={profile} />
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

        {tab === "treehole" ? (
          <button
            type="button"
            aria-label="投稿树洞"
            onClick={openComposer}
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+84px)] right-5 z-20 flex items-center justify-center rounded-full bg-[var(--survey-primary)] p-4 text-[var(--survey-primary-content)] shadow-lg"
          >
            <Pencil className="h-5 w-5" />
          </button>
        ) : null}

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
                autoFocus
                placeholder="写下你想说的话（5-500 字，配图后可以只发图）…"
                className="mt-3 w-full resize-none rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] p-3 text-sm text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)]"
              />

              {imagePreview ? (
                <div className="relative mt-2.5 overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)]">
                  <img src={imagePreview} alt="配图预览" className="max-h-52 w-full object-cover" />
                  <button
                    type="button"
                    aria-label="移除配图"
                    onClick={clearImage}
                    className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : null}

              <div className="mt-2.5 flex items-center gap-2">
                <label
                  className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--survey-card-border)] px-3 py-1.5 text-xs font-medium text-[var(--survey-body)] ${
                    imageBusy ? "opacity-60" : ""
                  }`}
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  {imageBusy ? "上传中…" : imageAssetId ? "换一张" : "配图"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    disabled={imageBusy}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      // 允许重复选择同一个文件：清空 value。
                      event.target.value = "";
                      void selectImage(file);
                    }}
                  />
                </label>
                <input
                  value={topicInput}
                  maxLength={20}
                  onChange={(event) => setTopicInput(event.target.value)}
                  placeholder="#话题#（可选）"
                  className="min-w-0 flex-1 rounded-full border border-[var(--survey-card-border)] bg-[var(--survey-bg)] px-3 py-1.5 text-xs text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)]"
                />
              </div>
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
                disabled={submitting || imageBusy || (!imageAssetId && content.trim().length < 5)}
                onClick={() => void submitPost()}
                className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-semibold text-[var(--survey-primary-content)] disabled:opacity-50"
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
      <BottomNav />
    </div>
  );
}
