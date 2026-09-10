import { useEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { SurveyThemeDto } from "./api";

/** DaisyUI presets shared by the survey fill page and the plaza page. */
export const SURVEY_THEME_PRESETS = [
  { id: "light", name: "明亮" },
  { id: "dark", name: "暗色" },
  { id: "night", name: "深蓝夜" },
  { id: "luxury", name: "黑金奢华" },
  { id: "retro", name: "复古纸张" },
  { id: "cupcake", name: "粉彩" },
  { id: "synthwave", name: "霓虹" },
  { id: "black", name: "纯黑" },
];

export function PresetSwatch({ presetId }: { presetId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ base: string; primary: string } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setColors({
      base: style.getPropertyValue("--color-base-100").trim() || "#ffffff",
      primary: style.getPropertyValue("--color-primary").trim() || "#4f46e5",
    });
  }, [presetId]);

  return (
    <div
      ref={ref}
      data-theme={presetId}
      className="h-8 w-full overflow-hidden rounded-lg border border-black/10"
      style={colors ? { backgroundColor: colors.base } : undefined}
    >
      {colors ? <span className="block h-full w-1/3" style={{ backgroundColor: colors.primary }} /> : null}
    </div>
  );
}

export function themeCssVars(theme: SurveyThemeDto | null): Record<string, string> {
  if (!theme) return {};
  const vars: Record<string, string> = {};
  if (theme.preset) {
    // Map the DaisyUI theme library tokens onto the survey surface.
    vars["--survey-primary"] = "var(--color-primary)";
    vars["--survey-primary-content"] = "var(--color-primary-content)";
    vars["--survey-secondary"] = "var(--color-secondary)";
    vars["--survey-bg"] = "var(--color-base-100)";
    vars["--survey-card-bg"] = "var(--color-base-100)";
    vars["--survey-card-border"] = "var(--color-base-200)";
    vars["--survey-heading"] = "var(--color-base-content)";
    vars["--survey-body"] = "var(--color-base-content)";
    vars["--survey-muted"] = "color-mix(in oklab, var(--color-base-content) 65%, transparent)";
    vars["--survey-primary-soft"] = "color-mix(in srgb, var(--color-primary) 10%, var(--color-base-100))";
    // Follow the preset surface; the :root default is a white glass strip
    // that glares on dark presets (black/night/luxury).
    vars["--survey-header-bg"] = "color-mix(in srgb, var(--color-base-100) 82%, transparent)";
    vars["--survey-radius"] = "var(--radius-box)";
    vars["--survey-button-radius"] = "var(--radius-field)";
  }
  if (theme.primaryColor) {
    vars["--survey-primary"] = theme.primaryColor;
    vars["--survey-primary-soft"] = `color-mix(in srgb, ${theme.primaryColor} 10%, var(--survey-card-bg, #ffffff))`;
  }
  if (theme.secondaryColor) vars["--survey-secondary"] = theme.secondaryColor;
  if (theme.card?.background) vars["--survey-card-bg"] = theme.card.background;
  if (theme.card?.border) vars["--survey-card-border"] = theme.card.border;
  if (theme.card?.radius !== undefined) vars["--survey-radius"] = `${theme.card.radius}px`;
  if (theme.card?.glass) {
    vars["--survey-header-bg"] = "color-mix(in srgb, var(--survey-card-bg, #ffffff) 72%, transparent)";
  }
  if (theme.text?.heading) vars["--survey-heading"] = theme.text.heading;
  if (theme.text?.body) vars["--survey-body"] = theme.text.body;
  if (theme.text?.muted) vars["--survey-muted"] = theme.text.muted;
  if (theme.button?.radius !== undefined) {
    vars["--survey-button-radius"] = `${theme.button.radius}px`;
  }
  return vars;
}

export function themeBackgroundStyle(theme: SurveyThemeDto | null): CSSProperties {
  const background = theme?.background;
  if (!background?.color && !background?.image) {
    return theme?.preset ? { backgroundColor: "var(--color-base-100)" } : {};
  }
  return {
    backgroundColor: background?.color,
    backgroundImage: background?.image ? `url("${background.image}")` : undefined,
    backgroundPosition: background?.position ?? "center",
    backgroundSize: background?.size ?? "cover",
    backgroundAttachment: "fixed",
  };
}

/** Bottom-sheet theme picker shared by the survey and plaza pages. */
export function ThemePickerSheet({
  open,
  onClose,
  selected,
  onSelect,
  defaultLabel = "默认",
}: {
  open: boolean;
  onClose: () => void;
  /** Currently chosen preset id, or null for the default look. */
  selected: string | null;
  onSelect: (presetId: string | null) => void;
  defaultLabel?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30">
      <button aria-label="关闭主题选择" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-[0_-12px_40px_-16px_rgba(15,23,42,.3)]">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold text-[var(--survey-heading)]">选择主题</span>
          <button type="button" className="survey-icon-btn h-8 w-8" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2.5">
          <button
            type="button"
            className={`rounded-lg border p-1.5 text-left ${
              selected === null ? "border-[var(--survey-primary)]" : "border-[var(--survey-card-border)]"
            }`}
            onClick={() => onSelect(null)}
          >
            <div className="h-8 w-full rounded-lg bg-[var(--surface-muted)]" />
            <span className="mt-1 block text-[11px] text-[var(--survey-muted)]">{defaultLabel}</span>
          </button>
          {SURVEY_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`rounded-lg border p-1.5 text-left ${
                selected === preset.id ? "border-[var(--survey-primary)]" : "border-[var(--survey-card-border)]"
              }`}
              onClick={() => onSelect(preset.id)}
            >
              <PresetSwatch presetId={preset.id} />
              <span className="mt-1 block text-[11px] text-[var(--survey-body)]">{preset.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
