import { useState } from "react";
import { apiSend, fetchIdentityCards, type IdentityCardSummary } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

function ownerLabel(card: IdentityCardSummary): string {
  const owner = card.owner;
  if (!owner) return "未知用户";
  return owner.username ? `@${owner.username}` : owner.firstName || `用户 ${owner.telegramUserId}`;
}

function cardMetaLine(card: IdentityCardSummary): string {
  return [card.identityLabel, card.nickname ? `@${card.nickname}` : null, card.age !== null ? `${card.age} 岁` : null]
    .filter(Boolean)
    .join(" · ");
}

function CardTile({ card, onToggle }: { card: IdentityCardSummary; onToggle: (card: IdentityCardSummary) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{card.name}</h3>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{cardMetaLine(card) || "暂无标签"}</p>
        </div>
        <span
          className={
            card.galleryPublished
              ? "shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          }
        >
          {card.galleryPublished ? "已发布" : "未发布"}
        </span>
      </div>
      <div className="grid min-h-40 place-items-center overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800">
        {card.cardImageUrl && !imageFailed ? (
          <img
            src={card.cardImageUrl}
            alt={`${card.name} 的资料卡`}
            loading="lazy"
            className="h-64 w-auto object-contain"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">
            {imageFailed ? "卡片图片加载失败（可能已被清理）" : "暂无卡片图片，重新生成后会自动展示"}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {ownerLabel(card)} · {card.templateStyle} · {formatDateTime(card.createdAt)}
        {card.galleryPublishedAt ? ` · 发布于 ${formatDateTime(card.galleryPublishedAt)}` : ""}
      </p>
      {card.description ? (
        <p className="line-clamp-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{card.description}</p>
      ) : null}
      <button
        type="button"
        onClick={() => onToggle(card)}
        className={
          card.galleryPublished
            ? "rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            : "rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        }
      >
        {card.galleryPublished ? "从画廊下架" : "发布到画廊"}
      </button>
    </article>
  );
}

export function IdentityCardsPage() {
  const [view, setView] = useState<"all" | "published">("all");
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const { data, error, retry } = useApi<{
    items: IdentityCardSummary[];
    total: number;
    limit: number;
    offset: number;
  }>(`/api/admin/identity-cards?view=${view}&offset=${page * pageSize}&limit=${pageSize}`);

  const toggle = async (card: IdentityCardSummary) => {
    try {
      await apiSend("POST", "/api/admin/identity-cards/publish", { id: card.id, published: !card.galleryPublished });
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
        title="资料卡"
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
                {option === "all" ? "全部" : "已发布"}
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
        <EmptyPanel text="还没有资料卡。用户在机器人里制作资料卡后会出现在这里。" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((card) => (
              <CardTile key={card.id} card={card} onToggle={toggle} />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              共 {total} 张 · 第 {page + 1}/{totalPages} 页
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
