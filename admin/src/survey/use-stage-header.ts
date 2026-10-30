import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * 沉浸舞台的顶部信息条滑出/收回裁决（2026-10-30 沉浸式重设计）。
 *
 * 舞台版式下头部信息（标题/进度/返回/退出）默认完全隐藏，把整块视口让给
 * 场景；需要时通过以下任一入口唤出，3.5 秒无操作自动收回：
 *
 *  - 顶部中央常驻的把手按钮（触屏可见可达）
 *  - 桌面指针触及视口最顶端 ≤8px（VLC 全屏控制条的习惯用法；舞台内容
 *    从 flex 链顶开始，8px 边缘几乎不会压到热点）
 *  - 打开状态下在信息条外按下 → 立即收回；Escape 收回
 *
 * `activeRef` 是镜像 ref（SurveyApp 的 stageLayout 在早退分支之后才算得出，
 * hook 本身必须无条件调用——与该文件 bottomBarModeRef 同一模式）；
 * 非 active 时强制收起且不监听任何事件。
 */
const AUTO_HIDE_MS = 3500;
/** 桌面「指针贴边唤出」的判定条高度（px）。 */
export const STAGE_HEADER_EDGE_PX = 8;

export function useStageHeader(activeRef: RefObject<boolean>) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const hideTimer = useRef<number | undefined>(undefined);

  const clearHideTimer = useCallback(() => {
    window.clearTimeout(hideTimer.current);
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setOpen(false), AUTO_HIDE_MS);
  }, [clearHideTimer]);

  const reveal = useCallback(() => {
    setOpen(true);
    scheduleHide();
  }, [scheduleHide]);

  const dismiss = useCallback(() => {
    clearHideTimer();
    setOpen(false);
  }, [clearHideTimer]);

  useEffect(() => {
    if (!activeRef.current) {
      dismiss();
      return undefined;
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.clientY <= STAGE_HEADER_EDGE_PX && !openRef.current) reveal();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!openRef.current) return;
      const target = event.target as Element | null;
      // 点在信息条（或唤出把手）上不算「外面」；信息条内部操作续期自动收回。
      if (target?.closest("[data-stage-header], [data-stage-header-handle]")) {
        scheduleHide();
        return;
      }
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    // 只摘监听器、不清 hide timer：本 effect 无依赖数组（activeRef 是镜像 ref，
    // SurveyApp 每次打字机帧都重渲染），cleanup 若清 timer，打开瞬间的重渲染
    // 就会把 3.5s 自动收回杀掉（交互走查实测抓到过）。timer 由 dismiss/卸载管理。
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  return { open, reveal, dismiss, scheduleHide };
}
