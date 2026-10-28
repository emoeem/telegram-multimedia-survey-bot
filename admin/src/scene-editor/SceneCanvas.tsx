import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ImagePlus } from "lucide-react";
import type { HotspotScene } from "../../../src/survey/hotspot";
import {
  MIN_RECT,
  clamp01,
  moveRect,
  normalizeRect,
  rectToStyle,
  resizeRect,
  type Rect,
  type ResizeHandle,
} from "./model";

const HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface SceneCanvasProps {
  scene: HotspotScene;
  /** 编辑器内显示用的 URL（媒体资产走 /api/admin/media/<id>/image）。 */
  imageUrl: string | null;
  selectedHotspotId: string | null;
  readOnly: boolean;
  onSelect: (hotspotId: string | null) => void;
  onCreate: (rect: Rect) => void;
  onChange: (hotspotId: string, rect: Rect) => void;
  onRequestImage: () => void;
}

interface DragState {
  mode: "draw" | "move" | "resize";
  start: { x: number; y: number };
  rect: Rect;
  id?: string;
  handle?: ResizeHandle;
  moved: boolean;
}

interface LiveRect {
  id: string;
  rect: Rect;
}

/**
 * 场景画布：底图上用 Pointer Events 绘制/移动/缩放矩形。
 *
 * 画布热点是 aria-hidden 的视觉层（指针交互）；键盘用户用左侧热点列表
 * 选中、方向键微调、Delete 删除——两条路径修改同一份配置。
 */
export function SceneCanvas({
  scene,
  imageUrl,
  selectedHotspotId,
  readOnly,
  onSelect,
  onCreate,
  onChange,
  onRequestImage,
}: SceneCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const liveRef = useRef<LiveRect | null>(null);
  const [live, setLive] = useState<LiveRect | null>(null);

  const setLiveRect = (next: LiveRect | null) => {
    liveRef.current = next;
    setLive(next);
  };

  if (!scene.image) {
    return (
      <div className="scene-canvas-empty">
        <span className="scene-canvas-empty-icon">
          <ImagePlus className="h-6 w-6" />
        </span>
        <div>
          <h2>这个场景还没有底图</h2>
          <p>选择一张已有图片，或上传新图；支持 JPG / PNG / WebP，单张不超过 20MB。</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={readOnly} onClick={onRequestImage}>
          选择或上传底图
        </button>
      </div>
    );
  }

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = event.target as HTMLElement;
    const spot = target.closest<HTMLElement>("[data-hotspot-id]");
    if (spot) {
      const hotspotId = spot.dataset.hotspotId ?? "";
      const hotspot = scene.hotspots.find((item) => item.id === hotspotId);
      if (!hotspot) return;
      onSelect(hotspotId);
      const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as ResizeHandle | undefined;
      dragRef.current = {
        mode: handle ? "resize" : "move",
        start: pointFromEvent(event),
        rect: { x: hotspot.x, y: hotspot.y, w: hotspot.w, h: hotspot.h },
        id: hotspotId,
        handle,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (target === stageRef.current || target === imageRef.current) {
      const start = pointFromEvent(event);
      dragRef.current = {
        mode: "draw",
        start,
        rect: { x: start.x, y: start.y, w: MIN_RECT, h: MIN_RECT },
        moved: false,
      };
      setLiveRect({ id: "__new__", rect: { x: start.x, y: start.y, w: MIN_RECT, h: MIN_RECT } });
      onSelect(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = pointFromEvent(event);
    if (Math.abs(point.x - drag.start.x) + Math.abs(point.y - drag.start.y) > 0.004) {
      drag.moved = true;
    }
    if (drag.mode === "draw") {
      setLiveRect({ id: "__new__", rect: normalizeRect(drag.start, point) });
      return;
    }
    if (!drag.id) return;
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    setLiveRect({
      id: drag.id,
      rect: drag.mode === "move" ? moveRect(drag.rect, dx, dy) : resizeRect(drag.rect, drag.handle ?? "se", dx, dy),
    });
  };

  const finishDrag = () => {
    const drag = dragRef.current;
    const liveState = liveRef.current;
    dragRef.current = null;
    setLiveRect(null);
    if (!drag || !drag.moved) return;
    if (drag.mode === "draw") {
      if (liveState && liveState.rect.w >= MIN_RECT && liveState.rect.h >= MIN_RECT) {
        onCreate(liveState.rect);
      }
      return;
    }
    if (drag.id && liveState) onChange(drag.id, liveState.rect);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setLiveRect(null);
  };

  return (
    <div
      ref={stageRef}
      className="scene-canvas"
      style={{ aspectRatio: `${scene.width} / ${scene.height}` }}
      role="group"
      aria-label="场景画布：在空白处拖拽创建热点，拖动热点移动，拖动角柄缩放"
      data-readonly={readOnly ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
    >
      <img
        ref={imageRef}
        className="scene-canvas-image"
        src={imageUrl ?? scene.image}
        alt={scene.alt ?? scene.title}
        draggable={false}
      />
      <div className="scene-canvas-layer" aria-hidden="true">
        {scene.hotspots.map((hotspot) => {
          const rect = live?.id === hotspot.id ? live.rect : hotspot;
          const selected = hotspot.id === selectedHotspotId;
          return (
            <div
              key={hotspot.id}
              className={`scene-canvas-spot${selected ? " is-selected" : ""}`}
              data-hotspot-id={hotspot.id}
              style={rectToStyle(rect)}
            >
              <span className="scene-canvas-index">{hotspot.meta ?? ""}</span>
              <span className="scene-canvas-label">{hotspot.label || "未命名"}</span>
              {selected && !readOnly
                ? HANDLES.map((handle) => (
                    <span key={handle} className={`scene-canvas-handle is-${handle}`} data-handle={handle} />
                  ))
                : null}
            </div>
          );
        })}
        {live?.id === "__new__" ? (
          <div className="scene-canvas-spot is-drawing" style={rectToStyle(live.rect)} />
        ) : null}
      </div>
    </div>
  );
}
