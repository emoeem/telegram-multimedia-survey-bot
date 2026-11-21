import { Gamepad2 } from "lucide-react";
import { GomokuBoardPanel } from "./GomokuBoardPanel";
import { registerGameBoard, resolveGameBoard, type GameBoardProps } from "./game-board-registry";

/**
 * 内置 Board 注册（批次：Lobby/Board 分层）——与服务端 server-engines.ts
 * 同一模式：新增一款玩法 = 写一个 *BoardPanel（消费 GameBoardProps）+ 在
 * 这里加一行 registerGameBoard。大厅、连接管理、房间壳（创建/加入/玩家
 * 列表/准备/开局/观战）全部复用，零改动。
 *
 * MultiplayerGameScreen 引入本模块即完成注册（副作用 import）；未注册的
 * gameType 由 UnknownGameBoard 兜底——服务端先行上引擎、客户端 Board 未跟
 * 进时，房间仍可进（观战提示），不会白屏。
 */
registerGameBoard("gomoku", GomokuBoardPanel);

export { resolveGameBoard, type GameBoardProps };

/** 未注册玩法的兜底卡：服务端已有引擎、客户端棋盘/牌桌还没跟上。 */
export function UnknownGameBoard({ gameType }: { gameType: string }) {
  return (
    <section className="survey-card flex flex-col items-center gap-2 p-6 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
        <Gamepad2 className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-[14px] font-bold text-[var(--survey-heading)]">该游戏客户端即将上线</p>
      <p className="text-[12px] leading-relaxed text-[var(--survey-muted)]">
        服务端玩法（{gameType}）还没有对应的客户端棋盘，等新版本发布后就能在这里对局。
      </p>
    </section>
  );
}
