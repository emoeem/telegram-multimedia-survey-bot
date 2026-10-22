import { useEffect, useMemo, useState } from "react";

export * from "./chart-options";

/** Reads the admin theme palette so charts follow the active theme. */
export function useChartColors() {
  // Re-read the CSS palette whenever the theme is switched. The previous
  // `useMemo([], ...)` captured the variables once, so a chart page left open
  // across an OS-scheme or manual theme change kept the stale colors.
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") ?? "");
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute("data-theme") ?? "");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim() || "";
    return {
      primary: read("--color-primary") || "#4f46e5",
      text: read("--color-ink") || "#0f172a",
      muted: read("--color-muted") || "#64748b",
      border: read("--color-edge") || "#e5e9f0",
      success: "#16a34a",
      info: "#0284c7",
      warning: "#d97706",
      danger: "#dc2626",
    };
  }, [theme]);
}
