import type { MouseEvent } from "react";
import { BOARD_VIEW_SIZE, boardGeometry, cellFromPoint, starPoints, type GomokuColor } from "./game-room-logic";

/**
 * 五子棋 15×15 SVG 棋盘（批次 W3）。
 *
 * 单个 <svg> 承载网格/星位/棋子/最后一手标记/胜者连线高亮，整块只挂一个
 * click 监听：点击坐标经 cellFromPoint 吸附到最近交点（半格对角线内都算
 * 点到，格间不留死区）——390px 视口下交点间距约 21px，触控热区必须整格
 * 连续才够手指点。棋子颜色是玩法语义（黑白），不走主题变量；落子可用性
 * 由父层决定（不可用时整块不响应点击）。touch-manipulation 关掉移动端
 * 双击缩放，落子不吃 300ms 延迟。
 */
export function GomokuBoard({
  board,
  boardSize,
  lastMove,
  winningLine,
  playable,
  onCellClick,
}: {
  board: Array<Array<GomokuColor | null>>;
  boardSize: number;
  lastMove: { row: number; col: number } | null;
  winningLine: Array<{ row: number; col: number }> | null;
  playable: boolean;
  onCellClick: (row: number, col: number) => void;
}) {
  const { cell, points } = boardGeometry(boardSize);
  const stoneRadius = cell * 0.42;
  const winningSet = new Set((winningLine ?? []).map((point) => `${point.row}-${point.col}`));

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!playable) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * BOARD_VIEW_SIZE;
    const y = ((event.clientY - rect.top) / rect.height) * BOARD_VIEW_SIZE;
    const cellPoint = cellFromPoint(x, y, boardSize);
    if (cellPoint) onCellClick(cellPoint.row, cellPoint.col);
  };

  return (
    <svg
      viewBox={`0 0 ${BOARD_VIEW_SIZE} ${BOARD_VIEW_SIZE}`}
      role="img"
      aria-label="五子棋棋盘"
      onClick={handleClick}
      className={`aspect-square w-full touch-manipulation select-none ${playable ? "cursor-pointer" : "cursor-default"}`}
    >
      {/* 棋盘底 + 网格线 */}
      <rect x={0} y={0} width={BOARD_VIEW_SIZE} height={BOARD_VIEW_SIZE} rx={12} fill="#e7c48a" />
      {points.length > 0 ? (
        <>
          {/* 横线：每行的第一个交点连到最后一个 */}
          {Array.from({ length: boardSize }, (_, row) => {
            const first = points[row * boardSize];
            const last = points[row * boardSize + (boardSize - 1)];
            if (!first || !last) return null;
            return (
              <line
                key={`h-${row}`}
                x1={first.x}
                y1={first.y}
                x2={last.x}
                y2={last.y}
                stroke="#8a5a2b"
                strokeWidth={1}
              />
            );
          })}
          {/* 竖线：每列第一个交点连到最后一个 */}
          {Array.from({ length: boardSize }, (_, col) => {
            const first = points[col];
            const last = points[(boardSize - 1) * boardSize + col];
            if (!first || !last) return null;
            return (
              <line
                key={`v-${col}`}
                x1={first.x}
                y1={first.y}
                x2={last.x}
                y2={last.y}
                stroke="#8a5a2b"
                strokeWidth={1}
              />
            );
          })}
          {/* 边框加粗一圈，收住视觉边界 */}
          <rect
            x={points[0]?.x ?? 0}
            y={points[0]?.y ?? 0}
            width={(boardSize - 1) * cell}
            height={(boardSize - 1) * cell}
            fill="none"
            stroke="#8a5a2b"
            strokeWidth={2}
          />
        </>
      ) : null}

      {/* 星位 */}
      {starPoints(boardSize).map((star) => {
        const point = points[star.row * boardSize + star.col];
        if (!point) return null;
        return <circle key={`s-${star.row}-${star.col}`} cx={point.x} cy={point.y} r={cell * 0.09} fill="#8a5a2b" />;
      })}

      {/* 棋子：最后一手加同色环标记，胜者连线加主题色高亮环 */}
      {board.map((line, row) =>
        line.map((cellColor, col) => {
          if (cellColor === null) return null;
          const point = points[row * boardSize + col];
          if (!point) return null;
          const isLast = lastMove !== null && lastMove.row === row && lastMove.col === col;
          const isWinning = winningSet.has(`${row}-${col}`);
          const fill = cellColor === "black" ? "#1f2937" : "#f8fafc";
          const stroke = cellColor === "black" ? "#0f172a" : "#64748b";
          return (
            <g key={`c-${row}-${col}`}>
              <circle cx={point.x} cy={point.y} r={stoneRadius} fill={fill} stroke={stroke} strokeWidth={1.5} />
              {isLast ? (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={stoneRadius * 0.34}
                  fill={cellColor === "black" ? "#f8fafc" : "#1f2937"}
                />
              ) : null}
              {isWinning ? (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={stoneRadius + 3}
                  fill="none"
                  stroke="var(--survey-primary)"
                  strokeWidth={3}
                />
              ) : null}
            </g>
          );
        }),
      )}
    </svg>
  );
}
