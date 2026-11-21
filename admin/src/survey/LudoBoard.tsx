import {
  LUDO_SEAT_COLORS,
  LUDO_STRETCH_CELLS_BY_COLOR,
  ludoHangarPoint,
  ludoPathPoint,
  ludoTrackPoint,
  type LudoGridPoint,
  type LudoMoveRecordView,
  type LudoRulesView,
  type LudoSeatView,
} from "./game-room-logic";

/**
 * 飞行棋 SVG 棋盘（游戏批次 X2-C）。
 *
 * 标准 Ludo 十字布局：15×15 网格上画四角机场（机位）、52 格四色循环主环、
 * 每色 5 格终点跑道与中心终点（四色三角分象），并按视图 rules 画本方颜色格
 * 之间的捷径虚线（飞行格 → 落点）。所有坐标来自 game-room-logic 的纯几何
 * （与引擎 ludoLoopCell 主环恒等式对齐），组件不做任何规则计算。
 *
 * 棋子 = 色块 + 编号（1..4，不引外部图片）；同一格多机并置时横向错开。
 * 可交互性由父层裁剪：playable（轮到你 + await_move + 连接可用）时仅
 * legalPlanes 里的己方飞机可点（机库待飞 / 航线可走都算），其余棋子纯展示。
 * 触控：svg 挂 touch-manipulation 关掉双击缩放，棋子热区覆盖整个色块。
 */
