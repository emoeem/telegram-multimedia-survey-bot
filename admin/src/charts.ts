import { useEffect, useState } from "react";

export * from "./chart-options";

function readChartColors() {
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
}

/** Reads the admin theme palette so charts follow the active theme. */
export function useChartColors() {
  // Re-read the CSS palette whenever the theme is switched. The previous
  // `useMemo([], ...)` captured the variables once, so a chart page left open
  // across an OS-scheme or manual theme change kept the stale colors.
  // 旧实现把 theme state 塞进 useMemo 依赖当「重算信号」——theme 不参与
  // 计算，exhaustive-deps 判为 unnecessary。现在直接以色板对象为 state：
  // observer 触发时重新读取 CSS 变量，语义不变，依赖关系也不用造假。
  const [colors, setColors] = useState(readChartColors);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setColors(readChartColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}
