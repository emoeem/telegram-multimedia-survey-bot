/**
 * 环形图（donutOption）的渲染验收。
 *
 * 为什么单独有一份：上一轮看到 375px 下「色环只画在左上角一小条」，据此报了一个
 * 并不存在的布局 bug。真因是 ECharts 的入场动画（扇区从 0 长到目标角度，约 1s），
 * 而截图发生在动画开头。这类「结论被采样时机左右」的检查必须靠几何断言 +
 * 确定性等待，不能靠肉眼看图，也不能靠 sleep 猜。
 *
 * 断言：
 *  1. 环是圆的（外接框宽高差 ≤ 3px）——不是被压扁的椭圆
 *  2. 环完整落在 180px 高的画布里（四周留白 ≥ 4px）——不是被裁掉一角
 *  3. 环心落在 option 指定的 center（35%, 50%），偏差 ≤ 4px
 *  4. 圆心数字落在环孔内（不压扇区、不出框）
 *  5. `prefers-reduced-motion: reduce` 下首帧即完整（动画被关掉，不是慢慢长出来）
 *
 * 用法：node qa/admin-chart-check.mjs [--headed]
 * 前提：先 `pnpm --dir admin build`。
 */
import { chromium } from "playwright";
import { startAdminStub } from "./lib/admin-stub.mjs";

const HEADED = process.argv.includes("--headed");
const stub = await startAdminStub();
const ORIGIN = stub.origin;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * 采集环的几何。只认「有 fill 且 path 里带 A（arc）」的 path——图例色块、圆心
 * 数字、labelLine 都不是这种形状，混进来会把外接框撑大。
 */
const GEOMETRY = () => {
  const svg = [...document.querySelectorAll("svg")].find((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 120 && box.height === 180;
  });
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  // 只要扇区：带 arc 指令、有实色填充、且高度超过 20px。
  // 图例色块同样是 `fill` 有色的 path，但只有 12×12——不排除它，外接框会被
  // 右侧图例整体拉宽，环看起来像椭圆（第一版就是这么误判的）。
  const arcs = [...svg.querySelectorAll("path")]
    .map((path) => ({
      d: path.getAttribute("d") ?? "",
      fill: path.getAttribute("fill"),
      box: path.getBoundingClientRect(),
    }))
    .filter(
      (arc) => arc.d.includes("A") && arc.fill && arc.fill !== "none" && arc.box.height > 20 && arc.box.width > 5,
    );
  if (arcs.length === 0) return null;
  const ring = arcs.reduce(
    (acc, arc) => ({
      left: Math.min(acc.left, arc.box.left),
      right: Math.max(acc.right, arc.box.right),
      top: Math.min(acc.top, arc.box.top),
      bottom: Math.max(acc.bottom, arc.box.bottom),
    }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  );
  // 内外半径从 path 的 `A rx ry` 里读，不写死 option 的百分比
  // 圆角用的是 `A4 4`，比内外半径小一个量级，按 >10 排除
  const radii = arcs
    .flatMap((arc) => [...arc.d.matchAll(/A([\d.]+)\s+([\d.]+)/g)].map((match) => Number(match[1])))
    .filter((radius) => radius > 10);
  const texts = [...svg.querySelectorAll("text")].map((node) => ({
    text: (node.textContent ?? "").trim(),
    box: node.getBoundingClientRect(),
  }));
  return {
    svg: { left: box.left, top: box.top, width: box.width, height: box.height },
    arcs: arcs.length,
    radii: {
      inner: radii.length ? Math.min(...radii) : Number.NaN,
      outer: radii.length ? Math.max(...radii) : Number.NaN,
    },
    ring: {
      width: ring.right - ring.left,
      height: ring.bottom - ring.top,
      centerX: (ring.left + ring.right) / 2 - box.left,
      centerY: (ring.top + ring.bottom) / 2 - box.top,
      insetLeft: ring.left - box.left,
      insetRight: box.right - ring.right,
      insetTop: ring.top - box.top,
      insetBottom: box.bottom - ring.bottom,
    },
    texts,
  };
};

/** 动画稳定：连续两次采样几何完全一致才算完成（不靠固定 sleep，也不 eval）。 */
async function waitForChartSettled(page) {
  let previous = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const geometry = await page.evaluate(GEOMETRY);
    if (geometry) {
      const signature = [
        Math.round(geometry.ring.width),
        Math.round(geometry.ring.height),
        Math.round(geometry.ring.centerX),
        Math.round(geometry.ring.centerY),
        geometry.texts.length,
      ].join(":");
      if (signature === previous) return geometry;
      previous = signature;
    }
    await page.waitForTimeout(80);
  }
  return page.evaluate(GEOMETRY);
}

const browser = await chromium.launch({ headless: !HEADED });
const problems = [];
const shot = async (page, file) => {
  await page.screenshot({ path: file, fullPage: false });
};

