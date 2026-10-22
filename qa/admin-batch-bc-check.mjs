/**
 * 后台「批次 B / C」的浏览器验收。
 *
 * 为什么必须跑真浏览器：这一批改的东西有一半只有渲染后才成立——
 * `data-label` 是 `::before` 的 content，44px 触控热区取决于 `pointer: coarse`
 * 媒体的真实匹配，`aria-label` 要在图标轨（640–999px）下才看得出必要性。
 * 单测证明不了这些。
 *
 * 覆盖：
 *  B1 报告页全选 / 批量重试 / 生成中「强制重试」
 *  B2 图标轨宽度下每个导航项都有可读名字（title + aria-label），导航可滚动
 *  B3 `pointer: coarse` 下按钮 / 复选框热区 ≥ 44px
 *  B4 手机宽度下每个 td 自带字段名（::before content）
 *  B5 筛选为空时是 EmptyPanel + 「清除筛选」，不是一句硬编码
 *  C1 总览与报告页共用同一张指标卡（圆角 / 数字字号一致），4 张卡不塌成空位
 *  C2 配色支持手输 HEX / HEX8，且取色器不吃掉 alpha
 *
 * 用法：node qa/admin-batch-bc-check.mjs [--headed]
 * 前提：先 `pnpm --dir admin build`。
 */
import { chromium } from "playwright";
import { ITEMS, startAdminStub } from "./lib/admin-stub.mjs";

const HEADED = process.argv.includes("--headed");

const stub = await startAdminStub();
const ORIGIN = stub.origin;
const requests = stub.requests;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: !HEADED });
const pageErrors = [];

const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await desktop.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
const page = await desktop.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));

/* ---------------------------------------------------------------- B1 ---- */
await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "报告归档" }).waitFor();

const rowChecks = page.locator('tbody input[type="checkbox"]');
const rowCount = await rowChecks.count();
check("每行都有选择框", rowCount === ITEMS.length, `rows=${rowCount}`);

await page.getByRole("checkbox", { name: /选择本页全部任务/ }).check();
await page.waitForTimeout(120);
const batchBar = page.getByText(/已选 \d+ 项/);
check("全选后出现批量操作条", (await batchBar.innerText()) === `已选 ${ITEMS.length} 项`, await batchBar.innerText());

const retryPostsBefore = requests.filter((r) => r.includes("/retry")).length;
await page.getByRole("button", { name: "批量重试" }).click();
await page.getByRole("status").filter({ hasText: "已提交" }).waitFor({ timeout: 5000 });
const retryPosts = requests.filter((r) => r.includes("/retry")).length - retryPostsBefore;
check("批量重试对每个选中项各发一次 retry", retryPosts === ITEMS.length, `POST=${retryPosts}`);
check(
  "批量重试后选择被清空（不会误操作到下一页）",
  (await page.getByText(/已选 \d+ 项/).count()) === 0,
);

// 生成中的任务：强制重试要二次确认
const deliveringRow = page.locator("tbody tr", { hasText: "生成中" }).first();
await deliveringRow.getByRole("button", { name: "强制重试" }).click();
const forceDialog = page.getByRole("dialog");
await forceDialog.waitFor();
const forceText = await forceDialog.innerText();
check(
  "生成中任务可强制重试，并说明已卡时长",
  forceText.includes("强制重试") && forceText.includes("24 分钟"),
  forceText.replace(/\s+/g, " ").slice(0, 60),
);
const beforeForce = requests.filter((r) => r.includes("/retry")).length;
await page.getByRole("button", { name: "再等等" }).click();
await forceDialog.waitFor({ state: "detached" });
check(
  "取消强制重试不会发请求",
  requests.filter((r) => r.includes("/retry")).length === beforeForce,
);

