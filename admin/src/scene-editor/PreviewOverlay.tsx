import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { HotspotScene } from "../survey/HotspotScene";
import type { AnswerValue, SurveyQuestionDto } from "../survey/api";
import { trapFocusWithin } from "../components/focus-trap";

/**
 * 全屏预览：直接把编辑中的草稿交给 HotspotScene，探索状态只存在本地，
 * 不影响问卷答案。关闭后焦点回到打开预览的按钮。
 */
export function PreviewOverlay({ question, onClose }: { question: SurveyQuestionDto; onClose: () => void }) {
  const [value, setValue] = useState<AnswerValue>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 热点弹层自己的 Escape/Tab 由 HotspotScene 处理，这里不能抢。
      if (target?.closest(".hotspot-modal")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") trapFocusWithin(overlayRef.current, event);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div ref={overlayRef} className="scene-editor-preview" role="dialog" aria-modal="true" aria-label="场景预览">
      <div className="scene-editor-preview-bar">
        <span>预览 · 保存后参与者会看到同样内容</span>
        <button ref={closeRef} type="button" className="btn btn-sm" onClick={onClose}>
          <X className="h-4 w-4" />
          关闭预览
        </button>
      </div>
      <div className="scene-editor-preview-body">
        <HotspotScene question={question} value={value} onChange={setValue} />
      </div>
    </div>
  );
}
