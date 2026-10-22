/**
 * 侧栏在 900px 高窗口里「装得下、够得到」的验收。
 *
 * 这一轮修的不是样式，是结构：侧栏原来是 `sm:static`，高度由正文撑开
 * （1440x900 下实测 1118px），底部两个入口和环境行被推出视口，而 nav 的
 * scrollHeight 恒等于 clientHeight —— 它根本没有内部滚动，滚动的是整页。
 * 所以本脚本量的是三件不同的事：
 *   1. 侧栏是不是固定成视口高度的框（sticky + h-dvh）
 *   2. nav 自身是否零滚动（内容真的装得下，不是被拉伸后看起来装得下）
 *   3. 底部入口是否落在视口内（aside.bottom <= innerHeight）
 *
 * 用法：node qa/admin-nav-900-check.mjs [--headed]
 * 前提：先 `pnpm --dir admin build`。
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startAdminStub } from "./lib/admin-stub.mjs";

const HEADED = process.argv.includes("--headed");
const stub = await startAdminStub();
const ORIGIN = stub.origin;
const OUT = "qa/artifacts";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: !HEADED });
const problems = [];

const probe = () => {
  // Link 渲染成 /admin/xxx，footer 是 /xxx：去掉前缀再比，否则去重断言是空跑
  const normalize = (href) => new URL(href, location.origin).pathname.replace(/^\/admin(?=\/|$)/, "") || "/";
  const nav = document.querySelector("nav.admin-nav");
  const aside = document.querySelector("aside");
  const footer = nav?.nextElementSibling;
  const groups = [...(nav?.children ?? [])].map((group) => {
    const toggle = group.querySelector(".admin-nav-toggle");
    const items = group.querySelector("[id^='nav-group-']");
    return {
      label: (toggle?.textContent ?? group.querySelector(".admin-nav-label")?.textContent ?? "").trim(),
      expanded: toggle ? toggle.getAttribute("aria-expanded") : null,
      itemsDisplay: items ? getComputedStyle(items).display : null,
      links: items ? items.querySelectorAll("a").length : 0,
    };
  });
  const links = [...document.querySelectorAll("nav.admin-nav a")];
  return {
    vh: window.innerHeight,
    docH: document.scrollingElement.scrollHeight,
    docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    asidePosition: aside ? getComputedStyle(aside).position : null,
    asideTop: aside ? Math.round(aside.getBoundingClientRect().top) : null,
    asideBottom: aside ? Math.round(aside.getBoundingClientRect().bottom) : null,
    asideHeight: aside ? Math.round(aside.getBoundingClientRect().height) : null,
    navClient: nav ? Math.round(nav.clientHeight) : null,
    navScroll: nav ? Math.round(nav.scrollHeight) : null,
    navOverflow: nav ? Math.round(nav.scrollHeight - nav.clientHeight) : null,
    // 内容装得下时 scrollHeight === clientHeight，看不出还剩多少余量。
    // 临时把 nav 改成按内容撑开，量到真实内容高度后还原。
    navContent: (() => {
      if (!nav) return null;
      const previous = nav.getAttribute("style") ?? "";
      nav.style.flex = "0 0 auto";
      nav.style.height = "max-content";
      const content = Math.round(nav.scrollHeight);
      if (previous) nav.setAttribute("style", previous);
      else nav.removeAttribute("style");
      return content;
    })(),
    navOverflowY: nav ? getComputedStyle(nav).overflowY : null,
    footerBottom: footer ? Math.round(footer.getBoundingClientRect().bottom) : null,
    footerHrefs: footer ? [...footer.querySelectorAll("a")].map((a) => normalize(a.getAttribute("href"))) : [],
    navHrefs: links.map((a) => normalize(a.getAttribute("href"))),
    moreTriggers: document.querySelectorAll("[aria-controls='admin-rail-more']").length,
    // 折叠组里的链接高度是 0（display:none），只量真正渲染出来的行
    linkHeights: [...new Set(links.map((a) => Math.round(a.getBoundingClientRect().height)).filter((h) => h > 0))],
    toggles: document.querySelectorAll(".admin-nav-toggle").length,
    groups,
  };
};

async function openPage(context, path, viewport) {
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1, main").first().waitFor();
  await page.waitForTimeout(300);
  return page;
}

/* ------------------------------------------------ 900px 高：装得下 ------ */
for (const [width, height] of [
  [1440, 900],
  [1280, 900],
]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await openPage(ctx, "/admin");
  const m = await page.evaluate(probe);

  check(
    `${width}x${height} 侧栏固定成视口高度的框（sticky + dvh）`,
    m.asidePosition === "sticky" && Math.abs(m.asideHeight - height) <= 1,
    `position=${m.asidePosition} height=${m.asideHeight} vh=${m.vh}`,
  );
  check(
    `${width}x${height} 导航零内部滚动（真的装得下）`,
    m.navOverflow <= 1 && m.navScroll <= m.navClient + 1,
    `scrollHeight=${m.navScroll} clientHeight=${m.navClient} overflow=${m.navOverflow}`,
  );
  // 「刚好装下」等于没装下：+1 个菜单项就破了。留 20px 才算有真实余量。
  check(
    `${width}x${height} 导航余量 ≥ 20px（不是刚好卡住）`,
    m.navClient - m.navContent >= 20,
    `client=${m.navClient} content=${m.navContent} 余量=${m.navClient - m.navContent}`,
  );
  check(
    `${width}x${height} 底部快捷入口落在视口内`,
    m.footerBottom !== null && m.footerBottom <= m.vh + 1,
    `footerBottom=${m.footerBottom} vh=${m.vh}`,
  );
  check(`${width}x${height} 侧栏顶到视口顶部`, m.asideTop === 0, `top=${m.asideTop}`);
  check(
    `${width}x${height} 默认只折叠「系统」，「内容」保持展开`,
    m.groups.find((g) => g.label === "系统")?.expanded === "false" &&
      m.groups.find((g) => g.label === "内容")?.expanded === "true" &&
      m.groups.every((g) => (g.label === "系统" ? g.itemsDisplay === "none" : g.itemsDisplay !== "none")),
    JSON.stringify(m.groups),
  );
  check(
    `${width}x${height} 折叠组的条目不在 tab 序里（display:none）`,
    (() => {
      const folded = m.groups.filter((g) => g.expanded === "false");
      return folded.length > 0 && folded.every((g) => g.itemsDisplay === "none");
    })(),
    JSON.stringify(m.groups.filter((g) => g.expanded === "false")),
  );
  check(
    `${width}x${height} 导航项行高为 40px（桌面指针，不是触屏 44）`,
    m.linkHeights.length === 1 && m.linkHeights[0] === 40,
    `heights=${JSON.stringify(m.linkHeights)}`,
  );
  check(`${width}x${height} 无横向溢出`, m.docOverflowX <= 1, `overflowX=${m.docOverflowX}`);

  if (width === 1440) {
    // 去重：同一 href 不该在侧栏里出现两次（/plaza /showcase 曾经一内一外各一份）
    const all = [...m.navHrefs, ...m.footerHrefs];
    const dupes = all.filter((href, index) => all.indexOf(href) !== index);
    check(
      "侧栏内没有重复链接（footer 与 nav 不指向同一页）",
      dupes.length === 0,
      `dupes=${JSON.stringify(dupes)} 全部=${JSON.stringify(all)}`,
    );

    const labels = await page.evaluate(() => {
      const pick = (suffix) =>
        [...document.querySelectorAll("aside a")]
          .filter((a) => new URL(a.getAttribute("href"), location.origin).pathname.endsWith(suffix))
          .map((a) => (a.getAttribute("aria-label") ?? a.textContent ?? "").trim());
      return { taskPacks: pick("/task-packs"), trial: pick("/trial") };
    });
    check(
      "两个「挑战任务」不再同名不同页（nav=任务包 / footer=挑战任务）",
      labels.taskPacks[0] === "任务包" && labels.trial[0] === "挑战任务",
      JSON.stringify(labels),
    );

    await page.screenshot({ path: `${OUT}/nav-1440-900.png` });
  }
  await ctx.close();
}

