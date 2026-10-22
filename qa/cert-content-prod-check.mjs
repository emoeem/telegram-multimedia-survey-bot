/**
 * 认证卡内容页 —— **生产环境只读回归**（批次 A）。
 *
 * 与 `qa/cert-content-check.mjs` 的区别：那个跑本地 dist + 桩接口，证明的是
 * "我的代码逻辑对不对"；这个跑 https://emoemok.top 上真实部署的 bundle + 真实登录
 * + 真实 D1，证明的是"上线之后它还是对的"。
 *
 * 为什么不写：生产 `cert_content_pack` 当前是空，编辑器首屏拿到的是
 * `[blankTheme()]`。在这个页面点一次保存 = 把代码内置的 12 套主题换成 1 张空白卡。
 * 所以本脚本**只读**，并在最后断言"整场 PUT/DELETE 请求数 = 0"。
 *
 * 用法：
 *   ADMIN_PASSWORD=xxx node qa/cert-content-prod-check.mjs [--headed]
 */
import { chromium } from "playwright";

const ORIGIN = process.env.PROD_ORIGIN ?? "https://emoemok.top";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const HEADED = process.argv.includes("--headed");

if (!PASSWORD) {
  console.error("缺少 ADMIN_PASSWORD 环境变量");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
const page = await context.newPage();

const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

/**
 * 记录所有**改动数据**的写请求：整场必须为 0。
 * 登录接口 POST /api/admin/auth/password 是认证动作，不算数据写入，单独放行
 * （最早那版断言把登录也算进来，结果最后一条必然误报）。
 */
const AUTH_PATHS = new Set(["/api/admin/auth/password"]);
const writes = [];
page.on("request", (request) => {
  const method = request.method();
  const path = new URL(request.url()).pathname;
  if (AUTH_PATHS.has(path)) return;
  if (["PUT", "POST", "DELETE", "PATCH"].includes(method)) writes.push(`${method} ${path}`);
});

// —— 1. 真实密码登录 ——
await page.goto(`${ORIGIN}/admin/login`, { waitUntil: "domcontentloaded" });
const passwordField = page.locator('input[type="password"]').first();
await passwordField.fill(PASSWORD);
await page.getByRole("button", { name: /登录|进入/ }).first().click();
await page.waitForURL((url) => !url.pathname.endsWith("/admin/login"), { timeout: 20000 });
check("真实密码登录成功，离开登录页", !page.url().endsWith("/admin/login"), page.url());

// —— 2. 进入认证卡内容页 ——
await page.goto(`${ORIGIN}/admin/cert-content`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "认证卡内容" }).waitFor({ timeout: 20000 });
const loadError = await page.getByText("加载失败").count();
check("认证卡内容页在生产 bundle 上正常加载", loadError === 0);

// —— 3. 记录当前内容包状态（空包 → 编辑器只有一张空白主题）——
const themeItems = await page.locator('aside button, aside [role="button"]').allInnerTexts();
const themeRows = themeItems.filter((text) => text.trim() && text.trim() !== "新增主题");
check(
  "生产为空内容包，编辑器首屏只有 1 套空白主题（保存会覆盖内置 12 套，只读验证）",
  themeRows.length === 1,
  `themes=${JSON.stringify(themeRows.map((t) => t.trim().split("\n")[0]))}`,
);

// —— 4. 深色下边框色（旧 --color-border 未定义 → currentColor → 发白）——
const asideBorder = await page.evaluate(() => {
  const aside = document.querySelector("aside[class*=\"rounded-\"]");
  return aside ? getComputedStyle(aside).borderTopColor : null;
});
const channels = (asideBorder ?? "").match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
check(
  "深色主题下侧栏边框是深灰而不是近白",
  channels.length === 3 && Math.max(...channels) < 200,
  `borderTopColor=${asideBorder}`,
);

// —— 5. 主题 ID 可连续编辑（旧实现敲一个字符整块表单消失）——
const idInput = page.locator("input[aria-invalid], .form-control input").first();
await idInput.fill("prod-check-theme");
await page.waitForTimeout(150);
const stillEditing = (await page.getByText("没有可选主题").count()) === 0;
const idValue = await idInput.inputValue();
check(
  "主题 ID 可以连续编辑，表单不会消失",
  stillEditing && idValue === "prod-check-theme",
  `value=${idValue}`,
);

// —— 6. 非法 ID：标红 + 禁保存 + 不发写请求 ——
await idInput.fill("主题一");
await page.waitForTimeout(150);
const idErrorVisible = await page.locator("#theme-id-error").isVisible();
const saveDisabled = await page.getByRole("button", { name: /保存/ }).isDisabled();
check("非法 ID 标红并禁用保存", idErrorVisible && saveDisabled, `error=${idErrorVisible} disabled=${saveDisabled}`);
await idInput.fill("prod-check-theme");
await page.waitForTimeout(150);
check("ID 改回合法后保存按钮恢复", !(await page.getByRole("button", { name: /保存/ }).isDisabled()));

// —— 7. 等级区间空洞：弹窗点名缺失区间，且一次写请求都没发 ——
const writesBefore = writes.length;
const secondStart = page.locator('input[aria-label="第 2 档起点"]');
await secondStart.fill("43");
await secondStart.blur();
await page.getByRole("button", { name: /保存/ }).click();
// 校验失败现在是单键 alertdialog，不是两键 dialog
const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
await dialog.waitFor({ timeout: 10000 });
const dialogText = (await dialog.innerText()).replace(/\s+/g, " ");
check(
  "等级区间空洞时保存被拦下，并点名缺失区间",
  dialogText.includes("34–42") && writes.length === writesBefore,
  `dialog=${JSON.stringify(dialogText.slice(0, 70))} writes=${writes.length}`,
);
await page.getByRole("button", { name: "返回修改" }).click();
await dialog.waitFor({ state: "detached" });

// —— 8. 脏守卫拦站内跳转 ——
await page.getByRole("textbox").nth(1).fill("改了名字但不保存");
await page.waitForTimeout(150);
await page.getByRole("link", { name: /问卷/ }).first().click();
const guard = page.getByRole("dialog");
await guard.waitFor({ timeout: 10000 });
const guardText = (await guard.innerText()).replace(/\s+/g, " ");
check("未保存时点侧栏被确认框拦住", guardText.includes("有未保存的修改"), guardText.slice(0, 40));
await page.getByRole("button", { name: "留下修改" }).click();
await page.waitForTimeout(300);
check("选择「留下修改」后仍停在认证卡页", page.url().includes("/cert-content"), page.url());

// —— 9. 整场零写入 ——
check(
  "整场没有发出任何写请求（生产数据零改动）",
  writes.length === 0,
  writes.length ? writes.join(", ") : "0 writes",
);
check("页面无脚本异常", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
