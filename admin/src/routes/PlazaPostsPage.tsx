import { useState } from "react";
import {
  fetchAdminPlazaComments,
  fetchPlazaPosts,
  setPlazaCommentStatus,
  setPlazaPostStatus,
  type PlazaCommentSummary,
  type PlazaPostSummary,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
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

function PostRow({ post, onToggle }: { post: PlazaPostSummary; onToggle: (post: PlazaPostSummary) => void }) {
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
          ? "rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
          : "rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 opacity-80 dark:border-slate-600 dark:bg-slate-900/60"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            #{post.id} · {authorLabel(post)}
            {post.kind === "trial" ? (
              <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                🎯 挑战晒卡
              </span>
            ) : null}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {formatDateTime(post.createdAt)} · {post.status === "published" ? "展示中" : "已下架"} · 💬{" "}
            {post.commentCount}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(post)}
          className={
            post.status === "published"
              ? "shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              : "shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          }
        >
          {post.status === "published" ? "下架" : "恢复展示"}
        </button>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 dark:text-slate-200">
        {post.content}
      </p>

      <div className="mt-3 border-t border-slate-100 pt-2.5 dark:border-slate-800">
        <button
          type="button"
          onClick={toggleComments}
          className="text-xs font-semibold text-slate-500 dark:text-slate-400"
        >
          💬 评论（{publishedComments || post.commentCount}）
          <span className="ml-1">{commentsOpen ? "收起" : "展开"}</span>
        </button>
        {commentsOpen ? (
          <div className="mt-2 space-y-2">
            {commentsError ? <p className="text-xs text-red-500">{commentsError}</p> : null}
            {comments === null ? (
              <p className="text-xs text-slate-400">加载中…</p>
            ) : comments.length === 0 ? (
              <p className="text-xs text-slate-400">暂无评论</p>
            ) : (
              comments.map((comment) => (
                <div
                  key={comment.id}
                  className="flex items-start justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      #{comment.id} · {commentAuthorLabel(comment)}
                      <span className="ml-2 font-normal text-slate-400">{formatDateTime(comment.createdAt)}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-slate-600 dark:text-slate-300">
                      {comment.content}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyComment === comment.id}
                    onClick={() => void toggleComment(comment)}
                    className={
                      comment.status === "published"
                        ? "shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                        : "shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white"
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

  const toggle = async (post: PlazaPostSummary) => {
    try {
      await setPlazaPostStatus(post.id, post.status === "published" ? "removed" : "published");
      retry();
    } catch {
      retry();
    }
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
                    ? "rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                    : "rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
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
              <PostRow key={post.id} post={post} onToggle={toggle} />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              共 {total} 条 · 第 {page + 1}/{totalPages} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-slate-600"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((current) => current + 1)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-slate-600"
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
