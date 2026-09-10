#!/usr/bin/env node
/**
 * Telegram Web DOM 探测器（真机校准用）。
 *
 * 用法（在 telegram-bot 根目录，已装 playwright）：
 *   node tg-archive/web/probe.mjs [webA|webK] [timeoutSeconds]
 *
 * 行为：
 *   1. 弹出 Chromium 窗口打开 web.telegram.org（默认 /a）；
 *   2. 由用户自己在窗口里扫码/登录（脚本不碰账号密码）；
 *   3. 检测到聊天界面后，输出 DOM 结构快照到 /tmp/tgwa-probe.* 并自动关闭窗口。
 *
 * 隐私：快照只记录标签/class/属性与文本长度，不保存消息正文。
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const variant = process.argv[2] === "webK" ? "/k" : "/a";
const timeoutSec = Number(process.argv[3] || 900);
const url = "https://web.telegram.org" + variant + "/";
const outDir = "/tmp/tgwa-probe";

const candidates = {
  chatTitle: [".sidebar-header .title", ".ChatInfo .title", "header .title"],
  message: [".messages-container .Message", ".Message", "[data-message-id]", ".bubble", "[data-mid]"],
  messageText: [".text-content", ".message-content .text", ".bubble-content .text", ".text-content, .message-content"],
  media: [".media", ".message-media", ".photo, .video, .document, .audio, .voice", "img[src*='stream']", "video"],
  actionMore: ['[title="More options"]', '[aria-label="More options"]', ".MessageAction .more"],
  searchInput: ['input[type="search"]', 'input[placeholder*="Search"]', ".SearchInput input", ".search-input input"],
};

const browser = await chromium.launch({ headless: false, viewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
const messages = [];
let closing = false;

page.on("console", (msg) => {
  const t = msg.text();
  if (t.length < 300) messages.push(t);
});
page.on("pageerror", (err) => messages.push("PAGEERROR " + err.message.slice(0, 300)));

console.log("打开 " + url + " …请在弹出的窗口里扫码/登录（最多等待 " + timeoutSec + " 秒）");
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("goto:", e.message));

mkdirSync(outDir, { recursive: true });
await page.screenshot({ path: `${outDir}/01-login.png` }).catch(() => {});

process.on("SIGINT", async () => {
  closing = true;
  console.log("收到中断，关闭浏览器…");
  await browser.close().catch(() => {});
  process.exit(130);
});

async function quickState() {
  return page.evaluate((cands) => {
    const bodyText = (document.body.innerText || "").slice(0, 2000);
    const counts = {};
    for (const [name, sels] of Object.entries(cands)) {
      counts[name] = sels.reduce((n, sel) => {
        try {
          return n + document.querySelectorAll(sel).length;
        } catch {
          return n;
        }
      }, 0);
    }
    const classFreq = {};
    for (const el of document.querySelectorAll("*")) {
      const c = (el.className || "").toString();
      if (!c) continue;
      for (const one of String(c).split(/\s+/).slice(0, 8)) {
        if (!one || one.length > 40) continue;
        classFreq[one] = (classFreq[one] || 0) + 1;
      }
    }
    const topClasses = Object.entries(classFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([c, n]) => `${c}(${n})`);
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .slice(0, 80)
      .map((b) => (b.getAttribute("aria-label") || b.title || b.innerText || "").slice(0, 50))
      .filter(Boolean);
    return {
      url: location.href.slice(0, 160),
      title: document.title.slice(0, 200),
      bodyHint: bodyText.includes("QR") || bodyText.includes("二维码"),
      hasPhoneInput: !!document.querySelector('input[type="tel"], input[name="phone"]'),
      counts,
      topClasses,
      buttons: [...new Set(buttons)].slice(0, 60),
      firstMsgTextLen: (document.querySelector(cands.message.join(","))?.innerText || "").length || 0,
    };
  }, candidates);
}

const deadline = Date.now() + timeoutSec * 1000;
let loggedIn = false;
let tick = 0;
while (Date.now() < deadline && !closing) {
  try {
    const state = await quickState();
    tick++;
    const name = `state-${String(tick).padStart(3, "0")}`;
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify(state, null, 2));
    console.log(
      `[tick ${tick}] buttons=${state.buttons.length} phoneInput=${state.hasPhoneInput} ` +
        `msgCandidates=${state.counts.message} class=${state.topClasses.slice(0, 4).join(" | ")}`
    );
    // 粗判登录：有消息/搜索/输入区候选，或按钮列表里出现典型的聊天 UI 动作。
    const looksLoggedIn =
      state.counts.message > 0 ||
      state.buttons.some((b) => /search|settings|new chat|contacts/i.test(b)) ||
      state.topClasses.some((c) => /chatlist|sidebar|messages-container|composer/i.test(c));
    if (looksLoggedIn) {
      loggedIn = true;
      break;
    }
  } catch (err) {
    console.log("state error:", err.message);
  }
  await page.waitForTimeout(5000);
}

if (!loggedIn) {
  console.log("超时未检测到登录界面（可能网络不通或未完成登录）。最近状态见 " + outDir + "/state-*.json");
  await browser.close();
  process.exit(2);
}

console.log("检测到聊天界面，等待 5 秒后抓取完整结构…");
await page.waitForTimeout(5000);
await page.screenshot({ path: `${outDir}/02-chat.png` }).catch(() => {});

const probe = await page.evaluate((cands) => {
  const counts = {};
  const firsts = {};
  for (const [name, sels] of Object.entries(cands)) {
    let total = 0;
    let first = null;
    for (const sel of sels) {
      const list = document.querySelectorAll(sel);
      total += list.length;
      if (!first && list.length) first = list[0];
    }
    counts[name] = total;
    if (first) {
      const clone = first.cloneNode(true);
      clone.querySelectorAll("script, style").forEach((n) => n.remove());
      const summarize = (node, depth) => {
        if (!node || depth > 3) return null;
        const cls = (node.className || "").toString();
        const attrs = {};
        for (const a of node.attributes || []) {
          if (["style", "src", "href"].includes(a.name)) continue;
          attrs[a.name] = String(a.value).slice(0, 100);
        }
        return {
          tag: node.tagName,
          cls: cls.slice(0, 140),
          attrs,
          kids: Array.from(node.children || []).slice(0, 5).map((c) => summarize(c, depth + 1)),
        };
      };
      firsts[name] = summarize(clone, 0);
    }
  }
  return {
    url: location.href,
    title: document.title.slice(0, 200),
    counts,
    firsts,
    buttons: Array.from(document.querySelectorAll("button, [role='button']"))
      .slice(0, 120)
      .map((b) => {
        const label = b.getAttribute("aria-label") || b.title || b.innerText || "";
        return { label: label.slice(0, 60), cls: (b.className || "").toString().slice(0, 80) };
      })
      .filter((x) => x.label),
  };
}, candidates);

writeFileSync(`${outDir}/probe.json`, JSON.stringify(probe, null, 2));
writeFileSync(`${outDir}/console.txt`, messages.slice(0, 200).join("\n"));
console.log("探测完成 → " + outDir + "/probe.json");
closing = true;
await browser.close();