/* ---------------------------------------------------------------- B5 ---- */
await page.goto(`${ORIGIN}/admin/reports?status=delivered`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "报告归档" }).waitFor();
await page.getByLabel("报告状态筛选").selectOption("");
await page.waitForTimeout(250);
// 直接拦截成空列表，验证「筛选为空」与「本来就没有」给出不同文案
await page.route("**/api/admin/report-deliveries**", (route) => {
  if (route.request().method() !== "GET") return route.continue();
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 1,
      statusSummary: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
    }),
  });
});
await page.goto(`${ORIGIN}/admin/reports?status=failed`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "报告归档" }).waitFor();
const emptyText = await page.locator(".empty").first().innerText();
check("筛选为空时点名当前筛选", emptyText.includes("失败") && emptyText.includes("没有任务"), emptyText.replace(/\s+/g, " "));
const clearBtn = page.getByRole("button", { name: "清除筛选" });
check("空状态提供「清除筛选」按钮", (await clearBtn.count()) === 1);
await clearBtn.click();
await page.waitForTimeout(200);
check("清除筛选后回到全部状态", !page.url().includes("status="), page.url());

/* ---------------------------------------------------------------- C1 ---- */
await page.unroute("**/api/admin/report-deliveries**");
await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "报告归档" }).waitFor();
const reportCards = page.locator(".admin-stat");
const reportCardCount = await reportCards.count();
const reportMetrics = await reportCards.first().evaluate((el) => {
  const style = getComputedStyle(el);
  const value = el.querySelector(".admin-stat-value");
  return {
    radius: style.borderTopLeftRadius,
    valueFont: value ? getComputedStyle(value).fontSize : null,
    glow: getComputedStyle(el, "::after").backgroundColor,
  };
});
check("报告页 4 张状态卡", reportCardCount === 4, `cards=${reportCardCount}`);
check("4 张卡在 1280 宽下排成一行（不再留第 5 个空位）", await (async () => {
  const tops = await reportCards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  return new Set(tops.map((t) => Math.round(t))).size === 1;
})());

await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "数据总览" }).waitFor();
const dashMetrics = await page.locator(".admin-stat").first().evaluate((el) => {
  const style = getComputedStyle(el);
  const value = el.querySelector(".admin-stat-value");
  return {
    radius: style.borderTopLeftRadius,
    valueFont: value ? getComputedStyle(value).fontSize : null,
    glow: getComputedStyle(el, "::after").backgroundColor,
  };
});
check(
  "总览与报告页共用同一张指标卡（圆角/数字字号/装饰一致）",
  dashMetrics.radius === reportMetrics.radius &&
    dashMetrics.valueFont === reportMetrics.valueFont &&
    dashMetrics.glow === reportMetrics.glow,
  `dash=${JSON.stringify(dashMetrics)} report=${JSON.stringify(reportMetrics)}`,
);

/* ---------------------------------------------------------------- B2 ---- */
const railCtx = await browser.newContext({ viewport: { width: 820, height: 700 } });
const railPage = await railCtx.newPage();
await railPage.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
await railPage.getByRole("heading", { name: "数据总览" }).waitFor();

