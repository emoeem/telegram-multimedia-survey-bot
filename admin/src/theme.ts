/** Admin UI theme switching backed by the DaisyUI themes already imported
 *  in index.css (no extra library needed).
 *
 *  "system" is resolved to the concrete "light"/"dark" DaisyUI theme via
 *  matchMedia instead of relying on a CSS media query, so the whole palette
 *  (not just a hard-coded subset) follows the OS setting. An inline boot
 *  snippet in index.html applies the same resolution before first paint to
 *  avoid a light flash for dark-OS users. */
export const THEME_OPTIONS = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "明亮" },
  { id: "dark", name: "暗色" },
  { id: "night", name: "深蓝夜" },
  { id: "luxury", name: "黑金奢华" },
  { id: "retro", name: "复古纸张" },
  { id: "cupcake", name: "粉彩" },
  { id: "synthwave", name: "霓虹" },
  { id: "black", name: "纯黑" },
] as const;

export type AdminThemeId = (typeof THEME_OPTIONS)[number]["id"];
type ConcreteThemeId = Exclude<AdminThemeId, "system">;

const STORAGE_KEY = "admin_theme";

const darkSchemeQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function resolveTheme(theme: AdminThemeId): ConcreteThemeId {
  if (theme !== "system") return theme;
  return darkSchemeQuery?.matches ? "dark" : "light";
}

export function getStoredTheme(): AdminThemeId {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEME_OPTIONS.some((option) => option.id === value)
      ? (value as AdminThemeId)
      : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: AdminThemeId): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(theme));
  try {
    if (theme === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    /* storage unavailable — the attribute is still applied */
  }
}

// Keep the applied theme in sync while the user switches the OS scheme.
darkSchemeQuery?.addEventListener?.("change", () => {
  if (getStoredTheme() === "system") {
    applyTheme("system");
  }
});
