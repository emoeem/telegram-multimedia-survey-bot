import type { CSSProperties, ReactNode } from "react";

/**
 * 舞台框：在父容器给出的盒子里**按比例铺满**，不裁切、不留白边。
 *
 * 实现用原生容器查询单位（cqw/cqh）——这是「fit 到容器并保持比例」的标准做法，
 * 也是它取代 JS 测量的原因：
 *
 *   width: min(100cqw, calc(100cqh * ratio))
 *
 * 取「宽度约束」与「高度约束」里更紧的那个：宽屏下受高度限制（不会溢出视口），
 * 窄高屏下受宽度限制。因为舞台本身保持场景比例，热点坐标（% of stage）不需要
 * 任何换算，也不会像 `object-fit: cover` 那样把边缘热点裁掉。
 *
 * 2026-10-30 沉浸式重设计：宽高比不同的屏幕上 contain-fit 必然留下两侧/上下
 * 空白。`backdrop` 传入同一张场景图 URL，铺满整个舞台框并模糊压暗——把
 * 「死黑」变成画面本身（galgame 全屏体验）。模糊层在比例框之后（z 序更低），
 * 热点永远只落在未模糊的前景框上，坐标语义不变。
 *
 * 无比例内容（未来的视频/网页嵌入）传 `ratio={undefined}`，此时铺满整框。
 *
 * 老浏览器兜底：不支持容器查询单位时退回 CSS 里的 `max-height` 估算
 * （见 index.css 的 `@supports not (width: 1cqw)` 分支）。
 */
export function StageFrame({
  ratio,
  label,
  backdrop,
  children,
}: {
  /** 宽高比（width / height）。缺省表示内容自适应铺满。 */
  ratio?: number;
  label?: string;
  /** 比例框之外的空间用这张图模糊放大填满（contain-fit 的留白不是死黑）。 */
  backdrop?: string;
  children: ReactNode;
}) {
  const style: CSSProperties | undefined = ratio
    ? ({
        "--stage-ratio": ratio,
        "--stage-aspect": String(ratio),
      } as CSSProperties)
    : undefined;
  return (
    <div className="stage-frame" role="group" aria-label={label}>
      {backdrop ? (
        <div aria-hidden className="stage-backdrop" style={{ backgroundImage: `url("${backdrop}")` }} />
      ) : null}
      <div className={`stage-frame-box${ratio ? "" : " is-fluid"}`} style={style}>
        {children}
      </div>
    </div>
  );
}
