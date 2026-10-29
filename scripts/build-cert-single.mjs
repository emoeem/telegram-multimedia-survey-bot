#!/usr/bin/env node
/**
 * 把 cert/ 打成**单文件离线版**：cert/cert.html。
 *
 * 为什么需要它：/cert/ 正常是线上托管（Cloudflare），但某些网络的用户根本连不上
 * —— 那个页面对他们来说就是「打不开」。这个生成器把 CSS / 全部脚本 / 成人词库
 * 内联进一个 HTML，落到本地双击就能用，不依赖任何服务器。
 *
 * 与线上版的差异（有意为之）：
 *   - 不请求 /api/cert-content（后台发布的内容包），直接用 themes.js 内置主题；
 *   - 分享链接指向线上地址（CERT_SHARE_BASE 注入），file:// 下也能生成可分享的 URL；
 *   - 成人词库作为 text/plain 内联，app.js 转 Blob URL 加载，file:// 同样能解锁。
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const certDir = join(root, "cert");
/* 离线版生成分享链接时用的线上地址。
 *
 * 必须用**国内可达**的那个域名：emoe.eu.cc 是 Cloudflare 共享段，国内多数网络直接
 * SNI 阻断，拿它当 share base 等于把收到文件的人再送回打不开的站点。emoemok.top 是
 * 同一 Worker 的 Vercel 中继（见 docs/ops/CN_ACCESS_VERCEL_RELAY.md），国内可直连。
 * 换域名时可以用 CERT_SHARE_BASE 覆盖，不必改脚本。 */
const SHARE_BASE = process.env.CERT_SHARE_BASE || "https://emoemok.top/cert/";
const OUT = join(certDir, "cert.html");

const read = (p) => readFileSync(join(certDir, p), "utf8");

/** 内联进 <script> 时必须切断 </script，否则提前闭合 */
function safeJs(src, label) {
  if (/<\/script/i.test(src)) {
    throw new Error(`[cert-single] ${label} 含 </script，不能直接内联`);
  }
  return src;
}

let html = read("index.html");

/* 1. 样式 */
const css = readFileSync(join(certDir, "styles.css"), "utf8");
html = html.replace(/<link rel="stylesheet" href="styles\.css[^"]*"\s*\/?>/, () => `<style>\n${css}\n</style>`);

/* 2. 各脚本按原顺序内联，并把本地相对路径换成 CERT_SHARE_BASE */
const scripts = [
  ["vendor/qrcode.js", null],
  ["themes.js", null],
  ["presets.js", null],
  ["render.js", null],
  ["app.js", `window.CERT_SHARE_BASE = ${JSON.stringify(SHARE_BASE)};`],
];

for (const [file, prefix] of scripts) {
  const src = safeJs(read(file), file);
  const re = new RegExp(`<script src="${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"></script>`);
  if (!re.test(html)) throw new Error(`[cert-single] index.html 里找不到 ${file} 的 script 标签`);
  html = html.replace(
    re,
    () => `<script>\n${prefix ? "/* 单文件离线版：分享链接指向线上地址 */\n" + prefix + "\n" : ""}${src}\n</script>`,
  );
}

/* 3. 成人词库：作为惰性内联块，用户在页面上点了「18+」才真正执行 */
const adult = safeJs(read("themes-adult.js"), "themes-adult.js");
html = html.replace("</body>", `<script type="text/plain" id="cert-adult-pack">\n${adult}\n</script>\n</body>`);

/* 4. 单文件自己就是「离线版」，把下载它自己的按钮拿掉，避免自我循环 */
html = html.replace(/<a class="btn primary" href="cert\.html"[^>]*>[^<]*<\/a>\s*/, "");

/* 4b. 顶栏「← 首页」不能留相对路径 "/"：单文件常在 file:// 下打开，那里 "/"
 *     指的是文件系统根目录，点了什么也不会发生。改成线上站点的问卷首页。 */
const siteOrigin = new URL(SHARE_BASE).origin;
html = html.replace(/(<a class="home-link" href=")\/(")/, `$1${siteOrigin}/s$2`);

/* 4c. 其余站内根路径链接同理（如「一键投稿 →」指向 /submissions）。
 *     做成通用规则而不是逐条列举：以后页面里再加 href="/xxx"，不用回来改脚本。
 *     不匹配 "//cdn…"（协议相对）和已经是 http(s) 的绝对地址。 */
html = html.replace(/(href=")\/(?!\/)([^"]*)(")/g, (_m, open, path, close) => `${open}${siteOrigin}/${path}${close}`);

/* 5. 自检：不能残留任何对本地文件的引用（只看标签层，脚本里的字符串不算） */
const skeleton = html
  .replace(/<script[\s\S]*?<\/script>/gi, "<script></script>")
  .replace(/<style[\s\S]*?<\/style>/gi, "<style></style>");
const leftovers = [...skeleton.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => !/^(https?:|data:|#|javascript:)/.test(p));
if (leftovers.length) {
  throw new Error(`[cert-single] 仍有外部引用未内联: ${leftovers.join(", ")}`);
}
for (const must of ["CERT_SHARE_BASE", "cert-adult-pack", "data-cert-ready", "window.CERT_RENDER"]) {
  if (!html.includes(must)) throw new Error(`[cert-single] 产物缺少必需片段: ${must}`);
}

html = html.replace("<head>", "<head>\n<!-- 单文件离线版：由 scripts/build-cert-single.mjs 生成，勿手改 -->");
writeFileSync(OUT, html, "utf8");

const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log(`[cert-single] cert/cert.html 已生成（${kb} KiB，${html.split("\n").length} 行）`);
