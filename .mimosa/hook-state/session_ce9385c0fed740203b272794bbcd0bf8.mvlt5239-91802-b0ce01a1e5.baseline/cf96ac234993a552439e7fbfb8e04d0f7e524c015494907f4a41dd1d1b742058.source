/** Admin UI theme switching backed by the same presets as the public site
 *  (see survey/theme-ui.tsx): 暗金（默认）/ 暗色 / 明亮. The foxgold palette
 *  lives in index.css as the `[data-theme="foxgold"]` block.
 *
 *  An inline boot snippet in index.html applies the stored theme before first
 *  paint; applyTheme re-applies the same id on boot. Legacy stored ids
 *  ("system" + the retired DaisyUI presets) resolve through the same mapping
 *  so nobody flashes the wrong palette after the 2026-10 redesign. */

export const THEME_OPTIONS = [
  { id: "foxgold", name: "暗金" },
  { id: "dark", name: "暗色" },
  { id: "light", name: "明亮" },
] as const;

export type AdminThemeId = (typeof THEME_OPTIONS)[number]["id"];
type ConcreteThemeId = AdminThemeId;

const STORAGE_KEY = "admin_theme";

/** Retired ids → nearest surviving theme. Keep in sync with
 *  survey/theme-ui.tsx LEGACY_PRESET_MAP. */
const LEGACY_THEME_MAP: Record<string, ConcreteThemeId> = {
  system: "foxgold",
  night: "dark",
  luxury: "foxgold",
  synthwave: "dark",
  black: "foxgold",
  retro: "light",
  cupcake: "light",
};

function normalizeTheme(value: string | null): ConcreteThemeId {
  if (!value) return "foxgold";
  if (LEGACY_THEME_MAP[value]) return LEGACY_THEME_MAP[value];
  return THEME_OPTIONS.some((option) => option.id === value) ? (value as ConcreteThemeId) : "foxgold";
}

export function getStoredTheme(): AdminThemeId {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "foxgold";
  }
}

export function applyTheme(theme: AdminThemeId): void {
  const root = document.documentElement;
  const concrete = normalizeTheme(theme);
  root.setAttribute("data-theme", concrete);
  try {
    localStorage.setItem(STORAGE_KEY, concrete);
  } catch {
    /* storage unavailable — the attribute is still applied */
  }
}
