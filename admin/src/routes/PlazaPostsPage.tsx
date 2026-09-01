import { useState } from "react";
import { fetchPlazaPosts, setPlazaPostStatus, type PlazaPostSummary } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

function authorLabel(post: PlazaPostSummary): string {
  if (post.anonymous) return "匿名";
  const owner = post.owner;
  if (!owner) return "未知用户";
  return owner.username ? `@${owner.username}` : owner.firstName || `用户 ${owner.telegramUserId}`;
}

function PostRow({ post, onToggle }: { post: PlazaPostSummary; onToggle: (post: PlazaPostSummary) => void }) {
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
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {formatDateTime(post.createdAt)} · {post.status === "published" ? "展示中" : "已下架"}
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
    </article>
  );
}

export function PlazaPostsPage() {
  const [view, setView] = useState<"all" | "published">("all");
  const [page, setPage] = useState(0);
  const pageSize = 20;
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
        <EmptyPanel text="还没有树洞内容。用户在机器人里投稿后会出现在这里。" />
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
