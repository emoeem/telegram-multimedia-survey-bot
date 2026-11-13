/**
 * 雨夜书房 · 插画栅格化工具。
 *
 * art-svg/*.svg（成套美术系统的手作矢量插画）→ art/*.png（与 asset-plan.json
 * 的路径与尺寸一一对应）。用仓库自带的 Playwright Chromium 离屏渲染：
 * 生成 API（生图/生视频）在当前账号不可用（code 3706），本脚本是确定性替代。
 *
 * 用法：pnpm exec node study-room/tools/render-art.mjs
 */
import { chromium } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const svgDir = new URL("../art-svg/", import.meta.url).pathname;
const pngDir = new URL("../art/", import.meta.url).pathname;

const svgs = readdirSync(svgDir)
  .filter((name) => name.endsWith(".svg"))
  .sort();
if (svgs.length === 0) {
  console.error("art-svg/ 里没有 SVG");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();

for (const file of svgs) {
  const path = join(svgDir, file);
  // 先读出 SVG 声明的尺寸，设置视口后整页截图，保证 1:1 像素输出。
  const svg = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
  const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
  const height = Number(/height="(\d+)"/.exec(svg)?.[1]);
  if (!width || !height) {
    console.error(`${file}: 缺少 width/height`);
    continue;
  }
  await page.setViewportSize({ width, height });
  await page.goto(`file://${path}`);
  await page.waitForTimeout(60); // 字体/滤镜渲染余量
  const out = join(pngDir, `${basename(file, ".svg")}.png`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
  const size = statSync(out).size;
  console.log(`${file} → ${out} (${width}x${height}, ${(size / 1024).toFixed(0)} KB)`);
}

await browser.close();
console.log(`完成：${svgs.length} 张`);
