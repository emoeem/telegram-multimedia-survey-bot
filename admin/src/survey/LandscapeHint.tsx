import { useEffect, useState } from "react";
import { Maximize2, RotateCw, X } from "lucide-react";

/**
 * 「横屏优先」模式下的竖屏提示条（display=landscape 且手机竖屏时出现）。
 *
 * 浏览器不允许网页强制旋转（`screen.orientation.lock` 只在全屏态、且 iOS
 * 不支持），所以这里只做两件事：提示用户横过来、提供一个「全屏横屏」按钮
 * 尽力而为（全屏成功后再尝试锁方向，失败静默——不影响答题）。
 *
 * 可关闭：关掉后本次会话（sessionStorage，按问卷隔离）不再打扰；竖屏下
 * 布局本身仍然可用，只是场景图不会铺满高度。
 */
const PORTRAIT_PHONE_QUERY = "(orientation: portrait) and (max-width: 900px)";

function dismissedKey(surveyId: number): string {
  return `survey-landscape-hint-dismissed:${surveyId}`;
}

export function LandscapeHint({ surveyId }: { surveyId: number }) {
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    if (sessionStorage.getItem(dismissedKey(surveyId)) === "1") return false;
    return window.matchMedia(PORTRAIT_PHONE_QUERY).matches;
  });

  useEffect(() => {
    const query = window.matchMedia?.(PORTRAIT_PHONE_QUERY);
    if (!query) return undefined;
    const onChange = () => {
      // 转成横屏后提示自然消失；转回竖屏时尊重「已关闭」的选择。
      setVisible(query.matches && sessionStorage.getItem(dismissedKey(surveyId)) !== "1");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [surveyId]);

  if (!visible) return null;

  const dismiss = () => {
    sessionStorage.setItem(dismissedKey(surveyId), "1");
    setVisible(false);
  };

  /**
   * 尽力而为：requestFullscreen 必须在用户手势里同步调用；锁方向随后，
   * iOS Safari / Firefox 可能直接拒绝——两条都 catch 掉，用户仍可手动
   * 横屏（布局在横屏下自动生效）。
   */
  const goFullscreenLandscape = async () => {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      /* 全屏被拒绝：继续尝试锁方向没有意义，直接返回。 */
      return;
    }
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (mode: string) => Promise<void>;
      };
      await orientation.lock?.("landscape");
    } catch {
      /* 锁方向不支持（iOS / 桌面）：保持当前方向。 */
    }
  };

  return (
    <div
      className="mx-auto mb-3 flex w-full max-w-xl items-center gap-3 rounded-[14px] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-3 py-2 text-xs text-[var(--survey-body)] lg:max-w-3xl"
      role="status"
    >
      <RotateCw className="h-4 w-4 shrink-0 text-[var(--survey-primary)]" aria-hidden="true" />
      <span className="min-w-0 flex-1">横过来看，场景会铺满整块屏幕。</span>
      <button
        type="button"
        className="btn btn-sm shrink-0"
        onClick={() => void goFullscreenLandscape()}
        title="全屏并尝试锁定横屏（不支持时会保持当前方向）"
      >
        <Maximize2 className="h-3.5 w-3.5" />
        全屏横屏
      </button>
      <button
        type="button"
        className="shrink-0 rounded-full p-1 text-[var(--survey-muted)] hover:bg-[var(--surface-hover)]"
        onClick={dismiss}
        aria-label="关闭横屏提示"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
