import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_PAGE_META, publicPageHead } from "../../../src/http/public-page";

/**
 * 五子棋联机对战（批次 W3，/game）的接线守护。
 *
 * 与 app-center.test.ts 同一惯例：仓库没有 @testing-library，组件渲染断言
 * 降级为「静态读源码」的结构守卫；纯逻辑的真实断言在 game-room-logic.test.ts。
 */

describe("PUBLIC_PAGE_META 的 /game 条目", () => {
  it("含 /game 键，标题口径与其它公开页一致（「xx · 问卷平台」）", () => {
    const meta = PUBLIC_PAGE_META["/game"];
    expect(meta, "/game 缺 meta 条目：生产 head 注入会回退成广场那套").toBeDefined();
    expect(meta?.title).toBe("五子棋 · 联机对战 · 问卷平台");
    expect(meta?.description.trim()).not.toBe("");
  });

  it("head 注入的 canonical 指向 /game，标题/描述进了 og 与 twitter", () => {
    const { title, injectHead } = publicPageHead("https://emoemok.top", "/game");
    expect(title).toBe("五子棋 · 联机对战 · 问卷平台");
    expect(injectHead).toContain('<link rel="canonical" href="https://emoemok.top/game" />');
    expect(injectHead).toContain('<meta property="og:url" content="https://emoemok.top/game" />');
    expect(injectHead).toContain('content="五子棋 · 联机对战 · 问卷平台"');
    expect(injectHead).not.toContain("undefined");
  });
});

describe("/game 的接线（前端分发链 + Worker 静态页 + 入口卡）", () => {
  const surveyApp = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");
  const router = readFileSync(join(process.cwd(), "src", "http", "router.ts"), "utf8");
  const trialScreen = readFileSync(join(process.cwd(), "admin", "src", "survey", "TrialScreen.tsx"), "utf8");
  const appCenter = readFileSync(join(process.cwd(), "admin", "src", "survey", "AppCenterScreen.tsx"), "utf8");

  it("SurveyApp 分发链有 /game 分支且渲染懒加载的 MultiplayerGameScreen（与 /app 同款结构）", () => {
    expect(surveyApp).toContain('import("./MultiplayerGameScreen")');
    expect(surveyApp).toContain(
      'window.location.pathname === "/game" || window.location.pathname.startsWith("/game/")',
    );
    expect(surveyApp).toContain("<MultiplayerGameScreen />");
  });

  it("分发复用 LazyScreen 占位，不引入静态 import（懒加载纪律）", () => {
    const branch = surveyApp.slice(surveyApp.indexOf('pathname === "/game"'), surveyApp.indexOf("<SurveyRunner />"));
    expect(branch).toContain("<LazyScreen>");
    expect(branch).not.toMatch(/^import\s+.*MultiplayerGameScreen/m);
  });

  it("Worker 侧 /game 走 servePublicPageWithMeta（生产 assets not_found_handling=none，缺分支会真 404）", () => {
    expect(router).toContain('servePublicPageWithMeta(env, request, "/game")');
  });

  it("/trial 小游戏区有「五子棋 · 联机对战」入口卡，整页跳 /game", () => {
    expect(trialScreen).toContain('href="/game"');
    expect(trialScreen).toContain("五子棋 · 联机对战");
  });

  it("/trial 联机对战入口卡读 GET /api/game/types，失败回退静态五子棋入口（分层批次）", () => {
    expect(trialScreen).toContain("fetchGameTypes()");
    expect(trialScreen).toContain("gameEntryHref(");
    // 静态回退卡仍在源里（guard 读源码而非运行时）：入口在任何部署下都不消失。
    expect(trialScreen).toContain('href="/game"');
  });

  it("/app 应用中心小游戏区有联机对战入口卡（读 /api/game/types，静态回退不消失）", () => {
    // X2 批次：/app 与 /trial 同一数据面——动态渲染已注册玩法（五子棋/象棋）。
    expect(appCenter).toContain("fetchGameTypes()");
    expect(appCenter).toContain("gameEntryHref(");
    expect(appCenter).toContain("FALLBACK_GAME_TYPES");
    // 回退卡的五子棋文案仍在源里（守卫读源码而非运行时）。
    expect(appCenter).toContain("和好友实时对弈");
  });

  it("/s 与 /cert 分支未被触碰（答题流程与认证卡 DOM 不动）", () => {
    expect(surveyApp).toContain("window.location.pathname.match(/^\\/s\\/(\\d+)/)");
    expect(router).toContain('servePublicPageWithMeta(env, request, "/s")');
  });
});

