import { useEffect, useState } from "react";
import { ArchiveRestore, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, apiSend, fetchAdminTrash, type TrashItem } from "../api";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

const KIND_LABEL: Record<TrashItem["kind"], string> = {
  survey: "问卷",
  showcase_person: "展示人物",
  showcase_item: "展示作品",
  plaza_post: "树洞",
  report_template: "报告模板",
};

export function TrashPage() {
  const { toast, confirm } = useDialogs();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setError(null);
    try {
      const data = await fetchAdminTrash();
      setItems(data.items);
      setSelected(new Set());
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError
          : new ApiError(0, requestError instanceof Error ? requestError.message : "加载回收站失败"),
      );
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const keyOf = (item: TrashItem) => `${item.kind}:${item.id}`;

  const restore = async (targets: TrashItem[]) => {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      const result = await apiSend<{ ok: boolean }>("POST", "/api/admin/trash", {
        items: targets.map(({ kind, id }) => ({ kind, id })),
      });
      if (!result.ok) throw new Error("部分内容已过期或已被处理，请刷新回收站");
      toast({ message: `已恢复 ${targets.length} 项`, variant: "success" });
      await reload();
    } catch (requestError) {
      toast({ message: requestError instanceof Error ? requestError.message : "恢复失败", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const purgeSelected = async () => {
    if (selectedItems.length === 0) return;
    if (
      !(await confirm({
        message: `彻底删除选中的 ${selectedItems.length} 项？此操作无法恢复。`,
        variant: "danger",
        confirmLabel: "彻底删除",
      }))
    )
      return;
    setBusy(true);
    try {
      const result = await apiSend<{ ok: boolean }>("DELETE", "/api/admin/trash", {
        items: selectedItems.map(({ kind, id }) => ({ kind, id })),
      });
      if (!result.ok) throw new Error("部分内容已过期或已被处理，请刷新回收站");
      toast({ message: `已彻底删除 ${selectedItems.length} 项`, variant: "success" });
      await reload();
    } catch (requestError) {
      toast({ message: requestError instanceof Error ? requestError.message : "彻底删除失败", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (item: TrashItem) => {
    const key = keyOf(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (error) return <ErrorPanel error={error} onRetry={() => void reload()} />;
  if (!items) return <SkeletonPanel lines={6} />;

  const selectedItems = items.filter((item) => selected.has(keyOf(item)));

  return (
    <div className="space-y-4">
      <PageHeader
        title="回收站"
        actions={
          <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
        }
      />
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">最近 30 天</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              到期后由每日 maintenance sweep 自动物理清理；清理前可恢复。
            </p>
          </div>
          {selectedItems.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void restore(selectedItems)}
              >
                <ArchiveRestore className="h-4 w-4" /> 恢复 {selectedItems.length} 项
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void purgeSelected()}>
                <Trash2 className="h-4 w-4" /> 彻底删除 {selectedItems.length} 项
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {items.length === 0 ? (
        <EmptyPanel text="回收站是空的。删除问卷、展示内容、树洞或自定义模板后，会在这里保留 30 天。" />
      ) : (
        <section className="card overflow-hidden p-0">
          <div className="divide-y divide-[var(--color-edge-soft)]">
            {items.map((item) => (
              <div key={keyOf(item)} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <input
                  type="checkbox"
                  aria-label={`选择${KIND_LABEL[item.kind]} ${item.title}`}
                  checked={selected.has(keyOf(item))}
                  disabled={busy}
                  onChange={() => toggle(item)}
                  className="h-4 w-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge badge-gray">{KIND_LABEL[item.kind]}</span>
                    <strong className="truncate">{item.title || "未命名内容"}</strong>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
                    删除于 {formatDateTime(item.deletedAt)} · 保留至约 30 天
                  </p>
                </div>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void restore([item])}>
                  <ArchiveRestore className="h-4 w-4" /> 恢复
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !(await confirm({
                        message: "彻底删除后将无法恢复，确定继续？",
                        variant: "danger",
                        confirmLabel: "彻底删除",
                      }))
                    )
                      return;
                    setBusy(true);
                    try {
                      await apiSend("DELETE", "/api/admin/trash", { items: [{ kind: item.kind, id: item.id }] });
                      await reload();
                    } catch (requestError) {
                      toast({
                        message: requestError instanceof Error ? requestError.message : "彻底删除失败",
                        variant: "error",
                      });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" /> 彻底删除
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
