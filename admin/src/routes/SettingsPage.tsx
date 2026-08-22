import { useState } from "react";
import { api, apiSend, type SystemSettingsData } from "../api";
import { useApi } from "../hooks";
import { ErrorPanel, SkeletonPanel } from "../components/ui";

export function SettingsPage() {
  const { data, error, retry } = useApi<{ settings: SystemSettingsData }>("/api/admin/settings");
  const [form, setForm] = useState<SystemSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;
  const settings = form ?? data.settings;

  const update = (patch: Partial<SystemSettingsData>) => {
    setForm((current) => ({ ...(current ?? data.settings), ...patch }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await apiSend("PUT", "/api/admin/settings", {
        report_channel_id: settings.reportChannelId,
        default_report_template: settings.defaultReportTemplate,
        media_ttl_seconds: settings.mediaTtlSeconds,
        max_upload_mb: settings.maxUploadMb,
        max_response_media_mb: settings.maxResponseMediaMb,
        pdf_max_mb: settings.pdfMaxMb,
      });
      setSaved(true);
      setForm(null);
      retry();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const numberField = (
    key: keyof SystemSettingsData,
    label: string,
    hint: string,
    step = 1,
  ) => (
    <label className="grid gap-1 text-sm">
      <span className="text-gray-500">{label}</span>
      <input
        className="input"
        type="number"
        min={1}
        step={step}
        value={settings[key]}
        onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<SystemSettingsData>)}
      />
      <span className="text-xs text-gray-400">{hint}</span>
    </label>
  );

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-lg font-semibold">系统设置</h2>
      <p className="mt-1 text-sm text-gray-500">敏感凭据（Bot Token 等）不在此展示，请通过 Cloudflare Secrets 管理。</p>

      <div className="mt-5 grid max-w-2xl gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-gray-500">报告归档频道 ID</span>
          <input
            className="input"
            value={settings.reportChannelId}
            onChange={(event) => update({ reportChannelId: event.target.value })}
            placeholder="-100xxxxxxxxxx"
          />
          <span className="text-xs text-gray-400">优先级：环境变量 → KV 缓存 → 此处设置</span>
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-gray-500">默认报告模板</span>
          <select
            className="input"
            value={settings.defaultReportTemplate}
            onChange={(event) => update({ defaultReportTemplate: event.target.value })}
          >
            <option value="classic">经典报告</option>
            <option value="magazine-dark">杂志暗色</option>
          </select>
          <span className="text-xs text-gray-400">问卷未指定模板时使用</span>
        </label>

        {numberField("mediaTtlSeconds", "临时媒体保留时间（秒）", "默认 604800（7 天）")}
        {numberField("maxUploadMb", "单张图片上限（MB）", "默认 10")}
        {numberField("maxResponseMediaMb", "单份答卷图片总量（MB）", "默认 50")}
        {numberField("pdfMaxMb", "PDF 体积目标（MB）", "默认 15，非硬性限制", 0.5)}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button className="btn bg-indigo-600 text-white" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存设置"}
        </button>
        {saved ? <span className="text-sm text-green-600">已保存</span> : null}
        {saveError ? <span className="text-sm text-red-600">{saveError}</span> : null}
      </div>
    </section>
  );
}
