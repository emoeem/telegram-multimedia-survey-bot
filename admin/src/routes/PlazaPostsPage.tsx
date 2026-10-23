import { useState } from "react";
import {
  fetchAdminPlazaComments,
  fetchPlazaPosts,
  deletePlazaPost,
  restorePlazaPost,
  setPlazaCommentStatus,
  setPlazaPostStatus,
  type PlazaCommentSummary,
  type PlazaPostSummary,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { DeleteWithUndo } from "../components/DeleteWithUndo";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

function authorLabel(post: PlazaPostSummary): string {
  if (post.anonymous) return "匿名";
  const owner = post.owner;
  if (!owner) return "未知用户";
  return owner.username ? `@${owner.username}` : owner.firstName || `用户 ${owner.telegramUserId}`;
}

function commentAuthorLabel(comment: PlazaCommentSummary): string {
  const owner = comment.owner;
  if (!owner) return "未知用户";
  return owner.username ? `@${owner.username}` : owner.firstName || `用户 ${owner.telegramUserId}`;
}

function PostRow({
  post,
  onToggle,
  onDelete,
  onRefresh,
}: {
  post: PlazaPostSummary;
  onToggle: (post: PlazaPostSummary) => void;
  onDelete: (post: PlazaPostSummary) => Promise<void>;
  onRefresh: () => void;
}) {
  const { toast } = useDialogs();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<PlazaCommentSummary[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [busyComment, setBusyComment] = useState<number | null>(null);

  const loadComments = async () => {
    setCommentsError(null);
    try {
      const response = await fetchAdminPlazaComments(post.id, "all");
      setComments(response.items);
    } catch (error) {
      setCommentsError(error instanceof Error ? error.message : "评论加载失败");
    }
  };

  const toggleComments = () => {
    const next = !commentsOpen;
    setCommentsOpen(next);
    if (next && comments === null) void loadComments();
  };

  const toggleComment = async (comment: PlazaCommentSummary) => {
    setBusyComment(comment.id);
    try {
      const nextStatus = comment.status === "published" ? "removed" : "published";
      await setPlazaCommentStatus(comment.id, nextStatus);
      setComments((current) =>
        current ? current.map((item) => (item.id === comment.id ? { ...item, status: nextStatus } : item)) : current,
      );
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "操作失败", variant: "error" });
    } finally {
      setBusyComment(null);
    }
  };

  const publishedComments = comments?.filter((comment) => comment.status === "published").length ?? 0;

  return (
    <article
      className={
        post.status === "published"
          ? "card"
          : "card opacity-80"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            #{post.id} · {authorLabel(post)}
            {post.kind === "trial" ? (
              <span className="ml-2 badge badge-blue">
                🎯 挑战晒卡
              </span>
            ) : null}
          </p>
          <p className="text-xs text-[var(--color-muted)]">
            {formatDateTime(post.createdAt)} · {post.status === "published" ? "展示中" : "已下架"} · 💬{" "}
            {post.commentCount}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onToggle(post)}
            className={
              post.status === "published"
                ? "btn btn-sm"
                : "btn btn-primary btn-sm"
            }
          >
            {post.status === "published" ? "下架" : "恢复展示"}
          </button>
          <DeleteWithUndo
            confirmMessage={`删除树洞 #${post.id}？内容会进入回收站并保留 30 天。`}
            onDelete={() => onDelete(post)}
            onUndo={async () => {
              await restorePlazaPost(post.id);
              onRefresh();
            }}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-[var(--app-danger)] hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            删除
          </DeleteWithUndo>
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-ink)]">
        {post.content}
      </p>
      {post.topic ? (
        <p className="mt-2">
          <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-muted)]">
            #{post.topic}#
          </span>
        </p>
      ) : null}
      {post.imageAssetId !== null ? (
        <a
          href={`/api/admin/media/${post.imageAssetId}/image`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block w-fit"
        >
          <img
            src={`/api/admin/media/${post.imageAssetId}/image`}
            alt="树洞配图"
            loading="lazy"
            className="max-h-56 rounded-xl border border-[var(--color-edge)] object-cover"
          />
        </a>
      ) : null}

      <div className="mt-3 border-t border-[var(--color-edge)] pt-2.5">
        <button
          type="button"
          onClick={toggleComments}
          className="text-xs font-semibold text-[var(--color-muted)]"
        >
          💬 评论（{publishedComments || post.commentCount}）
          <span className="ml-1">{commentsOpen ? "收起" : "展开"}</span>
        </button>
        {commentsOpen ? (
          <div className="mt-2 space-y-2">
            {commentsError ? <p className="text-xs text-[var(--app-danger)]">{commentsError}</p> : null}
            {comments === null ? (
              <p className="text-xs text-[var(--color-muted-soft)]">加载中…</p>
            ) : comments.length === 0 ? (
              <p className="text-xs text-[var(--color-muted-soft)]">暂无评论</p>
            ) : (
              comments.map((comment) => (
                <div
                  key={comment.id}
                  className="flex items-start justify-between gap-3 rounded-xl bg-[var(--surface-muted)] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[var(--color-ink)]">
                      #{comment.id} · {commentAuthorLabel(comment)}
                      <span className="ml-2 font-normal text-[var(--color-muted-soft)]">{formatDateTime(comment.createdAt)}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--color-muted)]">
                      {comment.content}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyComment === comment.id}
                    onClick={() => void toggleComment(comment)}
                    className={
                      comment.status === "published"
                        ? "btn btn-sm"
                        : "btn btn-primary btn-sm"
                    }
                  >
                    {comment.status === "published" ? "下架" : "恢复"}
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function PlazaPostsPage() {
  const [view, setView] = useState<"all" | "published">("all");
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const { toast } = useDialogs();
  const { data, error, retry } = useApi<{
    items: PlazaPostSummary[];
    total: number;
    limit: number;
    offset: number;
  }>(`/api/admin/plaza/posts?view=${view}&offset=${page * pageSize}&limit=${pageSize}`);

  const [togglingId, setTogglingId] = useState<number | null>(null);
  const toggle = async (post: PlazaPostSummary) => {
    if (togglingId !== null) return;
    setTogglingId(post.id);
    try {
      await setPlazaPostStatus(post.id, post.status === "published" ? "removed" : "published");
      retry();
    } catch (error) {
      // 此前失败被静默吞掉（只 retry 列表），管理员不知道下架没生效。
      toast({ message: error instanceof Error ? error.message : "操作失败，请重试", variant: "error" });
      retry();
    } finally {
      setTogglingId(null);
    }
  };

  const remove = async (post: PlazaPostSummary) => {
    await deletePlazaPost(post.id);
    retry();
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="树洞"
        actions={
          <div className="flex gap-2">
            {(["all", "published"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setView(option);
                  setPage(0);
                }}
                className={
                  view === option
                    ? "btn btn-sm"
                    : "btn btn-sm"
                }
              >
                {option === "all" ? "全部" : "展示中"}
              </button>
            ))}
          </div>
        }
      />
      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={6} />
      ) : data.items.length === 0 ? (
        <EmptyPanel text="还没有树洞内容。用户在机器人里投稿、晒挑战结局后会出现在这里。" />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {data.items.map((post) => (
              <PostRow key={post.id} post={post} onToggle={toggle} onDelete={remove} onRefresh={retry} />
            ))}
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-[var(--color-muted)]">
            <span>
              共 {total} 条 · 第 {page + 1}/{totalPages} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="btn btn-sm"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((current) => current + 1)}
                className="btn btn-sm"
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
