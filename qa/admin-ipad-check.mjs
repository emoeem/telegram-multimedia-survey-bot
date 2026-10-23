/**
 * 平板（iPad）适配验收。
 *
 * 之前这一项是「没法验证」：`pointer: coarse` 只有 Chromium 模拟，真机 Safari
 * 我没碰过。现在至少把引擎这一层补上——优先用 Playwright 的 WebKit（Safari 的
 * 内核）跑，跑不了就退回 Chromium 并**如实标注引擎**，不假装是 Safari。
 *
 * 断言（810 = iPad 竖屏，落在 640–999 的图标轨区间）：
 *  1. 页面没有横向溢出（表格宽了要滚在容器里，不是整页跟着滚）
 *  2. 表格容器自身 overflow-x 可滚（宽表在平板上仍可读全）
 *  3. `pointer: coarse` 命中，且所有可点元素热区 ≥ 44×44
 *  4. 图标轨下每个导航项仍有可读名字
 *
 * 用法：node qa/admin-ipad-check.mjs [--headed]
 * 前提：先 `pnpm --dir admin build`。
 */
// 这台机器是 Arch/CachyOS，Playwright 的 WebKit 只认 libicu74 / libxml2.so.2 /
// libflite，Arch 上是 icu76 / libxml2.so.16。装系统包要 root，所以把 Ubuntu 的
// 三个包解到 `~/.local/lib/webkit-deps`，再拷进 WebKit 自带的
// `minibrowser-*/sys/lib`（内层 wrapper 会重置 LD_LIBRARY_PATH，只能放进它自己
// 的目录）。因此需要跳过 Playwright 的主机校验，否则启动前就被拦下。
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= "1";

import { readFileSync, readdirSync } from "node:fs";
import { chromium, devices, webkit } from "playwright";
import { startAdminStub } from "./lib/admin-stub.mjs";

const HEADED = process.argv.includes("--headed");
const stub = await startAdminStub();
const ORIGIN = stub.origin;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function pickEngine() {
  try {
    const browser = await webkit.launch({ headless: !HEADED });
    return { browser, engine: "webkit", label: "WebKit（Safari 内核）" };
  } catch (error) {
    const browser = await chromium.launch({ headless: !HEADED });
    return {
      browser,
      engine: "chromium",
      label: `Chromium（WebKit 不可用：${String(error).split("\n")[0].slice(0, 80)}）`,
    };
  }
}

const { browser, engine, label } = await pickEngine();
console.log(`引擎：${label}\n`);

const VIEWPORTS = [
  { width: 810, height: 1080, name: "iPad 竖屏" },
  { width: 1024, height: 768, name: "iPad 横屏" },
  { width: 768, height: 1024, name: "iPad mini 竖屏" },
];

