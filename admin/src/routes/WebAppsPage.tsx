import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Globe, Plus, Save, Trash2 } from "lucide-react";
import {
  createAdminWebApp,
  deleteAdminWebApp,
  fetchAdminWebApps,
  reorderAdminWebApps,
  updateAdminWebApp,
  type AdminWebApp,
  type AdminWebAppInput,
  type WebAppOpenMode,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";

/**
 * 网页应用管理（0104，P0 批次 M2）：应用中心「网页导航」区的数据源。
 *
 * 形态沿用 TaskPacksPage 的「列表 ↔ 编辑器」两态：应用字段多（链接/图标/
 * 分类/打开方式/域名白名单），表格行内编辑放不下。排序走 ↑↓ 全量 reorder
 * （服务端按提交顺序写 sort_order=1..N），不暴露裸数字输入——顺序只有
 * 「相对位置」一种语义，数字反而不直观。删除是硬删（web_apps 无级联子表，
 * 历史无关联数据），确认文案如实说明；所有写操作都会进审计日志（web_app.*）。
 */

const OPEN_MODE_LABELS: Record<WebAppOpenMode, string> = {
  browser: "浏览器打开",
  miniapp: "内嵌打开（M4）",
};

interface EditableApp {
  id: number | null;
  name: string;
  url: string;
  description: string;
  iconUrl: string;
  category: string;
  enabled: boolean;
  openMode: WebAppOpenMode;
  /** 一行一个域名（小写主机名，不带协议）。 */
  domainsText: string;
}

function appToEditable(app: AdminWebApp): EditableApp {
  return {
    id: app.id,
    name: app.name,
    url: app.url,
    description: app.description ?? "",
    iconUrl: app.iconUrl ?? "",
    category: app.category ?? "",
    enabled: app.enabled,
    openMode: app.openMode,
    domainsText: (app.allowedDomains ?? []).join("\n"),
  };
}

function blankApp(): EditableApp {
  return {
    id: null,
    name: "",
    url: "https://",
    description: "",
    iconUrl: "",
    category: "",
    enabled: true,
    openMode: "browser",
    domainsText: "",
  };
}

function toInput(app: EditableApp): AdminWebAppInput {
  return {
    name: app.name.trim(),
    url: app.url.trim(),
    description: app.description.trim() || null,
    iconUrl: app.iconUrl.trim() || null,
    category: app.category.trim() || null,
    enabled: app.enabled,
    openMode: app.openMode,
    allowedDomains: app.domainsText
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** 编辑态图标预览：URL 变化即试加载，坏地址静默隐藏（不打编辑流）。 */
function IconPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url.trim() || failed) return null;
  return (
    <img
      src={url.trim()}
      alt="图标预览"
      className="h-8 w-8 rounded border border-[var(--color-edge)] object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function WebAppsPage() {
  const { data, error, retry } = useApi<{ items: AdminWebApp[] }>("/api/admin/web-apps");
  const { confirm, toast } = useDialogs();
  const apps = useMemo(() => data?.items ?? [], [data]);

  const [editing, setEditing] = useState<EditableApp | null>(null);
  // 打开编辑器那一刻的快照：与当前 editing 的差异即「未保存修改」
  // （对照 TaskPacksPage：快照显式拍摄，不用 effect 依赖 id）。
  const editingBaseline = useRef("");
  const editingDirty = editing !== null && JSON.stringify(editing) !== editingBaseline.current;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 正在切换「玩家端可见」的应用 id：开关是整应用 PATCH，连点会互相覆盖。 */
  const [togglingId, setTogglingId] = useState<number | null>(null);
  /** 正在 ↑↓ 重排中：禁用相邻按钮防连点乱序。 */
  const [reordering, setReordering] = useState(false);

  const openNew = () => {
    setSaveError(null);
    const blank = blankApp();
    editingBaseline.current = JSON.stringify(blank);
    setEditing(blank);
  };

  const openEdit = (app: AdminWebApp) => {
    setSaveError(null);
    const editable = appToEditable(app);
    editingBaseline.current = JSON.stringify(editable);
    setEditing(editable);
  };

  /** 退出编辑：有未保存修改时先确认（对照 TaskPacksPage 的离场守卫）。 */
  const exitEditor = async () => {
    if (
      editingDirty &&
      !(await confirm({
        title: "有未保存的修改",
        message: "网页应用的修改还没保存，离开后会丢失。",
        confirmLabel: "离开",
        cancelLabel: "留下修改",
        variant: "danger",
      }))
    ) {
      return;
    }
    setEditing(null);
  };

  const updateField = (patch: Partial<EditableApp>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setSaveError("名称不能为空");
      return;
    }
    if (!/^https:\/\/[^\s]+\.[^\s]+/i.test(editing.url.trim())) {
      setSaveError("链接必须是以 https:// 开头的合法网址（服务端同样强校验）");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (editing.id === null) {
        await createAdminWebApp(toInput(editing));
      } else {
        await updateAdminWebApp(editing.id, toInput(editing));
      }
      setEditing(null);
      retry();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (app: AdminWebApp) => {
    if (
      !(await confirm({
        title: "删除网页应用",
        message: `确定删除「${app.name}」吗？删除后玩家端立即不再显示（无关联历史数据，删除不可恢复）。`,
        confirmLabel: "删除",
        variant: "danger",
      }))
    )
      return;
    try {
      await deleteAdminWebApp(app.id);
      toast({ message: "网页应用已删除", variant: "success" });
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "删除失败", variant: "error" });
    }
  };

  const toggleEnabled = async (app: AdminWebApp, enabled: boolean) => {
    if (togglingId !== null) return;
    setTogglingId(app.id);
    try {
      await updateAdminWebApp(app.id, {
        name: app.name,
        url: app.url,
        description: app.description,
        iconUrl: app.iconUrl,
        category: app.category,
        openMode: app.openMode,
        allowedDomains: app.allowedDomains ?? [],
        enabled,
      });
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" });
    } finally {
      setTogglingId(null);
    }
  };

  /** ↑↓ 与相邻项交换后全量 reorder；失败提示并重拉恢复真实顺序。 */
  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= apps.length || reordering) return;
    const ids = apps.map((app) => app.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setReordering(true);
    try {
      await reorderAdminWebApps(ids);
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "排序失败", variant: "error" });
      retry();
    } finally {
      setReordering(false);
    }
  };

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <button type="button" className="btn btn-sm gap-1.5" onClick={() => void exitEditor()} disabled={saving}>
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </button>
          <div className="flex items-center gap-2">
            {saveError ? <span className="text-xs text-[var(--app-danger)]">{saveError}</span> : null}
            <button
              type="button"
              className="btn btn-sm gap-1.5 btn-primary"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save className="h-4 w-4" />
              {saving ? "保存中…" : "保存网页应用"}
            </button>
          </div>
        </div>

        <section className="card">
          <h2 className="text-sm font-bold text-[var(--color-ink)]">
            {editing.id === null ? "新建网页应用" : `编辑「${editing.name || "未命名"}」`}
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            保存后立即出现在应用中心的「网页导航」区（启用状态下）；打开方式与域名白名单供后续内嵌打开（M4）使用。
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <label className="block text-xs font-medium text-[var(--color-muted)]">
              名称
              <input
                className="input mt-1 w-full"
                value={editing.name}
                maxLength={60}
                placeholder="例如：好用工具站"
                onChange={(event) => updateField({ name: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
              链接（必须是 https://）
              <input
                className="input mt-1 w-full font-mono text-xs"
                value={editing.url}
                placeholder="https://example.com"
                onChange={(event) => updateField({ url: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
              简介（玩家端展示在名称下方，可空）
              <textarea
                className="input mt-1 min-h-16 w-full py-2"
                value={editing.description}
                maxLength={300}
                onChange={(event) => updateField({ description: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)]">
              分类（自由填写，可空）
              <input
                className="input mt-1 w-full"
                value={editing.category}
                maxLength={30}
                placeholder="例如：工具"
                onChange={(event) => updateField({ category: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
              图标地址（https://，可空）
              <div className="mt-1 flex items-center gap-2">
                <input
                  className="input w-full font-mono text-xs"
                  value={editing.iconUrl}
                  placeholder="https://cdn.example.com/icon.png"
                  onChange={(event) => updateField({ iconUrl: event.target.value })}
                />
                <IconPreview url={editing.iconUrl} />
              </div>
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)]">
              打开方式
              <select
                className="select mt-1 h-9 w-full text-xs"
                value={editing.openMode}
                onChange={(event) => updateField({ openMode: event.target.value as WebAppOpenMode })}
              >
                {Object.entries(OPEN_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--color-muted-soft)]">
                内嵌打开（miniapp）需配合下方域名白名单，M4 批次生效。
              </span>
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
              域名白名单（每行一个主机名，如 example.com；可空 = 未配置）
              <textarea
                className="input mt-1 min-h-16 w-full py-2 font-mono text-xs"
                value={editing.domainsText}
                placeholder={"example.com\nstatic.example.com"}
                onChange={(event) => updateField({ domainsText: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-[var(--color-muted)]">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={editing.enabled}
                onChange={(event) => updateField({ enabled: event.target.checked })}
              />
              玩家端可见
            </label>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--color-ink)]">网页应用</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            应用中心「网页导航」区的外链收录：启用项按排序展示给玩家；改动立即生效并记入审计日志。
          </p>
        </div>
        <button type="button" className="btn btn-sm gap-1.5 btn-primary" onClick={openNew}>
          <Plus className="h-4 w-4" />
          新建网页应用
        </button>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : data === null ? (
        <SkeletonPanel lines={5} />
      ) : apps.length === 0 ? (
        <EmptyPanel text="还没有收录任何网页应用，先新建一个吧" />
      ) : (
        <section className="card">
          <div className="hidden overflow-x-auto sm:block">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-16">排序</th>
                  <th className="w-40">名称</th>
                  <th>简介</th>
                  <th className="w-14">图标</th>
                  <th className="w-20">分类</th>
                  <th className="w-32">打开方式</th>
                  <th className="w-44">域名白名单</th>
                  <th className="w-16">启用</th>
                  <th className="w-24">操作</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app, index) => (
                  <tr key={app.id} className={app.enabled ? "" : "opacity-60"}>
                    <td data-label="排序">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          aria-label="上移"
                          className="btn btn-ghost btn-xs"
                          disabled={index === 0 || reordering}
                          onClick={() => void move(index, -1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="下移"
                          className="btn btn-ghost btn-xs"
                          disabled={index === apps.length - 1 || reordering}
                          onClick={() => void move(index, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td data-label="名称" className="font-medium">
                      {app.name}
                    </td>
                    <td data-label="简介" className="max-w-64 truncate text-sm text-[var(--color-muted)]">
                      {app.description || "—"}
                    </td>
                    <td data-label="图标">
                      {app.iconUrl ? (
                        <img
                          src={app.iconUrl}
                          alt=""
                          className="h-7 w-7 rounded border border-[var(--color-edge)] object-cover"
                          onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                          }}
                        />
                      ) : (
                        <Globe className="h-5 w-5 text-[var(--color-muted-soft)]" aria-hidden="true" />
                      )}
                    </td>
                    <td data-label="分类" className="text-sm">
                      {app.category || "—"}
                    </td>
                    <td data-label="打开方式" className="text-sm">
                      {OPEN_MODE_LABELS[app.openMode]}
                    </td>
                    <td
                      data-label="域名白名单"
                      className="max-w-44 truncate font-mono text-xs text-[var(--color-muted)]"
                    >
                      {app.allowedDomains?.length ? app.allowedDomains.join(", ") : "—"}
                    </td>
                    <td data-label="启用">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={app.enabled}
                        disabled={togglingId !== null}
                        onChange={(event) => void toggleEnabled(app, event.target.checked)}
                      />
                    </td>
                    <td data-label="操作">
                      <div className="flex items-center gap-1.5">
                        <button type="button" className="btn btn-sm" onClick={() => openEdit(app)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          aria-label="删除网页应用"
                          className="btn btn-sm btn-ghost text-[var(--app-danger)]"
                          onClick={() => void remove(app)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:hidden">
            {apps.map((app, index) => (
              <div key={app.id} className="rounded-lg border border-[var(--color-edge)] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {app.iconUrl ? (
                      <img
                        src={app.iconUrl}
                        alt=""
                        className="h-8 w-8 rounded border border-[var(--color-edge)] object-cover"
                      />
                    ) : (
                      <Globe className="h-5 w-5 text-[var(--color-muted-soft)]" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <strong className="block truncate">{app.name}</strong>
                      <span className="block truncate font-mono text-[11px] text-[var(--color-muted)]">{app.url}</span>
                    </div>
                  </div>
                  <span className={app.enabled ? "badge badge-green" : "badge badge-gray"}>
                    {app.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                {app.description ? (
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--color-muted)]">{app.description}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-ink)] dark:text-[var(--color-muted-soft)]">
                  {app.category ? (
                    <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">{app.category}</span>
                  ) : null}
                  <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">
                    {OPEN_MODE_LABELS[app.openMode]}
                  </span>
                  {app.allowedDomains?.length ? (
                    <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 font-mono">
                      白名单 {app.allowedDomains.length} 域
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-edge)] pt-3">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="上移"
                      className="btn btn-ghost btn-xs"
                      disabled={index === 0 || reordering}
                      onClick={() => void move(index, -1)}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="下移"
                      className="btn btn-ghost btn-xs"
                      disabled={index === apps.length - 1 || reordering}
                      onClick={() => void move(index, 1)}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={app.enabled}
                        disabled={togglingId !== null}
                        onChange={(event) => void toggleEnabled(app, event.target.checked)}
                      />
                      启用
                    </label>
                    <button type="button" className="btn btn-sm" onClick={() => openEdit(app)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      aria-label="删除网页应用"
                      className="btn btn-sm btn-ghost text-[var(--app-danger)]"
                      onClick={() => void remove(app)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