/* ----------------------------------------- 800px 高：改走紧凑模式 ------ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, "/admin");
  const m = await page.evaluate(probe);
  // 800px 高的窗口装不下 17 项（实测溢出约 95px）。上一版的做法是「折叠后装下」，
  // 这一版改成结构性的：只铺开前两组，其余收进「更多」面板——少一次「先滚再找」。
  check("1280x800 走紧凑模式（nav 零滚动）", m.navOverflow <= 1, `overflow=${m.navOverflow}`);
  check("1280x800 只铺开前两组（10 项）", m.navHrefs.length === 10, `links=${m.navHrefs.length}`);
  check("1280x800 出现「更多」触发器", m.moreTriggers === 1, `triggers=${m.moreTriggers}`);

  const more = page.locator("[aria-controls='admin-rail-more']");
  await more.click();
  const panel = page.locator("#admin-rail-more");
  await panel.waitFor();
  const panelLinks = await panel.locator("a").evaluateAll((nodes) =>
    nodes.map((node) => ({
      href: new URL(node.getAttribute("href") ?? "", location.origin).pathname.replace(/^\/admin(?=\/|$)/, "") || "/",
      h: Math.round(node.getBoundingClientRect().height),
      name: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(),
    })),
  );
  check("「更多」面板收齐后两组 + 快捷入口", panelLinks.length === 9, `entries=${panelLinks.length}`);
  check(
    "面板条目都有名字",
    panelLinks.length > 0 && panelLinks.every((link) => link.name.length > 0),
    JSON.stringify(panelLinks.map((link) => link.name)),
  );
  check(
    "面板条目可点高度 ≥ 40px（触屏 44）",
    panelLinks.every((link) => link.h >= 40),
    `heights=${JSON.stringify(panelLinks.map((link) => link.h))}`,
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(
    "Esc 关闭面板并把焦点还给触发器",
    (await panel.count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")) === "更多",
  );

  await more.click();
  await panel.locator("a").filter({ hasText: "审计" }).click();
  await page.waitForURL(/\/admin\/audit$/);
  check("面板里的条目真的可达（审计）", page.url().endsWith("/admin/audit"), page.url());
  await page.screenshot({ path: `${OUT}/nav-1280-800-compact.png` });
  await ctx.close();
}

/* ------------------------------------------------ 自动展开 + 持久化 ------ */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await openPage(ctx, "/admin/audit");
  const deep = await page.evaluate(probe);
  const system = deep.groups.find((g) => g.label === "系统");
  check(
    "深链接 /admin/audit 自动展开「系统」并高亮当前项",
    system?.expanded === "true" && system?.itemsDisplay !== "none",
    JSON.stringify(system),
  );
  const current = await page.evaluate(() =>
    document.querySelector("nav.admin-nav a[aria-current='page']")?.getAttribute("aria-label"),
  );
  check("当前页的导航项带 aria-current", current === "审计", String(current));

  // 折叠「内容」后应当跨刷新保留
  await page.locator(".admin-nav-toggle").filter({ hasText: "内容" }).click();
  await page.waitForTimeout(150);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("h1, main").first().waitFor();
  await page.waitForTimeout(300);
  const reloaded = await page.evaluate(probe);
  check(
    "折叠状态跨刷新保留",
    reloaded.groups.find((g) => g.label === "内容")?.expanded === "false" &&
      reloaded.groups.find((g) => g.label === "系统")?.expanded === "true",
    JSON.stringify(reloaded.groups.map((g) => [g.label, g.expanded])),
  );

  // 键盘：聚焦按钮并回车，能翻转
  const toggle = page.locator(".admin-nav-toggle").filter({ hasText: "内容" });
  await toggle.focus();
  const beforeKey = await toggle.getAttribute("aria-expanded");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const afterKey = await toggle.getAttribute("aria-expanded");
  check("键盘 Enter 可翻转折叠", beforeKey !== afterKey, `${beforeKey} → ${afterKey}`);
  const focusRing = await toggle.evaluate((el) => getComputedStyle(el).outlineStyle);
  check("折叠按钮有可见焦点样式", focusRing !== "none", `outline=${focusRing}`);
  await ctx.close();
}

