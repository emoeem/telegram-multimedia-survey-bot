/**
 * 认证卡内容页的浏览器验收（批次 A）。
 *
 * 为什么要跑真浏览器而不是只看单测：这一批修的全是**交互闭环**问题，
 * 单测能证明“校验函数返回了什么”，证明不了“输入框还活着”“点了保存有没有真的发请求”。
 *
 * 覆盖 5 条，每条都对应审计里的一个具体缺陷：
 *  1. 主题 ID 可编辑（旧实现敲一个字符就整块表单消失）
 *  2. 非法 ID 标红 + 禁保存，且不误发请求
 *  3. 等级区间有空洞时保存被弹窗拦下，且 **PUT 一次都没发**
 *  4. 改回合法值后能保存成功，且提交体里的 rank 数值与服务端契约一致
 *  5. 有未保存修改时点侧栏跳转会被确认框拦住
 * 另加一条深色主题的边框色实测（--color-border 未定义 → currentColor → 发白）。
 *
 * 用法：node qa/cert-content-check.mjs [--headed]
 * 前提：先 `pnpm --dir admin build`（脚本直接吃 admin/dist）。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const DIST = join(process.cwd(), "admin", "dist");
const HEADED = process.argv.includes("--headed");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** 初始内容包：一套百分制主题，等级区间合法（0–33 / 34–100）。 */
const pack = {
  version: 1,
  themes: [
    {
      id: "worker",
      name: "打工人执业认证",
      cardLabel: "执业资格证",
      issuer: "全国打工人执业资格认证中心",
      subtitle: "CERTIFICATE OF EMPLOYMENT",
      sealText: "打工人执业认证专用章",
      palette: {
        primary: "#1e3a8a",
        primary2: "#2563eb",
        accent: "#f59e0b",
        ink: "#0f172a",
        muted: "#64748b",
        paper: "#f7f9fc",
      },
      tags: ["摸鱼时长超标", "加班抗性拉满"],
      groups: [{ name: "职场日常", emoji: "💼", tags: ["摸鱼时长超标", "加班抗性拉满"] }],
      ranks: [
        { min: 0, max: 33, name: "青铜" },
        { min: 34, max: 100, name: "王者" },
      ],
    },
  ],
};

const requests = [];
let putBody = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  requests.push(`${req.method} ${url.pathname}`);

  if (url.pathname === "/api/admin/cert-content") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pack }));
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      putBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pack: putBody }));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // 其余 /api/* 一律给一个空壳，避免页面上的次要请求把断言带偏。
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let filePath = url.pathname;
  if (!extname(filePath)) filePath = "/index.html";
  try {
    const body = await readFile(join(DIST, filePath));
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    const body = await readFile(join(DIST, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(body);
  }
});

const PORT = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const ORIGIN = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 深色主题：边框色只有在深色下才暴露 currentColor 退化的后果。
await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.goto(`${ORIGIN}/admin/cert-content`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "认证卡内容" }).waitFor();

// —— 1. 主题 ID 可编辑（回归：旧实现敲一个字符表单就消失）——
const idInput = page.locator("input[aria-invalid], .form-control input").first();
await idInput.fill("worker-2");
await page.waitForTimeout(120);
const stillEditing = (await page.getByText("没有可选主题").count()) === 0;
const idValue = await idInput.inputValue();
check("主题 ID 可以连续编辑，表单不会消失", stillEditing && idValue === "worker-2", `value=${idValue}`);

// —— 2. 非法 ID：标红 + 禁保存 + 不发请求 ——
const putsBefore = requests.filter((r) => r.startsWith("PUT")).length;
await idInput.fill("主题一");
await page.waitForTimeout(120);
const idErrorVisible = await page.locator("#theme-id-error").isVisible();
const saveDisabled = await page.getByRole("button", { name: /保存/ }).isDisabled();
const invalidClass = await idInput.getAttribute("class");
check(
  "非法 ID 标红并禁用保存",
  idErrorVisible && saveDisabled && (invalidClass ?? "").includes("color-mix"),
  `error=${idErrorVisible} disabled=${saveDisabled}`,
);
await idInput.fill("worker-2");
await page.waitForTimeout(120);
check("ID 改回合法后保存按钮恢复", !(await page.getByRole("button", { name: /保存/ }).isDisabled()));

// —— 3. 等级区间空洞：弹窗拦下，且没有发 PUT ——
const secondStart = page.locator('input[aria-label="第 2 档起点"]');
await secondStart.fill("43");
await secondStart.blur();
await page.getByRole("button", { name: /保存/ }).click();
// 校验失败现在是单键 alertdialog，不是两键 dialog
const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
await dialog.waitFor();
const dialogText = await dialog.innerText();
const putsAfterBlocked = requests.filter((r) => r.startsWith("PUT")).length;
check(
  "等级区间空洞时保存被拦下，并点名缺失区间",
  dialogText.includes("34–42") && putsAfterBlocked === putsBefore,
  `dialog=${JSON.stringify(dialogText.replace(/\s+/g, " ").slice(0, 80))} puts=${putsAfterBlocked}`,
);
check(
  "校验失败用的是单键 alertdialog（不是两个按钮做同一件事）",
  (await dialog.getAttribute("role")) === "alertdialog" && (await dialog.getByRole("button").count()) === 1,
  `role=${await dialog.getAttribute("role")} buttons=${await dialog.getByRole("button").count()}`,
);
// Esc 关掉：键盘用户不必去够鼠标
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
check("Esc 可以关掉提示框", (await dialog.count()) === 0);
await page.getByRole("button", { name: /保存/ }).click();
await dialog.waitFor();
await page.getByRole("button", { name: "返回修改" }).click();
await dialog.waitFor({ state: "detached" });

// —— 4. 修好后保存成功，提交体里 rank 与契约一致 ——
await secondStart.fill("34");
await secondStart.blur();
await page.getByRole("button", { name: /保存/ }).click();
await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
const ranks = putBody?.themes?.[0]?.ranks;
check(
  "修正后保存成功，PUT 体里 rank 为 0–33 / 34–100",
  JSON.stringify(ranks) ===
    JSON.stringify([
      { min: 0, max: 33, name: "青铜" },
      { min: 34, max: 100, name: "王者" },
    ]),
  JSON.stringify(ranks),
);
check("保存只发了一次 PUT", requests.filter((r) => r.startsWith("PUT")).length === putsBefore + 1);

// —— 5. 脏状态拦截侧栏跳转 ——
await page.getByRole("textbox").nth(1).fill("改了名字但不保存"); // 主题名称
await page.waitForTimeout(120);
await page.getByRole("link", { name: /问卷/ }).first().click();
const guard = page.getByRole("dialog");
await guard.waitFor();
const guardText = await guard.innerText();
check("未保存时点侧栏被确认框拦住", guardText.includes("有未保存的修改"), guardText.replace(/\s+/g, " ").slice(0, 40));
await page.getByRole("button", { name: "留下修改" }).click();
check("选择「留下修改」后仍停在认证卡页", page.url().includes("/cert-content"), page.url());

// —— 6. 深色下边框不再是 currentColor（旧 --color-border 未定义）——
const asideBorder = await page.evaluate(() => {
  const aside = document.querySelector("aside.rounded-surface");
  return aside ? getComputedStyle(aside).borderTopColor : null;
});
const channels =
  (asideBorder ?? "")
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number) ?? [];
check(
  "深色主题下侧栏边框是深灰而不是近白（currentColor 退化已修好）",
  channels.length === 3 && Math.max(...channels) < 200,
  `borderTopColor=${asideBorder}`,
);

check("页面无脚本异常", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
