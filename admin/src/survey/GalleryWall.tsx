/**
 * 投稿墙 —— 已发布免登录投稿的公开展示面（/submissions 的「投稿墙」页签）。
 *
 * 页签本身由 showcaseEnabled 门控（见 submission-tab.ts / SubmissionHub），
 * 这里只负责渲染后端已经双闸投影好的条目：不自己判断开关、不自己筛字段——
 * 前端二次过滤会把「服务端漏闸」掩盖成「前端少显示」，审计口径就乱了。
 *
 * 数据链：条目与字段值来自 GET /api/submit/gallery（KV 戳式缓存，见
 * submit-gallery.ts）；附件字节走 GET /api/submit/gallery/media/:assetId
 * （公开端点，<img src> 直连，不需要身份头）。字段标签从表单 schema
 * （preloadSubmitForm，与投稿表单同一份缓存）按 step id 查——运营改表单
 * 字段名时墙上的标签跟着变。
 */
import { useEffect, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "./PublicPrimitives";
import { fetchGalleryWall, galleryMediaUrl, type GalleryWallItem } from "./gallery-wall";
import { preloadSubmitForm, type SubmitStep } from "./submit-form-preload";

/** unix 秒 → 本地日期（墙只精确到天，不暴露投稿的钟点）。 */
function formatDay(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}

function WallCard({ item, labels }: { item: GalleryWallItem; labels: Map<string, string> }) {
  const photos = item.mediaAssetIds;
  return (
    <article className="survey-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-[var(--survey-heading)]">{item.nickname || "匿名"}</span>
        <span className="text-[12px] text-[var(--survey-muted)]">{formatDay(item.createdAt)}</span>
      </div>
      {photos.length > 0 ? (
        <div className={`mt-3 grid gap-2 ${photos.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {photos.map((assetId) => (
            <img
              key={assetId}
              src={galleryMediaUrl(assetId)}
              alt=""
              loading="lazy"
              className="max-h-72 w-full rounded-xl object-cover"
            />
          ))}
        </div>
      ) : null}
      {Object.entries(item.fields).map(([stepId, value]) => (
        <div key={stepId} className="mt-3">
          <p className="text-[12px] font-medium text-[var(--survey-muted)]">{labels.get(stepId) ?? stepId}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-6 text-[var(--survey-heading)]">
            {value}
          </p>
        </div>
      ))}
    </article>
  );
}

export function GalleryWall() {
  const [items, setItems] = useState<GalleryWallItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 字段标签与墙数据并行拉；标签走表单缓存的同一份 promise，不多发请求。
    preloadSubmitForm()
      .then((form) => {
        if (cancelled) return;
        setLabels(new Map(form.steps.map((step: SubmitStep) => [step.id, step.label || step.id])));
      })
      .catch(() => {
        /* 标签拉不到就用 step id 兜底，墙本体不受影响。 */
      });
    fetchGalleryWall()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "投稿墙加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (error)
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setError(null);
          setItems(null);
          setReloadKey((key) => key + 1);
        }}
      />
    );
  if (items === null) return <LoadingState />;
  if (items.length === 0) return <EmptyState title="墙上还没有内容" description="通过审核的投稿会展示在这里。" />;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <WallCard key={item.id} item={item} labels={labels} />
      ))}
    </div>
  );
}
