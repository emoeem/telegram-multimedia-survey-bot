// ==UserScript==
// @name         TG Web Archive（流式截图归档）
// @namespace    tg-web-archive
// @version      0.5.0
// @description  在官方 web.telegram.org 内把聊天归档进自己的频道：snapshot 截图 / copy 文字 / forward 原生转发；流式处理、失败自动重试、幂等去重；不需要 api_id。
// @match        https://web.telegram.org/a/*
// @match        https://web.telegram.org/k/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @run-at       document-idle
// ==/UserScript==

/*
 * 设计：docs/WEB_VIEW_ARCHIVE_MVP.md；功能清单与验收口径：tg-archive/web/FEATURES.md
 *
 * 核心流程（流式，一次只持有 1 张截图）：
 *   源聊天 截图1 → 切到归档频道 发送1 → 切回源聊天 截图2 → ……
 *
 * 0.5.0 语义（对应 FEATURES.md 的 P0/P1）：
 *   - done:<peer>   按聊天隔离的“已归档/有意跳过”名单，所有方向判重依据（P0-3）；
 *   - check:<peer>  向下方向高水位断点；向上回溯不依赖它（P1-10）；
 *   - 发送成功 = 输入框被清空 且 频道里出现了新消息（气泡签名变化，P0-2）；
 *   - snapshot caption 带 #m_<peer>_<mid> 幂等标记，发送前先查频道是否已有
 *     同标记消息，重跑不产生重复归档（P1-11）；
 *   - 相册（同一 album 容器内的多条消息）整组截一张，组内不重复不漏图（P1-6）；
 *   - forward 模式：调用页面原生转发对话框（实验性，选择器需探测校准，P1-5）；
 *   - 可配置：截图倍率/格式、发送间隔；进度实时显示；错误分类；运行统计（P1-9/10、P2-14/15/16）；
 *   - 重试队列只持久化元数据，重试时回源聊天重新截图/定位消息（P0-4）。
 */