const navAudit = await railPage.evaluate(() => {
  const links = Array.from(document.querySelectorAll("nav.admin-nav a"));
  const nav = document.querySelector("nav.admin-nav");
  return {
    total: links.length,
    unnamed: links.filter((a) => !(a.getAttribute("aria-label") ?? "").trim()).length,
    untitled: links.filter((a) => !(a.getAttribute("title") ?? "").trim()).length,
    nameText: links.slice(0, 3).map((a) => a.getAttribute("aria-label")),
    overflowY: nav ? getComputedStyle(nav).overflowY : null,
    // 图标轨下文字被隐藏，所以「可见文本为空但仍有 name」正是我们要的
    hiddenText: links.filter((a) => {
      const span = a.querySelector("span:not(.absolute)");
      return span ? getComputedStyle(span).display === "none" : false;
    }).length,
  };
});
// 820×700 是「图标轨 + 矮窗口」，走紧凑模式：nav 里 10 项，其余 9 项在
// 「更多」面板里。所以这里量的是「nav 里这 10 项」；面板里的 9 项由下面一段
// 单独量——一条断言不该靠数目去猜自己在量哪一半。
check(
  "图标轨宽度（820px）下每个导航项都有 aria-label 与 title",
  navAudit.unnamed === 0 && navAudit.untitled === 0 && navAudit.total === 10,
  JSON.stringify(navAudit),
);
await railPage.locator("[aria-controls='admin-rail-more']").click();
await railPage.locator("#admin-rail-more").waitFor();
const panelAudit = await railPage.evaluate(() => {
  const links = Array.from(document.querySelectorAll("#admin-rail-more a"));
  return {
    total: links.length,
    unnamed: links.filter((a) => !(a.getAttribute("aria-label") ?? a.textContent ?? "").trim()).length,
    hiddenText: links.filter((a) => {
      const span = a.querySelector("span:not(.absolute)");
      return span ? getComputedStyle(span).display === "none" : false;
    }).length,
  };
});
check(
  "「更多」面板里的 9 项也都有可读名字（图标轨下文字被隐藏）",
  panelAudit.total === 9 && panelAudit.unnamed === 0 && panelAudit.hiddenText === 0,
  JSON.stringify(panelAudit),
);
await railPage.keyboard.press("Escape");
check("导航容器可纵向滚动（短屏不会截断菜单）", navAudit.overflowY === "auto", String(navAudit.overflowY));

/* ---------------------------------------------------------------- B4 ---- */
const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 780 } });
const phone = await phoneCtx.newPage();
await phone.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await phone.getByRole("heading", { name: "报告归档" }).waitFor();
const labels = await phone.evaluate(() => {
  const cells = Array.from(document.querySelectorAll("tbody tr:first-child td"));
  return cells.map((td) => ({
    attr: td.getAttribute("data-label"),
    content: getComputedStyle(td, "::before").content,
    theadHidden: getComputedStyle(document.querySelector("thead")).display,
  }));
});
const labelled = labels.filter((c) => c.attr && c.attr !== "");
check(
  "手机宽度下 td 自带字段名（::before 取到 data-label）",
  labelled.length >= 6 && labelled.every((c) => c.content.includes(c.attr) || c.content.replace(/"/g, "") === c.attr),
  JSON.stringify(labels.map((l) => `${l.attr}:${l.content}`)),
);
check("表头在手机端隐藏（改由字段名承担）", labels[0]?.theadHidden === "none", String(labels[0]?.theadHidden));

/* ---------------------------------------------------------------- B3 ---- */
const touchCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});
const touch = await touchCtx.newPage();
await touch.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await touch.getByRole("heading", { name: "报告归档" }).waitFor();
const touchAudit = await touch.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  // 只看可见元素：`.btn-sm` 的第一个匹配是 header 里 `hidden sm:inline-flex`
  // 的「设置」按钮，`.hit-target` 的第一个在 <thead> 里（手机端 thead 被隐藏），
  // 拿它量会得到 0×0 并误判成实现有问题。
  const visible = (sel) =>
    Array.from(document.querySelectorAll(sel)).filter((el) => el.getBoundingClientRect().width > 0);
  const smallest = (sel) => {
    const sizes = visible(sel).map(box);
    if (!sizes.length) return null;
    return sizes.reduce((a, b) => (a.h * a.w <= b.h * b.w ? a : b));
  };
  return {
    coarse: window.matchMedia("(pointer: coarse)").matches,
    btn: smallest(".btn"),
    sm: smallest(".btn-sm"),
    hit: smallest(".hit-target"),
    check: smallest(".row-check"),
    counts: { hit: visible(".hit-target").length, check: visible(".row-check").length },
  };
});
check("模拟触屏时 pointer: coarse 生效", touchAudit.coarse === true);
check(
  "按钮热区 ≥ 44×44（最小者，含只有图标的刷新按钮）",
  (touchAudit.btn?.w ?? 0) >= 44 && (touchAudit.btn?.h ?? 0) >= 44 && (touchAudit.sm?.w ?? 0) >= 44 && (touchAudit.sm?.h ?? 0) >= 44,
  JSON.stringify({ btn: touchAudit.btn, sm: touchAudit.sm }),
);
check(
  "复选框的点击热区 ≥ 44×44（控件本体仍小）",
  (touchAudit.hit?.w ?? 0) >= 44 &&
    (touchAudit.hit?.h ?? 0) >= 44 &&
    (touchAudit.check?.w ?? 99) < 44 &&
    touchAudit.counts.hit >= 1,
  JSON.stringify({ hit: touchAudit.hit, control: touchAudit.check, counts: touchAudit.counts }),
);

