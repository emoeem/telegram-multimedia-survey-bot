/** Admin UI theme switching backed by the DaisyUI themes already imported
 *  in index.css (no extra library needed). */
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

const STORAGE_KEY = "admin_theme";

export function getStoredTheme(): AdminThemeId {
  const value = localStorage.getItem(STORAGE_KEY);
  return THEME_OPTIONS.some((option) => option.id === value)
    ? (value as AdminThemeId)
    : "system";
}

export function applyTheme(theme: AdminThemeId): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    localStorage.removeItem(STORAGE_KEY);
  } else {
    root.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }
}