describe("/game 的 Lobby/Board 分层（Board 注册表 + 未知玩法兜底）", () => {
  const screen = readFileSync(join(process.cwd(), "admin", "src", "survey", "MultiplayerGameScreen.tsx"), "utf8");
  const boards = readFileSync(join(process.cwd(), "admin", "src", "survey", "game-boards.tsx"), "utf8");

  it("屏按 view.gameType 经注册表分发 Board；未注册玩法渲染「该游戏客户端即将上线」", () => {
    expect(screen).toContain("resolveGameBoard(view.gameType)");
    expect(screen).toContain("<UnknownGameBoard gameType={view.gameType} />");
    expect(boards).toContain('registerGameBoard("gomoku", GomokuBoardPanel)');
    // X2 批次：象棋 Board 面板同样注册进分发表。
    expect(boards).toContain('registerGameBoard("xiangqi", XiangqiBoardPanel)');
  });

  it("大厅层走 GameLobby.tsx；房间壳不再直接触碰五子棋渲染（分层守护）", () => {
    expect(screen).toContain('from "./GameLobby"');
    // 玩法私有渲染全部下沉到 GomokuBoardPanel：房间壳不 import 棋盘组件、
    // 不解析玩法载荷（normalizeRoomCode 等房间级纯函数仍可复用）。
    expect(screen).not.toContain('from "./GomokuBoard"');
    expect(screen).not.toContain("parseGomokuView");
    expect(screen).not.toContain("<GomokuBoard");
  });

  it("建房路径必须同步落「我的行」锚点 setMyHash（创建不经 enterRoom，漏掉即房主被渲染成观战）", () => {
    // handleCreate 拿到 create 响应（game-api 的 you 字段 → selfSeatToken，
    // 修复 1：you 是座位令牌，不再携带 participantHash）后要 setMyHash，再
    // attachConnection；这是「建→备→开局」链路的前提。
    const createBlock = screen.slice(screen.indexOf("const handleCreate"), screen.indexOf("const handleJoinInput"));
    expect(createBlock).toContain("setMyHash(result.data.selfSeatToken)");
    expect(createBlock).toContain("attachConnection(result.data.roomId)");
  });
});

describe("M8 双区布局（docs/design/IMPLEMENTATION_PROGRESS.md 批次 M8）", () => {
  const screen = readFileSync(join(process.cwd(), "admin", "src", "survey", "MultiplayerGameScreen.tsx"), "utf8");
  const lobby = readFileSync(join(process.cwd(), "admin", "src", "survey", "GameLobby.tsx"), "utf8");
  const indexCss = readFileSync(join(process.cwd(), "admin", "src", "index.css"), "utf8");

  it("大厅入口双区：桌面 5fr/7fr + 横屏短高度双列，手机纵堆不变", () => {
    expect(lobby).toContain("game-lobby-grid");
    expect(indexCss).toMatch(
      /@media \(min-width: 1000px\)[\s\S]{0,80}\.game-lobby-grid\s*\{[\s\S]{0,120}5fr\) minmax\(0, 7fr\)/,
    );
    expect(indexCss).toMatch(/landscape\) and \(max-height: 560px\)[\s\S]{0,80}\.game-lobby-grid/);
  });

  it("房间大厅形态：左区等待中房间列表可点击直加；创建卡含公开/私人选择与配置插槽", () => {
    expect(lobby).toContain("等待中的房间");
    expect(lobby).toContain("onJoinRoom(room.id)");
    // 屏层把列表点击接到 enterRoom（按房间号直加）
    expect(screen).toContain("onJoinRoom={(roomIdTarget) => void enterRoom(roomIdTarget)}");
    // 0108：创建卡有 公开/私人 两种可见性，私人房标价 100 金币
    expect(lobby).toContain("roomVisibility");
    expect(lobby).toContain("100 金币");
    // configPanel 仍在创建卡内（狼人杀房主配置跟创建走右区）
    const createBlock = lobby.slice(lobby.indexOf('title="创建房间"'), lobby.indexOf('title="加入房间"'));
    expect(createBlock).toContain("{configPanel}");
  });

  it("对局/结算态棋盘主列 + 聊天侧栏（sticky）；大厅态保持纵堆", () => {
    expect(screen).toContain("room-stage-grid");
    expect(screen).toContain('"room-stage-grid is-playing"');
    expect(screen).toContain('className="room-chat-col min-w-0"');
    expect(indexCss).toMatch(/\.room-stage-grid\.is-playing\s*\{[\s\S]{0,120}320px/);
    expect(indexCss).toContain(".room-stage-grid.is-playing .room-chat-col");
  });
});
