import { useCallback, useEffect, useState } from "react";
import { Copy, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import {
  ApiError,
  deleteAdminMediaLibrary,
  fetchAdminMediaLibrary,
  uploadAdminMediaLibrary,
  type AdminMediaLibraryItem,
} from "../api";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";

/**
 * 素材库（0091）：媒体素材的一等管理面。
 *
 * 上传走内容寻址去重——同一份字节全库只存一份，命中已有素材时直接复用
 * （页面提示「已复用既有素材」）。删除有引用保护：题目/选项/答卷挂载、
 * 封面、以及 BGM/场景图这类弱引用都会计入，非零即拒绝。
 */

const MIME_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "application", label: "文档" },
];

const PAGE_SIZE = 30;

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mediaUrl(id: number): string {
  return `/api/survey/media/${id}`;
}

export function MediaLibraryPage() {
  const { confirm, toast } = useDialogs();
  const [mime, setMime] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AdminMediaLibraryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchAdminMediaLibrary({
        ...(mime ? { mime } : {}),
        limit: PAGE_SIZE,
        offset,
      });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("加载失败"));
      setItems(null);
    }
  }, [mime, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadAdminMediaLibrary(file);
      toast({
        message: result.deduplicated ? "库里已有同一份素材，已直接复用（未重复占用存储）" : "已上传到素材库",
        variant: "success",
      });
      setOffset(0);
      await load();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "上传失败", variant: "error" });
    } finally {
      setUploading(false);
    }
  };

  const remove = async (item: AdminMediaLibraryItem) => {
    const refs = item.hardRefs + item.weakRefs;
    if (refs > 0) {
      toast({ message: `该素材仍被 ${refs} 处引用，先解除引用再删除`, variant: "error" });
      return;
    }
    if (
      !(await confirm({
        title: "删除素材？",
        message: `${item.fileName ?? `#${item.id}`} 将从素材库与存储中移除，不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
      }))
    ) {
      return;
    }
    setDeletingId(item.id);
    try {
      await deleteAdminMediaLibrary(item.id);
      toast({ message: "已删除", variant: "success" });
      await load();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "删除失败", variant: "error" });
    } finally {
      setDeletingId(null);
    }
  };

  const copyUrl = async (id: number) => {
    try {
      await navigator.clipboard.writeText(mediaUrl(id));
      toast({ message: "已复制素材链接", variant: "success" });
    } catch {
      toast({ message: "复制失败，请手动复制", variant: "error" });
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--color-ink)]">素材库</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            内容寻址去重：同一份文件全库只存一份。素材可直接挂到题目（编辑器「从素材库选择」）。
          </p>
        </div>
        <label className="btn btn-sm gap-1.5 btn-primary">
          <Upload className="h-4 w-4" />
          {uploading ? "上传中…" : "上传素材"}
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {MIME_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={`btn btn-sm ${mime === filter.value ? "btn-primary" : "btn-ghost"}`}
            onClick={() => {
              setMime(filter.value);
              setOffset(0);
            }}
          >
            {filter.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-[var(--color-muted-soft)]">共 {total} 个素材</span>
      </div>

      {error ? (
        <ErrorPanel
          error={error instanceof ApiError ? error : new ApiError(0, error.message)}
          onRetry={() => void load()}
        />
      ) : items === null ? (
        <SkeletonPanel lines={5} />
      ) : items.length === 0 ? (
        <EmptyPanel text="素材库还是空的，上传第一个素材吧" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const refs = item.hardRefs + item.weakRefs;
            return (
              <article key={item.id} className="card flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  {item.mimeType?.startsWith("image/") ? (
                    <img
                      src={mediaUrl(item.id)}
                      alt={item.fileName ?? `素材 ${item.id}`}
                      className="h-16 w-16 shrink-0 rounded-lg object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--color-muted)]">
                      <ImageIcon className="h-6 w-6" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                      {item.fileName ?? `素材 #${item.id}`}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--color-muted-soft)]">
                      {item.mimeType ?? item.mediaType} · {formatSize(item.fileSize)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--color-muted-soft)]">
                      引用 {refs} 处
                      {item.hardRefs > 0 ? `（挂载 ${item.hardRefs}）` : ""}
                      {item.weakRefs > 0 ? `（弱引用 ${item.weakRefs}）` : ""}
                      {item.contentHash ? " · 已去重" : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-edge)] pt-2">
                  <button type="button" className="btn btn-ghost btn-sm gap-1" onClick={() => void copyUrl(item.id)}>
                    <Copy className="h-3.5 w-3.5" /> 复制链接
                  </button>
                  <button
                    type="button"
                    aria-label={`删除素材 ${item.fileName ?? item.id}`}
                    className="btn btn-ghost btn-sm text-[var(--app-danger)]"
                    disabled={refs > 0 || deletingId === item.id}
                    title={refs > 0 ? "仍有引用，不能删除" : "删除素材"}
                    onClick={() => void remove(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={page <= 1}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            {page} / {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={page >= pageCount}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}
