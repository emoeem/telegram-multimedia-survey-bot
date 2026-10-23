import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PUBLISH_MAX_EDGE,
  PUBLISH_MIME,
  PUBLISH_QUALITY,
  PUBLISH_SKIP_UNDER_BYTES,
  shouldReencode,
} from "../../../admin/src/lib/image-publish.shared";

/**
 * "用户上传的图片压缩发布"这套逻辑有两个实现：
 *   - admin/src/lib/image-publish.ts        —— React 侧（投稿 / 树洞 / 答卷附件）
 *   - cert/app.js 里的 normalizeForPublish  —— 认证卡（零依赖离线单文件，不能 import）
 *
 * 两份实现必须同参数，否则同一张照片在问卷里被压到 1600px、在认证卡里还是
 * 4000px，用户看不出区别，账单看得出。所以这里做两件事：
 *   1. 断言决策函数本身的行为（纯函数，node 里可测）；
 *   2. 直接读 cert/app.js 源码，逐项比对常量，并确认它真的接在了上传/导出
 *      两个出口上——常量对但没接线，同样等于没做。
 */

const certApp = readFileSync(join(process.cwd(), "cert", "app.js"), "utf8");

/** 从 cert/app.js 里取一个 `var NAME = ...;` 的字面量，取不到就返回 null。 */
function certConstant(name: string): string | null {
  const match = certApp.match(new RegExp(`var ${name} = ([^;]+);`));
  const value = match?.[1];
  return value ? value.trim() : null;
}

/**
 * 取数值常量。cert/app.js 里写的是 `320 * 1024` 这种可读表达式，直接比字符串
 * 会把"同一个值、两种写法"判成不一致。只接受数字与 `*`，不做任意求值。
 */
function certNumber(name: string): number | null {
  const raw = certConstant(name);
  if (!raw) return null;
  const factors = raw.split("*").map((part) => part.trim());
  if (!factors.every((part) => /^\d+(\.\d+)?$/.test(part))) return null;
  return factors.reduce((acc, part) => acc * Number(part), 1);
}

describe("shouldReencode —— 什么时候才值得重编码", () => {
  it("超过最长边的图必须重编码", () => {
    expect(shouldReencode({ width: 4000, height: 3000, byteLength: 900 * 1024 })).toBe(true);
    // 竖图同样按最长边判断
    expect(shouldReencode({ width: 1200, height: 3000, byteLength: 900 * 1024 })).toBe(true);
  });

  it("尺寸没超标、体积也小的图放行（不浪费 CPU 重编码）", () => {
    expect(shouldReencode({ width: 800, height: 600, byteLength: 120 * 1024 })).toBe(false);
    expect(shouldReencode({ width: PUBLISH_MAX_EDGE, height: PUBLISH_MAX_EDGE, byteLength: 1000 })).toBe(false);
  });

  it("尺寸没超标但体积很大的图仍然重编码（已经压过的高分辨率噪声图）", () => {
    expect(shouldReencode({ width: 1200, height: 900, byteLength: PUBLISH_SKIP_UNDER_BYTES + 1 })).toBe(true);
  });

  it("读不出尺寸时一律放行——宁可传原图，也不凭猜测重编码", () => {
    expect(shouldReencode({ width: 0, height: 0, byteLength: 5 * 1024 * 1024 })).toBe(false);
    expect(shouldReencode({ width: Number.NaN, height: 900, byteLength: 5 * 1024 * 1024 })).toBe(false);
    expect(shouldReencode({ width: 4000, height: -1, byteLength: 5 * 1024 * 1024 })).toBe(false);
  });

  it("maxEdge 可以被调用方收紧（缩略图 / 特殊入口）", () => {
    const input = { width: 1000, height: 800, byteLength: 90 * 1024 };
    expect(shouldReencode(input)).toBe(false);
    expect(shouldReencode(input, { maxEdge: 480 })).toBe(true);
  });
});

describe("cert/app.js 与共享模块的参数必须一致", () => {
  it("最长边一致", () => {
    expect(certNumber("PUBLISH_MAX_EDGE")).toBe(PUBLISH_MAX_EDGE);
  });

  it("质量一致", () => {
    expect(certNumber("PUBLISH_QUALITY")).toBe(PUBLISH_QUALITY);
  });

  it("编码格式一致", () => {
    expect(certConstant("PUBLISH_MIME")).toBe(JSON.stringify(PUBLISH_MIME));
  });

  it("跳过阈值一致", () => {
    expect(certNumber("PUBLISH_SKIP_UNDER_BYTES")).toBe(PUBLISH_SKIP_UNDER_BYTES);
  });
});

describe("cert/app.js 的压缩必须真的接在出口上", () => {
  it("原图上传前经过归一化", () => {
    // pickedPhotoBlobs 是发往 /api/cert/share 的原图来源；没接就等于没压。
    expect(certApp).toMatch(
      /return fetch\(p\.url\)[\s\S]{0,200}?\.then\(function \(blob\) \{\s*return normalizeForPublish\(blob\);/,
    );
  });

  it("成品图导出走 exportCardBlob（WebP 优先、PNG 兜底）", () => {
    expect(certApp).toMatch(/function exportCardBlob\(done\)/);
    expect(certApp).toMatch(/exportCardBlob\(function \(blob\)/);
    // 两处导出（下载 / 复制）都应该换过来，不能再直接 toBlob(..., "image/png")
    expect(certApp.match(/exportCardBlob\(function \(blob\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(certApp).not.toMatch(/\$\("card"\)\.toBlob\(function \(blob\) \{[\s\S]{0,80}?"image\/png"\);/);
  });

  it("文件名扩展名跟着真实类型走（否则下载下来是坏文件）", () => {
    expect(certApp).toMatch(/function fileName\(mime\)/);
    expect(certApp).toMatch(/a\.download = fileName\(blob\.type\)/);
  });

  it("剪贴板 MIME 键与 blob 类型一致（不一致浏览器直接拒写）", () => {
    expect(certApp).toMatch(/blob\.type === "image\/webp" \? "image\/webp" : "image\/png"/);
  });
});
