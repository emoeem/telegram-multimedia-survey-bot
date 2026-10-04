import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudOff,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, apiSend, type DeploymentTaskView, type DeploymentView, type PublicationTargetView, type ProvisionCustomerResult } from "../api";
import { formatDateTime } from "../format";
import { Modal, SkeletonPanel } from "../components/ui";
import { RemoteDataViewer } from "../components/RemoteDataViewer";
import { useDialogs } from "../components/Dialogs";

const statusLabel: Record<DeploymentView["status"], string> = {
  pending: "待部署",
  deploying: "部署中",
  online: "在线",
  offline: "离线",
  disabled: "已停用",
  failed: "失败",
};
const taskLabel: Record<DeploymentTaskView["type"], string> = {
  deploy: "部署",
  update: "升级",
  rollback: "回滚",
  disable: "停用",
  enable: "启用",
};
const taskStatusLabel: Record<DeploymentTaskView["status"], string> = {
  queued: "排队",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
};

function StatusBadge({ status }: { status: DeploymentView["status"] }) {
  const cls =
    status === "online"
      ? "badge-success"
      : status === "failed"
        ? "badge-error"
        : status === "deploying"
          ? "badge-warning"
          : status === "disabled"
            ? "badge-ghost"
            : "badge-info";
  return <span className={`badge ${cls} badge-sm`}>{statusLabel[status]}</span>;
}

function TaskBadge({ status }: { status: DeploymentTaskView["status"] }) {
  const cls = status === "succeeded" ? "badge-success" : status === "failed" ? "badge-error" : status === "running" ? "badge-warning" : "badge-info";
  return <span className={`badge ${cls} badge-sm`}>{taskStatusLabel[status]}</span>;
}