export function LudoBoard({
  seats,
  rules,
  legalPlanes,
  yourSeat,
  playable,
  lastMove,
  onSelectPlane,
}: {
  seats: LudoSeatView[];
  /** 规则快照（捷径虚线按 flyPos/flyStep 画；视图缺失时 parseLudoView 已给默认值）。 */
  rules: LudoRulesView;
  /** 当前待走方（=你）的可动飞机槽位（服务端权威）。 */
  legalPlanes: number[];
  /** 你的座位号；null = 观战（没有任何飞机可点）。 */
  yourSeat: number | null;
  playable: boolean;
  /** 最后一手（终点格高亮 + 反弹后落点也在此格），null = 尚无走子。 */
  lastMove: LudoMoveRecordView | null;
  onSelectPlane: (seatIndex: number, planeSlot: number) => void;
}) {
  const cell = 32;
  const point = (grid: LudoGridPoint) => ({ x: grid.col * cell + cell / 2, y: grid.row * cell + cell / 2 });

  // 棋子颜色（玩法语义，不走主题变量；与引擎 LUDO_SEAT_COLORS 序号一致）。
  const seatFill = ["#dc2626", "#d97706", "#2563eb", "#16a34a"];
  const cellFill = ["#fee2e2", "#fef3c7", "#dbeafe", "#dcfce7"];

  /** 主环格着色相位 = 格号 % 4（引擎恒等式：起飞格 13c 即该色）。 */
  const cellColor = (loopCell: number) => loopCell % 4;

  // 同格并置的飞机分桶：key = 网格坐标串，value = 该格上的 (seat, slot) 列表。
  // 待机飞机固定在各自机位（ludoHangarPoint），不参与并置。
  const occupancy = new Map<string, Array<{ seatIndex: number; colorIndex: number; planeSlot: number; pos: number }>>();
  const planePoint = (colorIndex: number, planeSlot: number, pos: number | null) => {
    if (pos === null) return ludoHangarPoint(colorIndex, planeSlot);
    return ludoPathPoint(colorIndex, pos);
  };
  for (const seat of seats) {
    seat.planes.forEach((pos, planeSlot) => {
      const grid = planePoint(seat.colorIndex, planeSlot, pos);
      if (!grid) return;
      const key = `${grid.row},${grid.col}`;
      const list = occupancy.get(key) ?? [];
      list.push({ seatIndex: seat.seatIndex, colorIndex: seat.colorIndex, planeSlot, pos: pos ?? -1 });
      occupancy.set(key, list);
    });
  }

  const lastMovePoint = lastMove !== null ? ludoPathPoint(lastMove.colorIndex, lastMove.to) : null;

  const handleSelect = (seatIndex: number, planeSlot: number) => {
    if (!playable || seatIndex !== yourSeat) return;
    if (!legalPlanes.includes(planeSlot)) return;
    onSelectPlane(seatIndex, planeSlot);
  };

  const pieceSize = 24;

  return (
    <svg viewBox="0 0 480 480" role="img" aria-label="飞行棋棋盘" className="w-full touch-manipulation select-none">
      {/* 棋盘底 */}
      <rect x={0} y={0} width={480} height={480} rx={14} fill="#f7f2e7" />

      {/* 四角机场：色块底 + 四个停机位圆 */}
      {seats.map((seat) => {
        const corners = [
          { x: 6, y: 6 },
          { x: 288, y: 6 },
          { x: 288, y: 288 },
          { x: 6, y: 288 },
        ];
        const corner = corners[seat.colorIndex];
        if (!corner) return null;
        return (
          <g key={`base-${seat.colorIndex}`}>
            <rect
              x={corner.x}
              y={corner.y}
              width={186}
              height={186}
              rx={16}
              fill={cellFill[seat.colorIndex]}
              stroke={seatFill[seat.colorIndex]}
              strokeWidth={2}
              opacity={0.9}
            />
            <text
              x={corner.x + 93}
              y={corner.y + 168}
              textAnchor="middle"
              fontSize={16}
              fontWeight={700}
              fill={seatFill[seat.colorIndex]}
              opacity={0.75}
              style={{ userSelect: "none" }}
            >
              {LUDO_SEAT_COLORS[seat.colorIndex] ?? "?"}方机位
            </text>
          </g>
        );
      })}
      {/* 机位空圈（占位提示：飞机起飞后这里就空了） */}
      {seats.map((seat) =>
        [0, 1, 2, 3].map((slot) => {
          const grid = ludoHangarPoint(seat.colorIndex, slot);
          if (!grid) return null;
          const p = point(grid);
          return (
            <circle
              key={`slot-${seat.colorIndex}-${slot}`}
              cx={p.x}
              cy={p.y}
              r={14}
              fill="white"
              stroke={seatFill[seat.colorIndex]}
              strokeWidth={1.5}
              opacity={0.85}
            />
          );
        }),
      )}

      {/* 52 格主环：圆角方块按格号四色循环着色，起飞格加白色小三角标记 */}
      {Array.from({ length: 52 }, (_, loopCell) => {
        const grid = ludoTrackPoint(loopCell);
        if (!grid) return null;
        const p = point(grid);
        const colorIndex = cellColor(loopCell);
        const isTakeoff = loopCell % 13 === 0;
        return (
          <g key={`track-${loopCell}`}>
            <rect
              x={p.x - 13}
              y={p.y - 13}
              width={26}
              height={26}
              rx={6}
              fill={cellFill[colorIndex]}
              stroke={seatFill[colorIndex]}
              strokeWidth={1.2}
            />
            {isTakeoff ? (
              <polygon
                points={`${p.x},${p.y - 6} ${p.x - 6},${p.y + 5} ${p.x + 6},${p.y + 5}`}
                fill="white"
                opacity={0.9}
              />
            ) : null}
          </g>
        );
      })}

      {/* 每色 5 格终点跑道（几何单一事实来源在 game-room-logic 的常量表） */}
      {seats.map((seat) =>
        (LUDO_STRETCH_CELLS_BY_COLOR[seat.colorIndex] ?? []).map((grid, step) => {
          const p = point(grid);
          return (
            <rect
              key={`stretch-${seat.colorIndex}-${step}`}
              x={p.x - 13}
              y={p.y - 13}
              width={26}
              height={26}
              rx={6}
              fill={seatFill[seat.colorIndex]}
              stroke="white"
              strokeWidth={1.5}
              opacity={0.82}
            />
          );
        }),
      )}

      {/* 中心终点：四色三角分象（上黄/左红/右蓝/下绿，与各色跑道方向对应） */}
      <g>
        <polygon points="192,192 288,192 240,240" fill={seatFill[1]} opacity={0.85} />
        <polygon points="192,192 192,288 240,240" fill={seatFill[0]} opacity={0.85} />
        <polygon points="288,192 288,288 240,240" fill={seatFill[2]} opacity={0.85} />
        <polygon points="192,288 288,288 240,240" fill={seatFill[3]} opacity={0.85} />
        <rect x={192} y={192} width={96} height={96} fill="none" stroke="#8a5a2b" strokeWidth={1.5} />
        <text
          x={240}
          y={240}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={15}
          fontWeight={700}
          fill="white"
          style={{ userSelect: "none" }}
        >
          终点
        </text>
      </g>

      {/* 捷径虚线：本方飞行格 → 落点（按视图 rules 画，色随本方） */}
      {seats.map((seat) => {
        const from = ludoPathPoint(seat.colorIndex, rules.flyPos);
        const to = ludoPathPoint(seat.colorIndex, rules.flyPos + rules.flyStep);
        if (!from || !to) return null;
        const a = point(from);
        const b = point(to);
        return (
          <line
            key={`fly-${seat.colorIndex}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={seatFill[seat.colorIndex]}
            strokeWidth={2}
            strokeDasharray="6 5"
            opacity={0.55}
          />
        );
      })}

      {/* 最后一手落点高亮 */}
      {lastMovePoint
        ? (() => {
            const p = point(lastMovePoint);
            return (
              <circle
                cx={p.x}
                cy={p.y}
                r={17}
                fill="none"
                stroke="var(--survey-primary)"
                strokeWidth={2.5}
                opacity={0.8}
              />
            );
          })()
        : null}

      {/* 棋子：色块 + 编号；同格并置横向错开；可动机架高亮可点 */}
      {[...occupancy.values()].map((group) =>
        group.map((piece, indexInCell) => {
          const seat = seats.find((item) => item.seatIndex === piece.seatIndex);
          if (!seat) return null;
          const pos = seat.planes[piece.planeSlot] ?? null;
          const grid = planePoint(seat.colorIndex, piece.planeSlot, pos);
          if (!grid) return null;
          const p = point(grid);
          const dx = (indexInCell - (group.length - 1) / 2) * 9;
          const x = p.x + dx;
          const isMine = seat.seatIndex === yourSeat;
          const isLegal = playable && isMine && legalPlanes.includes(piece.planeSlot);
          const fill = seatFill[seat.colorIndex] ?? "#666";
          return (
            <g
              key={`plane-${seat.seatIndex}-${piece.planeSlot}`}
              onClick={() => handleSelect(seat.seatIndex, piece.planeSlot)}
              className={isLegal ? "cursor-pointer" : "cursor-default"}
            >
              {isLegal ? (
                <rect
                  x={x - 15}
                  y={p.y - 15}
                  width={30}
                  height={30}
                  rx={8}
                  fill="none"
                  stroke="var(--survey-primary)"
                  strokeWidth={3}
                />
              ) : null}
              <rect
                x={x - 12}
                y={p.y - 12}
                width={pieceSize}
                height={pieceSize}
                rx={6}
                fill={fill}
                stroke="white"
                strokeWidth={2}
              />
              <text
                x={x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={13}
                fontWeight={800}
                fill="white"
                style={{ userSelect: "none", pointerEvents: "none" }}
              >
                {piece.planeSlot + 1}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}