const problems = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    ...devices["iPad (gen 7)"],
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${viewport.name}: ${error.message}`));
  await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "报告归档" }).waitFor();

  const layout = await page.evaluate(() => {
    const table = document.querySelector(".tbl");
    const container = table?.parentElement;
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
      containerWidth: container ? Math.round(container.getBoundingClientRect().width) : null,
      containerOverflowX: container ? getComputedStyle(container).overflowX : null,
      containerScrollable: container ? container.scrollWidth - container.clientWidth : null,
      navHiddenText: (() => {
        const span = document.querySelector("nav.admin-nav a span:not(.absolute)");
        return span ? getComputedStyle(span).display === "none" : null;
      })(),
      navUnnamed: Array.from(document.querySelectorAll("nav.admin-nav a")).filter(
        (anchor) => !(anchor.getAttribute("aria-label") ?? "").trim(),
      ).length,
      // 图标轨下导航是否装得下：`aside` 高度 = 视口高度才算"固定框"，`nav` 的
      // scrollHeight 超过 clientHeight 就是有图标被挤到滚动区里——平板上滚动找
      // 入口等于没有入口，所以这条必须是零。
      asideHeight: Math.round(document.querySelector("aside").getBoundingClientRect().height),
      navClient: document.querySelector("nav.admin-nav").clientHeight,
      navScroll: document.querySelector("nav.admin-nav").scrollHeight,
      navItems: document.querySelectorAll("nav.admin-nav a").length,
      navItemHeight: Math.round(document.querySelector("nav.admin-nav a").getBoundingClientRect().height),
    };
  });

  check(
    `${viewport.name} 侧栏固定在视口内`,
    layout.asideHeight === viewport.height,
    `aside=${layout.asideHeight} / 视口=${viewport.height}`,
  );
  check(
    `${viewport.name} 图标轨下导航不需要滚动`,
    layout.navScroll - layout.navClient <= 1,
    `${layout.navItems} 项 × ${layout.navItemHeight}px · 内容 ${layout.navScroll} / 可视 ${layout.navClient} · 溢出 ${Math.max(0, layout.navScroll - layout.navClient)}px`,
  );

  check(`${viewport.name} 命中 pointer: coarse`, layout.coarse === true, String(layout.coarse));
  check(`${viewport.name} 页面无横向溢出`, layout.docOverflow <= 1, `overflow=${layout.docOverflow}`);
  check(
    `${viewport.name} 宽表格滚在容器里`,
    layout.containerOverflowX === "auto",
    `overflowX=${layout.containerOverflowX} 表格 ${layout.tableWidth} / 容器 ${layout.containerWidth} / 可滚 ${layout.containerScrollable}px`,
  );
  check(
    `${viewport.name} 图标轨下导航项都有名字`,
    layout.navUnnamed === 0,
    `unnamed=${layout.navUnnamed}${layout.navHiddenText ? "（文字被隐藏，靠 aria-label）" : ""}`,
  );

  const small = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        'button, .btn, .btn-sm, .btn-icon, select, input[type="checkbox"], input[type="color"], a.survey-header-pill',
      ),
    ).filter((element) => element.getBoundingClientRect().width > 0);
    return nodes
      .map((element) => {
        // 复选框靠 .hit-target 撑开热区，量外层
        const target = element.closest(".hit-target") ?? element;
        const box = target.getBoundingClientRect();
        return {
          text: (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 18),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      })
      .filter((item) => item.width < 44 || item.height < 44);
  });
  check(
    `${viewport.name} 可点元素热区 ≥ 44×44`,
    small.length === 0,
    small.length ? JSON.stringify(small.slice(0, 5)) : "全部达标",
  );

  await page.screenshot({ path: `qa/artifacts/ipad-${viewport.width}.png`, fullPage: false });
  await context.close();
}

/* --------------- 紧凑轨的「更多」面板：触屏上必须好用，不只是存在 --------- */
{
  // 1024x768（iPad 横屏）是唯一落进紧凑模式的档位：装不下 17 个 44px 图标。
  const context = await browser.newContext({
    ...devices["iPad (gen 7)"],
    viewport: { width: 1024, height: 768 },
  });
  await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`更多面板: ${error.message}`));
  await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "报告归档" }).waitFor();

  const trigger = page.locator("[aria-controls='admin-rail-more']");
  check("横屏 紧凑模式下有「更多」触发器", (await trigger.count()) === 1);
  await trigger.click();
  const panel = page.locator("#admin-rail-more");
  await panel.waitFor();

  const entries = await panel.locator("a").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        name: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(),
        width: Math.round(box.width),
        height: Math.round(box.height),
        right: Math.round(box.right),
      };
    }),
  );
  check("横屏 面板收齐后两组 + 快捷入口", entries.length === 9, `entries=${entries.length}`);
  check(
    "横屏 面板条目热区 ≥ 44×44",
    entries.every((entry) => entry.width >= 44 && entry.height >= 44),
    JSON.stringify(entries.map((entry) => `${entry.name}:${entry.width}x${entry.height}`)),
  );
  check(
    "横屏 面板整体在视口内（不越出右边界）",
    entries.every((entry) => entry.right <= 1024),
    `maxRight=${Math.max(...entries.map((entry) => entry.right))}`,
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(
    "横屏 Esc 关闭面板并把焦点还给触发器",
    (await panel.count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")) === "更多",
  );

  await trigger.click();
  await panel.locator("a").filter({ hasText: "审计" }).click();
  await page.waitForURL(/\/admin\/audit$/);
  check("横屏 面板里的条目真的可达（审计）", page.url().endsWith("/admin/audit"), page.url());
  await page.screenshot({ path: "qa/artifacts/ipad-1024-more-panel.png" });
  await context.close();
}

/* --------------- 构建产物：可移植性相关声明真的发布到了线上 CSS ------------- */
{
  // 这里量的是「构建后还在不在」。上一版我写过 `height: 100vh` 兜底，被
  // lightningcss 按 baseline 目标（Safari 16.4 起）裁掉了——源码里看得到、
  // 产物里没有，属于「声称修了实际没修」。所以断言只认 dist。
  const dir = "admin/dist/assets";
  const css = readdirSync(dir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(`${dir}/${file}`, "utf-8"))
    .join("\n");
  check(
    "产物里侧栏底部让出安全区（env(safe-area-inset-bottom)）",
    /\.admin-sidebar\{[^}]*safe-area-inset-bottom/.test(css),
  );
  check(
    "产物里侧栏高度是 dvh（h-dvh → 100dvh），不是 vh",
    /h-dvh\{height:100dvh\}/.test(css) && !/\.h-dvh\{height:100vh\}/.test(css),
  );
}

check("全程无脚本异常", problems.length === 0, problems.join(" | "));

await browser.close();
stub.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n引擎=${engine} · ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
