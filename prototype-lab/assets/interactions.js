/* Prototype Lab — 共享交互运行时（Modal / Drawer / Sheet / Toast / Tabs / 状态面板）
   所有数据均为 Mock，不会请求真实后端。 */
(function () {
  "use strict";

  const ProtoUI = { version: "1.0.0", mock: true };

  /* ---------- Toast ---------- */
  let toastEl = null;
  let toastTimer = null;
  ProtoUI.toast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add("is-visible"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2200);
  };

  /* ---------- 弹层管理（Modal / Drawer / Sheet 通用） ---------- */
  const openStack = [];
  let lastTrigger = null;

  function focusables(el) {
    return el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  }

  ProtoUI.open = function (target, trigger) {
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return;
    lastTrigger = trigger || document.activeElement;
    el.hidden = false;
    openStack.push(el);
    document.body.classList.add("proto-overlay-open");
    const f = focusables(el);
    if (f.length) f[0].focus();
  };

  ProtoUI.close = function (el) {
    if (typeof el === "string") el = document.querySelector(el);
    const top = openStack[openStack.length - 1];
    const node = el || top;
    if (!node) return;
    node.hidden = true;
    const i = openStack.indexOf(node);
    if (i >= 0) openStack.splice(i, 1);
    if (!openStack.length) document.body.classList.remove("proto-overlay-open");
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
  };

  ProtoUI.closeTop = function () {
    const top = openStack[openStack.length - 1];
    if (top) ProtoUI.close(top);
    return Boolean(top);
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openStack.length) {
      e.preventDefault();
      ProtoUI.closeTop();
    }
  });

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-open]");
    if (opener) {
      e.preventDefault();
      ProtoUI.open(opener.getAttribute("data-open"), opener);
      return;
    }
    const closer = e.target.closest("[data-close]");
    if (closer) {
      e.preventDefault();
      ProtoUI.close(closer.getAttribute("data-close") || undefined);
      return;
    }
    // 点击遮罩空白处关闭
    if (e.target.classList && e.target.classList.contains("overlay")) {
      ProtoUI.close(e.target);
    }
  });

  /* ---------- Tabs / 分段控件（视图面板按全局 [data-view-panel] 匹配） ---------- */
  ProtoUI.bindSeg = function (rootSel, onChange) {
    document.querySelectorAll(rootSel + " .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(rootSel + " .seg-btn")
          .forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        const viewSel = btn.getAttribute("data-view");
        if (viewSel) {
          document
            .querySelectorAll("[data-view-panel]")
            .forEach((p) => (p.hidden = p.getAttribute("data-view-panel") !== viewSel));
        }
        if (onChange) onChange(btn.getAttribute("data-view"), btn);
      });
    });
  };

  /* ---------- Telegram WebView 宿主栏模拟（?frame=tg，四页统一） ---------- */
  ProtoUI.applyTgFrame = function (opts) {
    opts = opts || {};
    if (new URLSearchParams(location.search).get("frame") !== "tg") return false;
    document.body.classList.add("tg-frame");
    const bar = document.createElement("div");
    bar.className = "tg-hostbar";
    bar.innerHTML =
      '<span class="tg-hostbar-back">← 返回</span><strong>' +
      (opts.title || "问卷星球") +
      '</strong><span class="tg-hostbar-app">Mini App</span>';
    document.body.prepend(bar);
    if (opts.mount) {
      const mount = document.querySelector(opts.mount);
      if (mount) {
        const note = document.createElement("div");
        note.className = "tg-note";
        note.textContent = "📱 模拟 Telegram WebView：宿主返回栏、安全区与短视口布局（页面导航由宿主接管）。";
        mount.prepend(note);
      }
    }
    return true;
  };

  /* ---------- 原型状态面板 ---------- */
  ProtoUI.bindStatePanel = function (states, apply, initial) {
    const params = new URLSearchParams(location.search);
    let current = params.get("state") || initial || "normal";

    const wrap = document.createElement("div");
    wrap.className = "proto-panel";
    wrap.innerHTML =
      '<button type="button" class="proto-panel-toggle" id="pp-toggle" aria-label="原型控制面板" title="原型控制面板">🛠</button>' +
      '<div class="proto-panel-body" id="pp-body" hidden>' +
      '<div class="field"><label class="field-label" for="pp-state">页面状态（演示）</label>' +
      '<select class="select" id="pp-state">' +
      states.map((s) => '<option value="' + s.value + '">' + s.label + "</option>").join("") +
      "</select></div>" +
      '<p class="proto-note">此页面为交互原型，全部数据为 Mock，不请求真实后端、不写入生产。</p>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="pp-reset">重置状态</button>' +
      "</div>";
    document.body.appendChild(wrap);

    const body = wrap.querySelector("#pp-body");
    const sel = wrap.querySelector("#pp-state");
    wrap.querySelector("#pp-toggle").addEventListener("click", () => {
      body.hidden = !body.hidden;
    });
    wrap.querySelector("#pp-reset").addEventListener("click", () => {
      current = "normal";
      sel.value = "normal";
      apply("normal");
      history.replaceState(null, "", stripState());
      ProtoUI.toast("已重置为默认状态（Mock）");
    });
    sel.value = current;
    sel.addEventListener("change", () => {
      current = sel.value;
      apply(current);
      const u = new URL(stripState());
      if (current !== "normal") u.set("state", current);
      history.replaceState(null, "", u.toString().replace(/^\?/, "") ? "?" + u.toString() : location.pathname);
    });

    if (current !== "normal") apply(current);
    return { get: () => current };
  };

  function stripState() {
    const u = new URL(location.href);
    u.searchParams.delete("state");
    return u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
  }

  /* ---------- 复制（原型内为演示数据） ---------- */
  ProtoUI.copy = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  };

  window.ProtoUI = ProtoUI;
})();
