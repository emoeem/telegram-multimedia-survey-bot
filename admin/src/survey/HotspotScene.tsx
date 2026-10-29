import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseHotspotScene,
  resolveHotspotSceneRefs,
  type Hotspot,
  type HotspotSceneConfig,
  type ResolvedHotspot,
  type ResolvedHotspotSceneConfig,
} from "../../../src/survey/hotspot";
import type { AnswerValue, SurveyMediaDto, SurveyQuestionDto } from "./api";
import type { SurveyDisplayMode } from "../../../src/survey/display";
import { preloadImages, shouldSkipPreload } from "./media-preload";
import { playSfx } from "./sfx";
import { trapFocusWithin } from "../components/focus-trap";
import { StageFrame } from "./StageFrame";

/**
 * 互动场景题（scene）的查看器：场景图上的可点区域，点开内层图片或切换子场景。
 * 交互原型见 /home/emo/code/hotspot-scene-demo（viewer.js），这里是它的 React 化：
 * - 坐标仍是 settings_json 里的 0..1 归一化值，与图片原始像素/屏幕宽度解耦；
 * - 弹层用 clip-path 从热点矩形展开（prefers-reduced-motion 下直接显示）；
 * - 探索过的热点 id 通过 onChange 记入答案（{kind:"scene",visited}），由
 *   SurveyApp 的保存队列落库，断点续答时从 value 恢复。
 */

interface HotspotSceneProps {
  question: SurveyQuestionDto;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  disabled?: boolean;
  /** 问卷显示模式：landscape + 短横屏时场景脱离文档流铺满（见 compactLandscape）。 */
  display?: SurveyDisplayMode;
  /**
   * 舞台版式（layout 契约为 "stage" 时由 SurveyApp 传入）：场景交给 StageFrame
   * 按比例铺满剩余空间；intro / 进度 / 底注交给 StageLayout 的 heading 区承载，
   * 不在舞台里抢高度。
   */
  fill?: boolean;
}

interface ModalState {
  hotspot: ResolvedHotspot;
  sceneId: string;
  rect: DOMRect;
  trigger: HTMLButtonElement;
}

const TOUCH =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(hover: none)").matches
    : false;

const REDUCED_MOTION =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

function readVisited(value: AnswerValue | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as { kind?: unknown; visited?: unknown };
  if (record.kind !== "scene" || !Array.isArray(record.visited)) return [];
  return record.visited.filter((id): id is string => typeof id === "string");
}

function pct(value: number): string {
  return `${Math.min(100, Math.max(0, value * 100))}%`;
}

export function visitedCountFromAnswer(value: AnswerValue): number {
  return readVisited(value).length;
}

