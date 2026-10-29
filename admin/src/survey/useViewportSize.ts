import { useEffect, useState } from "react";
import type { ViewportSize } from "../../../src/survey/layout";

/**
 * 视口尺寸（布局裁决的输入）。
 *
 * 为什么用 `innerWidth/innerHeight` 而不是 `matchMedia`：裁决函数要的是具体尺寸
 * （宽度阈值 + 矮横屏判定），一次性拿到宽高比组合若干媒体查询更直接，也便于单测。
 * 监听 `resize` 与 `orientationchange`：iOS 上旋转时 resize 可能晚一步触发。
 */
export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() =>
    typeof window === "undefined"
      ? { width: 1440, height: 900 }
      : { width: window.innerWidth, height: window.innerHeight },
  );

  useEffect(() => {
    const sync = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);

  return size;
}
