import { useEffect, useRef, useState } from "react";
import { apiSend, type SystemSettingsData } from "../api";
import { useApi } from "../hooks";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import { applyTheme, getStoredTheme, THEME_OPTIONS, type AdminThemeId } from "../theme";

function ThemeSwatch({
  themeId,
  name,
  selected,
  onSelect,
}: {
  themeId: AdminThemeId;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ base: string; primary: string } | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const style = getComputedStyle(element);
    setColors({
      base: style.getPropertyValue("--color-base-100").trim() || "#ffffff",
      primary: style.getPropertyValue("--color-primary").trim() || "#4f46e5",
    });
  }, [themeId]);

  return (
    <button
      type="button"
      data-theme={themeId === "system" ? "light" : themeId}
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-36 flex-col gap-1.5 rounded-xl border p-2 text-left transition ${
        selected
          ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/25"
          : "border-[var(--color-edge)] hover:border-[var(--color-primary)]/50"
      }`}
    >
      <div
        ref={ref}
        className="h-12 w-full overflow-hidden rounded-lg border border-black/10"
        style={colors ? { backgroundColor: colors.base } : undefined}
      >
        {colors ? (
          <span className="block h-full w-1/3" style={{ backgroundColor: colors.primary }} />
        ) : null}
      </div>
      <span className="truncate text-xs font-medium text-[var(--color-muted)]">
        {selected ? "✓ " : ""}{name}
      </span>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-[var(--color-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-xs text-[var(--color-muted-soft)]">{hint}</span> : null}
    </label>
  );
}

export function SettingsPage() {
  const { data, error, retry } = useApi<{ settings: SystemSettingsData }>("/api/admin/settings");
  const [theme, setTheme] = useState<AdminThemeId>(getStoredTheme());
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
        report_watermark: settings.reportWatermark,
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
    <Field key={key} label={label} hint={hint}>
      <input
        className="input w-full"
        type="number"
        min={1}
        step={step}
        value={settings[key]}
        onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<SystemSettingsData>)}
      />
    </Field>
  );

  return (
    <div className="space-y-5">
      <section className="card">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">界面外观</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">主题即时生效，仅影响当前浏览器。</p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {THEME_OPTIONS.map((option) => (
            <ThemeSwatch
              key={option.id}
              themeId={option.id}
              name={option.name}
              selected={theme === option.id}
              onSelect={() => {
                setTheme(option.id);
                applyTheme(option.id);
              }}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">系统设置</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            敏感凭据（Bot Token 等）不在此展示，请通过 Cloudflare Secrets 管理。
          </p>
        </div>

        <div className="mt-5 grid max-w-3xl gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label="报告归档频道 ID" hint="优先级：环境变量 → KV 缓存 → 此处设置">
            <input
              className="input w-full"
              value={settings.reportChannelId}
              onChange={(event) => update({ reportChannelId: event.target.value })}
              placeholder="-100xxxxxxxxxx"
            />
          </Field>

          <Field label="默认报告模板" hint="问卷未指定模板时使用">
            <select
              className="select w-full"
              value={settings.defaultReportTemplate}
              onChange={(event) => update({ defaultReportTemplate: event.target.value })}
            >
              <option value="classic">经典报告</option>
              <option value="magazine-dark">杂志暗色</option>
            </select>
          </Field>

          <Field label="报告结尾水印" hint="显示在每份报告（网页 / PDF / 频道归档）的结尾">
            <input
              className="input w-full"
              value={settings.reportWatermark}
              onChange={(event) => update({ reportWatermark: event.target.value })}
              placeholder="更多问卷 @hnhgggfj_bot"
            />
          </Field>

          {numberField("mediaTtlSeconds", "临时媒体保留时间（秒）", "默认 604800（7 天）")}
          {numberField("maxUploadMb", "单张图片上限（MB）", "默认 10")}
          {numberField("maxResponseMediaMb", "单份答卷图片总量（MB）", "默认 50")}
          {numberField("pdfMaxMb", "PDF 体积目标（MB）", "默认 15，非硬性限制", 0.5)}
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-[var(--color-edge-soft)] pt-5">
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存设置"}
          </button>
          {saved ? <span className="text-sm text-[var(--color-success)]">已保存</span> : null}
          {saveError ? <span className="text-sm text-[var(--color-danger)]">{saveError}</span> : null}
        </div>
      </section>
    </div>
  );
}
