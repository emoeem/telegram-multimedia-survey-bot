import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  AtSign,
  BookOpen,
  ClipboardList,
  Code2,
  ExternalLink,
  FileText,
  Film,
  Folder,
  Globe,
  Headphones,
  Image as ImageIcon,
  Link2,
  Mail,
  Send,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import {
  SHOWCASE_ITEM_KIND_LABELS,
  type ShowcaseItem,
  type ShowcaseItemKind,
  type ShowcasePerson,
} from "./showcase-api";
import { ShowcaseViewer, showcaseItemActionLabel, showcaseItemOpensInApp } from "./ShowcaseViewer";

/**
 * The detail panel of the Showcase stage.
 *
 * It is a dependency-free bottom sheet rather than a library one: the whole
 * interaction is a translateY plus a pointer-driven drag, and pulling in a
 * drawer runtime for that would have added more bundle than the stage itself.
 * The behaviour copies what those libraries get right — enter/exit transition,
 * drag-to-dismiss with a velocity threshold, Escape to close, body scroll lock
 * and a backdrop tap target that is a real button.
 */

const KIND_ICONS: Record<ShowcaseItemKind, typeof Link2> = {
  image: ImageIcon,
  article: FileText,
  audio: Headphones,
  video: Film,
  project: Folder,
  github: Code2,
  website: Globe,
  social: AtSign,
  survey: ClipboardList,
  other: Link2,
};

const LINK_ICONS: Record<string, typeof Link2> = {
  github: Code2,
  website: Globe,
  social: AtSign,
  email: Mail,
  telegram: Send,
  other: Link2,
};

const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.6;

