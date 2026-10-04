import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, ExternalLink, X } from "lucide-react";
import {
  fetchShowcaseItem,
  SHOWCASE_ITEM_KIND_LABELS,
  type ShowcaseItem,
  type ShowcaseItemKind,
} from "./showcase-api";

/**
 * 作品的查看层：一个覆盖全屏的 readonly 视图，按作品类型切换内容形态。
 *
 * - image  → 大图（contain，黑底，点背景/Esc 关闭）
 * - audio  → 内联播放器（有封面就一起显示）
 * - video  → 16:9 内联播放器（playsinline / 预加载元数据）
 * - 文字   → 阅读层（feed 只给预览，长文在这里按需取全文）
 * 任何类型都保留「原文链接」，外链作品仍然可以跳出去。
 */

/** 卡片提示文案：让用户知道点下去会发生什么。 */
export function showcaseItemActionLabel(item: ShowcaseItem): string | null {
  if (item.mediaUrl) {
    if (item.kind === "image") return "查看大图";
    if (item.kind === "audio") return "播放音频";
    if (item.kind === "video") return "播放视频";
  }
  if (item.description && (item.descriptionTruncated || item.description.length > 120 || item.kind === "article")) {
    return "阅读全文";
  }
  return null;
}

/** 点开是「内容」还是「外链」：有内容文件/正文就在站内看，否则跳链接。 */
export function showcaseItemOpensInApp(item: ShowcaseItem): boolean {
  return Boolean(showcaseItemActionLabel(item));
}

function isExternal(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function kindIcon(kind: ShowcaseItemKind) {
  return kind === "audio" ? "🎧" : kind === "video" ? "🎬" : kind === "image" ? "🖼️" : "📄";
}

export function ShowcaseViewer({ item, onClose }: { item: ShowcaseItem; onClose: () => void }) {
  const [full, setFull] = useState<ShowcaseItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = full ?? item;
  const hasMedia = Boolean(current.mediaUrl);
  const isText = !hasMedia || current.kind === "article";
  // 深色舞台只给「铺满画面」的内容（图片 / 视频）：音频是一张卡片，放在主题
  // 底色上更好看，也更容易读标题。
  const darkStage = hasMedia && (current.kind === "image" || current.kind === "video");

  // 长正文按需取全文；短视频/音频不需要额外请求（浏览器自己流式加载）。
  useEffect(() => {
    let cancelled = false;
    if (!item.descriptionTruncated) return undefined;
    setLoading(true);
    setError(null);
    fetchShowcaseItem(item.id)
      .then((detail) => {
        if (!cancelled) setFull(detail);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "正文加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.descriptionTruncated]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className={darkStage ? "showcase-viewer showcase-viewer-dark" : "showcase-viewer"}
      role="dialog"
      aria-modal="true"
      aria-label={current.title}
    >
      <div className="showcase-viewer-bar">
        <button type="button" className="showcase-viewer-back" aria-label="返回资料面板" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="showcase-viewer-kind">
          <span aria-hidden>{kindIcon(current.kind)}</span>
          {SHOWCASE_ITEM_KIND_LABELS[current.kind] ?? "作品"}
        </span>
        {current.url ? (
          <a
            className="showcase-viewer-src"
            href={current.url}
            target={isExternal(current.url) ? "_blank" : undefined}
            rel={isExternal(current.url) ? "noreferrer" : undefined}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            原文
          </a>
        ) : null}
        <button type="button" className="showcase-viewer-close" aria-label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="showcase-viewer-scroll">
        <h2 className="showcase-viewer-title">{current.title}</h2>

        {hasMedia && current.kind === "image" ? (
          <figure className="showcase-viewer-image">
            <img src={current.mediaUrl as string} alt={current.title} loading="lazy" decoding="async" />
          </figure>
        ) : null}

        {hasMedia && current.kind === "video" ? (
          <figure className="showcase-viewer-video">
            {/* playsinline：iOS 上不要强制全屏，才好在资料面板里看完返回。 */}
            <video src={current.mediaUrl as string} controls playsInline preload="metadata" />
          </figure>
        ) : null}

        {hasMedia && current.kind === "audio" ? (
          <figure className="showcase-viewer-audio">
            <div className="showcase-viewer-audio-head">
              {current.coverUrl ? (
                <img src={current.coverUrl} alt="" className="showcase-viewer-audio-cover" loading="lazy" decoding="async" />
              ) : (
                <span className="showcase-viewer-audio-cover showcase-viewer-audio-fallback" aria-hidden>
                  🎧
                </span>
              )}
              <figcaption className="showcase-viewer-audio-meta">
                <span className="showcase-viewer-audio-title">{current.title}</span>
                <span className="showcase-viewer-audio-hint">点击播放</span>
              </figcaption>
            </div>
            {/* 播放器整行铺满：手机上是唯一能让原生控件不挤的排法。 */}
            <audio src={current.mediaUrl as string} controls preload="metadata" />
          </figure>
        ) : null}

        {loading ? <p className="showcase-viewer-hint">正文加载中…</p> : null}
        {error ? <p className="showcase-viewer-hint">{error}</p> : null}
        {current.description ? (
          <div className="showcase-viewer-body">{current.description}</div>
        ) : isText ? (
          <p className="showcase-viewer-hint">
            <BookOpen className="mr-1 inline h-3.5 w-3.5" />
            这篇作品还没有正文。
          </p>
        ) : null}
      </div>
    </div>
  );
}
