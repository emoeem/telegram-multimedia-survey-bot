import { useState } from "react";
import { api, apiSend, type CreatorTrialView, type LicenseView, type SoftwareReleaseView } from "../api";
import { useApi } from "../hooks";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

const LICENSE_STATUS_LABELS: Record<string, string> = {
  active: "生效中",
  suspended: "已暂停",
  revoked: "已吊销",
};

const LICENSE_TYPE_LABELS: Record<string, string> = {
  timed: "限时",
  perpetual: "永久",
};

export function LicensesPage() {
  const licenses = useApi<{ items: LicenseView[] }>("/api/admin/licenses");
  const releases = useApi<{ items: SoftwareReleaseView[] }>("/api/admin/releases");
  const trials = useApi<{ items: CreatorTrialView[] }>("/api/admin/trials");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  // 签发授权表单
  const [customerName, setCustomerName] = useState("");
  const [licenseType, setLicenseType] = useState<"timed" | "perpetual">("timed");
  const [usageDays, setUsageDays] = useState("365");
  const [updateDays, setUpdateDays] = useState("365");
  const [maxActivations, setMaxActivations] = useState("1");
  const [notes, setNotes] = useState("");

  // 注册版本表单
  const [releaseVersion, setReleaseVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");

  // 试用管理表单
  const [trialUserId, setTrialUserId] = useState("");
  const [trialDays, setTrialDays] = useState("30");

  const act = async (path: string, body: Record<string, unknown>, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend("PATCH", path, body);
      setMessage({ kind: "ok", text: okText });
      licenses.retry();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "操作失败" });
    } finally {
      setBusy(false);
    }
  };

  const createLicense = async () => {
    setBusy(true);
    setMessage(null);
    setCreatedKey(null);
    try {
      const result = await apiSend<{ licenseKey: string }>("POST", "/api/admin/licenses", {
        customerName,
        licenseType,
        usageDays: licenseType === "timed" ? Number(usageDays) : undefined,
        updateDays: licenseType === "perpetual" ? Number(updateDays) : undefined,
        maxActivations: Number(maxActivations),
        notes,
      });
      setCreatedKey(result.licenseKey);
      setMessage({ kind: "ok", text: "授权已签发，请复制密钥并交给客户" });
      setCustomerName("");
      licenses.retry();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "签发失败" });
    } finally {
      setBusy(false);
    }
  };

  const registerRelease = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend("POST", "/api/admin/releases", {
        version: releaseVersion.trim(),
        notes: releaseNotes.trim(),
      });
      setMessage({ kind: "ok", text: "版本已注册到授权中心" });
      setReleaseVersion("");
      setReleaseNotes("");
      releases.retry();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "注册失败" });
    } finally {
      setBusy(false);
    }
  };

  const grantTrial = async () => {
    const userId = Number(trialUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      setMessage({ kind: "error", text: "请输入有效的用户 ID" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiSend("POST", `/api/admin/users/${userId}/trial`, { days: Number(trialDays) });
      setMessage({ kind: "ok", text: "试用权限已开通" });
      trials.retry();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "开通失败" });
    } finally {
      setBusy(false);
    }
  };

  const revokeTrial = async (userId: number) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend("DELETE", `/api/admin/users/${userId}/trial`, {});
      setMessage({ kind: "ok", text: "试用权限已回收" });
      trials.retry();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "回收失败" });
    } finally {
      setBusy(false);
    }
  };

  if (licenses.error) return <ErrorPanel error={licenses.error} onRetry={licenses.retry} />;
  if (!licenses.data) return <SkeletonPanel lines={8} />;

  return (
    <div className="space-y-5">
      {message ? (
        <div className={`alert ${message.kind === "ok" ? "alert-success" : "alert-error"}`}>{message.text}</div>
      ) : null}

      <section className="card">
        <div className="card-title">
          <h2>授权列表</h2>
          <button className="btn btn-sm" disabled={busy} onClick={licenses.retry}>
            刷新
          </button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>客户</th>
                <th>类型</th>
                <th>状态</th>
                <th>到期</th>
                <th>升级有效期</th>
                <th>激活</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {licenses.data.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-[var(--color-muted-soft)]">
                    暂无授权
                  </td>
                </tr>
              ) : null}
              {licenses.data.items.map((license) => (
                <LicenseRow key={license.publicId} license={license} busy={busy} onAction={act} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">签发授权</h2>
        <div className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">客户名称</span>
            <input className="input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">授权类型</span>
            <select
              className="select"
              value={licenseType}
              onChange={(event) => setLicenseType(event.target.value as "timed" | "perpetual")}
            >
              <option value="timed">限时（到期自动锁定）</option>
              <option value="perpetual">永久（只算升级有效期）</option>
            </select>
          </label>
          {licenseType === "timed" ? (
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">使用天数</span>
              <input
                className="input"
                type="number"
                min={1}
                value={usageDays}
                onChange={(event) => setUsageDays(event.target.value)}
              />
            </label>
          ) : (
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">升级有效期（天，留空=永久更新）</span>
              <input
                className="input"
                type="number"
                min={1}
                value={updateDays}
                onChange={(event) => setUpdateDays(event.target.value)}
              />
            </label>
          )}
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">激活数上限</span>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={maxActivations}
              onChange={(event) => setMaxActivations(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            <span className="text-[var(--color-muted)]">备注</span>
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
        <button className="btn btn-primary mt-4" disabled={busy} onClick={() => void createLicense()}>
          {busy ? "处理中…" : "签发授权"}
        </button>
        {createdKey ? (
          <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--color-success)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] p-3 text-sm">
            <p className="font-medium text-[var(--color-success)]">授权密钥（仅显示一次，请立即复制）：</p>
            <code className="code mt-1 block break-all">{createdKey}</code>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-title">
          <h2>版本管理（发布新版本后在此注册）</h2>
        </div>
        <div className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">版本号（x.y.z）</span>
            <input
              className="input"
              value={releaseVersion}
              onChange={(event) => setReleaseVersion(event.target.value)}
              placeholder="0.4.0"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">更新说明</span>
            <input className="input" value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} />
          </label>
        </div>
        <button className="btn mt-3" disabled={busy} onClick={() => void registerRelease()}>
          注册版本
        </button>
        <div className="mt-4 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>版本</th>
                <th>渠道</th>
                <th>发布时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {(releases.data?.items ?? []).map((release) => (
                <tr key={release.version}>
                  <td className="font-mono text-sm">{release.version}</td>
                  <td>{release.channel}</td>
                  <td>{formatDateTime(release.releasedAt)}</td>
                  <td className="text-[var(--color-muted)]">{release.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <h2>体验创作者试用</h2>
          <button className="btn btn-sm" disabled={busy} onClick={trials.retry}>
            刷新
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">用户 ID（问卷后台/用户目录可查）</span>
            <input
              className="input w-full sm:w-40"
              value={trialUserId}
              onChange={(event) => setTrialUserId(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--color-muted)]">试用天数</span>
            <input
              className="input w-full sm:w-24"
              type="number"
              min={1}
              value={trialDays}
              onChange={(event) => setTrialDays(event.target.value)}
            />
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void grantTrial()}>
            开通试用
          </button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>用户</th>
                <th>Telegram ID</th>
                <th>到期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(trials.data?.items ?? []).map((trial) => (
                <tr key={trial.userId}>
                  <td>
                    {[trial.firstName, trial.lastName].filter(Boolean).join(" ") ||
                      (trial.username ? `@${trial.username}` : `用户 ${trial.userId}`)}
                  </td>
                  <td>{trial.telegramUserId}</td>
                  <td>{formatDateTime(trial.expiresAt)}</td>
                  <td>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void revokeTrial(trial.userId)}
                    >
                      回收
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function LicenseRow({
  license,
  busy,
  onAction,
}: {
  license: LicenseView;
  busy: boolean;
  onAction: (path: string, body: Record<string, unknown>, okText: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = license.customerName ?? license.publicId.slice(0, 8);
  return (
    <>
      <tr className="align-top">
        <td>
          <div className="font-medium">{name}</div>
          {license.customerContact ? (
            <div className="text-xs text-[var(--color-muted-soft)]">{license.customerContact}</div>
          ) : null}
          <div className="mt-0.5 font-mono text-xs text-[var(--color-muted-soft)]">{license.publicId}</div>
        </td>
        <td>{LICENSE_TYPE_LABELS[license.licenseType] ?? license.licenseType}</td>
        <td>
          <span
            className={`badge ${license.status === "active" ? "badge-green" : license.status === "suspended" ? "badge-amber" : "badge-red"}`}
          >
            {LICENSE_STATUS_LABELS[license.status] ?? license.status}
          </span>
        </td>
        <td>{license.expiresAt ? formatDateTime(license.expiresAt) : "永久"}</td>
        <td>{license.updatesUntil ? formatDateTime(license.updatesUntil) : "永久"}</td>
        <td>
          {license.activationCount} / {license.maxActivations}
          <button
            className="ml-2 text-xs text-[var(--color-primary)] hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "详情"}
          </button>
        </td>
        <td>
          <div className="flex flex-wrap gap-1.5">
            {license.status === "active" ? (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void onAction(`/api/admin/licenses/${license.publicId}`, { status: "suspended" }, "已暂停")
                }
              >
                暂停
              </button>
            ) : license.status === "suspended" ? (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void onAction(`/api/admin/licenses/${license.publicId}`, { status: "active" }, "已恢复")}
              >
                恢复
              </button>
            ) : null}
            {license.status !== "revoked" ? (
              <button
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() =>
                  void onAction(`/api/admin/licenses/${license.publicId}`, { status: "revoked" }, "已吊销")
                }
              >
                吊销
              </button>
            ) : null}
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void onAction(
                  `/api/admin/licenses/${license.publicId}`,
                  { extendUsageDays: 30, extendUpdateDays: 30 },
                  "已延期 30 天",
                )
              }
            >
              延期30天
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7} className="bg-[var(--surface-muted)]">
            <div className="grid gap-1 text-xs text-[var(--color-muted)] sm:grid-cols-2">
              <div>签发时间：{formatDateTime(license.createdAt)}</div>
              <div>开始时间：{formatDateTime(license.startsAt)}</div>
              {license.notes ? <div className="sm:col-span-2">备注：{license.notes}</div> : null}
              {license.activations.length ? (
                <div className="sm:col-span-2">
                  <div className="mb-1 font-medium text-[var(--text-soft)]">激活记录：</div>
                  {license.activations.map((activation) => (
                    <div key={activation.installationId} className="flex flex-wrap gap-x-3">
                      <span className="font-mono">{activation.installationId}</span>
                      <span>版本 {activation.appVersion ?? "—"}</span>
                      <span>最近 {formatDateTime(activation.lastSeenAt)}</span>
                      {activation.deactivatedAt ? (
                        <span className="text-[var(--color-muted-soft)]">
                          已解绑 {formatDateTime(activation.deactivatedAt)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