export function ControlCenterPage() {
  // The panel's own confirm dialog: this page was the only place still calling
  // the browser's native confirm(), which some WebViews refuse outright (the
  // button then did nothing at all).
  const { confirm: confirmDialog } = useDialogs();
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [targets, setTargets] = useState<PublicationTargetView[] | null>(null);
  const [selected, setSelected] = useState<DeploymentView | null>(null);
  // Vendor-side read-only viewer (客户数据); null keeps it closed.
  const [remoteFor, setRemoteFor] = useState<DeploymentView | null>(null);
  const [tasks, setTasks] = useState<DeploymentTaskView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | DeploymentView["status"]>("all");
  const [showDeploy, setShowDeploy] = useState(false);
  const [showTarget, setShowTarget] = useState(false);
  const [editingTarget, setEditingTarget] = useState<PublicationTargetView | null>(null);
  const [provisionResult, setProvisionResult] = useState<ProvisionCustomerResult | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [adminIds, setAdminIds] = useState("");
  const [usageDays, setUsageDays] = useState("30");
  const [customerContact, setCustomerContact] = useState("");
  const [botToken, setBotToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [targetName, setTargetName] = useState("");
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [targetDefault, setTargetDefault] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [d, t] = await Promise.all([
        api<{ items: DeploymentView[] }>("/api/control/deployments"),
        api<{ items: PublicationTargetView[] }>("/api/control/publication-targets"),
      ]);
      setDeployments(d.items);
      setTargets(t.items);
      if (selected) setSelected(d.items.find((item) => item.id === selected.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  };

  const loadTasks = async (deployment: DeploymentView) => {
    try {
      const data = await api<{ items: DeploymentTaskView[] }>(`/api/control/deployments/${deployment.id}/tasks`);
      setTasks(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "任务加载失败");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selected) void loadTasks(selected);
    else setTasks([]);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || !["pending", "deploying"].includes(selected.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const fresh = await api<{ deployment: DeploymentView }>(`/api/control/deployments/${selected.id}`);
        setSelected(fresh.deployment);
        const taskData = await api<{ items: DeploymentTaskView[] }>(`/api/control/deployments/${selected.id}/tasks`);
        setTasks(taskData.items);
        if (fresh.deployment.status === "online" || fresh.deployment.status === "failed") await load();
      } catch {
        // The normal page error state is left untouched during background polling.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.status]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      if (selected) {
        const fresh = await api<{ deployment: DeploymentView }>(`/api/control/deployments/${selected.id}`);
        setSelected(fresh.deployment);
        await loadTasks(fresh.deployment);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(
    () =>
      (deployments ?? []).filter((d) => {
        const matchesStatus = statusFilter === "all" || d.status === statusFilter;
        const needle = query.trim().toLowerCase();
        const matchesQuery =
          !needle ||
          d.workerName.toLowerCase().includes(needle) ||
          d.installationId.toLowerCase().includes(needle) ||
          String(d.licenseId).includes(needle);
        return matchesStatus && matchesQuery;
      }),
    [deployments, query, statusFilter],
  );

  const stats = useMemo(() => {
    const all = deployments ?? [];
    return {
      total: all.length,
      online: all.filter((d) => d.status === "online").length,
      attention: all.filter((d) => d.status === "failed" || d.status === "offline").length,
      deploying: all.filter((d) => d.status === "deploying" || d.status === "pending").length,
      targets: (targets ?? []).filter((t) => t.enabled).length,
    };
  }, [deployments, targets]);

  const resetDeployForm = () => {
    setProvisionResult(null);
    setCustomerName("");
    setAdminIds("");
    setUsageDays("30");
    setCustomerContact("");
    setBotToken("");
    setAccountId("");
    setApiToken("");
    setWorkerName("");
  };

  const resetTargetForm = () => {
    setEditingTarget(null);
    setTargetName("");
    setChatId("");
    setThreadId("");
    setTargetEnabled(true);
    setTargetDefault(false);
  };

  const openEditTarget = (target: PublicationTargetView) => {
    setEditingTarget(target);
    setTargetName(target.name);
    setChatId(target.chatId);
    setThreadId(target.threadId ? String(target.threadId) : "");
    setTargetEnabled(target.enabled);
    setTargetDefault(target.isDefault);
    setShowTarget(true);
  };

  const submitTarget = () =>
    act(async () => {
      const body = {
        name: targetName,
        chatId,
        threadId: threadId ? Number(threadId) : null,
        enabled: targetEnabled,
        isDefault: targetDefault,
      };
      if (editingTarget) await apiSend("PATCH", `/api/control/publication-targets/${editingTarget.id}`, body);
      else await apiSend("POST", "/api/control/publication-targets", body);
      setShowTarget(false);
      resetTargetForm();
    });

  if (deployments === null && !error) return <SkeletonPanel />;

  return (
    <div className="space-y-5 control-center-page">
      <div className="admin-page-intro">
        <div>
          <h2>控制中心</h2>
          <p>统一管理 Customer Worker、部署任务、Runner 状态和 Telegram 发布目标</p>
        </div>
        <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />刷新
        </button>
      </div>

      {error ? (
        <div className="alert alert-error">
          <CircleAlert className="h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      <section className="admin-stat-grid">
        {[
          { label: "Customer Workers", value: stats.total, Icon: Server, tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]" },
          { label: "在线", value: stats.online, Icon: CheckCircle2, tint: "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]" },
          { label: "需要处理", value: stats.attention, Icon: CircleAlert, tint: "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]" },
          { label: "部署任务", value: stats.deploying, Icon: Activity, tint: "bg-[color-mix(in_srgb,var(--color-info)_12%,var(--surface))] text-[var(--color-info)]" },
          { label: "发布目标", value: stats.targets, Icon: ShieldCheck, tint: "bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] text-[var(--color-primary)]" },
        ].map(({ label, value, Icon, tint }) => (
          <div key={label} className="admin-stat">
            <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <span className={`grid h-7 w-7 place-items-center rounded-lg ${tint}`}><Icon className="h-4 w-4" /></span>
              {label}
            </div>
            <div className="mt-2 text-2xl font-bold font-tabular-nums">{value}</div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="card-title">
          <div>
            <h2>Customer Deployments</h2>
            <p className="card-sub">Customer Worker 是受授权的部署实例，不是 PC Agent。</p>
          </div>
          <button className="btn btn-accent btn-sm" onClick={() => setShowDeploy(true)}>
            <Plus className="h-4 w-4" />登记 Worker
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <input className="input min-w-56" placeholder="搜索 Worker / Installation / License" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="select select-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">全部状态</option>
            {Object.keys(statusLabel).map((status) => <option key={status} value={status}>{statusLabel[status as DeploymentView["status"]]}</option>)}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Worker</th><th>授权</th><th>状态</th><th>版本</th><th>最后在线</th><th /></tr></thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="hover">
                  <td>
                    <button className="text-left" onClick={() => setSelected(d)}>
                      <div className="font-medium">{d.workerName}</div>
                      <div className="text-xs opacity-50">{d.installationId}</div>
                    </button>
                  </td>
                  <td className="text-sm">{d.licenseId}</td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="text-sm">{d.currentVersion ?? "—"}{d.desiredVersion && d.desiredVersion !== d.currentVersion ? <span className="ml-1 opacity-50">→ {d.desiredVersion}</span> : null}</td>
                  <td className="text-xs opacity-60">{d.lastSeenAt ? formatDateTime(d.lastSeenAt) : "—"}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        className="btn btn-ghost btn-xs"
                        title="只读查看该客户实例的数据"
                        onClick={() => setRemoteFor(d)}
                      >
                        <Database className="h-3.5 w-3.5" />查看数据
                      </button>
                      <button className="btn btn-ghost btn-xs" onClick={() => setSelected(d)}><ChevronRight className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length ? <tr><td colSpan={6} className="py-10 text-center opacity-50">没有匹配的部署</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <div>
            <h2>Deployment Tasks</h2>
            <p className="card-sub">Runner 从这里领取任务；控制中心负责创建、追踪和查看结果。</p>
          </div>
          {selected ? <span className="text-sm opacity-60">{selected.workerName} · 最近 {tasks.length} 条</span> : null}
        </div>
        {selected ? (
          <div className="mt-4 space-y-2">
            {tasks.map((task) => (
              <div key={task.id} className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface-muted)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">#{task.id} {taskLabel[task.type]}</span>
                  <TaskBadge status={task.status} />
                  {task.targetVersion ? <span className="text-xs opacity-60">目标 {task.targetVersion}</span> : null}
                  <span className="ml-auto text-xs opacity-50">{formatDateTime(task.requestedAt)}</span>
                </div>
                {task.errorMessage ? <p className="mt-2 text-sm text-error">{task.errorMessage}</p> : null}
                {task.logText ? <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-base-200 p-2 text-xs whitespace-pre-wrap">{task.logText}</pre> : null}
              </div>
            ))}
            {!tasks.length ? <div className="empty py-8">选择一个 Worker 查看部署任务</div> : null}
          </div>
        ) : (
          <div className="empty py-8">从上方选择 Worker</div>
        )}
      </section>

      <section className="card">
        <div className="card-title">
          <div>
            <h2>Telegram Publication Targets</h2>
            <p className="card-sub">公开报告统一发布到这里配置的群组 / Topic；Bot 不维护独立配置。</p>
          </div>
          <button className="btn btn-accent btn-sm" onClick={() => { resetTargetForm(); setShowTarget(true); }}>
            <Plus className="h-4 w-4" />添加目标
          </button>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {(targets ?? []).map((target) => (
            <div key={target.id} className={`rounded-xl border p-4 ${target.isDefault ? "border-[color-mix(in_srgb,var(--color-primary)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--color-primary)_6%,var(--surface))]" : "border-[var(--color-edge)] bg-[var(--surface)]"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {target.name}
                    {target.isDefault ? <span className="badge badge-primary badge-sm">默认</span> : null}
                    {!target.enabled ? <span className="badge badge-ghost badge-sm">已停用</span> : null}
                  </div>
                  <div className="mt-2 text-sm opacity-70">Chat ID: {target.chatId}</div>
                  <div className="text-sm opacity-70">Topic: {target.threadId ?? "主聊天"}</div>
                </div>
                <div className="flex gap-1">
                  <button className="btn btn-ghost btn-sm" title="编辑" onClick={() => openEditTarget(target)}><Pencil className="h-4 w-4" /></button>
                  <button className="btn btn-ghost btn-sm text-error" title="删除" disabled={busy} onClick={() => void (async () => {
                    if (!(await confirmDialog({ message: `删除发布目标“${target.name}”？`, variant: "danger", confirmLabel: "删除" }))) return;
                    void act(() => apiSend("DELETE", `/api/control/publication-targets/${target.id}`));
                  })()}><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-xs" disabled={busy || target.isDefault || !target.enabled} onClick={() => void act(() => apiSend("PATCH", `/api/control/publication-targets/${target.id}`, { name: target.name, chatId: target.chatId, threadId: target.threadId, enabled: true, isDefault: true }))}>设为默认</button>
                <button className="btn btn-xs" disabled={busy} onClick={() => void act(() => apiSend("PATCH", `/api/control/publication-targets/${target.id}`, { name: target.name, chatId: target.chatId, threadId: target.threadId, enabled: !target.enabled, isDefault: target.isDefault && target.enabled }))}>
                  {target.enabled ? "停用" : "启用"}
                </button>
                <button className="btn btn-xs" onClick={() => navigator.clipboard?.writeText(target.chatId)}><Copy className="h-3 w-3" />复制 Chat ID</button>
              </div>
            </div>
          ))}
          {!targets?.length ? <div className="empty py-8 lg:col-span-2">尚未配置发布目标</div> : null}
        </div>
      </section>

      {selected ? (
        <Modal open onClose={() => setSelected(null)} size="lg" title={selected.workerName}>
            <p className="-mt-1 text-sm text-[var(--color-muted)]">{selected.workerUrl ?? selected.installationId}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">状态</span><div className="mt-1"><StatusBadge status={selected.status} /></div></div>
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">当前版本</span><div className="mt-1 font-medium">{selected.currentVersion ?? "—"}</div></div>
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">目标版本</span><div className="mt-1 font-medium">{selected.desiredVersion ?? "—"}</div></div>
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">最后在线</span><div className="mt-1 font-medium">{selected.lastSeenAt ? formatDateTime(selected.lastSeenAt) : "—"}</div></div>
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">授权到期</span><div className="mt-1 font-medium">{selected.licenseExpiresAt ? formatDateTime(selected.licenseExpiresAt) : "长期有效"}</div></div>
              <div className="rounded-xl bg-base-200 p-3"><span className="text-xs opacity-50">授权状态</span><div className="mt-1 font-medium">{selected.licenseStatus}</div></div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button className="btn btn-success btn-sm" disabled={busy || selected.licenseStatus === "revoked"} onClick={() => void act(async () => { await apiSend("POST", `/api/control/deployments/${selected.id}/renew`, { days: 30 }); })}>续费 30 天</button>
              <button className="btn btn-primary btn-sm" disabled={busy || selected.status === "disabled"} onClick={() => void act(() => apiSend("POST", `/api/control/deployments/${selected.id}`, { type: "update" }))}><Wrench className="h-4 w-4" />升级</button>
              <button className="btn btn-sm" disabled={busy || selected.status === "disabled"} onClick={() => void act(() => apiSend("POST", `/api/control/deployments/${selected.id}`, { type: "rollback" }))}>回滚任务</button>
              {selected.status === "disabled" ? (
                <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => apiSend("POST", `/api/control/deployments/${selected.id}`, { type: "enable" }))}><CheckCircle2 className="h-4 w-4" />重新启用</button>
              ) : (
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(() => apiSend("POST", `/api/control/deployments/${selected.id}`, { type: "disable" }))}><CloudOff className="h-4 w-4" />停用</button>
              )}
            </div>
            <div className="mt-3 border-t border-[var(--color-edge)] pt-3">
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  const target = selected;
                  setSelected(null);
                  setRemoteFor(target);
                }}
              >
                <Database className="h-4 w-4" />查看客户数据（只读）
              </button>
            </div>
            {selected.metadataJson ? <details className="mt-5"><summary className="cursor-pointer text-sm font-medium">Worker Metadata</summary><pre className="mt-2 overflow-auto rounded-xl bg-base-200 p-3 text-xs">{selected.metadataJson}</pre></details> : null}
        </Modal>
      ) : null}

      {showDeploy ? (
        <Modal
          open
          onClose={() => {
            setShowDeploy(false);
            resetDeployForm();
          }}
          size="lg"
          title={provisionResult ? "客户已创建，部署任务已提交" : "一键新建客户"}
        >
            {provisionResult ? (
              <>
                <div className="space-y-3">
                  <div className="rounded-xl border border-success/30 bg-success/10 p-4">
                    <div className="font-medium">授权已签发 · {provisionResult.license.expiresAt ? "到期 " + formatDateTime(provisionResult.license.expiresAt) : "长期有效"}</div>
                    <div className="mt-2 text-sm opacity-70">授权编号：{provisionResult.license.publicId}</div>
                  </div>
                  <label className="grid gap-1 text-sm">
                    <span className="text-[var(--color-muted)]">授权密钥（只显示这一次）</span>
                    <div className="flex gap-2">
                      <input className="input w-full font-mono" readOnly value={provisionResult.license.licenseKey} />
                      <button className="btn" onClick={() => navigator.clipboard?.writeText(provisionResult.license.licenseKey)}><Copy className="h-4 w-4" />复制</button>
                    </div>
                  </label>
                  <div className="rounded-xl bg-base-200 p-4 text-sm">
                    <div>Worker：<span className="font-medium">{provisionResult.deployment.workerName}</span></div>
                    <div className="mt-1">部署任务：#{provisionResult.task.id} · <TaskBadge status={provisionResult.task.status} /></div>
                    <div className="mt-1 opacity-60">Runner 会自动领取任务并完成 Cloudflare 部署。</div>
                  </div>
                </div>
                <div className="toolbar mt-4 justify-end">
                  <button className="btn" onClick={() => { setShowDeploy(false); resetDeployForm(); void load(); }}>完成</button>
                  <button className="btn btn-primary" onClick={() => { setShowDeploy(false); setSelected(provisionResult.deployment); resetDeployForm(); void load(); }}>查看部署</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--color-muted)]">创建 30 天授权、Customer Worker 和部署任务。Runner 会自动完成实际 Cloudflare 部署。</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm sm:col-span-2"><span>客户名称 *</span><input className="input" placeholder="例如：小明传媒" value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm"><span>管理员 Telegram ID *</span><input className="input" placeholder="123456789" value={adminIds} onChange={(e) => setAdminIds(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm"><span>授权天数 *</span><input className="input" type="number" min={1} max={36500} value={usageDays} onChange={(e) => setUsageDays(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm sm:col-span-2"><span>Telegram Bot Token *</span><input className="input font-mono" type="password" placeholder="123456:ABC..." value={botToken} onChange={(e) => setBotToken(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm"><span>Cloudflare Account ID *</span><input className="input font-mono" placeholder="客户 Cloudflare Account ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm"><span>Worker 名称（可选）</span><input className="input font-mono" placeholder="自动生成" value={workerName} onChange={(e) => setWorkerName(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm sm:col-span-2"><span>Cloudflare API Token *</span><input className="input font-mono" type="password" placeholder="建议使用仅 Workers/D1/KV/Queue 所需权限的 Token" value={apiToken} onChange={(e) => setApiToken(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm sm:col-span-2"><span>客户联系方式（可选）</span><input className="input" placeholder="Telegram / 邮箱 / 备注" value={customerContact} onChange={(e) => setCustomerContact(e.target.value)} /></label>
                </div>
                <div className="mt-4 rounded-xl bg-warning/10 p-3 text-sm">
                  <div className="font-medium">安全提示</div>
                  <div className="mt-1 opacity-70">Bot Token 和 Cloudflare Token 只会进入加密的部署任务；Runner 领取后立即从任务记录删除，不会显示在客户列表。</div>
                </div>
                <div className="toolbar mt-4 justify-end">
                  <button className="btn" disabled={busy} onClick={() => { setShowDeploy(false); resetDeployForm(); }}>取消</button>
                  <button className="btn btn-primary" disabled={busy || !customerName.trim() || !adminIds.trim() || !botToken.trim() || !accountId.trim() || !apiToken.trim()} onClick={() => void (async () => {
                    setBusy(true); setError(null);
                    try {
                      const result = await apiSend<ProvisionCustomerResult>("POST", "/api/control/provision", {
                        customerName: customerName.trim(),
                        adminIds: adminIds.trim(),
                        usageDays: Number(usageDays),
                        customerContact: customerContact.trim() || null,
                        botToken: botToken.trim(),
                        accountId: accountId.trim(),
                        apiToken: apiToken.trim(),
                        workerName: workerName.trim() || null,
                      });
                      setProvisionResult(result);
                      setSelected(result.deployment);
                      await load();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "创建客户失败");
                    } finally {
                      setBusy(false);
                    }
                  })()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}创建并部署
                  </button>
                </div>
              </>
            )}
        </Modal>
      ) : null}

      {showTarget ? (
        <Modal
          open
          onClose={() => {
            setShowTarget(false);
            resetTargetForm();
          }}
          title={editingTarget ? "编辑发布目标" : "添加发布目标"}
        >
            <div className="space-y-3">
              <input className="input w-full" placeholder="目标名称" value={targetName} onChange={(e) => setTargetName(e.target.value)} />
              <input className="input w-full" placeholder="Telegram Chat ID" value={chatId} onChange={(e) => setChatId(e.target.value)} />
              <input className="input w-full" placeholder="Topic Thread ID（可选）" value={threadId} onChange={(e) => setThreadId(e.target.value)} />
              <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" className="checkbox" checked={targetEnabled} onChange={(e) => setTargetEnabled(e.target.checked)} /><span>启用</span></label>
              <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" className="checkbox" checked={targetDefault} onChange={(e) => setTargetDefault(e.target.checked)} /><span>设为默认发布目标</span></label>
            </div>
            <div className="toolbar mt-4 justify-end">
              <button className="btn" onClick={() => { setShowTarget(false); resetTargetForm(); }}>取消</button>
              <button className="btn btn-primary" disabled={busy || !targetName || !chatId} onClick={() => void submitTarget()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}保存</button>
            </div>
        </Modal>
      ) : null}

      {remoteFor ? <RemoteDataViewer deployment={remoteFor} onClose={() => setRemoteFor(null)} /> : null}
    </div>
  );
}