function isExternal(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function FeaturedCard({ item, onOpen }: { item: ShowcaseItem; onOpen: (item: ShowcaseItem) => void }) {
  const Icon = KIND_ICONS[item.kind] ?? Link2;
  // 作品卡片分三种命运：能在站内看（图片/音频/视频/长文）→ 点开查看层；
  // 只有外链 → 跳出去；两者都没有 → 静态卡。判据集中在 ShowcaseViewer。
  const openable = showcaseItemOpensInApp(item);
  const action = showcaseItemActionLabel(item);
  const actionIcon =
    item.kind === "image" ? ImageIcon : item.kind === "audio" ? Headphones : item.kind === "video" ? Film : BookOpen;
  const ActionIcon = actionIcon;
  const body = (
    <>
      <span className="showcase-work-cover">
        {item.coverUrl ? (
          <img src={item.coverUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="showcase-work-cover-fallback">
            <Icon className="h-5 w-5" />
          </span>
        )}
      </span>
      <span className="showcase-work-body">
        <span className="showcase-work-kind">
          <Icon className="h-3 w-3" />
          {SHOWCASE_ITEM_KIND_LABELS[item.kind] ?? "作品"}
        </span>
        <span className="showcase-work-title">{item.title}</span>
        {item.description ? <span className="showcase-work-desc">{item.description}</span> : null}
        {action ? (
          <span className="showcase-work-more">
            <ActionIcon className="h-3 w-3" />
            {action}
          </span>
        ) : null}
      </span>
    </>
  );

  if (openable) {
    return (
      <div className="showcase-work showcase-work-readable">
        <button type="button" className="showcase-work-main" onClick={() => onOpen(item)}>
          {body}
        </button>
        {item.url ? (
          <a
            className="showcase-work-src"
            href={item.url}
            target={isExternal(item.url) ? "_blank" : undefined}
            rel={isExternal(item.url) ? "noreferrer" : undefined}
          >
            <ExternalLink className="h-3 w-3" />
            原文链接
          </a>
        ) : null}
      </div>
    );
  }

  if (!item.url) {
    return <div className="showcase-work showcase-work-static">{body}</div>;
  }
  return (
    <a
      className="showcase-work"
      href={item.url}
      target={isExternal(item.url) ? "_blank" : undefined}
      rel={isExternal(item.url) ? "noreferrer" : undefined}
    >
      {body}
    </a>
  );
}

export function ShowcaseSheet({
  person,
  open,
  onClose,
}: {
  person: ShowcasePerson | null;
  open: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dragY, setDragY] = useState(0);
  // 查看层（大图 / 播放器 / 阅读层）：由 ShowcaseViewer 负责具体形态与取全文。
  const [viewerItem, setViewerItem] = useState<ShowcaseItem | null>(null);
  const dragRef = useRef<{ startY: number; lastY: number; startTime: number; active: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && person) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    setDragY(0);
    setViewerItem(null);
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
  }, [open, person]);

  // Escape closes the sheet; while it is open the page behind must not scroll
  // (on iOS a scrollable body also drags the whole overlay around).
  useEffect(() => {
    if (!mounted) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 查看层在上面：Esc 先退出查看层，再关资料面板。
      if (viewerItem) {
        setViewerItem(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mounted, onClose, viewerItem]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const distance = Math.max(0, drag.lastY - drag.startY);
    const elapsed = Math.max(1, performance.now() - drag.startTime);
    setDragY(0);
    if (distance > DISMISS_DISTANCE || distance / elapsed > DISMISS_VELOCITY) onClose();
  }, [onClose]);

  if (!mounted || !person) return null;

  const featured = person.items.filter((item) => item.featured);
  const rest = person.items.filter((item) => !item.featured);
  const style = {
    transform: visible ? `translateY(${dragY}px)` : "translateY(100%)",
    transition: dragY > 0 ? "none" : undefined,
  } as const;

  return (
    <div className="showcase-sheet-root" data-open={visible ? "true" : "false"}>
      <button type="button" className="showcase-sheet-backdrop" aria-label="关闭资料面板" onClick={onClose} />
      <div
        ref={panelRef}
        className="showcase-sheet"
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={`${person.name} 的资料`}
      >
        <div
          className="showcase-sheet-grip"
          onPointerDown={(event) => {
            dragRef.current = {
              startY: event.clientY,
              lastY: event.clientY,
              startTime: performance.now(),
              active: true,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag?.active) return;
            drag.lastY = event.clientY;
            setDragY(Math.max(0, event.clientY - drag.startY));
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="showcase-sheet-handle" aria-hidden="true" />
        </div>

        <button type="button" className="showcase-sheet-close" aria-label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>

        <div className="showcase-sheet-scroll">
          <header className="showcase-sheet-head">
            {person.avatarUrl ? (
              <img src={person.avatarUrl} alt="" className="showcase-sheet-avatar" loading="lazy" decoding="async" />
            ) : (
              <span className="showcase-sheet-avatar showcase-sheet-avatar-fallback" aria-hidden="true">
                {person.name.slice(0, 1)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="showcase-sheet-name">{person.name}</h2>
              {person.subtitle ? <p className="showcase-sheet-subtitle">{person.subtitle}</p> : null}
            </div>
          </header>

          {person.tags.length > 0 ? (
            <div className="showcase-sheet-tags">
              {person.tags.map((tag) => (
                <span key={tag} className="showcase-tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {person.description ? <p className="showcase-sheet-desc">{person.description}</p> : null}

          {person.surveyId ? (
            <a className="showcase-sheet-action" href={`/s/${person.surveyId}`}>
              <ClipboardList className="h-4 w-4" />
              查看我的问卷
              <ArrowUpRight className="ml-auto h-4 w-4 opacity-70" />
            </a>
          ) : null}

          {featured.length > 0 ? (
            <section className="showcase-sheet-section">
              <h3 className="showcase-sheet-section-title">
                <Sparkles className="h-3.5 w-3.5" />
                精选作品
              </h3>
              <div className="showcase-works">
                {featured.map((item) => (
                  <FeaturedCard key={item.id} item={item} onOpen={setViewerItem} />
                ))}
              </div>
            </section>
          ) : null}

          {rest.length > 0 ? (
            <section className="showcase-sheet-section">
              <h3 className="showcase-sheet-section-title">
                <Star className="h-3.5 w-3.5" />
                全部作品
              </h3>
              <div className="showcase-works">
                {rest.map((item) => (
                  <FeaturedCard key={item.id} item={item} onOpen={setViewerItem} />
                ))}
              </div>
            </section>
          ) : null}

          {person.items.length === 0 && !person.description ? (
            <p className="showcase-sheet-desc">这位创作者还没有补充更多资料。</p>
          ) : null}

          {person.links.length > 0 ? (
            <section className="showcase-sheet-section">
              <h3 className="showcase-sheet-section-title">
                <Link2 className="h-3.5 w-3.5" />
                找到ta
              </h3>
              <div className="showcase-links">
                {person.links.map((link) => {
                  const Icon = LINK_ICONS[link.type] ?? Link2;
                  return (
                    <a
                      key={`${link.type}-${link.url}`}
                      className="showcase-link"
                      href={link.url}
                      target={isExternal(link.url) ? "_blank" : undefined}
                      rel={isExternal(link.url) ? "noreferrer" : undefined}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="truncate">{link.label}</span>
                    </a>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {viewerItem ? <ShowcaseViewer item={viewerItem} onClose={() => setViewerItem(null)} /> : null}
    </div>
  );
}
