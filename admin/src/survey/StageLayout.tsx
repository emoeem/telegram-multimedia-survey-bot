import type { ReactNode } from "react";

/**
 * 舞台版式外壳（场景/小游戏/视频等画布优先题型）。
 *
 * 为什么单独成一个组件：`SurveyApp` 里「铺满视口」曾有三套并行机制
 * （VN 的 fixed 背景层、矮横屏的 fixed hack、宽卡片），每加一种画布题型就要
 * 再写一遍 CSS 穿透。这里把**整条 flex 链收在一个组件里**：
 *
 *   .survey-stage-main (flex:1, min-height:0)      ← 由 SurveyApp 提供
 *     └─ .survey-stage-body (flex:1, min-height:0)  ← 本组件
 *          ├─ .survey-stage-heading (flex:none)     ← 题面（短，可省略）
 *          └─ .stage-frame (flex:1, min-height:0)   ← 舞台吃掉剩余空间
 *
 * 每条 flex 项都必须带 `min-height: 0`——漏一条，子项的最小内容高度会把链撑开，
 * 舞台就会溢出到下方的操作条下面（这正是固定 `max-height` 时代的事故形态）。
 * 链只在组件内部，因此任何外层新增 wrapper 都不会静默破坏版式。
 *
 * 底栏在舞台版式下改为静态 flex 子项（见 SurveyApp），结构上不可能遮挡舞台。
 */
export function StageLayout({
  heading,
  stage,
  trailing,
}: {
  heading?: ReactNode;
  stage: ReactNode;
  /** 舞台之后的可选区块（如最后一题的「公开发布」选项）：限高并内部滚动。 */
  trailing?: ReactNode;
}) {
  return (
    <div className="survey-stage-body">
      {heading ? <div className="survey-stage-heading">{heading}</div> : null}
      {stage}
      {trailing ? (
        // 折叠而不是常驻：短横屏下常驻区块会把舞台压到几十像素高（实测 79px）。
        // 展开时自身限高滚动，舞台相应收缩——用户主动要看选项时才让位。
        <details className="survey-stage-trailing">
          <summary>公开发布选项</summary>
          <div className="survey-stage-trailing-body">{trailing}</div>
        </details>
      ) : null}
    </div>
  );
}
