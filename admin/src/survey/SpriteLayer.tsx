import { useEffect, useMemo, useState } from "react";

/** The subset of the Network Information API this component consults. */
interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * True when pre-downloading a few hundred KB would be a bad trade: the visitor
 * asked to save data, or the browser reports a connection slower than 4G.
 */
function shouldSkipPreload(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return Boolean(connection.effectiveType && connection.effectiveType !== "4g");
}

/**
 * 视觉小说式「立ち絵」层：把当前节点的角色立绘贴在场景里。
 *
 * 布局（一套 DOM，两种排版）：
 *  - 手机上立绘在正文上方居中，跟内容一起滚动（半身像式），不会压住文字；
 *  - `lg` 以上固定在视口右下角，位于内容层之下（`z` 更低 + DOM 在前），
 *    正文卡片压在立绘下半身上——就是 VN 的「立绘在对话框后面」。
 *
 * 立绘不是装饰图：它有 `alt`（角色名 + 表情），加载失败时整层消失而不是留一个
 * 破图框；`prefers-reduced-motion` 下不做淡入。
 */
export function SpriteLayer({
  url,
  expression,
  name,
  expressions,
}: {
  url: string;
  expression: string;
  name?: string;
  /** 整张表情表（`theme.sprite.expressions`）：首帧后空闲预热，避免换表情时闪白。
   *  这里收的是**稳定的对象引用**而不是调用方每次渲染新建的数组，否则下面那个
   *  预热 effect 会在每次渲染时重置定时器，预热可能永远不发生。 */
  expressions?: Record<string, string>;
}) {
  const preload = useMemo(() => Object.values(expressions ?? {}), [expressions]);
  // 换表情时先保留旧图，新的解码完成再换，避免中间闪一下空白。
  const [shown, setShown] = useState(url);
  useEffect(() => {
    if (url === shown) return;
    let cancelled = false;
    const image = new Image();
    const swap = () => {
      if (!cancelled) setShown(url);
    };
    image.onload = swap;
    image.onerror = swap;
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, shown]);

  // 预热：整份表情表只有几百 KB，等页面空闲时一次拿全，之后切换零延迟。
  // 但「几百 KB」对弱网用户是实打实的等待——它和首屏、翻页请求抢同一条
  // 链路。省流量模式或 2G/3G 下不预热：换表情时再单张加载，功能不受影响。
  useEffect(() => {
    if (preload.length === 0) return;
    if (shouldSkipPreload()) return;
    const timer = window.setTimeout(() => {
      for (const candidate of preload) {
        if (candidate === url) continue;
        const image = new Image();
        image.decoding = "async";
        image.src = candidate;
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [preload, url]);

  return (
    <div
      data-survey-sprite={expression}
      className="pointer-events-none relative mx-auto mb-2 flex w-full justify-center lg:fixed lg:bottom-0 lg:right-4 lg:z-[-1] lg:mb-0 lg:w-auto lg:justify-end xl:right-10"
      aria-hidden={false}
    >
      <img
        src={shown}
        alt={name ? `${name}（${expression}）` : `角色立绘（${expression}）`}
        decoding="async"
        draggable={false}
        className="h-[28vh] max-h-[320px] w-auto select-none object-contain opacity-95 drop-shadow-[0_18px_38px_rgba(2,6,23,.55)] motion-safe:transition-opacity motion-safe:duration-300 lg:h-[min(56vh,600px)] lg:max-h-none"
      />
    </div>
  );
}
