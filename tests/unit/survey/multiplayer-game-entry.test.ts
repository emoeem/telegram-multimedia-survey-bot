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
    // handleCreate 拿到 create 响应（game-api 的 you 字段 → selfParticipantHash）
    // 后要 setMyHash，再 attachConnection；这是「建→备→开局」链路的前提。
    const createBlock = screen.slice(screen.indexOf("const handleCreate"), screen.indexOf("const handleJoinInput"));
    expect(createBlock).toContain("setMyHash(result.data.selfParticipantHash)");
    expect(createBlock).toContain("attachConnection(result.data.roomId)");
  });
});
