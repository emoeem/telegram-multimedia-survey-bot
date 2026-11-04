import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Palette } from "lucide-react";
import { BottomNav } from "./BottomNav";
import {
  loadGlobalPreset,
  saveGlobalPreset,
  themeBackgroundStyle,
  themeCssVars,
  ThemePickerSheet,
  useResolvedPreset,
} from "./theme-ui";
import type { SurveyThemeDto } from "./api";

/**
 * 公开页统一壳（2026-11）。
 *
 * 背景：/plaza、/me、/coins、/notes、/submissions、/series 各自维护了一份
 * `loadGlobalPreset + useResolvedPreset + themeCssVars + themeBackgroundStyle`
 * 和顶栏/底栏；漏接入的页面（/coins、/notes、/submissions、/series）在暗金
 * 默认主题下仍是浅色，且没有主题入口。这里把主题状态与页面壳收成一份实现。
 */
export interface PublicThemeState {
  preset: string | null;
  theme: SurveyThemeDto | null;
  vars: Record<string, string>;
  background: CSSProperties;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  selectPreset: (preset: string | null) => void;
}

export function usePublicTheme(): PublicThemeState {
  const [preset, setPreset] = useState<string | null>(() => loadGlobalPreset());
  const [pickerOpen, setPickerOpen] = useState(false);
  const resolved = useResolvedPreset(preset);
  const theme = useMemo(
    () => (resolved ? ({ preset: resolved } as Parameters<typeof themeCssVars>[0]) : null),
    [resolved],
  );
  const vars = useMemo(() => themeCssVars(theme), [theme]);
  const background = useMemo(() => themeBackgroundStyle(theme), [theme]);
  const selectPreset = useCallback((next: string | null) => {
    setPreset(next);
    saveGlobalPreset(next);
    setPickerOpen(false);
  }, []);
  return {
    preset,
    theme: theme as SurveyThemeDto | null,
    vars,
    background,
    pickerOpen,
    openPicker: useCallback(() => setPickerOpen(true), []),
    closePicker: useCallback(() => setPickerOpen(false), []),
    selectPreset,
  };
}

export function ScreenShell({
  themeState,
  nav = true,
  className = "",
  children,
}: {
  themeState: PublicThemeState;
  /** 是否渲染主导航；投稿中心这类由 PageHeader(topNav=false) 接管的页面传 false。 */
  nav?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`survey-glow min-h-dvh ${nav ? "pb-24" : "pb-10"} ${className}`}
      data-theme={themeState.theme?.preset ?? undefined}
      style={{ ...themeState.vars, ...themeState.background }}
    >
      {children}
      <ThemePickerSheet
        open={themeState.pickerOpen}
        onClose={themeState.closePicker}
        selected={themeState.preset}
        onSelect={themeState.selectPreset}
      />
      {nav ? <BottomNav /> : null}
    </div>
  );
}

/** 顶栏使用的标准主题按钮（44×44 触摸区，文案与图标与其他页面一致）。 */
export function ThemeAction({ themeState }: { themeState: PublicThemeState }) {
  return (
    <button
      type="button"
      aria-label="选择主题"
      title="选择主题"
      className="survey-icon-btn"
      onClick={themeState.openPicker}
    >
      <Palette className="h-4 w-4" />
    </button>
  );
}
