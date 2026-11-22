import { expect, test } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * /game（联机游戏大厅 + 房间）的视觉与功能守卫。
 *
 * 背景（M6 批次 6.3，docs/design/IMPLEMENTATION_PROGRESS.md）：qa/visual 此前
 * 对 /game 零覆盖，M8 双区改造（原型 room-grid）没有任何截图回归保护。
 * 本规格先行落地，M8 改造时以这里的基线为回归依据。
 *
 * ⚠️ 基线纪律：基线 PNG 只能由 visual-baseline.yml（CI 字体环境）生成/更新；
 * 本地首跑会自动写入 local-font 基线并判失败——**本地生成的 PNG 不得提交**，
 * 一律以 CI 产物为准（见 IMPLEMENTATION_PROGRESS「QA 工作流铁律」）。
 *
 * 覆盖状态：大厅入口态（未进房）三视口 + 玩法切换交互。房间内态（等待/对局/
 * 结算）依赖 WS 会话，待 M8 双区改造时以本地 Worker + 双会话方案另行补规格。
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 844, height: 390 }, // 手机横屏：M8 双区布局的目标形态
];

const TELEGRAM_STUB = `
window.Telegram = {
  WebApp: {
    initData: "",
    ready() {},
    expand() {},
    close() {},
    setHeaderColor() {},
    setBottomBarColor() {},
    requestTheme() {},
    requestViewport() {},
    requestSafeArea() {},
    requestContentSafeArea() {}
  }
};
`;

// 与 src/http/game-api.ts 的 GET /api/game/types 响应同形（读注册表 meta）。
const GAME_TYPES = {
  ok: true,
  games: [
    {
      name: "gomoku",
      displayName: "五子棋",
      description: "黑白轮流落子，先连成五子的一方获胜；每一步限时一分钟。",
      minPlayers: 2,
      maxPlayers: 2,
    },
    {
      name: "xiangqi",
      displayName: "象棋",
      description: "楚河汉界双人博弈：车马炮兵将士，将死或困毙对方获胜。",
      minPlayers: 2,
      maxPlayers: 2,
    },
    {
      name: "ludo",
      displayName: "飞行棋",
      description: "经典飞行棋 2–4 人：掷六起飞、终点精确反弹，先进全部飞机到者胜。",
      minPlayers: 2,
      maxPlayers: 4,
    },
    {
      name: "doudizhu",
      displayName: "斗地主",
      description: "3 人开局：叫分抢地主、底牌公开、炸弹王炸翻倍、春天反春天积分制。",
      minPlayers: 3,
      maxPlayers: 3,
    },
    {
      name: "werewolf",
      displayName: "狼人杀",
      description: "6–12 人开局：预言家/女巫/守卫/猎人，黑夜白昼轮转，票选放逐。",
      minPlayers: 6,
      maxPlayers: 12,
    },
  ],
};

const API_MOCKS: Record<string, unknown> = {
  "/api/game/types": GAME_TYPES,
  // 未进房：无活跃房间（joinbycode/create 不在本规格触达，POST 走兜底空对象）。
  "/api/game/rooms/state": { ok: false },
};

async function mockGameApi(page: import("@playwright/test").Page) {
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const body = API_MOCKS[url.pathname];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body ?? {}),
    });
  });
}

for (const viewport of VIEWPORTS) {
  test(`game lobby @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockGameApi(page);

    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });

    await page.goto("/game", { waitUntil: "domcontentloaded" });
    // mock 玩法列表真正渲染出来（页面加载数据的信号）。first()：displayName
    // 同时出现在创建卡的玩法单选里，避免 strict 多匹配。
    await expect(page.getByText("五子棋").first()).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "选择玩法" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);

    await scanA11y(page, test.info().title);

    await expect(page).toHaveScreenshot(`game-lobby-${viewport.width}x${viewport.height}.png`, {
      maxDiffPixelRatio: 0.002,
    });
  });
}

test("game lobby · 切换玩法更新创建入口并挂载对应配置面板", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockGameApi(page);
  await page.goto("/game", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("radiogroup", { name: "选择玩法" })).toBeVisible();

  // 默认选中五子棋：创建按钮文案带玩法名。
  await expect(page.getByRole("button", { name: /创建.*房间/ })).toBeVisible();

  // 切到狼人杀：房主配置面板（板子预设）随之挂载——shell 的 configPanel 组合点。
  await page.getByRole("radio", { name: /狼人杀/ }).click();
  await expect(page.getByRole("group", { name: "板子预设" })).toBeVisible();

  // 切回五子棋：配置面板卸载（仅狼人杀有房主配置）。
  await page.getByRole("radio", { name: /五子棋/ }).click();
  await expect(page.getByRole("group", { name: "板子预设" })).toHaveCount(0);

  // 加入房间空码提交：内联错误可见（M8 双区改造中「加入」流程不得回归）。
  await page.getByLabel("房间码").fill("");
  await page.getByRole("button", { name: /^加入$/ }).click();
  await expect(page.getByText("房间码是创建房间时生成的一串数字")).toBeVisible();
});
