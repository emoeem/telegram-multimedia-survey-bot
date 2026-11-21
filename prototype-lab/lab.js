/* Prototype Lab 控制台逻辑：页面/视口/主题/方向切换 + 设备缩放。 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const iframe = $("proto-iframe");
  const frame = $("frame");
  const wrap = $("frame-wrap");

  const DEVICES = [
    { value: "1440x900", kind: "desktop", w: 1440, h: 900 },
    { value: "1280x800", kind: "desktop", w: 1280, h: 800 },
    { value: "1024x768", kind: "desktop", w: 1024, h: 768 },
    { value: "768x1024", kind: "tablet", w: 768, h: 1024 },
    { value: "1024x768@land", kind: "tablet-land", w: 1024, h: 768 },
    { value: "390x844", kind: "mobile", w: 390, h: 844 },
    { value: "360x800", kind: "mobile", w: 360, h: 800 },
    { value: "390x764", kind: "tg", w: 390, h: 764 },
    { value: "844x390", kind: "mobile-land", w: 844, h: 390 },
  ];

  const url = new URL(location.href);
  const state = {
    page: url.searchParams.get("page") || localStorage.getItem("lab-page") || "pages/dashboard.html",
    vp: url.searchParams.get("vp") || localStorage.getItem("lab-vp") || "1440x900",
    theme: url.searchParams.get("theme") || localStorage.getItem("lab-theme") || "dark",
    land: url.searchParams.get("orient") === "landscape" || localStorage.getItem("lab-orient") === "landscape",
  };
  if (state.vp.endsWith("@land")) {
    state.land = true;
    state.vp = state.vp.replace("@land", "");
  }

  function device() {
    const base = DEVICES.find((d) => d.value === state.vp) || DEVICES[0];
    const landscape = state.land && (base.kind === "mobile" || base.kind === "tg" || base.kind === "tablet");
    const w = landscape ? base.h : base.w;
    const h = landscape ? base.w : base.h;
    return { w, h, kind: base.kind, landscape };
  }

  function src() {
    const d = device();
    const u = new URL(state.page, location.href);
    u.searchParams.set("theme", state.theme);
    if (d.kind === "tg") u.searchParams.set("frame", "tg");
    return u.pathname + "?" + u.searchParams.toString();
  }

  function apply() {
    const d = device();
    $("ctl-page").value = state.page;
    $("ctl-vp").value = state.vp;
    $("ctl-theme").value = state.theme;
    $("ctl-orient").textContent = "↔ 方向: " + (d.landscape ? "横屏" : "竖屏");

    iframe.style.width = d.w + "px";
    iframe.style.height = d.h + "px";
    frame.style.width = d.w + "px";
    frame.style.height = d.h + "px";

    const stage = $("stage");
    const availW = stage.clientWidth - 40;
    const availH = stage.clientHeight - 40;
    const scale = Math.min(1, availW / d.w, availH / d.h);
    frame.style.transform = scale < 1 ? "scale(" + scale + ")" : "";
    wrap.style.width = d.w * scale + "px";
    wrap.style.height = d.h * scale + "px";
    $("ctl-size").textContent = d.w + "×" + d.h + " · " + Math.round(scale * 100) + "%";

    const want = src();
    const cur = new URL(iframe.src, location.href);
    if (cur.pathname + cur.search !== want) iframe.src = want;
    $("ctl-open").href = want;

    localStorage.setItem("lab-page", state.page);
    localStorage.setItem("lab-vp", state.vp);
    localStorage.setItem("lab-theme", state.theme);
    localStorage.setItem("lab-orient", d.landscape ? "landscape" : "portrait");
  }

  $("ctl-page").addEventListener("change", (e) => {
    state.page = e.target.value;
    apply();
  });
  $("ctl-vp").addEventListener("change", (e) => {
    state.vp = e.target.value;
    apply();
  });
  $("ctl-theme").addEventListener("change", (e) => {
    state.theme = e.target.value;
    apply();
  });
  $("ctl-orient").addEventListener("click", () => {
    state.land = !state.land;
    apply();
  });
  window.addEventListener("resize", apply);

  apply();
})();
