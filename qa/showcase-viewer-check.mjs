/**
 * 展示区查看层回归（QA，不进 CI）：图片 / 音频 / 视频 / 长文 四种作品点开后
 * 都能正常看，且没有横向溢出。
 *
 *   node qa/make-showcase-media-fixtures.mjs                     # 生成样本 + seed
 *   npx wrangler d1 execute DB --local --file=qa/showcase-media-seed.sql
 *   XDG_CONFIG_HOME=$PWD/.tmp-config npx wrangler dev --port 8787 --local
 *   node qa/showcase-viewer-check.mjs
 *
 * 断言：卡片按类型显示正确的动作提示；点开后出现对应节点（img / audio / video /
 * 正文），媒体地址走 /api/showcase/media/:id，页面与查看层都不产生横向滚动。
 */
import { chromium } from "playwright";

const base = process.env.BASE ?? "http://127.0.0.1:8787";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const failures = [];

await page.goto(base + "/showcase", { waitUntil: "networkidle" });
await page.waitForSelector(".showcase-figure");

const openSheet = async () => {
  if ((await page.locator('.showcase-sheet-root[data-open="true"]').count()) === 0) {
    await page.locator(".showcase-figure").first().click();
    await page.waitForTimeout(600);
  }
};

const findCard = async (title) => {
  const cards = page.locator(".showcase-work-main");
  const total = await cards.count();
  for (let index = 0; index < total; index += 1) {
    const text = await cards.nth(index).locator(".showcase-work-title").innerText();
    if (text.trim() === title) return cards.nth(index);
  }
  return null;
};

const noHorizontalOverflow = async (label) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) failures.push(label + " 出现横向滚动：" + overflow + "px");
};

const cases = [
  { title: "海报：长夜将明", action: "查看大图", selector: ".showcase-viewer-image img", shot: "qa/showcase-viewer-image.png", media: true },
  { title: "朗读：长夜将明（试听片段）", action: "播放音频", selector: ".showcase-viewer-audio audio", shot: "qa/showcase-viewer-audio.png", media: true },
  { title: "幕后：写长夜的那一周", action: "播放视频", selector: ".showcase-viewer-video video", shot: "qa/showcase-viewer-video.png", media: true },
  { title: "长夜将明", action: "阅读全文", selector: ".showcase-viewer-body", shot: "qa/showcase-viewer-article.png", media: false },
];

for (const item of cases) {
  await openSheet();
  const card = await findCard(item.title);
  if (!card) {
    failures.push("资料面板里找不到作品：" + item.title);
    continue;
  }
  const hint = await card.locator(".showcase-work-more").innerText().catch(() => "");
  if (!hint.includes(item.action)) failures.push(item.title + " 的卡片提示应为「" + item.action + "」，实际：" + hint);

  await card.click();
  await page.waitForSelector(item.selector, { timeout: 5000 });
  await page.waitForTimeout(450);

  const state = await page.locator(item.selector).evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    src: el.getAttribute("src") ?? el.querySelector("img,video,audio")?.getAttribute("src") ?? "",
    readyState: typeof el.readyState === "number" ? el.readyState : null,
    width: el.getBoundingClientRect().width,
    naturalWidth: el.naturalWidth ?? null,
  }));

  if (item.media && !/\/api\/showcase\/media\/\d+/.test(state.src)) {
    failures.push(item.title + " 的媒体地址不是授权路由：" + state.src);
  }
  if (item.selector.includes("img") && !(state.naturalWidth > 0)) {
    failures.push(item.title + " 的图片没有真正加载（naturalWidth=" + state.naturalWidth + "）");
  }
  if (item.selector.includes("img") === false && item.media === false) {
    // 文字作品：feed 只给 280 字预览，查看层必须是完整正文。
    const bodyLength = (await page.locator(item.selector).innerText()).length;
    if (bodyLength <= 280) failures.push(item.title + " 的查看层没拿到完整正文（" + bodyLength + " 字）");
  }
  if (item.selector.includes("audio") && (state.readyState ?? 0) < 1) {
    failures.push(item.title + " 的音频没有加载出元数据（readyState=" + state.readyState + "）");
  }
  if (state.width > 390) failures.push(item.title + " 的查看层内容比视口宽：" + state.width);
  await noHorizontalOverflow(item.title);

  await page.screenshot({ path: item.shot });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  if ((await page.locator(".showcase-viewer").count()) !== 0) failures.push(item.title + " 按 Esc 没有关闭查看层");
  if ((await page.locator('.showcase-sheet-root[data-open="true"]').count()) !== 1) {
    failures.push(item.title + " 关查看层时把资料面板一起关了");
  }
}

if (errors.length > 0) failures.push("页面报错: " + errors.join("; "));
if (failures.length > 0) {
  console.error("FAILED:\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("OK: 图片 / 音频 / 视频 / 长文 四种作品均可正常查看，无横向溢出");
}
await browser.close();