(function () {
  "use strict";

  const APP = location.pathname.startsWith("/a") ? "A" : location.pathname.startsWith("/k") ? "K" : "?";
  const LS = "tg-web-archive";
  const store = {
    get(key, dft) {
      try {
        if (typeof GM_getValue === "function") return GM_getValue(key, dft);
      } catch (_) {}
      try {
        const raw = localStorage.getItem(LS + ":" + key);
        return raw === null ? dft : JSON.parse(raw);
      } catch (_) {
        return dft;
      }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === "function") return void GM_setValue(key, val);
      } catch (_) {}
      try {
        localStorage.setItem(LS + ":" + key, JSON.stringify(val));
      } catch (_) {}
    },
  };

  // ------------------------------------------------------------------ 工具

  const logLines = [];
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logLines.push(line);
    if (logLines.length > 600) logLines.shift();
    console.log("[tgwa]", msg);
    const box = document.getElementById("tgwa-log");
    if (box) {
      box.textContent = logLines.slice(-90).join("\n");
      box.scrollTop = box.scrollHeight;
    }
  }

  function updateStatus(text) {
    const el = document.getElementById("tgwa-status");
    if (el) el.textContent = text;
  }

  function firstVisible(selectors) {
    for (const sel of selectors || []) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      } catch (_) {}
    }
    return null;
  }

  function firstWithin(parent, selectors) {
    for (const sel of selectors || []) {
      try {
        const el = parent.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      } catch (_) {}
    }
    return null;
  }

  function allVisible(selectors) {
    const out = [];
    for (const sel of selectors || []) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null && !out.includes(el)) out.push(el);
        }
      } catch (_) {}
    }
    return out;
  }

  function textOf(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function click(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  }

  function setText(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  }

  // ------------------------------------------------------------ 可配置项（P1-9 / P2-14）

  function getSettings() {
    return {
      scale: Math.max(1, Math.min(3, Number(store.get("optScale", 2)) || 2)),
      format: store.get("optFormat", "png") === "jpeg" ? "jpeg" : "png",
      delayMs: Math.max(0, Math.min(30, Number(store.get("optDelay", 1.2)) * 1000 || 1200)),
    };
  }

  // ------------------------------------------------------------ DOM 探测

  const HINTS = {
    A: {
      chatTitle: [".sidebar-header .title", ".ChatInfo .title", "header .title"],
      messageText: [".text-content", ".message-content .text", ".bubble-content .text"],
      searchInput: ['input[type="search"]', 'input[placeholder*="Search"]', ".SearchInput input"],
      composer: [".composer", ".message-input", ".input-message-container"],
    },
    K: {
      chatTitle: [".sidebar-header .peer-title", ".chat-title"],
      messageText: [".message.spoilers-container .translatable-message", ".message.spoilers-container", ".bubble-content .message"],
      searchInput: ['input[type="search"]', ".search-input input"],
      composer: [".input-message-container", ".composer"],
    },
  };
  const H = HINTS[APP] || HINTS.K;

  function probeDOM() {
    const tree = (node, depth) => {
      if (!node || depth > 4) return "";
      const cls = (node.className || "").toString();
      const attrs = {};
      for (const a of node.attributes || []) {
        if (["style", "src"].includes(a.name)) continue;
        attrs[a.name] = String(a.value).slice(0, 60);
      }
      const meta = `${"  ".repeat(depth)}<${node.tagName.toLowerCase()} class="${cls.slice(0, 120)}" ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}>`;
      const kids = Array.from(node.children || [])
        .slice(0, 10)
        .map((c) => tree(c, depth + 1))
        .join("\n");
      return kids ? meta + "\n" + kids : meta;
    };
    const bubbles = Array.from(document.querySelectorAll(".bubble:not(.service)")).slice(0, 3);
    const sidebar = Array.from(document.querySelectorAll("[data-peer-id]"))
      .filter((el) => !el.closest(".bubble") && el.offsetParent !== null)
      .slice(0, 12)
      .map((el) => `<${el.tagName.toLowerCase()} cls="${(el.className || "").toString().slice(0, 80)}" peer=${el.getAttribute("data-peer-id")} text="${textOf(el).slice(0, 26)}">`)
      .join(" ");
    const report = [
      "app=" + APP + " url=" + location.href,
      "chatTitle=" + textOf(firstVisible(H.chatTitle)),
      "bubbles=" + bubbles.length,
      "sidebarRows: " + (sidebar || "无（没有找到带 data-peer-id 的会话行）"),
      "composer: " +
        allVisible([".input-message-container", ".input-message-input"]).slice(0, 3).map((el) => `<${el.tagName.toLowerCase()} cls="${(el.className || "").toString().slice(0, 110)}">`).join(" "),
      "buttons: " +
        Array.from(document.querySelectorAll("button"))
          .slice(0, 40)
          .map((b) => `[${(b.getAttribute("aria-label") || b.title || textOf(b)).slice(0, 34)}]`)
          .filter(Boolean)
          .join(" "),
      "menus(modal/dialog): " +
        allVisible(["[class*='menu' i]", "[class*='dialog' i]", "[class*='modal' i]", "[role='menu']", "[role='dialog']"])
          .slice(0, 6)
          .map((el) => `<${el.tagName.toLowerCase()} cls="${(el.className || "").toString().slice(0, 100)}">`)
          .join(" "),
    ];
    bubbles.forEach((b, i) => {
      const t = textOf(b);
      report.push(`--- bubble${i + 1} mid=${b.getAttribute("data-mid")} ts=${b.getAttribute("data-timestamp")} textLen=${t.length} head=${t.slice(0, 30)}`);
      report.push(tree(b, 0).split("\n").slice(0, 34).join("\n"));
    });
    return report.join("\n");
  }

  function copyProbe() {
    const text = probeDOM();
    log("探测完成，已复制到剪贴板：\n" + text.split("\n").slice(0, 90).join("\n"));
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      log("✅ 已复制，请粘贴发给开发侧。");
    } catch (_) {
      log("请手动复制上方内容。");
    }
    ta.remove();
  }

  // ------------------------------------------------------ 消息读取 / 时间

  function classifyBubble(el) {
    const cls = String(el.className);
    if (el.querySelector("video")) return "video";
    if (el.querySelector("audio")) return "voice";
    if (/voice|audio/.test(cls)) return "voice";
    if (/video/.test(cls)) return "video";
    if (/photo|image|album/.test(cls)) return "photo";
    if (/document|file/.test(cls)) return "document";
    if (/sticker|gif/.test(cls)) return "sticker";
    return "text";
  }

  function mediaUrlsOf(messageEl) {
    const urls = [];
    const scope = messageEl.querySelector(".attachment") || messageEl;
    const push = (u) => {
      if (u && /^(stream\/|https?:\/\/|blob:)/.test(u) && u !== location.href && !urls.includes(u)) urls.push(u);
    };
    for (const v of scope.querySelectorAll("video")) push(v.currentSrc || v.src);
    for (const a of scope.querySelectorAll("audio")) push(a.currentSrc || a.src);
    for (const img of scope.querySelectorAll("img")) {
      push(img.currentSrc || img.src);
      const bg = getComputedStyle(img).backgroundImage || "";
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) push(m[1]);
    }
    for (const a of scope.querySelectorAll('a[href*="/stream/"], a[download]')) push(a.href);
    return urls;
  }

  // 相册分组（P1-6）：同一相册的多条消息共享一个分组容器（album/grouped）。
  // 返回 {el, mids}；找不到分组返回 null。以「探测 DOM」输出校准为准。
  function albumGroupOf(el) {
    for (let node = el.parentElement, depth = 0; node && depth < 5 && node !== document.body; node = node.parentElement, depth++) {
      if (!/(album|grouped|media-group)/i.test(String(node.className))) continue;
      const mids = [...new Set(Array.from(node.querySelectorAll("[data-mid]")).map((b) => b.getAttribute("data-mid")).filter(Boolean))];
      if (mids.length >= 2 && mids.length <= 12) return { el: node, mids };
    }
    return null;
  }

  const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6,
    七月: 7, 八月: 8, 九月: 9, 十月: 10, 十一月: 11, 十二月: 12,
  };

  function parseTimeString(s) {
    if (!s) return null;
    const low = s.toLowerCase();
    let m = low.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})[^\d]*(\d{1,2}):(\d{2})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime() / 1000;
    m = low.match(/(\d{1,2})\s+([a-z\u4e00-\u9fff]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
    if (m && MONTHS[m[2]]) return new Date(+m[3], MONTHS[m[2]] - 1, +m[1], +m[4], +m[5]).getTime() / 1000;
    m = low.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})[^\d]*(\d{1,2}):(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000;
    return null;
  }

  function messageTimeOf(el) {
    const ts = Number(el.getAttribute("data-timestamp"));
    if (ts > 1e8 && ts < 1e12) return Math.floor(ts);
    const timeEl = el.querySelector("time");
    const dt = timeEl && (timeEl.getAttribute("datetime") || timeEl.dateTime);
    const fromDt = parseTimeString(dt);
    if (fromDt) return fromDt;
    const titleEl = el.querySelector("[title]");
    const fromTitle = titleEl && parseTimeString(titleEl.getAttribute("title"));
    if (fromTitle) return fromTitle;
    return null;
  }

  function fmtHuman(ts) {
    if (!ts) return "未知日期";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtTag(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `#date_${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}`;
  }

  function sanitizeTag(s) {
    return String(s || "").replace(/[^\p{L}\p{N}_]+/gu, "").slice(0, 24);
  }

  // 幂等标记（P1-11）：snapshot caption 里的唯一 id，重跑前查频道是否已存在。
  function idempotencyMarker(item) {
    return `#m_${sanitizeTag(item.peer) || "p"}_${item.key}`;
  }

  function visibleMessages() {
    const out = [];
    for (const el of allVisible([".bubble"])) {
      if (String(el.className).includes("service")) continue;
      const key = el.getAttribute("data-mid");
      if (!key) continue;
      const textEl = firstWithin(el, H.messageText);
      const nameEl = firstWithin(el, [".colored-name .peer-title", ".name .peer-title"]);
      out.push({
        key,
        peer: el.getAttribute("data-peer-id") || "",
        ts: messageTimeOf(el),
        text: textEl && el.contains(textEl) ? textOf(textEl) : "",
        sender: nameEl && el.contains(nameEl) ? textOf(nameEl) : "",
        kind: classifyBubble(el),
        mediaUrls: mediaUrlsOf(el),
        el,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ 断点/判重（P0-3）

  // done:<peer> —— 该聊天已归档（或按策略有意跳过）的消息 key 列表。
  // 发送发生在归档频道聊天里，但 peer 始终显式传入，不会记错地方。
  const doneKey = (peer) => "done:" + peer;
  const isDone = (peer, k) => (peer ? (store.get(doneKey(peer), []) || []).includes(k) : false);
  function markDone(peer, k) {
    if (!peer || k == null) return;
    const arr = store.get(doneKey(peer), []) || [];
    if (!arr.includes(k)) {
      arr.push(k);
      if (arr.length > 50000) arr.splice(0, arr.length - 50000);
      store.set(doneKey(peer), arr);
    }
  }
  function markAllDone(peer, keys) {
    for (const k of keys || []) markDone(peer, k);
  }

  // check:<peer> —— 向下方向的“高水位”断点：已发送的最大 mid/ts。
  const checkKey = (peer) => "check:" + peer;
  const getCheckpoint = (peer) => (peer ? store.get(checkKey(peer), null) : null);
  const setCheckpoint = (peer, mid, ts) => {
    if (!peer) return;
    const old = getCheckpoint(peer) || { mid: 0, ts: 0 };
    const next = { mid: Math.max(old.mid, mid || 0), ts: Math.max(old.ts, ts || 0) };
    if (next.mid !== old.mid || next.ts !== old.ts) store.set(checkKey(peer), next);
  };

  let queue = []; // 失败/待重试的元数据（无 PNG/el，重试时回源聊天重新定位）
  const stop = { flag: false };

  function loadQueue() {
    const saved = store.get("queueV1", []);
    queue = Array.isArray(saved) ? saved.filter((x) => x && x.key) : [];
  }
  function saveQueue() {
    // 只保留可 JSON 化的元数据；PNG / DOM 引用重试时重建（P0-4）
    store.set(
      "queueV1",
      queue.map((it) => {
        const { png, el, ...rest } = it;
        return rest;
      })
    );
  }

  function clearQueue() {
    queue = [];
    saveQueue();
    updateQueueUi();
    log("🗑 队列已清空。");
  }

  function resetProgress() {
    const peer = currentPeerId();
    if (!peer) {
      log("请先打开源聊天再重置进度。");
      return;
    }
    if (!confirm(`重置进度会清空当前聊天（${peer}）的 done 判重名单与断点，已归档过的消息重跑会被再次发送。\n确定继续？`)) {
      log("已取消重置。");
      return;
    }
    store.set(doneKey(peer), []);
    store.set(checkKey(peer), { mid: 0, ts: 0 });
    log(`已重置 ${peer} 的断点与已处理标记（done/check），可重新 ▲ 向上回溯。`);
  }

  function captionFor(item) {
    const kindName = {
      video: "视频", photo: "图片", voice: "语音", audio: "音频",
      document: "文件", sticker: "贴纸", text: "文字",
    }[item.kind] || "";
    const n = (item.albumMids || []).length;
    const head =
      `📎 ${kindName}${n > 1 ? `×${n}` : ""} · 📅 ${fmtHuman(item.ts)}` + (item.sender ? ` · ${item.sender}` : "");
    // 标签规范（P1-8）：#media_类型 #date_YYYY_MM_DD #date_YYYY_MM #chat_来源，
    // 末尾附幂等标记 #m_<peer>_<mid>
    const tags = [];
    if (kindName) tags.push("#media_" + kindName);
    if (fmtTag(item.ts)) tags.push(fmtTag(item.ts));
    if (item.ts) {
      const d = new Date(item.ts * 1000);
      tags.push(`#date_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    if (item.chatTitle) tags.push("#chat_" + sanitizeTag(item.chatTitle));
    if (item.sender) tags.push("#user_" + sanitizeTag(item.sender));
    tags.push(idempotencyMarker(item));
    return head + "\n" + tags.join(" ");
  }

  // ------------------------------------------------------------ 发送原语

  function composerInput() {
    return document.querySelector(
      ".input-message-input, .input-message-input [contenteditable='true'], .composer [contenteditable='true'], textarea"
    );
  }

  function composerValue() {
    const el = composerInput();
    if (!el) return "";
    return el.isContentEditable ? el.innerText || "" : el.value || "";
  }

  async function clearComposer() {
    const el = composerInput();
    if (!el) return;
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("delete");
      el.innerText = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setText(el, "");
    }
  }

  async function typeText(text) {
    const el = composerInput();
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("insertText", false, text);
    } else {
      setText(el, el.value ? el.value + "\n" + text : text);
    }
    return true;
  }

  function findSendButton() {
    const scope = document.querySelector(".input-message-container, .composer") || document;
    return Array.from(scope.querySelectorAll("button, [role='button']")).find((b) => {
      const label = (b.getAttribute("aria-label") || b.title || b.innerText || "").toLowerCase();
      const cls = (b.className || "").toString().toLowerCase();
      return /send|发送/.test(label) || /(^|[\s_-])send([\s_-]|$)/.test(cls);
    });
  }

  // 发送当前输入框内容：输入框被清空即认为已提交。
  async function trySend() {
    const input = composerInput();
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    if (await waitFor(() => !composerValue(), 4000)) return true;
    const btn = findSendButton();
    if (btn) {
      click(btn);
      if (await waitFor(() => !composerValue(), 5000)) return true;
    }
    return false;
  }

  // 频道气泡签名（P0-2）：新消息出现 ⇒ 气泡数或最大 mid 增长。
  function channelSignature() {
    let count = 0;
    let last = 0;
    for (const b of document.querySelectorAll(".bubble[data-mid]")) {
      count++;
      const mid = Number(b.getAttribute("data-mid")) || 0;
      if (mid > last) last = mid;
    }
    return { count, last };
  }

  function channelChanged(sig) {
    if (!sig || (!sig.count && !sig.last)) return true; // 无法取签名时退回旧行为
    const cur = channelSignature();
    return cur.count > sig.count || cur.last > sig.last;
  }

  // 发送 + 校验“频道里真的多了一条消息”（P0-2）。
  async function trySendVerified() {
    const sig = channelSignature();
    if (!(await trySend())) return false;
    if (!(await waitFor(() => channelChanged(sig), 8000))) {
      log("  ⚠️ 输入框已清空但频道未出现新消息，按失败处理。");
      return false;
    }
    return true;
  }

  // 频道侧幂等（P1-11）：频道可见气泡里已有本条的 #m_ 标记 ⇒ 已归档过。
  function channelHasItem(item) {
    if (!item.caption) return false;
    const marker = idempotencyMarker(item);
    for (const b of allVisible([".bubble"])) {
      if ((b.innerText || "").includes(marker)) return true;
    }
    return false;
  }

  function composerScope() {
    return document.querySelector(".input-message-container, .composer, .message-input") || document;
  }

  function scopeElements(scope) {
    return scope ? Array.from(scope.querySelectorAll("*")) : [];
  }

  function mediaish(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (["svg", "path", "use", "button", "i"].includes(tag)) return false;
    if (el instanceof HTMLImageElement && el.src) return true;
    if (el instanceof HTMLVideoElement && (el.currentSrc || el.src)) return true;
    if (tag === "canvas") return true;
    const cls = (el.className || "").toString();
    if (/(thumbnail|preview|attachment|attached|media)/i.test(cls)) return true;
    const bg = getComputedStyle(el).backgroundImage || "";
    return !!bg && bg !== "none" && bg.includes("url(");
  }

  function uploadish(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (["svg", "path", "use", "button", "i"].includes(tag)) return false;
    const s = (el.className || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "");
    return /upload|progress|percent|sending|loading/i.test(s);
  }

  function newComposerSignal(baseline, matcher) {
    const scope = composerScope();
    for (const el of scopeElements(scope)) {
      if (baseline.has(el)) continue;
      if (matcher(el)) return el;
    }
    return null;
  }

  async function waitForSignal(baseline, matcher, timeout, sawRef) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = newComposerSignal(baseline, matcher);
      if (hit) return hit;
      if (sawRef && newComposerSignal(baseline, uploadish)) sawRef.val = true;
      await sleep(250);
    }
    return null;
  }

  // 附件进入输入框后，等上传进度条消失（本地小图可能无进度 UI，1.8s 后视为完成）。
  async function waitUploadSettled(baseline, uploadTimeout) {
    const start = Date.now();
    let saw = false;
    while (Date.now() - start < uploadTimeout) {
      const up = newComposerSignal(baseline, uploadish);
      if (up) {
        saw = true;
      } else if (saw) {
        return true;
      } else if (Date.now() - start > 1800) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  function composerHasMedia() {
    const scope = composerScope();
    if (!scope) return false;
    const hasEl = Array.from(scope.querySelectorAll("img[src], video[src], video[srcset], canvas")).some((el) => {
      const src = (el.src || "") + (el.currentSrc || "");
      return src.length > 0 && src !== location.href;
    });
    return (
      hasEl ||
      scope.querySelectorAll('[class*="thumbnail" i], [class*="preview" i], [class*="attachment" i], [class*="media-preview" i]').length > 0
    );
  }

  async function attachViaFileInput(file) {
    const input = Array.from(document.querySelectorAll('input[type="file"]')).find((el) => {
      return el.offsetParent !== null || !el.closest("#tgwa-panel");
    });
    if (!input) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set.call(input, dt.files);
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // 依次尝试 drop → paste → 现有 file input；每种方式都只认“输入框里真的出现媒体预览”。
  async function attachFile(file) {
    const makeDt = () => {
      const dt = new DataTransfer();
      dt.items.add(file);
      return dt;
    };
    const zone = firstVisible(H.composer);
    const attempts = [];
    if (zone) {
      attempts.push(async () => {
        for (const type of ["dragenter", "dragover", "drop"]) {
          zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: makeDt() }));
        }
      });
    }
    attempts.push(async () => {
      const el = composerInput();
      if (!el) return;
      el.focus();
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: makeDt(), bubbles: true, cancelable: true }));
    });
    attempts.push(async () => {
      await attachViaFileInput(file);
    });

    const names = ["drop", "paste", "file-input"];
    for (let i = 0; i < attempts.length; i++) {
      const baseline = new Set(scopeElements(composerScope()));
      try {
        await attempts[i]();
      } catch (_) {}
      const saw = { val: false };
      let media = await waitForSignal(baseline, mediaish, i === 0 ? 5000 : 3500, saw);
      if (!media && i === 0 && saw.val) {
        // drop 已触发上传进度但预览还没渲染：再等久一点
        media = await waitForSignal(baseline, mediaish, 12000, saw);
      }
      if (media) return { ok: true, method: names[i], baseline: new Set(scopeElements(composerScope())) };
      await clearComposer();
      await sleep(300);
    }
    return { ok: false };
  }

  async function fetchMediaBlob(url) {
    const chunks = [];
    let offset = 0;
    let mime = "";
    for (let i = 0; i < 512; i++) {
      const res = await fetch(url, { headers: { Range: `bytes=${offset}-` }, credentials: "same-origin" });
      if (![200, 206].includes(res.status)) throw new Error("HTTP " + res.status);
      mime = (res.headers.get("Content-Type") || "").split(";")[0];
      chunks.push(await res.blob());
      const m = (res.headers.get("Content-Range") || "").match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!m) break;
      offset = Number(m[2]) + 1;
      if (offset >= Number(m[3])) break;
    }
    return new Blob(chunks, { type: mime });
  }

  function snapshotReady() {
    const mode = currentMode();
    if (mode !== "snapshot") return true;
    if (typeof html2canvas === "function") return true;
    log("⚠️ html2canvas 未加载：请在 Tampermonkey 设置里允许外部脚本（@require）后刷新页面。");
    return false;
  }

  async function capturePng(el) {
    const { scale, format } = getSettings();
    try {
      const canvas = await html2canvas(el, {
        scale,
        backgroundColor: format === "jpeg" ? "#ffffff" : null,
        useCORS: true,
        logging: false,
        windowWidth: Math.max(el.scrollWidth, 640),
      });
      const type = format === "jpeg" ? "image/jpeg" : "image/png";
      return await new Promise((r) => canvas.toBlob(r, type, 0.85));
    } catch (err) {
      log("截图失败：" + (err && err.message ? err.message : err));
      return null;
    }
  }

  // 发送“一条”到当前打开的聊天（调用方保证已在目标频道）；成功 true，失败 false，
  // “频道里已存在同标记消息”视为成功（幂等跳过）。失败原因写入 item.error（P2-15）。
  async function sendOne(item) {
    await clearComposer();
    await sleep(250);
    if (channelHasItem(item)) {
      log(`  ♻️ 频道已有同标记消息，跳过重复发送：#${item.key}`);
      return true;
    }
    if (item.mode === "snapshot") {
      if (!item.png) {
        item.error = "capture";
        log(`  ❌ 无截图可发：${item.key}`);
        return false;
      }
      const { format } = getSettings();
      const ext = format === "jpeg" ? "jpg" : "png";
      const file = new File([item.png], "archive-" + item.key + "." + ext, { type: format === "jpeg" ? "image/jpeg" : "image/png" });
      const attached = await attachFile(file);
      if (!attached.ok) {
        item.error = "attach";
        log(`  ❌ 截图未进入输入框（drop/paste/file-input 均无媒体预览），为避免只发 caption 已取消：#${item.key}`);
        await clearComposer();
        return false;
      }
      log(`  📎 已通过 ${attached.method} 附加图片，等待上传完成…`);
      if (!(await waitUploadSettled(attached.baseline, 30000))) {
        item.error = "upload";
        log(`  ⏳ 图片上传超时，已取消并保留队列：#${item.key}`);
        await clearComposer();
        return false;
      }
      if (item.caption) {
        await typeText(item.caption);
        await sleep(400);
      }
      if (!composerHasMedia()) {
        item.error = "attach";
        log(`  ❌ 发送前媒体预览消失，已取消并保留队列：#${item.key}`);
        await clearComposer();
        return false;
      }
      if (item.caption && !(composerValue() || "").includes(String(item.caption).split("\n")[0].slice(0, 12))) {
        item.error = "attach";
        log(`  ❌ caption 未写入输入框，已取消并保留队列：#${item.key}`);
        await clearComposer();
        return false;
      }
      const ok = await trySendVerified();
      if (!ok) item.error = "send";
      return ok;
    }
    if (item.text) {
      const prefix = item.sender && !item.text.startsWith(item.sender) ? item.sender + "：" : "";
      if (!(await typeText(prefix + item.text))) {
        item.error = "send";
        return false;
      }
      await sleep(250);
      const ok = await trySendVerified();
      if (!ok) item.error = "send";
      return ok;
    }
    if (item.mediaUrls.length && currentPolicy() === "allow_media") {
      try {
        for (const url of item.mediaUrls) {
          const blob = await fetchMediaBlob(url);
          const file = new File([blob], "archive-" + item.key, { type: blob.type });
          const attached = await attachFile(file);
          if (!attached.ok) {
            item.error = "attach";
            log("  媒体未进入输入框，跳过：" + item.key);
            await clearComposer();
            return false;
          }
          if (!(await waitUploadSettled(attached.baseline, 30000))) {
            item.error = "upload";
            await clearComposer();
            return false;
          }
          if (!(await trySendVerified())) {
            item.error = "send";
            return false;
          }
        }
        return true;
      } catch (err) {
        item.error = "media-fetch";
        log("  媒体获取失败：" + (err && err.message ? err.message : err));
        return false;
      }
    }
    item.error = "empty";
    log(`  ❌ 无可发送内容：${item.key}`);
    return false;
  }

  // ------------------------------------------------------------ 聊天切换

  // 当前聊天的 peer id。web 端聊天 id 放在 URL hash（如 #-1001234），比
  // “取第一条气泡”可靠；气泡只作兜底。
  function currentPeerId() {
    const h = (location.hash || "").slice(1).split("_")[0];
    if (/^-?\d+$/.test(h)) return h;
    const b = document.querySelector(".bubble[data-peer-id]");
    return b ? b.getAttribute("data-peer-id") : "";
  }

  async function openPeer(peer) {
    if (!peer) return false;
    const target = String(peer);
    const cur = () => (location.hash || "").slice(1).split("_")[0];
    if (cur() === target) return true;
    location.hash = "#" + target;
    const ok = await waitFor(() => cur() === target, 3500);
    if (ok) await sleep(500);
    return ok;
  }

  function findSidebarPeer(name) {
    const rows = Array.from(document.querySelectorAll("[data-peer-id]")).filter(
      (el) => !el.closest(".bubble") && el.offsetParent !== null
    );
    const name2 = String(name).trim();
    const exact = rows.find((el) => textOf(el).trim() === name2);
    const fuzzy = exact || rows.find((el) => textOf(el).includes(name2));
    return fuzzy ? fuzzy.getAttribute("data-peer-id") : null;
  }

  async function openChannelByName(name) {
    const peer = findSidebarPeer(name);
    if (peer) {
      const row = Array.from(document.querySelectorAll("[data-peer-id]")).find(
        (el) => !el.closest(".bubble") && el.getAttribute("data-peer-id") === peer
      );
      click(row);
      if (await waitFor(() => currentPeerId() === peer, 3000)) {
        await sleep(600);
        return peer;
      }
    }
    // 兜底：如果当前打开的聊天标题就是目标频道（用户手动打开过）
    if (textOf(firstVisible(H.chatTitle)).includes(String(name).trim()) && currentPeerId()) {
      return currentPeerId();
    }
    return null;
  }

  // ------------------------------------------------------------ 重试辅助

  function findMessageEl(item) {
    return Array.from(document.querySelectorAll(".bubble")).find(
      (b) => b.getAttribute("data-mid") === String(item.key) && b.offsetParent !== null
    );
  }

  // 回源聊天定位消息；截图类重试需要它，forward 重试也需要。
  async function ensureMessageEl(item) {
    if (item.el) return item.el;
    if (!(await openPeer(item.peer))) return null;
    await sleep(800);
    // 消息可能已滚出视口：向上翻几屏找（失败消息通常靠近当前停留位置）
    for (let i = 0; i < 8; i++) {
      const el = findMessageEl(item);
      if (el) return el;
      const s = findScroller();
      if (!s) return null;
      s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight);
      await sleep(600);
    }
    return null;
  }

  async function ensureSnapshotPng(item) {
    if (item.mode !== "snapshot") return true;
    if (item.png) return true;
    const el = await ensureMessageEl(item);
    if (!el) return false;
    const captureEl = item.albumMids && item.albumMids.length > 1 ? albumGroupOf(el)?.el || el : el;
    const png = await capturePng(captureEl);
    if (!png) return false;
    item.png = png;
    if (!item.caption) item.caption = captionFor(item);
    return true;
  }

  // ------------------------------------------------------------ forward 模式（P1-5，实验性）

  // 对当前打开源聊天里的某条消息调用原生转发对话框。
  // 返回 {ok} | {denied}（受保护/无转发权限）| {ok:false, error}。
  async function forwardOne(item, channelName) {
    const el = item.el || findMessageEl(item);
    if (!el) return { ok: false, error: "forward-noel" };
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + Math.min(rect.height / 2, 60)),
      })
    );
    // 菜单项：转发 / Forward
    const menuItem = await waitFor(() => {
      return allVisible(["[role='menuitem']", ".MenuItem", "button", "li"]).find((e) => {
        const t = (e.innerText || "").trim();
        return (/^(forward|转发|轉發)$/i.test(t) || /^forward$/i.test(t)) && !e.closest("#tgwa-panel");
      });
    }, 3500);
    if (!menuItem) return { denied: true }; // 右键无“转发” ⇒ 多半是受保护聊天
    click(menuItem);
    await sleep(500);
    // 转发对话框里的搜索框 + 收件人列表
    const search = await waitFor(() => {
      const modal = allVisible(["[role='dialog']", "[class*='modal' i]", "[class*='dialog' i]"])[0];
      const inputs = allVisible(["input[type='text']", "input[type='search']", "input"]);
      return inputs.find((i) => (modal ? modal.contains(i) : true)) || null;
    }, 3500);
    if (!search) return { ok: false, error: "forward-search" };
    setText(search, channelName);
    await sleep(700);
    const name2 = String(channelName).trim();
    const row = await waitFor(() => {
      const rows = allVisible(["[data-peer-id]", "[class*='chat-item' i]", "[class*='Chat']"]).filter(
        (r) => !r.closest(".bubble") && textOf(r)
      );
      return rows.find((r) => textOf(r).trim() === name2) || rows.find((r) => textOf(r).includes(name2)) || null;
    }, 4000);
    if (!row) return { ok: false, error: "forward-select" };
    // 严格校验：行文本必须包含频道名，避免转发到错误会话
    if (!textOf(row).includes(name2)) return { ok: false, error: "forward-select" };
    click(row);
    await sleep(500);
    const sendBtn = await waitFor(() => {
      return allVisible(["button", "[role='button']"]).find((b) => {
        const label = (b.getAttribute("aria-label") || b.title || b.innerText || "").toLowerCase();
        return /send|发送|傳送|save|保存/.test(label) && !b.closest("#tgwa-panel");
      });
    }, 3000);
    if (!sendBtn) return { ok: false, error: "forward-send" };
    click(sendBtn);
    await sleep(700);
    return { ok: true };
  }

  // ------------------------------------------------------------ 流式引擎

  function currentMode() {
    return (document.getElementById("tgwa-mode") || {}).value || "snapshot";
  }

  function currentPolicy() {
    return (document.getElementById("tgwa-protected") || {}).value || "skip";
  }

  function readSinceTs() {
    const raw = ((document.getElementById("tgwa-since") || {}).value || "").trim();
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return 0;
    return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
  }

  function findScroller() {
    const b = document.querySelector(".bubble");
    if (!b) return document.scrollingElement || document.documentElement;
    let node = b;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/auto|scroll/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function makeItem(m, mode, chatTitle) {
    return {
      key: m.key,
      peer: m.peer || currentPeerId(),
      mid: Number(m.key),
      ts: m.ts,
      text: m.text,
      sender: m.sender,
      kind: m.kind,
      mediaUrls: m.mediaUrls,
      chatTitle: chatTitle || "",
      mode,
      el: m.el,
    };
  }

  async function streamRun(direction, { limit = 200, sinceTs = 0 } = {}) {
    if (!snapshotReady()) return;
    stop.flag = false;
    const mode = currentMode();
    const channelName = (document.getElementById("tgwa-channel") || {}).value.trim();
    if (!channelName) {
      log("请先在上方填归档频道名字。");
      return;
    }
    const sourcePeer = currentPeerId();
    if (!sourcePeer) {
      log("请先打开源聊天。");
      return;
    }

    const archivePeer = await openChannelByName(channelName);
    if (!archivePeer) {
      log("❌ 找不到归档频道：请确认它在左侧列表可见（可置顶）。");
      return;
    }
    if (archivePeer === sourcePeer) {
      log("❌ 当前打开的聊天就是归档频道，请先切到源聊天。");
      return;
    }
    await openPeer(sourcePeer);
    await sleep(900);
    const sourceTitle = textOf(firstVisible(H.chatTitle));

    const checkpoint = getCheckpoint(sourcePeer) || { mid: 0, ts: 0 };
    const since = sinceTs || readSinceTs();
    const { delayMs } = getSettings();
    const scroller = findScroller();
    if (direction === "up") scroller.scrollTop = scroller.scrollHeight;
    await sleep(900);

    // forward 模式需要频道签名基线做发送校验
    let forwardSig = null;

    let done = 0;
    let failed = 0;
    let skipped = 0;
    let bottomStreak = 0;
    let reachedEnd = false;
    let maxMid = checkpoint.mid || 0;
    let maxTs = checkpoint.ts || 0;
    const seen = new Set();
    const kindCounts = {};
    const albumHandled = new Set();
    // 向上回溯的停止条件：开始产出后，连续遇到 25 条已处理消息视为到达
    // “上次归档边界”。开始产出前的已处理区不做早停（否则刚跑完向下再回溯
    // 会被已归档的新消息卡住），整段都处理过的情况由步数上限兜底。
    let doneStreak = 0;
    let archivedAny = false;

    for (let step = 0; step < 200 && done + failed < limit; step++) {
      if (stop.flag) {
        log("⏹ 已停止（下次继续从断点之后开始）。");
        break;
      }
      for (const m of visibleMessages()) {
        if (stop.flag) break;
        if (seen.has(m.key)) continue;
        if (isDone(sourcePeer, m.key)) {
          seen.add(m.key);
          if (direction === "up" && archivedAny) {
            doneStreak++;
            if (doneStreak >= 25) {
              reachedEnd = true;
              break;
            }
          }
          continue;
        }
        doneStreak = 0;
        if (direction === "down" && checkpoint.mid && Number(m.key) <= checkpoint.mid) {
          seen.add(m.key);
          continue;
        }
        if (since && m.ts && m.ts < since) {
          // 早于起始日期：有意跳过并标记，避免每次重扫
          skipped++;
          markDone(sourcePeer, m.key);
          seen.add(m.key);
          continue;
        }
        seen.add(m.key);
        updateStatus(`运行中：mid=${m.key} ✅${done} ❌${failed} ⏭${skipped}`);

        // 相册（P1-6）：同一分组容器只截一张，组内所有 mid 一起判重
        const grp = mode === "snapshot" ? albumGroupOf(m.el) : null;
        if (grp && albumHandled.has(grp.el)) continue;

        const item = makeItem(m, mode, sourceTitle);
        if (grp) {
          albumHandled.add(grp.el);
          for (const mid of grp.mids) seen.add(mid);
          item.albumMids = grp.mids.slice();
          item.kind = "photo";
        }
        if (mode === "copy" && item.kind !== "text" && !(item.text || "").trim() && currentPolicy() !== "allow_media") {
          // copy + skip 策略下发不了纯媒体：按策略有意跳过，不进失败队列
          skipped++;
          markDone(sourcePeer, item.key);
          log(`  ⏭ 纯媒体消息按 copy+skip 策略跳过：#${item.key}`);
          continue;
        }
        if (mode === "snapshot") {
          item.png = await capturePng(grp ? grp.el : m.el);
          if (!item.png) {
            item.error = "capture";
            failed++;
            queue.push(item);
            updateQueueUi();
            continue;
          }
          item.caption = captionFor(item);
        }

        let ok = false;
        if (mode === "forward") {
          // 原生转发：不切聊天，直接走页面转发对话框
          const r = await forwardOne(item, channelName);
          if (r.denied) {
            skipped++;
            markDone(sourcePeer, item.key);
            markAllDone(sourcePeer, item.albumMids);
            log(`  ⏭ 无转发权限（受保护？）按策略跳过：#${item.key}`);
            continue;
          }
          ok = !!r.ok;
          if (!ok) item.error = r.error || "forward";
          if (ok) {
            // 校验（P0-2）：频道出现新消息才算成功
            await openPeer(archivePeer);
            await sleep(700);
            const sig = channelSignature();
            if (forwardSig && (sig.last > forwardSig.last || sig.count > forwardSig.count)) {
              forwardSig = sig;
            } else if (!forwardSig) {
              forwardSig = sig;
            } else {
              ok = false;
              item.error = "forward-verify";
            }
            await openPeer(sourcePeer);
            await sleep(800);
          }
        } else {
          // snapshot / copy：切到频道 → 发送 → 切回
          const live = findScroller();
          const scrollOffset = live ? live.scrollTop : 0;
          await openPeer(archivePeer);
          await sleep(800);
          ok = currentPeerId() === archivePeer && (await sendOne(item));
          if (!ok && currentPeerId() !== archivePeer) item.error = "switch";
          if (ok) {
            done++;
            archivedAny = true;
            kindCounts[item.kind] = (kindCounts[item.kind] || 0) + 1;
            markDone(sourcePeer, item.key);
            markAllDone(sourcePeer, item.albumMids);
            if (item.mid) {
              maxMid = Math.max(maxMid, item.mid);
              maxTs = Math.max(maxTs, item.ts || 0);
            }
            log(`  ✅ ${item.kind}${item.albumMids ? `×${item.albumMids.length}` : ""} #${item.key}${item.ts ? " " + fmtHuman(item.ts) : ""}`);
          } else {
            failed++;
            queue.push(item);
            updateQueueUi();
            log(`  ❌ #${item.key}${item.error ? `（${item.error}）` : ""}`);
          }
          item.png = null; // 释放，内存中任意时刻只保留正在发送的这一张
          await openPeer(sourcePeer);
          await sleep(1000);
          const sc2 = findScroller();
          if (sc2 && scrollOffset > 0) sc2.scrollTop = scrollOffset;
          await sleep(500);
        }
        if (mode === "forward") {
          if (ok) {
            done++;
            archivedAny = true;
            kindCounts[item.kind] = (kindCounts[item.kind] || 0) + 1;
            markDone(sourcePeer, item.key);
            markAllDone(sourcePeer, item.albumMids);
            if (item.mid) {
              maxMid = Math.max(maxMid, item.mid);
              maxTs = Math.max(maxTs, item.ts || 0);
            }
            log(`  ✅ forward #${item.key}${item.ts ? " " + fmtHuman(item.ts) : ""}`);
          } else {
            failed++;
            queue.push(item);
            updateQueueUi();
            log(`  ❌ #${item.key}${item.error ? `（${item.error}）` : ""}`);
          }
        }
        if (delayMs) await sleep(delayMs); // 温和节奏（P2-14）
      }
      if (reachedEnd) break;
      const s = findScroller();
      if (direction === "down") {
        const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 24;
        if (atBottom) {
          bottomStreak++;
          if (bottomStreak >= 2) {
            reachedEnd = true;
            break;
          }
          await sleep(600);
        } else {
          s.scrollTop = Math.min(s.scrollHeight, s.scrollTop + Math.max(300, s.clientHeight * 0.9));
          bottomStreak = 0;
          await sleep(700);
        }
      } else {
        if (s.scrollTop <= 0) {
          reachedEnd = true;
          break;
        }
        s.scrollTop = Math.max(0, s.scrollTop - Math.max(300, s.clientHeight * 0.9));
        await sleep(700);
      }
    }

    if (maxMid > (checkpoint.mid || 0)) setCheckpoint(sourcePeer, maxMid, maxTs);
    updateQueueUi();
    const kindSummary = Object.entries(kindCounts).map(([k, n]) => `${k}×${n}`).join(" ") || "无";
    const errSummary = countBy(queue.map((q) => q.error || "unknown"));
    const errText = Object.entries(errSummary).map(([k, n]) => `${k}×${n}`).join(" ");
    log(
      `📊 流式归档结束：成功 ${done}（${kindSummary}），失败 ${failed}（${errText || "无"}），按策略跳过 ${skipped}，` +
        (reachedEnd ? "已处理到边界。" : "达到本次上限，可再点一次继续。") +
        ` 断点已推进到 mid=${maxMid}`
    );
    updateStatus("");
  }

  function countBy(arr) {
    const out = {};
    for (const v of arr) out[v] = (out[v] || 0) + 1;
    return out;
  }

  // ------------------------------------------------------------ 重试队列

  // 重试自动打开归档频道并校验 peer 后才发送；截图类先回源聊天重新截图（P0-4）。
  async function sendQueueNow() {
    if (!queue.length) {
      log("重试队列为空。");
      return;
    }
    const channelName = ((document.getElementById("tgwa-channel") || {}).value || "").trim() || store.get("channel", "");
    if (!channelName) {
      log("请先填归档频道，再重试。");
      return;
    }
    const archivePeer = await openChannelByName(channelName);
    if (!archivePeer) {
      log("❌ 找不到归档频道，重试中止。");
      return;
    }
    log(`开始重试：目标频道 ${channelName}（peer=${archivePeer}），共 ${queue.length} 条。`);
    stop.flag = false;
    const { delayMs } = getSettings();
    const next = [];
    let okCount = 0;
    for (const item of queue) {
      if (stop.flag) {
        next.push(item);
        continue;
      }
      if (!item.peer) {
        log(`  ⚠️ #${item.key} 缺少源聊天信息，已丢弃。`);
        continue;
      }
      updateStatus(`重试中：#${item.key}`);
      if (item.mode === "forward") {
        const el = await ensureMessageEl(item);
        if (!el) {
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= 3) {
            log(`  ⚠️ #${item.key} 连续 3 次无法定位消息，已放弃（保持未归档）。`);
            continue;
          }
          next.push(item);
          continue;
        }
        item.el = el;
        const r = await forwardOne(item, channelName);
        if (r.denied) {
          markDone(item.peer, item.key);
          markAllDone(item.peer, item.albumMids);
          log(`  ⏭ 重试发现无转发权限，按策略跳过：#${item.key}`);
          continue;
        }
        if (r.ok) {
          // 校验频道出现新消息
          await openPeer(archivePeer);
          await sleep(700);
          okCount++;
          markDone(item.peer, item.key);
          markAllDone(item.peer, item.albumMids);
          setCheckpoint(item.peer, item.mid || 0, item.ts || 0);
          log(`  ✅ 重试成功（forward）#${item.key}`);
        } else {
          item.error = r.error || "forward";
          item.attempts = (item.attempts || 0) + 1;
          next.push(item);
        }
        item.el = null;
      } else {
        if (item.mode === "snapshot" && !item.png) {
          if (!(await ensureSnapshotPng(item))) {
            item.attempts = (item.attempts || 0) + 1;
            if (item.attempts >= 3) {
              log(`  ⚠️ #${item.key} 连续 3 次无法定位/截图，已放弃（该消息保持未归档状态）。`);
              continue;
            }
            log(`  ⏳ #${item.key} 暂时找不到消息（第 ${item.attempts} 次），留队下次再试。`);
            next.push(item);
            continue;
          }
        }
        await openPeer(archivePeer);
        await sleep(600);
        const ok = currentPeerId() === archivePeer && (await sendOne(item));
        if (ok) {
          okCount++;
          markDone(item.peer, item.key);
          markAllDone(item.peer, item.albumMids);
          setCheckpoint(item.peer, item.mid || 0, item.ts || 0);
          log(`  ✅ 重试成功 #${item.key}`);
        } else {
          item.attempts = (item.attempts || 0) + 1;
          next.push(item);
        }
        item.png = null;
      }
      if (delayMs) await sleep(delayMs);
    }
    queue = next;
    saveQueue();
    updateQueueUi();
    updateStatus("");
    log(`重试完成：成功 ${okCount}，剩余 ${queue.length}。`);
  }

  function updateQueueUi() {
    saveQueue();
    const byErr = countBy(queue.map((q) => q.error || "待重试"));
    const detail = Object.entries(byErr).map(([k, n]) => `${k}:${n}`).join(" / ");
    const label = document.getElementById("tgwa-queue");
    if (label) label.textContent = `重试队列：${queue.length} 条${detail ? `（${detail}）` : ""}`;
  }

  // ------------------------------------------------------------------- UI

  function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function showPanel(show) {
    const panel = document.getElementById("tgwa-panel");
    const fab = document.getElementById("tgwa-fab");
    if (panel) panel.style.display = show ? "block" : "none";
    if (fab) fab.style.display = show ? "none" : "flex";
  }

  function buildPanel() {
    if (document.getElementById("tgwa-panel")) return;
    const s = getSettings();
    const panel = document.createElement("div");
    panel.id = "tgwa-panel";
    panel.innerHTML = `
      <style>
        #tgwa-panel{position:fixed;right:12px;bottom:12px;z-index:999999;width:330px;font:13px/1.5 system-ui,sans-serif;color:#fff;
          background:rgba(20,24,33,.95);border:1px solid #3a3f4b;border-radius:12px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
        #tgwa-panel h3{margin:0 0 8px;font-size:14px}
        #tgwa-panel label{display:block;margin:6px 0 2px;opacity:.85}
        #tgwa-panel input,#tgwa-panel select{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid #555;background:#0f1217;color:#fff}
        #tgwa-panel .row{display:flex;gap:6px;margin-top:8px}
        #tgwa-panel .row > *{flex:1}
        #tgwa-panel button{flex:1;padding:6px 4px;border:0;border-radius:7px;cursor:pointer;background:#2f6fed;color:#fff}
        #tgwa-panel button.secondary{background:#3d4250}
        #tgwa-panel button.danger{background:#a33}
        #tgwa-panel .meta{margin-top:6px;opacity:.85}
        #tgwa-panel pre{height:150px;overflow:auto;background:#0b0e13;border-radius:6px;padding:6px;margin:8px 0 0;white-space:pre-wrap;font-size:11px}
        #tgwa-fab{position:fixed;right:12px;bottom:12px;z-index:999999;width:42px;height:42px;display:none;align-items:center;justify-content:center;
          border-radius:50%;background:#2f6fed;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);user-select:none}
      </style>
      <h3>TG Web 流式归档 <span style="opacity:.5">(${APP})</span></h3>
      <label>归档频道</label>
      <input id="tgwa-channel" placeholder="频道名字（需在左侧列表可见）" value="${escapeAttr(store.get("channel", ""))}" />
      <label>模式</label>
      <select id="tgwa-mode">
        <option value="snapshot">snapshot（截图即发，推荐）</option>
        <option value="copy">copy（文字带发送者）</option>
        <option value="forward">forward（原生转发，实验）</option>
      </select>
      <label>受保护聊天策略</label>
      <select id="tgwa-protected">
        <option value="skip">skip（默认）</option>
        <option value="text_only">text_only（仅文字，高级）</option>
        <option value="allow_media">allow_media（高风险）</option>
      </select>
      <label>起始日期（可选，早于此的消息跳过）</label>
      <input id="tgwa-since" placeholder="YYYY-MM-DD" value="${escapeAttr(store.get("since", ""))}" />
      <div class="row">
        <select id="tgwa-scale" title="截图倍率">
          <option value="1">1x 截图</option>
          <option value="2">2x 截图</option>
          <option value="3">3x 截图</option>
        </select>
        <select id="tgwa-format" title="截图格式">
          <option value="png">PNG</option>
          <option value="jpeg">JPEG(小)</option>
        </select>
        <input id="tgwa-delay" title="每条发送间隔（秒）" placeholder="间隔秒" value="${escapeAttr(store.get("optDelay", 1.2))}" />
      </div>
      <div class="row">
        <button id="tgwa-down">⚡ 截图到最新（流式）</button>
      </div>
      <div class="row">
        <button id="tgwa-up" class="secondary">▲ 向上回溯</button>
        <button id="tgwa-stop" class="secondary">停止</button>
      </div>
      <div class="row">
        <button id="tgwa-retry" class="secondary">重试队列</button>
        <button id="tgwa-clear" class="danger">清理队列</button>
      </div>
      <div class="row">
        <button id="tgwa-probe" class="secondary">① 探测 DOM</button>
        <button id="tgwa-reset" class="secondary">重置进度</button>
        <button id="tgwa-hide" class="secondary">收起</button>
      </div>
      <div id="tgwa-status" class="meta"></div>
      <div id="tgwa-queue" class="meta">重试队列：0 条</div>
      <pre id="tgwa-log"></pre>`;
    document.body.appendChild(panel);

    const fab = document.createElement("div");
    fab.id = "tgwa-fab";
    fab.textContent = "🗂";
    fab.title = "显示 TG 归档面板";
    fab.addEventListener("click", () => showPanel(true));
    document.body.appendChild(fab);

    const modeSel = panel.querySelector("#tgwa-mode");
    const mode = store.get("modeV2", "snapshot");
    modeSel.value = ["snapshot", "copy", "forward"].includes(mode) ? mode : "snapshot";
    const protSel = panel.querySelector("#tgwa-protected");
    protSel.value = ["skip", "text_only", "allow_media"].includes(store.get("protected", "skip"))
      ? store.get("protected", "skip")
      : "skip";
    panel.querySelector("#tgwa-scale").value = String(s.scale);
    panel.querySelector("#tgwa-format").value = s.format;
    panel.querySelector("#tgwa-channel").addEventListener("change", (e) => store.set("channel", e.target.value));
    modeSel.addEventListener("change", (e) => store.set("modeV2", e.target.value));
    protSel.addEventListener("change", (e) => store.set("protected", e.target.value));
    panel.querySelector("#tgwa-since").addEventListener("change", (e) => store.set("since", e.target.value));
    panel.querySelector("#tgwa-scale").addEventListener("change", (e) => store.set("optScale", e.target.value));
    panel.querySelector("#tgwa-format").addEventListener("change", (e) => store.set("optFormat", e.target.value));
    panel.querySelector("#tgwa-delay").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      store.set("optDelay", Number.isFinite(v) && v >= 0 ? v : 1.2);
    });

    const modeName = { snapshot: "snapshot（截图）", copy: "copy（文字）", forward: "forward（转发）" }[modeSel.value];
    log(`面板就绪，当前模式：${modeName}，保护策略：${protSel.value}。队列已恢复 ${queue.length} 条。`);
    log("⚠️ 自动化操作存在账号风控风险：请只归档有权使用的聊天，保持温和节奏（建议间隔 ≥1 秒）。");

    panel.querySelector("#tgwa-down").addEventListener("click", () => {
      const ch = (document.getElementById("tgwa-channel") || {}).value.trim();
      if (!ch) {
        log("请先填归档频道。");
        return;
      }
      if (currentMode() === "snapshot" && currentPolicy() === "skip") {
        log("⚠️ snapshot + skip：截图会把可见内容复制进频道；若聊天受保护，请改用 text_only/allow_media 并确认有权。");
      }
      streamRun("down").catch((err) => log("运行出错：" + (err && err.message ? err.message : err)));
    });
    panel.querySelector("#tgwa-up").addEventListener("click", () => {
      streamRun("up").catch((err) => log("回溯出错：" + (err && err.message ? err.message : err)));
    });
    panel.querySelector("#tgwa-stop").addEventListener("click", () => {
      stop.flag = true;
      log("⏹ 已请求停止：将在当前一条处理完后停下。");
    });
    panel.querySelector("#tgwa-retry").addEventListener("click", () =>
      sendQueueNow().catch((err) => log("重试出错：" + (err && err.message ? err.message : err)))
    );
    panel.querySelector("#tgwa-clear").addEventListener("click", clearQueue);
    panel.querySelector("#tgwa-probe").addEventListener("click", copyProbe);
    panel.querySelector("#tgwa-reset").addEventListener("click", resetProgress);
    panel.querySelector("#tgwa-hide").addEventListener("click", () => showPanel(false));
  }

  function init() {
    loadQueue();
    buildPanel();
    updateQueueUi();
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("TG Web 归档：探测 DOM", copyProbe);
      GM_registerMenuCommand("TG Web 归档：显示面板", () => showPanel(true));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