/* ------------------------------------------------------- 图标轨 820 ------ */
{
  const ctx = await browser.newContext({ viewport: { width: 820, height: 700 } });
  const page = await openPage(ctx, "/admin");
  const rail = await page.evaluate(probe);
  check(
    "图标轨下不渲染折叠按钮（否则只剩一个无名小箭头）",
    rail.toggles === 0 && rail.groups.every((g) => g.expanded === null),
    `toggles=${rail.toggles} groups=${JSON.stringify(rail.groups.map((g) => [g.label, g.expanded]))}`,
  );
  // 700px 高的图标轨同样装不下 17 个 44px 的图标（内容 777 / 可视约 500），
  // 所以这里也是紧凑模式：10 个常用 + 「更多」面板。
  check(
    "图标轨（矮窗口）零滚动，其余条目收进「更多」",
    rail.navOverflow <= 1 && rail.navHrefs.length === 10 && rail.moreTriggers === 1,
    `links=${rail.navHrefs.length} triggers=${rail.moreTriggers} overflow=${rail.navOverflow}`,
  );
  const names = await page.evaluate(
    () =>
      [...document.querySelectorAll("nav.admin-nav a")].filter((a) => !(a.getAttribute("aria-label") ?? "").trim())
        .length,
  );
  check("图标轨下每个条目仍有名字", names === 0, `unnamed=${names}`);
  await page.screenshot({ path: `${OUT}/nav-rail-820.png` });
  await ctx.close();
}

check("无脚本异常", problems.length === 0, problems.slice(0, 4).join(" | "));

await browser.close();
stub.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
