import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Monitor, X } from "lucide-react";
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

export const SYSTEM_PRESET_ID = "system";

/** Presets that are light-themed — used to pick the right fallback
 *  when the OS is in light vs. dark mode and `system` is active. */
const LIGHT_PRESETS = new Set(["light", "retro", "cupcake"]);

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve the "system" pseudo-preset to an actual DaisyUI preset id. */
export function resolvePresetId(presetId: string | null | undefined): string | null {
  if (!presetId) return null;
  if (presetId === SYSTEM_PRESET_ID) {
    return systemPrefersDark() ? "dark" : "light";
  }
  return SURVEY_THEME_PRESETS.some((p) => p.id === presetId) ? presetId : null;
}

/** Like resolvePresetId but also re-renders when OS theme changes. */
export function useResolvedPreset(presetId: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => resolvePresetId(presetId));

  useEffect(() => {
    const resolvedNow = resolvePresetId(presetId);
    setResolved(resolvedNow);
    if (resolvedNow) {
      try {
        document.documentElement.setAttribute("data-theme", resolvedNow);
      } catch {
        // SSR guard
      }
    }
    if (presetId !== SYSTEM_PRESET_ID) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolved(systemPrefersDark() ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [presetId]);

  return resolved;
}

export const GLOBAL_THEME_KEY = "surveyPreset";
export const isValidPresetId = (id: string): boolean =>
  id === SYSTEM_PRESET_ID || SURVEY_THEME_PRESETS.some((p) => p.id === id);

export function loadGlobalPreset(): string | null {
  try {
    const stored = localStorage.getItem(GLOBAL_THEME_KEY);
    return stored && isValidPresetId(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveGlobalPreset(id: string | null): void {
  try {
    if (id && isValidPresetId(id)) localStorage.setItem(GLOBAL_THEME_KEY, id);
    else localStorage.removeItem(GLOBAL_THEME_KEY);
  } catch {
    // storage unavailable — session-only choice still applies
  }
}

export { LIGHT_PRESETS };

export function PresetSwatch({ presetId, size = "sm" }: { presetId: string; size?: "sm" | "md" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ base: string; primary: string; content: string } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setColors({
      base: style.getPropertyValue("--color-base-100").trim() || "#ffffff",
      primary: style.getPropertyValue("--color-primary").trim() || "#4f46e5",
      content: style.getPropertyValue("--color-base-content").trim() || "#111827",
    });
  }, [presetId]);

  const hClass = size === "md" ? "h-10" : "h-8";

  return (
    <div
      ref={ref}
      data-theme={presetId}
      className={`${hClass} w-full overflow-hidden rounded-lg border border-black/10`}
      style={colors ? { backgroundColor: colors.base } : undefined}
    >
      {colors ? (
        <span className={`flex h-full items-center gap-1.5 px-2 ${size === "md" ? "h-10" : "h-8"}`} style={{ color: colors.content }}>
          <span
            className={`h-4 w-4 shrink-0 rounded-full ${size === "sm" ? "h-3 w-3" : ""}`}
            style={{ backgroundColor: colors.primary }}
          />
          <span className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: colors.content, opacity: 0.45 }} />
        </span>
      ) : null}
    </div>
  );
}

const DARK_PRESETS = new Set(["dark", "night", "luxury", "synthwave", "black"]);

export function themeCssVars(theme: SurveyThemeDto | null): Record<string, string> {
  if (!theme) return {};
  const vars: Record<string, string> = {};
  if (theme.preset) {
    // The survey SPA applies data-theme on an inner div (not <html>), so the
    // html[data-theme] block in index.css never fires. Mirror those semantic
    // token mappings here so that --color-ink, --surface, etc. resolve to the
    // preset's palette instead of the :root light defaults.
    vars["--color-page"] = "var(--color-base-200)";
    vars["--color-ink"] = "var(--color-base-content)";
    vars["--color-primary-soft"] = "color-mix(in srgb, var(--color-primary) 10%, var(--color-base-100))";
    vars["--color-edge"] = "color-mix(in srgb, var(--color-base-content) 13%, var(--color-base-100))";
    vars["--color-edge-soft"] = "color-mix(in srgb, var(--color-base-content) 7%, var(--color-base-100))";
    vars["--color-muted"] = "color-mix(in srgb, var(--color-base-content) 60%, var(--color-base-100))";
    vars["--color-muted-soft"] = "color-mix(in srgb, var(--color-base-content) 45%, var(--color-base-100))";
    vars["--surface"] = "var(--color-base-100)";
    vars["--surface-hover"] = "color-mix(in srgb, var(--color-base-content) 4%, var(--color-base-100))";
    vars["--surface-muted"] = "color-mix(in srgb, var(--color-base-content) 6%, var(--color-base-100))";
    vars["--surface-2"] = "color-mix(in srgb, var(--color-base-content) 3%, var(--color-base-100))";
    vars["--surface-input-disabled"] = "color-mix(in srgb, var(--color-base-content) 3%, var(--color-base-100))";
    vars["--table-hover"] = "color-mix(in srgb, var(--color-base-content) 4%, var(--color-base-100))";
    vars["--text-soft"] = "color-mix(in srgb, var(--color-base-content) 78%, var(--color-base-100))";
    vars["--control-border"] = "color-mix(in srgb, var(--color-base-content) 22%, var(--color-base-100))";
    vars["--skeleton-a"] = "color-mix(in srgb, var(--color-base-content) 9%, var(--color-base-100))";
    vars["--skeleton-b"] = "color-mix(in srgb, var(--color-base-content) 3%, var(--color-base-100))";
    vars["--surface-input"] = DARK_PRESETS.has(theme.preset)
      ? "color-mix(in srgb, var(--color-base-200) 55%, var(--color-base-100))"
      : "var(--color-base-100)";

    // Map the DaisyUI theme library tokens onto the survey surface.
    vars["--survey-primary"] = "var(--color-primary)";
    vars["--survey-primary-content"] = "var(--color-primary-content)";
    vars["--survey-secondary"] = "var(--color-secondary)";
    vars["--survey-bg"] = "var(--color-base-200)";
    vars["--survey-card-bg"] = "var(--color-base-100)";
    vars["--survey-card-border"] = "color-mix(in srgb, var(--color-base-content) 14%, var(--color-base-100))";
    vars["--survey-heading"] = "var(--color-base-content)";
    vars["--survey-body"] = "color-mix(in srgb, var(--color-base-content) 85%, var(--color-base-100))";
    vars["--survey-muted"] = "color-mix(in srgb, var(--color-base-content) 60%, var(--color-base-100))";
    vars["--survey-primary-soft"] = "color-mix(in srgb, var(--color-primary) 10%, var(--color-base-100))";
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
    return {};
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
  const isSystem = selected === SYSTEM_PRESET_ID;
  const resolvedSystem = resolvePresetId(SYSTEM_PRESET_ID);
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
          <button
            type="button"
            className={`rounded-lg border p-1.5 text-left ${
              isSystem ? "border-[var(--survey-primary)]" : "border-[var(--survey-card-border)]"
            }`}
            onClick={() => onSelect(SYSTEM_PRESET_ID)}
          >
            {resolvedSystem ? (
              <PresetSwatch presetId={resolvedSystem} />
            ) : (
              <div className="flex h-8 w-full items-center justify-center rounded-lg border border-dashed border-[var(--survey-card-border)] text-[var(--survey-muted)]">
                <Monitor className="h-4 w-4" />
              </div>
            )}
            <span className="mt-1 block text-[11px] text-[var(--survey-body)]">跟随系统</span>
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