for (const width of [1280, 375, 320]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${width}: ${error.message}`));
  await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "报告归档" }).waitFor();
  await waitForChartSettled(page);

  const geometry = await page.evaluate(GEOMETRY);
  if (!geometry) {
    check(`@${width} 找到环形图`, false, "没有取到 svg");
    await context.close();
    continue;
  }

  check(`@${width} 4 个状态扇区都画出来`, geometry.arcs === 4, `arcs=${geometry.arcs}`);
  check(
    `@${width} 环是圆的（不是被压扁的椭圆）`,
    Math.abs(geometry.ring.width - geometry.ring.height) <= 3,
    `${geometry.ring.width.toFixed(1)}×${geometry.ring.height.toFixed(1)}`,
  );
  const inset = Math.min(
    geometry.ring.insetLeft,
    geometry.ring.insetRight,
    geometry.ring.insetTop,
    geometry.ring.insetBottom,
  );
  check(`@${width} 环完整落在 180px 画布内（未被裁切）`, inset >= 4, `最小留白 ${inset.toFixed(1)}px`);
  check(
    `@${width} 环心对齐 option 的 center(35%, 50%)`,
    Math.abs(geometry.ring.centerX - geometry.svg.width * 0.35) <= 4 &&
      Math.abs(geometry.ring.centerY - geometry.svg.height * 0.5) <= 4,
    `中心 (${geometry.ring.centerX.toFixed(1)}, ${geometry.ring.centerY.toFixed(1)}) / 期望 (${(geometry.svg.width * 0.35).toFixed(1)}, ${(geometry.svg.height * 0.5).toFixed(1)})`,
  );

  // 圆心标签是「5」+「总计」两行 rich text，比的是这两行合起来的块，
  // 不是「5」这一行自己——单看第一行本来就偏上。
  const labelParts = geometry.texts.filter((item) => /^5$/.test(item.text) || item.text.includes("总计"));
  const label = labelParts.length
    ? labelParts.reduce(
        (acc, item) => ({
          left: Math.min(acc.left, item.box.left),
          right: Math.max(acc.right, item.box.right),
          top: Math.min(acc.top, item.box.top),
          bottom: Math.max(acc.bottom, item.box.bottom),
        }),
        { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
      )
    : null;
  const labelCenter = label
    ? { cx: (label.left + label.right) / 2 - geometry.svg.left, cy: (label.top + label.bottom) / 2 - geometry.svg.top }
    : null;
  check(
    `@${width} 圆心标签（数字+总计）落在环孔中心`,
    Boolean(label) &&
      Boolean(labelCenter) &&
      Math.abs(labelCenter.cx - geometry.ring.centerX) <= 3 &&
      Math.abs(labelCenter.cy - geometry.ring.centerY) <= 3,
    label
      ? `标签块 ${Math.round(label.right - label.left)}×${Math.round(label.bottom - label.top)} @ (${Math.round(labelCenter.cx)}, ${Math.round(labelCenter.cy)})，环心 (${Math.round(geometry.ring.centerX)}, ${Math.round(geometry.ring.centerY)})`
      : "没找到圆心标签",
  );
  check(
    `@${width} 圆心标签装得进环孔（不压扇区）`,
    Boolean(label) &&
      Number.isFinite(geometry.radii.inner) &&
      label.bottom - label.top + 8 <= geometry.radii.inner * 2 &&
      Math.hypot((labelCenter?.cx ?? 0) - geometry.ring.centerX, (labelCenter?.cy ?? 0) - geometry.ring.centerY) +
        (label.bottom - label.top) / 2 <=
        geometry.radii.inner,
    `内半径 ${geometry.radii.inner.toFixed(1)} / 标签高 ${label ? Math.round(label.bottom - label.top) : 0}`,
  );

  await shot(page, `qa/artifacts/chart-${width}.png`);
  await context.close();
}

/* --------------------------- prefers-reduced-motion ---------------------- */
/**
 * 采样器：从文档开始用 rAF 反复量「扇区最大高度」，记下第一次观测值和最后一个值。
 * 为什么不用「加载完再量一次」：那样量到的永远是动画结束态，断言恒真——
 * 第一版就是这种空断言，把 animation:false 关掉它照样 PASS。只有从首帧开始采样，
 * 才分得清「1 秒长出来」和「一帧就是完整环」。
 */
const SAMPLE_RING = () => {
  window.__ring = { first: 0, last: 0, frames: 0 };
  const measure = () => {
    const svg = [...document.querySelectorAll("svg")].find((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 120 && box.height === 180;
    });
    if (!svg) return 0;
    const arcs = [...svg.querySelectorAll("path")].filter(
      (path) =>
        (path.getAttribute("d") ?? "").includes("A") &&
        path.getAttribute("fill") &&
        path.getAttribute("fill") !== "none",
    );
    if (arcs.length === 0) return 0;
    return Math.max(...arcs.map((path) => path.getBoundingClientRect().height));
  };
  const tick = () => {
    const height = measure();
    if (height > 0) {
      if (!window.__ring.first) window.__ring.first = height;
      window.__ring.last = height;
      window.__ring.frames += 1;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function sampleRing(reducedMotion) {
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion });
  await context.addInitScript(() => window.localStorage.setItem("admin_theme", "dark"));
  await context.addInitScript(SAMPLE_RING);
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`ring: ${error.message}`));
  await page.goto(`${ORIGIN}/admin/reports`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "报告归档" }).waitFor();
  await waitForChartSettled(page);
  const sample = await page.evaluate(() => window.__ring);
  if (reducedMotion === "reduce") await shot(page, "qa/artifacts/chart-reduced-motion.png");
  await context.close();
  return sample;
}

const animated = await sampleRing("no-preference");
const ratioAnimated = animated.last ? animated.first / animated.last : 1;
check(
  "对照组：默认（未开 reduced-motion）环形图是长出来的，不是一帧到位",
  ratioAnimated <= 0.9,
  `首帧/终态 = ${animated.first.toFixed(1)}/${animated.last.toFixed(1)} = ${ratioAnimated.toFixed(2)}，采样 ${animated.frames} 帧`,
);

const still = await sampleRing("reduce");
const ratioStill = still.last ? still.first / still.last : 0;
check(
  "reduced-motion 下首帧即完整环（animation:false 生效）",
  ratioStill >= 0.98 && still.last >= 100,
  `首帧/终态 = ${still.first.toFixed(1)}/${still.last.toFixed(1)} = ${ratioStill.toFixed(2)}，采样 ${still.frames} 帧`,
);

check("全程无脚本异常", problems.length === 0, problems.join(" | "));
await browser.close();
stub.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
