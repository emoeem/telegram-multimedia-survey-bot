import type { MouseEvent } from "react";
import {
  XIANGQI_PIECE_CHARS,
  XIANGQI_VIEW_H,
  XIANGQI_VIEW_W,
  xiangqiCellFromPoint,
  xiangqiGeometry,
} from "./game-room-logic";

/**
 * 象棋 9×10 SVG 棋盘（多人玩法批次 X1，X2 补可走点提示）。
 *
 * 单个 <svg> 承载棋盘线（中路竖线在楚河汉界断开）、九宫斜线、河界文字、
 * 棋子（交点圆盘 + 汉字）、最后一手标记、选中高亮与可走点提示（空点画
 * 主题色圆点、对方棋子画吃子环——提示点可落在敌子上）；整块只挂一个
 * click 监听：点击坐标经 xiangqiCellFromPoint 吸附到最近交点。棋子颜色
 * 是玩法语义（红/黑汉字），不走主题变量；落子可用性由父层决定（不可用
 * 时整块不响应点击）。touch-manipulation 关掉移动端双击缩放。
 */
export function XiangqiBoard({
  board,
  lastMoveTo,
  selected,
  hints,
  playable,
  onCellClick,
}: {
  board: Array<Array<string | null>>;
  /** 最后一手的终点（盘面标记），null = 无。 */
  lastMoveTo: { row: number; col: number } | null;
  /** 当前选中的己方棋子（高亮环），null = 无。 */
  selected: { row: number; col: number } | null;
  /** 可走点提示（选中棋子的合法落点，服务端 legalMoves 按选中过滤而来）。 */
  hints: Array<{ row: number; col: number }>;
  playable: boolean;
  onCellClick: (row: number, col: number) => void;
}) {
  const { cellX, cellY, points } = xiangqiGeometry();
  const point = (row: number, col: number) => points[row * 9 + col];
  const stoneRadius = Math.min(cellX, cellY) * 0.42;

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!playable) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * XIANGQI_VIEW_W;
    const y = ((event.clientY - rect.top) / rect.height) * XIANGQI_VIEW_H;
    const cell = xiangqiCellFromPoint(x, y);
    if (cell) onCellClick(cell.row, cell.col);
  };

  return (
    <svg
      viewBox={`0 0 ${XIANGQI_VIEW_W} ${XIANGQI_VIEW_H}`}
      role="img"
      aria-label="象棋棋盘"
      onClick={handleClick}
      className={`w-full touch-manipulation select-none ${playable ? "cursor-pointer" : "cursor-default"}`}
    >
      {/* 棋盘底 */}
      <rect x={0} y={0} width={XIANGQI_VIEW_W} height={XIANGQI_VIEW_H} rx={12} fill="#e7c48a" />

      {/* 横线：10 条全宽 */}
      {Array.from({ length: 10 }, (_, row) => {
        const first = point(row, 0);
        const last = point(row, 8);
        if (!first || !last) return null;
        return (
          <line key={`h-${row}`} x1={first.x} y1={first.y} x2={last.x} y2={last.y} stroke="#8a5a2b" strokeWidth={1} />
        );
      })}
      {/* 竖线：两侧边线全高；中路 7 条在楚河汉界（row 4–5 之间）断开 */}
      {Array.from({ length: 9 }, (_, col) => {
        const top = point(0, col);
        const riverTop = point(4, col);
        const riverBottom = point(5, col);
        const bottom = point(9, col);
        if (!top || !riverTop || !riverBottom || !bottom) return null;
        if (col === 0 || col === 8) {
          return (
            <line key={`v-${col}`} x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} stroke="#8a5a2b" strokeWidth={1} />
          );
        }
        return (
          <g key={`v-${col}`} stroke="#8a5a2b" strokeWidth={1}>
            <line x1={top.x} y1={top.y} x2={riverTop.x} y2={riverTop.y} />
            <line x1={riverBottom.x} y1={riverBottom.y} x2={bottom.x} y2={bottom.y} />
          </g>
        );
      })}
      {/* 外框加粗一圈，收住视觉边界 */}
      <rect
        x={point(0, 0)?.x ?? 0}
        y={point(0, 0)?.y ?? 0}
        width={(point(0, 8)?.x ?? 0) - (point(0, 0)?.x ?? 0)}
        height={(point(9, 0)?.y ?? 0) - (point(0, 0)?.y ?? 0)}
        fill="none"
        stroke="#8a5a2b"
        strokeWidth={2}
      />
      {/* 九宫斜线 */}
      {[
        [0, 3, 2, 5],
        [0, 5, 2, 3],
        [7, 3, 9, 5],
        [7, 5, 9, 3],
      ].map(([r1, c1, r2, c2]) => {
        const a = point(r1!, c1!);
        const b = point(r2!, c2!);
        if (!a || !b) return null;
        return <line key={`p-${r1}-${c1}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#8a5a2b" strokeWidth={1} />;
      })}
      {/* 楚河汉界 */}
      {[
        { col: 2, text: "楚 河" },
        { col: 6, text: "汉 界" },
      ].map(({ col, text }) => {
        const p = point(4, col);
        if (!p) return null;
        return (
          <text
            key={`r-${col}`}
            x={p.x}
            y={p.y + cellY / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.min(cellX, cellY) * 0.42}
            fill="#8a5a2b"
            opacity={0.7}
            fontWeight={700}
            letterSpacing={4}
          >
            {text}
          </text>
        );
      })}

      {/* 棋子：最后一手终点加主题色环，选中棋子加高亮环 */}
      {board.map((line, row) =>
        line.map((piece, col) => {
          if (piece === null) return null;
          const p = point(row, col);
          if (!p) return null;
          const isRed = piece === piece.toUpperCase();
          const isSelected = selected !== null && selected.row === row && selected.col === col;
          const isLast = lastMoveTo !== null && lastMoveTo.row === row && lastMoveTo.col === col;
          return (
            <g key={`c-${row}-${col}`}>
              {isLast ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={stoneRadius + 3}
                  fill="none"
                  stroke="var(--survey-primary)"
                  strokeWidth={2}
                  opacity={0.55}
                />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={stoneRadius}
                fill="#f8ecd2"
                stroke={isRed ? "#b91c1c" : "#1f2937"}
                strokeWidth={1.8}
              />
              {isSelected ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={stoneRadius + 4}
                  fill="none"
                  stroke="var(--survey-primary)"
                  strokeWidth={3}
                />
              ) : null}
              <text
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={stoneRadius * 1.12}
                fontWeight={700}
                fill={isRed ? "#b91c1c" : "#1f2937"}
                style={{ userSelect: "none" }}
              >
                {XIANGQI_PIECE_CHARS[piece] ?? piece}
              </text>
            </g>
          );
        }),
      )}

      {/* 可走点提示（X2）：空点画主题色小圆点；落点有对方棋子（吃子）画
          包住圆盘的提示环。画在棋子之后，环不被圆盘遮住。 */}
      {hints.map(({ row, col }) => {
        const p = point(row, col);
        if (!p) return null;
        const occupied = board[row]?.[col] != null;
        return occupied ? (
          <circle
            key={`hint-${row}-${col}`}
            cx={p.x}
            cy={p.y}
            r={stoneRadius + 3}
            fill="none"
            stroke="var(--survey-primary)"
            strokeWidth={2.5}
            opacity={0.9}
          />
        ) : (
          <circle
            key={`hint-${row}-${col}`}
            cx={p.x}
            cy={p.y}
            r={Math.max(3, stoneRadius * 0.24)}
            fill="var(--survey-primary)"
            opacity={0.8}
          />
        );
      })}
    </svg>
  );
}