/* ---------------------------------------------------------------- C2 ---- */
await desktop.addInitScript(() => {});
const cert = await desktop.newPage();
cert.on("pageerror", (error) => pageErrors.push(error.message));
await cert.goto(`${ORIGIN}/admin/cert-content`, { waitUntil: "networkidle" });
await cert.getByRole("heading", { name: "认证卡内容" }).waitFor();

const hexInput = cert.getByLabel("主色色值，支持 HEX 或 HEX8");
const swatch = cert.getByLabel("主色取色器");
await hexInput.fill("#12345680");
await hexInput.blur();
await cert.waitForTimeout(150);
const swatchValue = await swatch.inputValue();
check("HEX8 手输保留 alpha", (await hexInput.inputValue()) === "#12345680", await hexInput.inputValue());
check("取色器只拿 6 位（不会把 alpha 变成 #000000）", swatchValue === "#123456", swatchValue);

await hexInput.fill("#abc");
await hexInput.blur();
await cert.waitForTimeout(150);
check("三位缩写自动补全为六位", (await hexInput.inputValue()) === "#aabbcc", await hexInput.inputValue());

await hexInput.fill("#zzz");
await cert.waitForTimeout(120);
const invalidFlag = await hexInput.getAttribute("aria-invalid");
await hexInput.blur();
await cert.waitForTimeout(120);
check(
  "非法色值标红并在失焦后回退",
  invalidFlag === "true" && (await hexInput.inputValue()) === "#aabbcc",
  `invalid=${invalidFlag} value=${await hexInput.inputValue()}`,
);

await cert.getByRole("button", { name: /保存/ }).click();
await cert.getByRole("status").filter({ hasText: "已保存" }).waitFor({ timeout: 5000 });
check(
  "保存后 PUT 体里的色值与输入一致（#aabbcc）",
  stub.state.lastPut?.themes?.[0]?.palette?.primary === "#aabbcc",
  JSON.stringify(stub.state.lastPut?.themes?.[0]?.palette?.primary),
);

check("页面无脚本异常", pageErrors.length === 0, pageErrors.join(" | "));

/* ------------------------------------------------------- 截图留档 ---- */
const shot = async (target, path, fullPage = false) => {
  await target.screenshot({ path, fullPage });
  console.log(`SHOT ${path}`);
};
await railPage.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
await railPage.getByRole("heading", { name: "数据总览" }).waitFor();
await shot(railPage, "qa/artifacts/bc-rail-820.png");

await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "数据总览" }).waitFor();
await shot(page, "qa/artifacts/bc-dashboard-1280.png");

await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "报告归档" }).waitFor();
await page.getByRole("checkbox", { name: /选择本页全部任务/ }).check();
await page.waitForTimeout(150);
await shot(page, "qa/artifacts/bc-reports-1280.png");

await phone.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await phone.getByRole("heading", { name: "报告归档" }).waitFor();
await shot(phone, "qa/artifacts/bc-reports-375.png", true);

await touch.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
await touch.getByRole("heading", { name: "报告归档" }).waitFor();
await shot(touch, "qa/artifacts/bc-reports-touch-390.png", true);

await cert.goto(`${ORIGIN}/admin/cert-content`, { waitUntil: "networkidle" });
await cert.getByRole("heading", { name: "认证卡内容" }).waitFor();
await shot(cert, "qa/artifacts/bc-cert-colors-1280.png");

await browser.close();
stub.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
