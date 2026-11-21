/* Prototype Lab 验收测试（M1/M2 门禁）
   覆盖：9 视口 × 4 页打开矩阵（无横向溢出/无控制台错误/关键元素）、
   布局形态断言（导航/栅格随断点变化）、核心交互流程、错误态、
   Light 主题抽查、逐视口截图输出到 screenshots/。 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = path.join(ROOT, "screenshots");

const PAGES = [
  { key: "dashboard", file: "pages/dashboard.html", probe: "#kpi-grid" },
  { key: "games", file: "pages/games.html", probe: "#game-list" },
  { key: "room", file: "pages/room.html", probe: "#game-options" },
  { key: "profile", file: "pages/profile.html", probe: "#coin-card" },
];

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "compact-desktop-1024", width: 1024, height: 768 },
  { name: "tablet-portrait-768", width: 768, height: 1024 },
  { name: "tablet-landscape-1024", width: 1024, height: 768 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "narrow-mobile-360", width: 360, height: 800 },
  { name: "tg-webview-390", width: 390, height: 764 },
  { name: "mobile-landscape-844", width: 844, height: 390 },
];

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
  return errors;
}

/* ============ ① 打开矩阵：4 页 × 9 视口 ============ */
for (const vp of VIEWPORTS) {
  test.describe(`打开矩阵 · ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const p of PAGES) {
      test(`${p.key} 无溢出/无报错`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto(`/${p.file}?theme=dark`);
        await expect(page.locator(p.probe)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "横向溢出 " + overflow + "px").toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      });
    }
  });
}

/* ============ ② 布局形态随断点变化 ============ */
test.describe("布局形态", () => {
  test("桌面：用户端顶部导航可见，底部导航隐藏", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/pages/games.html");
    await expect(page.locator(".topnav-links")).toBeVisible();
    await expect(page.locator(".bottomnav")).toBeHidden();
  });

  test("手机：底部导航可见（含 6 项），顶部链接收纳", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pages/games.html");
    await expect(page.locator(".bottomnav")).toBeVisible();
    await expect(page.locator(".bottomnav-item")).toHaveCount(6);
    await expect(page.locator(".topnav-links")).toBeHidden();
  });

  test("手机横屏 844×390：房间页双列紧凑布局", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/pages/room.html");
    const cols = await page
      .locator(".room-grid")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(cols).toBe(2);
    await expect(page.locator(".bottomnav")).toBeHidden();
  });

  test("后台 ≤1023px：图标轨隐藏、顶栏汉堡可用；≥1024px 图标轨显示", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/pages/dashboard.html");
    await expect(page.locator(".adm-rail")).toBeHidden();
    await expect(page.locator("#nav-toggle")).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".adm-rail")).toBeVisible();
    await expect(page.locator("#nav-toggle")).toBeHidden();
  });

  test("游戏大厅 ≥1024px：三栏（分类/列表/详情），<1024 单列", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/pages/games.html");
    const cols = await page
      .locator(".lobby-grid")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(cols).toBe(3);
    await expect(page.locator("#trial-settings")).toBeVisible();

    await page.setViewportSize({ width: 768, height: 1024 });
    const cols2 = await page
      .locator(".lobby-grid")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(cols2).toBe(1);
  });

  test("TG WebView：宿主返回栏出现、页面导航隐藏（用户端三页）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 764 });
    for (const file of ["games", "room", "profile"]) {
      await page.goto(`/pages/${file}.html?frame=tg`);
      await expect(page.locator(".tg-hostbar")).toBeVisible();
      await expect(page.locator(".tg-note")).toBeVisible();
      await expect(page.locator(".topnav")).toBeHidden();
      await expect(page.locator(".bottomnav")).toBeHidden();
    }
  });
});

test("手机 KPI 5→2 列：最后一张卡跨双列（无孤行）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pages/dashboard.html");
  const span = await page.locator("#kpi-grid .kpi:last-child").evaluate((el) => getComputedStyle(el).gridColumnStart);
  expect(span).toBe("span 2");
  const box = await page.locator("#kpi-grid .kpi:last-child").boundingBox();
  const grid = await page.locator("#kpi-grid").boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(grid.width - 2);
});

test.describe("Dashboard 交互", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("搜索与状态筛选实时过滤队列", async ({ page }) => {
    await page.goto("/pages/dashboard.html");
    await page.fill("#topbar-search", "恋爱");
    await expect(page.locator("#queue-body tr")).toHaveCount(1);
    await page.fill("#topbar-search", "");
    await page.click('#queue-filters [data-filter="failed"]');
    await expect(page.locator("#queue-body tr")).toHaveCount(1);
    await expect(page.locator("#queue-body tr .chip-danger")).toBeVisible();
  });

  test("行点击打开报告详情抽屉，Escape 关闭", async ({ page }) => {
    await page.goto("/pages/dashboard.html");
    await page.click("#queue-body tr:first-child td:nth-child(2)");
    await expect(page.locator("#q-drawer")).toBeVisible();
    await expect(page.locator("#qd-name")).toContainText("恋爱依恋类型测评");
    await page.keyboard.press("Escape");
    await expect(page.locator("#q-drawer")).toBeHidden();
  });

  test("工作区卡片打开详情抽屉并可跳转占位页", async ({ page }) => {
    await page.goto("/pages/dashboard.html");
    await page.click('.workspace-card[data-ws="问卷"]');
    await expect(page.locator("#ws-drawer")).toBeVisible();
    await page.click("#ws-drawer-link");
    await expect(page).toHaveURL(/placeholder\.html\?from=dashboard/);
    await expect(page.locator("#ph-desc")).toBeVisible();
  });

  test("URL 状态参数驱动：loading / error / noperm / empty", async ({ page }) => {
    await page.goto("/pages/dashboard.html?state=loading");
    await expect(page.locator("#skeleton-layer")).toBeVisible();
    await expect(page.locator("#dash-main")).toBeHidden();

    await page.goto("/pages/dashboard.html?state=error");
    await expect(page.locator("#error-block")).toBeVisible();
    await page.click("#error-retry");
    await expect(page.locator("#dash-main")).toBeVisible({ timeout: 3000 });

    await page.goto("/pages/dashboard.html?state=noperm");
    await expect(page.locator("#noperm-block")).toBeVisible();

    await page.goto("/pages/dashboard.html?state=empty");
    await expect(page.locator("#queue-empty")).toBeVisible();
    await expect(page.locator('.kpi[data-kpi="users"] .kpi-value')).toHaveText("0");
  });

  test("部分失败与队列异常横幅", async ({ page }) => {
    await page.goto("/pages/dashboard.html?state=partial");
    await expect(page.locator("#partial-banner")).toBeVisible();
    await expect(page.locator('.kpi[data-kpi="today"]')).toHaveClass(/is-error/);

    await page.goto("/pages/dashboard.html?state=queue-error");
    await expect(page.locator("#queue-banner")).toBeVisible();
  });

  test("刷新按钮反馈", async ({ page }) => {
    await page.goto("/pages/dashboard.html");
    await page.click("#refresh-btn");
    await expect(page.locator("#refresh-btn")).toHaveClass(/is-loading/);
    await expect(page.locator(".toast")).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Games 大厅交互", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("选择游戏更新详情面板；开始跳转房间页", async ({ page }) => {
    await page.goto("/pages/games.html");
    await page.click('.game-card[data-game="chess"]');
    await expect(page.locator("#d-name")).toContainText("象棋");
    await page.click("#d-start");
    await expect(page).toHaveURL(/room\.html\?game=chess/);
    await expect(page.locator("#page-title")).toContainText("象棋");
  });

  test("分类筛选与试炼设置", async ({ page }) => {
    await page.goto("/pages/games.html");
    await page.click('#category-side [data-cat="party"]');
    await expect(page.locator("#game-list .game-card")).toHaveCount(1);
    await expect(page.locator("#game-list .game-card .game-name")).toContainText("狼人杀");
    await page.click('#trial-settings [data-setting="mode"] .seg-btn:nth-child(2)');
    await page.click("#trial-start");
    await expect(page.locator(".toast")).toContainText("试炼");
  });

  test("规则弹窗 Escape 关闭；记录/排行榜视图切换", async ({ page }) => {
    await page.goto("/pages/games.html");
    await page.click("#d-rules");
    await expect(page.locator("#rules-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#rules-modal")).toBeHidden();

    await page.click('#lobby-seg [data-view="ranks"]');
    await expect(page.locator("#rank-table")).toBeVisible();
    await page.click('#lobby-seg [data-view="records"]');
    await expect(page.locator('[data-view-panel="records"]')).toBeVisible();
    await expect(page.locator('[data-view-panel="play"]')).toBeHidden();
  });

  test("手机：点击游戏卡弹出 Bottom Sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pages/games.html");
    await page.click('.game-card[data-game="werewolf"]');
    await expect(page.locator("#game-sheet")).toBeVisible();
    await expect(page.locator("#s-name")).toContainText("狼人杀");
    await page.click("#game-sheet [data-close]");
    await expect(page.locator("#game-sheet")).toBeHidden();
  });
});

test.describe("Room 房间交互", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("创建房间 → 成功态 → 对手加入 → 可开局", async ({ page }) => {
    await page.goto("/pages/room.html");
    await expect(page.locator("#create-btn")).toHaveText("创建五子棋房间");
    await page.click("#create-btn");
    await expect(page.locator("#create-btn")).toHaveText("正在创建…");
    await expect(page.locator("#create-success")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#room-code")).toContainText("GOM-");
    await expect(page.locator("#start-match")).toBeHidden();
    await expect(page.locator("#start-match")).toBeVisible({ timeout: 4000 });
    await page.click("#start-match");
    await expect(page.locator(".toast")).toContainText("对局开始");
  });

  test("复制房间码", async ({ page }) => {
    await page.goto("/pages/room.html");
    await page.click("#create-btn");
    await expect(page.locator("#create-success")).toBeVisible({ timeout: 3000 });
    await page.click("#copy-code");
    await expect(page.locator("#copy-code")).toHaveText(/已复制|复制失败/, { timeout: 2000 });
  });

  test("切换玩法更新标题与 CTA；狼人杀出现人数设置", async ({ page }) => {
    await page.goto("/pages/room.html");
    await page.click('.game-option[data-game="werewolf"]');
    await expect(page.locator("#create-btn")).toHaveText("创建狼人杀房间");
    await expect(page.locator("#create-settings select")).toBeVisible();
    await page.click('.game-option[data-game="chess"]');
    await expect(page.locator("#create-btn")).toHaveText("创建象棋房间");
  });

  test("加入房间各错误态与成功态", async ({ page }) => {
    await page.goto("/pages/room.html");
    // 空码
    await page.click("#join-btn");
    await expect(page.locator("#join-error")).toBeVisible();
    await expect(page.locator("#join-error-text")).toContainText("请输入房间码");
    // 格式错误
    await page.fill("#join-code", "abc!");
    await page.click("#join-btn");
    await expect(page.locator("#join-error-text")).toContainText("格式不正确");
    // 不存在
    for (const [code, msg] of [
      ["0000", "房间不存在或已解散"],
      ["1111", "房间已满员"],
      ["2222", "对局已结束"],
      ["3333", "网络异常"],
    ]) {
      await page.fill("#join-code", code);
      await page.click("#join-btn");
      await expect(page.locator("#join-error-text")).toContainText(msg, { timeout: 2000 });
    }
    // 合法码 → 成功
    await page.fill("#join-code", "9999");
    await page.click("#join-btn");
    await expect(page.locator("#join-success")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#joined-code")).toHaveText("9999");
    // 粘贴邀请链接也可解析
    await page.click("#leave-room");
    await page.fill("#join-code", "https://emoemok.top/game?room=778899");
    await page.click("#join-btn");
    await expect(page.locator("#join-success")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#joined-code")).toHaveText("778899");
  });

  test("手机：创建/加入 Tab 切换", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pages/room.html");
    await expect(page.locator("#mobile-tabs")).toBeVisible();
    await expect(page.locator("#tab-join")).toBeHidden();
    await page.click('#mobile-tabs [data-mtab="join"]');
    await expect(page.locator("#tab-join")).toBeVisible();
    await expect(page.locator("#tab-create")).toBeHidden();
    await page.click('#mobile-tabs [data-mtab="create"]');
    await expect(page.locator("#tab-create")).toBeVisible();
  });
});

test.describe("Profile 个人中心交互", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("签到流程：处理中 → 已签到 + 金币 +5", async ({ page }) => {
    await page.goto("/pages/profile.html?logged=1");
    await expect(page.locator("#coin-balance")).toHaveText("128");
    await page.click("#checkin-btn");
    await expect(page.locator("#checkin-btn")).toHaveText(/签到中/);
    await expect(page.locator("#checkin-btn")).toHaveText("今日已签到 ✓", { timeout: 3000 });
    await expect(page.locator("#checkin-btn")).toBeDisabled();
    await expect(page.locator("#coin-balance")).toHaveText("133");
    await expect(page.locator(".toast")).toContainText("签到成功");
  });

  test("登录态切换（Mock）与退出", async ({ page }) => {
    await page.goto("/pages/profile.html");
    await page.click("#auth-btn");
    await expect(page.locator("#auth-modal")).toBeVisible();
    await page.fill("#auth-email", "emo@example.com");
    await page.click("#send-code");
    await expect(page.locator("#send-code")).toBeDisabled();
    await page.click("#auth-submit");
    await expect(page.locator("#identity-title")).toContainText("emo***");
    await expect(page.locator("#coin-balance")).toHaveText("128");
    await page.click("#auth-btn");
    await expect(page.locator("#identity-title")).toContainText("匿名访客身份");
  });

  test("明细抽屉、通知抽屉与全部已读", async ({ page }) => {
    await page.goto("/pages/profile.html");
    await page.click("#coin-detail");
    await expect(page.locator("#coin-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.click("#notif-entry");
    await expect(page.locator("#notif-drawer")).toBeVisible();
    await page.click("#mark-read");
    await expect(page.locator("#notif-drawer")).toBeHidden();
    await expect(page.locator("#notes-unread")).toBeHidden();
  });

  test("答卷足迹：生成 → 复制 → 撤销状态", async ({ page }) => {
    await page.goto("/pages/profile.html");
    await page.click("#footprint-btn");
    await expect(page.locator("#fp-modal")).toBeVisible();
    await page.click("#fp-revoke");
    await expect(page.locator("#fp-state")).toContainText("已撤销");
    await page.keyboard.press("Escape");
    await expect(page.locator("#fp-modal")).toBeHidden();
  });

  test("状态机：余额失败 / 无报告 / 已读", async ({ page }) => {
    await page.goto("/pages/profile.html?state=coin-error");
    await expect(page.locator("#coin-error")).toBeVisible();
    await page.goto("/pages/profile.html?state=no-reports");
    await expect(page.locator("#report-desc")).toContainText("还没有报告");
    await page.goto("/pages/profile.html?state=share-revoked");
    await expect(page.locator("#report-desc")).toContainText("已撤销");
    await page.goto("/pages/profile.html?state=notif-clean");
    await expect(page.locator("#notif-dot")).toBeHidden();
  });
});

/* ============ ④ 实验室外壳 ============ */
test.describe("实验室外壳", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("页面/视口/主题切换生效", async ({ page }) => {
    await page.goto("/index.html");
    await expect(page.locator("#proto-iframe")).toHaveAttribute("src", /dashboard\.html/);
    await page.selectOption("#ctl-page", "pages/games.html");
    await expect(page.locator("#proto-iframe")).toHaveAttribute("src", /games\.html/);
    await page.selectOption("#ctl-vp", "390x844");
    await expect(page.locator("#ctl-size")).toContainText("390×844");
    await page.selectOption("#ctl-theme", "light");
    await expect(page.locator("#proto-iframe")).toHaveAttribute("src", /theme=light/);
  });

  test("方向切换对移动视口生效", async ({ page }) => {
    await page.goto("/index.html");
    await page.selectOption("#ctl-vp", "390x844");
    await page.click("#ctl-orient");
    await expect(page.locator("#ctl-size")).toContainText("844×390");
  });
});

/* ============ ⑤ Light 主题抽查 ============ */
test.describe("Light 主题", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const p of PAGES.slice(0, 2)) {
    test(`${p.key} light 无报错且 data-theme 生效`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`/${p.file}?theme=light`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator(p.probe)).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

/* ============ ⑥ 逐视口截图（M2 证据） ============ */
test.describe.serial("截图输出", () => {
  const shotCombos = [
    ...PAGES.map((p) => ({ ...p, vp: VIEWPORTS[0], tag: "desktop-1440" })),
    ...PAGES.map((p) => ({ ...p, vp: VIEWPORTS[3], tag: "tablet-portrait-768" })),
    ...PAGES.map((p) => ({ ...p, vp: VIEWPORTS[5], tag: "mobile-390" })),
    // TG WebView：后台无 TG 形态（仅窄视口验证），用户端三页带宿主栏模拟
    { ...PAGES[0], vp: VIEWPORTS[7], tag: "tg-webview-390" },
    { ...PAGES[1], vp: VIEWPORTS[7], tag: "tg-webview-390", qs: "&frame=tg" },
    { ...PAGES[2], vp: VIEWPORTS[7], tag: "tg-webview-390", qs: "&frame=tg" },
    { ...PAGES[3], vp: VIEWPORTS[7], tag: "tg-webview-390", qs: "&frame=tg" },
    { ...PAGES[2], vp: VIEWPORTS[8], tag: "mobile-landscape-844" },
    { ...PAGES[3], vp: VIEWPORTS[5], tag: "mobile-390-signed", qs: "&state=signed" },
    { ...PAGES[0], vp: VIEWPORTS[0], tag: "desktop-1440-loading", qs: "&state=loading" },
  ];

  for (const combo of shotCombos) {
    test(`截图 ${combo.key} @ ${combo.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: combo.vp.width, height: combo.vp.height });
      await page.goto(`/${combo.file}?theme=dark${combo.qs || ""}`);
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(SHOT_DIR, `${combo.key}-${combo.tag}.png`),
        fullPage: true,
      });
    });
  }
});