export function HotspotScene({ question, value, onChange, disabled, display, fill }: HotspotSceneProps) {
  // 阶段 D：存储可能是 {assetId} 结构化引用，渲染前统一解析成公开 URL。
  const config = useMemo<ResolvedHotspotSceneConfig | null>(() => {
    const parsed = parseHotspotScene(question.settings);
    return parsed ? resolveHotspotSceneRefs(parsed) : null;
  }, [question.settings]);
  const altByUrl = useMemo(() => {
    const map = new Map<string, string>();
    for (const media of question.media as SurveyMediaDto[]) {
      if (media.alt) map.set(media.url, media.alt);
    }
    return map;
  }, [question.media]);

  const [sceneId, setSceneId] = useState<string>(config?.start ?? "");
  const [sceneStack, setSceneStack] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  /**
   * 短横屏沉浸：landscape 模式 + 横屏 + 高度 ≤560px 时，场景层 position:fixed
   * 铺满视口（按高度反推宽度、保持比例 → 热点坐标不用换算，也不裁切画面）。
   * 头部与底栏靠 z 层浮在上面——退出/翻页仍可达。卡片内的进度与 intro 隐藏，
   * 否则它们会把场景挤出首屏（这正是横屏「不够沉浸」的根源）。
   */
  const [compactLandscape, setCompactLandscape] = useState(false);
  useEffect(() => {
    if (display !== "landscape" || typeof window === "undefined" || !window.matchMedia) {
      setCompactLandscape(false);
      return undefined;
    }
    const query = window.matchMedia("(orientation: landscape) and (max-height: 560px)");
    const sync = () => setCompactLandscape(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [display]);

  const visited = readVisited(value);
  const totalHotspots = config
    ? Object.values(config.scenes).reduce((sum, scene) => sum + scene.hotspots.length, 0)
    : 0;
  const complete = totalHotspots > 0 && visited.length >= totalHotspots;

  // 题目内容变化（理论上只在续答重放时发生一次）时回到起始场景。
  useEffect(() => {
    if (config) {
      setSceneId(config.start);
      setSceneStack([]);
    }
  }, [config]);

  // 预热当前场景与子场景的图片；弱网/省流量时 preloadImages 自己会跳过。
  useEffect(() => {
    if (!config) return;
    const current = config.scenes[sceneId] ?? config.scenes[config.start];
    if (!current) return;
    const urls = [current.image];
    for (const hotspot of current.hotspots) {
      if (hotspot.action.kind === "image") urls.push(hotspot.action.src);
    }
    preloadImages(urls);
  }, [config, sceneId]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const openModal = useCallback((hotspot: ResolvedHotspot, scene: string, trigger: HTMLButtonElement) => {
    window.clearTimeout(closeTimer.current);
    playSfx("select");
    setModal({ hotspot, sceneId: scene, rect: trigger.getBoundingClientRect(), trigger });
    setModalOpen(false);
    requestAnimationFrame(() => {
      setModalOpen(true);
      window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), REDUCED_MOTION ? 0 : 120);
    });
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModal((current) => {
      if (!current) return null;
      document.body.classList.remove("hotspot-lock");
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(
        () => {
          setModal(null);
          current.trigger.focus({ preventScroll: true });
        },
        REDUCED_MOTION ? 0 : 560,
      );
      return current;
    });
  }, []);

  // 弹层打开期间：锁滚动 + Escape 关闭（焦点陷阱在卡片的 onKeyDown 里）。
  useEffect(() => {
    if (!modal) return;
    document.body.classList.add("hotspot-lock");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("hotspot-lock");
    };
  }, [modal, closeModal]);

  const activate = useCallback(
    (hotspot: ResolvedHotspot, scene: string, trigger: HTMLButtonElement) => {
      if (disabled) return;
      if (!visited.includes(hotspot.id)) {
        onChange({ kind: "scene", visited: [...visited, hotspot.id] });
      }
      if (hotspot.action.kind === "scene") {
        const targetSceneId = hotspot.action.sceneId;
        playSfx("page");
        // 先把子场景图载入缓存再切换，避免黑屏一闪（弱网/省流量时直接切，
        // 图片自己渐进加载）。
        const target = config?.scenes[targetSceneId];
        const swap = () => {
          setSceneStack((stack) => [...stack, scene]);
          setSceneId(targetSceneId);
        };
        if (!target || shouldSkipPreload()) {
          swap();
          return;
        }
        let settled = false;
        const once = () => {
          if (settled) return;
          settled = true;
          swap();
        };
        const image = new Image();
        image.onload = once;
        image.onerror = once;
        image.src = target.image;
        window.setTimeout(once, 1500);
        return;
      }
      openModal(hotspot, scene, trigger);
    },
    [config, disabled, onChange, openModal, visited],
  );

  const goBackScene = useCallback(() => {
    const previous = sceneStack[sceneStack.length - 1];
    if (previous === undefined) return;
    playSfx("cancel");
    setSceneId(previous);
    setSceneStack((stack) => stack.slice(0, -1));
  }, [sceneStack]);

  if (!config) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--survey-card-border)] px-4 py-3 text-xs text-[var(--survey-muted)]">
        场景配置缺失或无效。请在导入 JSON 中修正 settings.scene（见 docs/HOTSPOT_SCENES.md）。
      </p>
    );
  }

  const scene = config.scenes[sceneId] ?? config.scenes[config.start];
  if (!scene) return null;
  const progressLabel = complete ? "全部探索完成" : `已探索 ${visited.length} / ${totalHotspots}`;

  /** 舞台内容（场景图 + 热点）：阅读外壳与舞台外壳共用这一份，避免两套标记漂移。 */
  const stageLayerInner = (
    <>
      <img
        className="hotspot-image"
        src={scene.image}
        alt={altByUrl.get(scene.image) ?? scene.alt ?? scene.title}
        decoding="async"
      />
      <div className="hotspot-layer">
        {scene.hotspots.map((hotspot, index) => {
          const isVisited = visited.includes(hotspot.id);
          const targetTitle =
            hotspot.action.kind === "scene" ? config.scenes[hotspot.action.sceneId]?.title : undefined;
          return (
            <button
              key={hotspot.id}
              type="button"
              className={`hotspot-spot${isVisited ? " is-visited" : ""}`}
              style={{
                left: pct(hotspot.x),
                top: pct(hotspot.y),
                width: pct(hotspot.w),
                height: pct(hotspot.h),
                ["--hotspot-i" as string]: String(index),
              }}
              data-label-below={hotspot.y < 0.14 ? "true" : undefined}
              data-label-left={hotspot.x + hotspot.w > 0.86 ? "true" : undefined}
              disabled={disabled}
              aria-label={`${hotspot.label}，${hotspot.action.kind === "scene" ? `进入${targetTitle ?? "子场景"}` : "查看细节"}`}
              onClick={(event) => activate(hotspot, scene.id, event.currentTarget)}
              onPointerEnter={(event) => {
                if (hotspot.action.kind === "image") preloadImages([hotspot.action.src]);
                else preloadImages([config.scenes[hotspot.action.sceneId]?.image ?? ""]);
              }}
            >
              <span className="hotspot-box" aria-hidden="true">
                <i className="hotspot-handle tl" />
                <i className="hotspot-handle tr" />
                <i className="hotspot-handle bl" />
                <i className="hotspot-handle br" />
              </span>
              <span className="hotspot-index" aria-hidden="true">
                {hotspot.meta ?? String(index + 1).padStart(2, "0")}
                {isVisited ? <em>✓</em> : null}
              </span>
              <span className="hotspot-label">
                <b>{hotspot.label}</b>
                <small>{hotspot.action.kind === "scene" ? "进入" : "查看"}</small>
              </span>
              <span className="hotspot-dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="hotspot-vignette" aria-hidden="true" />
    </>
  );

  return (
    <div
      className={`hotspot${compactLandscape ? " is-immersive" : ""}${fill ? " is-fill" : ""}`}
      data-complete={complete ? "true" : undefined}
    >
      <p className="hotspot-meta" aria-live="polite" hidden={compactLandscape || fill}>
        <span>{progressLabel}</span>
        {sceneStack.length > 0 ? (
          <button type="button" className="hotspot-back" onClick={goBackScene} disabled={disabled}>
            ← 返回上一场景
          </button>
        ) : null}
      </p>
      {scene.intro && !compactLandscape && !fill ? <p className="hotspot-intro">{scene.intro}</p> : null}

      {fill ? (
        <StageFrame ratio={scene.width / scene.height} label={scene.title}>
          <div className="hotspot-stage is-fill">{stageLayerInner}</div>
        </StageFrame>
      ) : (
        <div className="hotspot-stage-wrap">
          <div className="hotspot-stage" style={{ aspectRatio: `${scene.width} / ${scene.height}` }}>
            {stageLayerInner}
          </div>
          <p className="hotspot-plate">
            <span>{scene.title}</span>
            <span>{TOUCH ? "点按高亮区域" : "点击高亮区域 · 悬停预览"}</span>
          </p>
        </div>
      )}

      {modal ? (
        <div
          className={`hotspot-modal${modalOpen ? " is-open" : ""}`}
          style={{
            ["--clip-top" as string]: `${modal.rect.top}px`,
            ["--clip-right" as string]: `${window.innerWidth - modal.rect.right}px`,
            ["--clip-bottom" as string]: `${window.innerHeight - modal.rect.bottom}px`,
            ["--clip-left" as string]: `${modal.rect.left}px`,
          }}
          role="dialog"
          aria-modal="true"
          aria-label={modal.hotspot.action.kind === "image" ? modal.hotspot.action.title : modal.hotspot.label}
        >
          <div
            ref={cardRef}
            className="hotspot-modal-card"
            onKeyDown={(event) => trapFocusWithin(cardRef.current, event.nativeEvent)}
          >
            <button ref={closeRef} type="button" className="hotspot-modal-close" onClick={closeModal} aria-label="关闭">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {modal.hotspot.action.kind === "image" ? (
              <>
                <div className="hotspot-modal-media">
                  <img
                    src={modal.hotspot.action.src}
                    alt={altByUrl.get(modal.hotspot.action.src) ?? modal.hotspot.action.title}
                    decoding="async"
                  />
                </div>
                <div className="hotspot-modal-caption">
                  <p className="hotspot-modal-meta">
                    {modal.hotspot.meta ?? ""} · {modal.hotspot.label}
                  </p>
                  <h3>{modal.hotspot.action.title}</h3>
                  {modal.hotspot.action.caption ? <p>{modal.hotspot.action.caption}</p> : null}
                  {modal.hotspot.action.note ? <p className="hotspot-modal-note">{modal.hotspot.action.note}</p> : null}
                  <div className="hotspot-modal-actions">
                    <span>{TOUCH ? "点空白处关闭" : "ESC 关闭"}</span>
                    <button type="button" className="hotspot-modal-back" onClick={closeModal}>
                      返回场景
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
