/**
 * 雨夜书房 · 雨丝帧序列生成器（视频叠加层）。
 *
 * 逐帧计算雨丝位置（种子化伪随机，可复现），内联 SVG 由 Chromium 离屏栅格化
 * 为带透明通道的 PNG 帧。生成 API 不可用（code 3706），本工具是确定性替代。
 *
 * 用法：pnpm exec node study-room/tools/gen-rain-frames.mjs [帧数=90]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const FRAMES = Number(process.argv[2] ?? 90); // 12s @30fps
const W = 1600;
const H = 1000;
const outDir = new URL("../video-frames/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

/** mulberry32：种子化伪随机，同种子同帧序列。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 固定一组雨丝：每滴有初始位置、长度、速度倍率、亮度。
const rand = mulberry32(20261114);
const drops = Array.from({ length: 260 }, () => ({
  x: rand() * W,
  y: rand() * H,
  len: 16 + rand() * 30,
  speed: 0.8 + rand() * 0.8,
  alpha: 0.08 + rand() * 0.16,
  width: 1 + rand() * 1.2,
}));
// 风向斜率（雨向左下落）。
const SLANT = -0.22;
const FRAME_STEP = 26; // 每帧下落像素（30fps ≈ 780px/s，视觉偏快但叠加层淡）

function rainSvg(frame) {
  const parts = [];
  for (const d of drops) {
    const y = ((d.y + frame * FRAME_STEP * d.speed) % (H + 60)) - 30;
    const x = ((((d.x + frame * FRAME_STEP * d.speed * SLANT) % (W + 40)) + W + 40) % (W + 40)) - 20;
    const x2 = x + SLANT * d.len;
    const y2 = y + d.len;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
        `stroke="#dfeaf6" stroke-opacity="${d.alpha.toFixed(3)}" stroke-width="${d.width.toFixed(2)}" stroke-linecap="round"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g>${parts.join("")}</g></svg>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

for (let frame = 0; frame < FRAMES; frame += 1) {
  await page.setContent(rainSvg(frame));
  const out = join(outDir, `rain${String(frame).padStart(3, "0")}.png`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
}

await browser.close();
console.log(`完成：${FRAMES} 帧 → ${outDir}`);
