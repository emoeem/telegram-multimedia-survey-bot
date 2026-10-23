/* 认证卡生成器 —— 状态、面板与导出
 *
 * 依赖（均为经典脚本，按顺序加载）：
 *   vendor/qrcode.js  —— Kazuhiko Arase 的 qrcode-generator（MIT），提供全局 qrcode()
 *   themes.js         —— window.CERT_THEMES（含分组标签库）
 *   presets.js        —— window.CERT_UI_PRESETS（问卷 daisyUI 预设调色板）
 *   render.js         —— window.CERT_RENDER（11 种样式 + 比例预设）
 *
 * 所有数据保存在 localStorage，照片只存在于内存与 object URL，从不外发。
 */
(function () {
  "use strict";

  var THEMES = [];
  var R = window.CERT_RENDER;
  var STORAGE_KEY = "cert-card-maker:v1";
  var SURVEY_PRESET_KEY = "surveyPreset"; // 问卷 SPA 写入的主题选择，同源共享
  /* 18+ 同意状态单独存一个键：boot 时要在 state 之前同步读到它，
   * 好决定「先把成人词库加载进来、再恢复上次的主题」，否则重启后主题会丢。 */
  var ADULT_KEY = "cert-card-maker:adult-ok";
  /* 频道署名单独存一个键：它表示「谁做的」，不属于卡片内容，
   * 所以不进 state.shared，也不会被分享链接 #s= 带出去。 */
  var SIGNER_KEY = "cert-card-maker:signer";
  var ADULT_SRC = "themes-adult.js";
  var adultLoading = null;

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + seq;
  }

  function todayText() {
    var d = new Date();
    var p = function (n) {
      return n < 10 ? "0" + n : "" + n;
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function defaultNo() {
    return "CERT-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ------------------------------------------------------------------ *
   * 分值制主题 / 成人向主题
   *
   * 默认主题按「勾选条数 ÷ 总条数」算强度。带 metric.kind === "score" 的主题
   * 改成「勾选词条分值累加 ÷ divisor」，与来源站同口径，因此百分比可以超过 100%。
   * 这类主题的词条还带性别（u 通用 / f 雌性 / m 雄性），选定性别后只显示 u + 该性别。
   * ------------------------------------------------------------------ */
  /* 频道署名：写完就存，下次打开还在。隐私模式写不进去也不影响导出。 */
  function readSigner() {
    try {
      return localStorage.getItem(SIGNER_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function writeSigner(value) {
    try {
      if (value) localStorage.setItem(SIGNER_KEY, value);
      else localStorage.removeItem(SIGNER_KEY);
    } catch (e) {
      /* 存不下就算了，本次导出仍然带着它 */
    }
  }

  function adultOk() {
    try {
      return localStorage.getItem(ADULT_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setAdultOk(v) {
    try {
      if (v) localStorage.setItem(ADULT_KEY, "1");
      else localStorage.removeItem(ADULT_KEY);
    } catch (e) {
      /* 隐私模式忽略 */
    }
  }

  function hashStr(s) {
    var h = 2166136261;
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function visibleThemes() {
    var ok = adultOk();
    return THEMES.filter(function (t) {
      return ok || !t.adult;
    });
  }

  function isScoreTheme(t) {
    t = t || theme();
    return !!(t && t.metric && t.metric.kind === "score");
  }

  function scoreDivisor() {
    var t = theme();
    return Math.max(1, num(t.metric && t.metric.divisor, 60));
  }

  function genderOn() {
    return !!theme().genderAware;
  }

  function tagVisible(x) {
    if (!genderOn()) return true;
    var sex = x.sex || "u";
    return sex === "u" || sex === state.gender;
  }

  function tagScore(x) {
    return clamp(Math.round(num(x.score, 1)), 1, 3);
  }

  /** 当前性别下真正显示/计分的词条 */
  function visibleTags() {
    return themeData().tags.filter(tagVisible);
  }

  /**
   * 频道消息用的已勾选标签文本。
   * 取不到就当空数组：标签是锦上添花，不能因为它让整次上传失败。
   */
  function selectedTagTexts() {
    try {
      return visibleTags()
        .filter(function (x) {
          return x.on && x.text.trim();
        })
        .map(function (x) {
          return x.text.trim();
        });
    } catch (e) {
      return [];
    }
  }

  /** 分值制主题的原始分值（只有勾选中的才算） */
  function rawScore() {
    var raw = 0;
    visibleTags().forEach(function (x) {
      if (x.on) raw += tagScore(x);
    });
    return raw;
  }

  /** 词条定义可能是纯字符串（中立主题）或 {t,s,g}（成人向主题） */
  function tagMeta(x) {
    if (x && typeof x === "object") {
      return {
        text: String(x.t || x.text || "").trim(),
        score: clamp(Math.round(num(x.s, 1)), 1, 3),
        sex: /^[ufm]$/.test(x.g) ? x.g : "u",
      };
    }
    return { text: String(x == null ? "" : x).trim(), score: 1, sex: "u" };
  }

  /** 主题的分组元信息；老数据（纯扁平 tags）兜底成一个「全部」分组。 */
  function groupsMeta(theme) {
    if (theme && theme.groups && theme.groups.length) return theme.groups;
    return [{ emoji: "🏷️", name: "全部", tags: [] }];
  }

  function blankThemeData(theme) {
    var tags = [];
    groupsMeta(theme).forEach(function (g) {
      (g.tags || []).forEach(function (def) {
        var meta = tagMeta(def);
        if (!meta.text) return;
        tags.push({ id: uid("t"), text: meta.text, on: false, g: g.name, sex: meta.sex, score: meta.score });
      });
    });
    return {
      tags: tags,
      ranks: (theme.ranks || []).map(function (r) {
        return {
          min: r.min,
          max: r.max,
          name: r.name || "",
          grade: r.grade || "",
          rare: r.rare || "",
          say: Array.isArray(r.say) ? r.say.slice() : null,
          f: Array.isArray(r.f) ? r.f.slice() : null,
          m: Array.isArray(r.m) ? r.m.slice() : null,
        };
      }),
      form: {
        issuer: theme.issuer,
        subtitle: theme.subtitle,
        cardLabel: theme.cardLabel,
        sealText: theme.sealText,
      },
    };
  }

  function blankState() {
    var themes = {};
    THEMES.forEach(function (t) {
      themes[t.id] = blankThemeData(t);
    });
    return {
      themeId: THEMES.length ? THEMES[0].id : "",
      styleId: R.STYLES[0].id,
      ratioId: R.RATIOS[1].id,
      gender: "f",
      shared: { name: "", no: defaultNo(), issueDate: todayText(), validUntil: "长期有效", qr: "" },
      autoPct: true,
      manualPct: 60,
      photoMode: "collage", // collage | single：照片位多图时怎么排
      photoOverlay: false, // 照片上是否压姓名/日期
      themes: themes,
    };
  }

  var state = null;

  function load() {
    var base = blankState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return base;
      if (saved.themeId && base.themes[saved.themeId]) base.themeId = saved.themeId;
      if (saved.gender === "f" || saved.gender === "m") base.gender = saved.gender;
      if (R.findStyle(saved.styleId).id === saved.styleId) base.styleId = saved.styleId;
      if (R.findRatio(saved.ratioId).id === saved.ratioId) base.ratioId = saved.ratioId;
      if (typeof saved.autoPct === "boolean") base.autoPct = saved.autoPct;
      if (typeof saved.manualPct === "number") base.manualPct = saved.manualPct;
      if (saved.photoMode === "single" || saved.photoMode === "collage") base.photoMode = saved.photoMode;
      if (typeof saved.photoOverlay === "boolean") base.photoOverlay = saved.photoOverlay;
      if (saved.shared) {
        Object.keys(base.shared).forEach(function (k) {
          if (typeof saved.shared[k] === "string") base.shared[k] = saved.shared[k];
        });
      }
      Object.keys(base.themes).forEach(function (id) {
        var s = saved.themes && saved.themes[id];
        if (!s) return;
        var themeDef =
          THEMES.filter(function (t) {
            return t.id === id;
          })[0] || {};
        /* 分值制主题的档位区间按分值算，可以超过 100，上限放到 999 */
        var hiMax = themeDef.metric && themeDef.metric.kind === "score" ? 999 : 100;
        if (Array.isArray(s.tags) && s.tags.length) {
          /* 旧存档的标签没有 g/sex/score 字段：按文本回填到主题分组里，找不到就进第一个分组。 */
          var meta = groupsMeta(
            THEMES.filter(function (t) {
              return t.id === id;
            })[0] || {},
          );
          var textToGroup = {};
          var textMeta = {};
          meta.forEach(function (g) {
            (g.tags || []).forEach(function (def) {
              var m = tagMeta(def);
              if (!m.text) return;
              if (!textToGroup[m.text]) textToGroup[m.text] = g.name;
              if (!textMeta[m.text]) textMeta[m.text] = m;
            });
          });
          var firstGroup = meta[0].name;
          base.themes[id].tags = s.tags
            .filter(function (t) {
              return t && typeof t.text === "string";
            })
            .map(function (t) {
              var m = textMeta[t.text] || { score: 1, sex: "u" };
              return {
                id: t.id || uid("t"),
                text: t.text,
                on: !!t.on,
                g: typeof t.g === "string" && t.g ? t.g : textToGroup[t.text] || firstGroup,
                sex: /^[ufm]$/.test(t.sex) ? t.sex : m.sex,
                score: clamp(Math.round(num(t.score, m.score)), 1, 3),
              };
            });
        }
        if (Array.isArray(s.ranks) && s.ranks.length) {
          base.themes[id].ranks = s.ranks.map(function (r) {
            return {
              min: num(r.min, 0),
              max: num(r.max, hiMax),
              name: String(r.name || ""),
              grade: String(r.grade || ""),
              rare: String(r.rare || ""),
              say: Array.isArray(r.say) ? r.say.slice() : null,
              f: Array.isArray(r.f) ? r.f.slice() : null,
              m: Array.isArray(r.m) ? r.m.slice() : null,
            };
          });
        }
        if (s.form) {
          Object.keys(base.themes[id].form).forEach(function (k) {
            if (typeof s.form[k] === "string") base.themes[id].form[k] = s.form[k];
          });
        }
      });
    } catch (e) {
      /* 存档损坏就用默认值 */
    }
    return base;
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        /* 隐私模式下写不进去就算了 */
      }
    }, 250);
  }

  function theme() {
    var list = visibleThemes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.themeId) return list[i];
    }
    return list[0] || { palette: {}, groups: [], ranks: [] };
  }

  /** 当前主题在 state 里的可变数据；主题被收起/换掉时按新主题现建一份 */
  function themeData() {
    if (
      !state.themes[state.themeId] ||
      !THEMES.some(function (t) {
        return t.id === state.themeId;
      })
    ) {
      state.themeId = theme().id || "";
      if (!state.themeId) return { tags: [], ranks: [], form: {} };
      state.themes[state.themeId] = blankThemeData(theme());
    }
    return state.themes[state.themeId];
  }

  function percent() {
    if (!state.autoPct) return clamp(Math.round(state.manualPct), 0, isScoreTheme() ? 999 : 100);
    if (isScoreTheme()) return Math.round((rawScore() / scoreDivisor()) * 100);
    var tags = visibleTags();
    if (!tags.length) return 0;
    var on = tags.filter(function (t) {
      return t.on;
    }).length;
    return Math.round((on / tags.length) * 100);
  }

  function selectedCount() {
    return visibleTags().filter(function (t) {
      return t.on;
    }).length;
  }

  function pickBy(arr, seed) {
    if (!arr || !arr.length) return "";
    return String(arr[Math.abs(seed) % arr.length] || "");
  }

  /**
   * 档位展示信息：name 手填过就用手填的，否则按「名字 hash」从该性别的 3 个候选称号里
   * 固定抽一个（同一个人每次都一样）；say 是这一档的点评，按 hash + 分值挑一句。
   */
  function rankView(r) {
    var gg = genderOn() ? state.gender : "f";
    if (!r) return { name: "未评级", grade: "", rare: "", say: "", min: 0, max: 0, raw: null };
    var seed = hashStr(String(state.shared.name || ""));
    var name = (r.name || "").trim();
    if (!name) {
      var cands = r[gg] || r.f || r.m || null;
      name = pickBy(cands, seed) || "未评级";
    }
    var say = "";
    if (Array.isArray(r.say) && r.say.length) say = pickBy(r.say, seed + rawScore());
    return {
      name: name,
      grade: r.grade || "",
      rare: r.rare || "",
      say: say,
      min: r.min,
      max: r.max,
      raw: r,
    };
  }

  function hitRank(pct) {
    var ranks = themeData().ranks;
    if (!ranks.length) return rankView(null);
    for (var i = 0; i < ranks.length; i++) {
      if (pct >= ranks[i].min && pct <= ranks[i].max) return rankView(ranks[i]);
    }
    return rankView(ranks[ranks.length - 1]);
  }

  /** 等级角标：如 "UR"（稀有度）；没配就是空串 */
  function gradeBadge(r) {
    if (!r) return "";
    return String(r.grade || r.rare || "");
  }

  /**
   * 已解锁的板块徽章：某个板块选中的词条数达到「该板块在当前性别下可见条数的 35%，
   * 且至少 4 条」就算拿到这枚徽章，最多取前 6 个（来源站是每个板块一枚徽章）。
   */
  function earnedBadges() {
    var meta = groupsMeta(theme());
    var byGroup = {};
    visibleTags().forEach(function (x) {
      if (!x.on) return;
      byGroup[x.g] = (byGroup[x.g] || 0) + 1;
    });
    var out = [];
    meta.forEach(function (g) {
      var n = byGroup[g.name] || 0;
      if (!g.badge || !n) return;
      var need = badgeNeed(g.name);
      if (n >= need) out.push({ emoji: g.emoji || "🏷️", name: g.badge, count: n, need: need });
    });
    return out.slice(0, 6);
  }

  function defaultQrText() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return shareUrl();
    }
    return "CERT " + (state.shared.no || "");
  }

  /* ------------------------------------------------------------------ *
   * 分享链接
   * ------------------------------------------------------------------ */
  function b64url(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function unb64url(s) {
    var t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return decodeURIComponent(escape(atob(t)));
  }

  function sharePayload() {
    var d = themeData();
    /* 带上性别与分值（v2），这样收到链接的人切换性别也能看到同样的词条。
     * 词表里两个性别的词条都导出，对方的勾选状态才完整。 */
    return {
      v: 2,
      t: state.themeId,
      s: state.styleId,
      r: state.ratioId,
      g: state.gender,
      n: state.shared.name || "",
      no: state.shared.no || "",
      vu: state.shared.validUntil || "",
      ap: state.autoPct ? 1 : 0,
      mp: state.autoPct ? undefined : clamp(Math.round(state.manualPct), 0, isScoreTheme() ? 999 : 100),
      tags: d.tags.map(function (t) {
        return [t.text, t.g, t.on ? 1 : 0, t.sex || "u", tagScore(t)];
      }),
    };
  }

  function shareUrl() {
    /* 单文件离线版会注入 CERT_SHARE_BASE：file:// 下也要能生成可分享的在线链接 */
    var base = window.CERT_SHARE_BASE || location.origin + location.pathname;
    return String(base).replace(/#.*$/, "") + "#s=" + b64url(JSON.stringify(sharePayload()));
  }

  function applyShareFromHash() {
    var m = /(?:^|&)s=([A-Za-z0-9_-]+)/.exec(location.hash.replace(/^#/, ""));
    if (!m) return false;
    try {
      var data = JSON.parse(unb64url(m[1]));
      if (!data || typeof data !== "object" || !Array.isArray(data.tags)) return false;
      state = blankState();
      if (R.findStyle(data.s).id === data.s) state.styleId = data.s;
      if (R.findRatio(data.r).id === data.r) state.ratioId = data.r;
      if (data.t && state.themes[data.t]) state.themeId = data.t;
      if (typeof data.n === "string") state.shared.name = data.n.slice(0, 40);
      if (typeof data.no === "string") state.shared.no = data.no.slice(0, 40);
      if (typeof data.vu === "string") state.shared.validUntil = data.vu.slice(0, 40);
      state.autoPct = data.ap !== 0;
      if (data.g === "f" || data.g === "m") state.gender = data.g;
      if (!state.autoPct && typeof data.mp === "number") state.manualPct = clamp(Math.round(data.mp), 0, 999);
      var d = state.themes[state.themeId];
      var meta = groupsMeta(
        THEMES.filter(function (t) {
          return t.id === state.themeId;
        })[0] || {},
      );
      var names = {};
      meta.forEach(function (g) {
        names[g.name] = true;
      });
      var firstGroup = meta[0].name;
      d.tags = data.tags
        .slice(0, 4000)
        .map(function (row) {
          if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0].trim()) return null;
          return {
            id: uid("t"),
            text: row[0].trim().slice(0, 40),
            g: typeof row[1] === "string" && row[1] ? row[1] : firstGroup,
            on: row[2] === 1,
            sex: /^[ufm]$/.test(row[3]) ? row[3] : "u",
            score: clamp(Math.round(num(row[4], 1)), 1, 3),
          };
        })
        .filter(Boolean);
      /* 分享里带了不在内置分组里的组名（自定义分组），补进元信息 */
      d.tags.forEach(function (t) {
        if (!names[t.g]) {
          meta.push({ emoji: "🏷️", name: t.g, tags: [] });
          names[t.g] = true;
        }
      });
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 主题选择（与问卷主页共用 localStorage.surveyPreset，双向同步）
   * ------------------------------------------------------------------ */
  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function rawPresetChoice() {
    try {
      return localStorage.getItem(SURVEY_PRESET_KEY);
    } catch (e) {
      return null;
    }
  }

  function resolvePreset(raw) {
    if (!raw) return null;
    if (raw === "system") return systemPrefersDark() ? "dark" : "light";
    return window.CERT_UI_PRESETS && window.CERT_UI_PRESETS[raw] ? raw : null;
  }

  function setPresetChoice(raw) {
    try {
      if (raw) localStorage.setItem(SURVEY_PRESET_KEY, raw);
      else localStorage.removeItem(SURVEY_PRESET_KEY);
    } catch (e) {
      /* 隐私模式等存不了就算了，本次会话仍生效 */
    }
    applyPreset();
  }

  function applyPreset() {
    var root = document.documentElement;
    var raw = rawPresetChoice();
    var preset = resolvePreset(raw);
    if (!preset) {
      root.removeAttribute("data-cert-preset");
      root.style.removeProperty("--bg");
      root.style.removeProperty("--panel");
      root.style.removeProperty("--ink");
      root.style.removeProperty("--brand");
      root.style.removeProperty("--on-brand");
    } else {
      var p = window.CERT_UI_PRESETS[preset];
      root.setAttribute("data-cert-preset", preset);
      root.style.setProperty("--bg", p.page);
      root.style.setProperty("--panel", p.card);
      root.style.setProperty("--ink", p.ink);
      root.style.setProperty("--brand", p.primary);
      root.style.setProperty("--on-brand", p.onPrimary);
    }
    var label = $("themePresetLabel");
    if (label) {
      label.textContent = raw === "system" ? "跟随系统" : preset ? window.CERT_UI_PRESETS[preset].label : "默认";
    }
    markSheetSelection(raw);
  }

  /* 跟随系统时，系统切换深浅色实时换肤 */
  if (window.matchMedia) {
    var mql = window.matchMedia("(prefers-color-scheme: dark)");
    var onSchemeChange = function () {
      if (rawPresetChoice() === "system") applyPreset();
    };
    if (mql.addEventListener) mql.addEventListener("change", onSchemeChange);
  }

  function markSheetSelection(raw) {
    var grid = $("themeGrid");
    if (!grid) return;
    var btns = grid.querySelectorAll("[data-preset]");
    for (var i = 0; i < btns.length; i++) {
      var val = btns[i].getAttribute("data-preset");
      btns[i].classList.toggle("active", (val || null) === (raw || null));
    }
  }

  function buildThemeSheet() {
    var grid = $("themeGrid");
    if (!grid) return;
    var P = window.CERT_UI_PRESETS || {};
    var entries = [
      { id: "", name: "默认" },
      { id: "system", name: "跟随系统" },
    ].concat(
      Object.keys(P).map(function (k) {
        return { id: k, name: P[k].label, p: P[k] };
      }),
    );
    entries.forEach(function (e) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-swatch";
      btn.setAttribute("data-preset", e.id);
      var box = document.createElement("span");
      box.className = "swatch-box";
      if (e.p) {
        box.style.background = e.p.page;
        var dot = document.createElement("span");
        dot.className = "swatch-dot";
        dot.style.background = e.p.primary;
        box.appendChild(dot);
        var bar = document.createElement("span");
        bar.className = "swatch-bar";
        bar.style.background = e.p.ink;
        box.appendChild(bar);
      } else if (e.id === "system") {
        box.className += " swatch-system";
        box.textContent = "🖥";
      } else {
        box.className += " swatch-default";
      }
      var name = document.createElement("span");
      name.className = "swatch-name";
      name.textContent = e.name;
      btn.appendChild(box);
      btn.appendChild(name);
      btn.addEventListener("click", function () {
        setPresetChoice(e.id || null);
        closeThemeSheet();
        toast("主题已切换：" + e.name + (e.id ? "（问卷主页同步生效）" : ""));
      });
      grid.appendChild(btn);
    });
  }

  function openThemeSheet() {
    var sheet = $("themeSheet");
    if (!sheet) return;
    markSheetSelection(rawPresetChoice());
    sheet.hidden = false;
  }

  function closeThemeSheet() {
    var sheet = $("themeSheet");
    if (sheet) sheet.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   * 渲染画布
   * ------------------------------------------------------------------ */
  var photos = [];
  var PHOTO_MAX = 9; // 一张卡最多铺 9 张，超出的在最后一格显示 +N

  /** 卡上要展示的照片（按勾选顺序，最多 9 张）；照片未解码完的先跳过 */
  function pickedPhotoImgs() {
    var out = [];
    for (var i = 0; i < photos.length && out.length < PHOTO_MAX; i++) {
      var p = photos[i];
      if (p.on && p.img && p.img.complete && p.img.naturalWidth) out.push(p.img);
    }
    return out;
  }

  /** 已勾选张数（含还没解码完的） */
  function pickedCount() {
    var n = 0;
    for (var i = 0; i < photos.length; i++) if (photos[i].on) n += 1;
    return n;
  }

  /** 未确认 18+ 时不能停在成人向版式上（本地存过、或分享链接带过来的都可能） */
  function safeStyle() {
    var style = R.findStyle(state.styleId);
    if (style.adult && !adultOk()) {
      for (var i = 0; i < R.STYLES.length; i++) {
        if (!R.STYLES[i].adult) {
          /* 同时把 state 改掉：只回退画布不改状态的话，选择器里会一个高亮的都没有 */
          state.styleId = R.STYLES[i].id;
          return R.STYLES[i];
        }
      }
    }
    return style;
  }

  function render() {
    var ratio = R.findRatio(state.ratioId);
    var style = safeStyle();
    var t = theme();
    var pct = percent();
    var d = themeData();
    var photoImgs = pickedPhotoImgs();
    var rank = hitRank(pct);
    var vis = visibleTags();

    var canvas = $("card");
    canvas.width = ratio.w;
    canvas.height = ratio.h;
    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ratio.w, ratio.h);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    style.render(ctx, {
      W: ratio.w,
      H: ratio.h,
      pal: t.palette,
      form: d.form,
      shared: state.shared,
      pct: pct,
      rank: rank,
      grade: gradeBadge(rank),
      say: rank.say || "",
      badges: earnedBadges(),
      score: { on: isScoreTheme(), raw: rawScore(), divisor: scoreDivisor() },
      gender: state.gender,
      tags: vis
        .filter(function (x) {
          return x.on && x.text.trim();
        })
        .map(function (x) {
          return x.text.trim();
        }),
      allTags: vis
        .map(function (x) {
          return x.text.trim();
        })
        .filter(Boolean),
      photo: photoImgs.length ? photoImgs[0] : null,
      photos: photoImgs,
      photoMode: state.photoMode || "collage",
      photoOverlay: !!state.photoOverlay,
      photoGrid: 9,
      qrText: state.shared.qr || defaultQrText(),
    });

    $("sizeEcho").textContent = ratio.w + " × " + ratio.h;
  }

  /* ------------------------------------------------------------------ *
   * 统计条
   * ------------------------------------------------------------------ */
  function updateStats() {
    var pct = percent();
    var rank = hitRank(pct);
    var score = isScoreTheme();
    $("statCount").textContent = selectedCount();
    $("statPct").textContent = pct + "%";
    if ($("statPctLabel")) $("statPctLabel").textContent = score ? "骚度" : "强度";
    $("statRank").textContent = (gradeBadge(rank) ? "[" + gradeBadge(rank) + "] " : "") + (rank.name || "未评级");
    /* 分值制主题的百分比能超过 100%，进度条只画满为止 */
    $("statFill").style.width = clamp(pct, 0, 100) + "%";
    $("ctaCount").textContent = selectedCount();
    $("pctEcho").textContent =
      "当前 " + pct + "%" + (score ? "（原始分值 " + rawScore() + "）" : "") + " · " + (rank.name || "未评级");
    var man = $("manualPct");
    if (man) man.max = score ? 999 : 100;
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */
  function $(id) {
    return document.getElementById(id);
  }

  function renderStyles() {
    /* 先把「存档/分享链接里是成人向版式但没解锁」这种情况收敛掉，
     * 否则选择器里会一个高亮的都没有（画布已经回退了，按钮却没回退）。 */
    safeStyle();
    var box = $("styleList");
    box.innerHTML = "";
    /* 两组：证件族（像真的）与创意版式。分组标题本身就是提示——
     * 想要「像身份证」的人不会在「通缉令」里找。 */
    var unlocked = adultOk();
    var groups = [
      { id: "doc", title: "证件样式", hint: "照真证件的版式与字段排" },
      { id: "fun", title: "创意版式", hint: "整活向，不追求像" },
      { id: "adult", title: "成人向证件", hint: "确认 18+ 后出现，词条同样来自成人向词库", adult: true },
    ];
    groups.forEach(function (g) {
      if (g.adult && !unlocked) return;
      var list = R.STYLES.filter(function (s) {
        if (g.adult) return !!s.adult;
        return (s.group || "fun") === g.id && !s.adult;
      });
      if (!list.length) return;
      var head = document.createElement("div");
      head.className = "style-group-title";
      var name = document.createElement("strong");
      name.textContent = g.title;
      var hint = document.createElement("span");
      hint.textContent = g.hint;
      head.appendChild(name);
      head.appendChild(hint);
      box.appendChild(head);
      var grid = document.createElement("div");
      grid.className = "style-grid";
      list.forEach(function (s) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "style-btn";
        b.textContent = s.name;
        b.setAttribute("aria-pressed", String(s.id === state.styleId));
        b.addEventListener("click", function () {
          state.styleId = s.id;
          save();
          renderStyles();
          render();
        });
        grid.appendChild(b);
      });
      box.appendChild(grid);
    });
    var adultCount = R.STYLES.filter(function (s) {
      return s.adult;
    }).length;
    $("styleCount").textContent = unlocked
      ? R.STYLES.length
      : R.STYLES.length - adultCount + "（另有 " + adultCount + " 种成人向证件待解锁）";
  }

  function renderRatios() {
    var box = $("ratioSeg");
    box.innerHTML = "";
    R.RATIOS.forEach(function (r) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn" + (r.id === state.ratioId ? " active" : "");
      b.textContent = r.name;
      b.setAttribute("data-ratio", r.id);
      b.addEventListener("click", function () {
        state.ratioId = r.id;
        save();
        renderRatios();
        render();
      });
      box.appendChild(b);
    });
  }

  function renderThemes() {
    var box = $("themeList");
    box.innerHTML = "";
    visibleThemes().forEach(function (t) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-btn";
      btn.setAttribute("aria-pressed", String(t.id === state.themeId));
      var dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = t.palette.accent;
      var txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = t.name;
      btn.appendChild(dot);
      btn.appendChild(txt);
      btn.addEventListener("click", function () {
        state.themeId = t.id;
        save();
        renderThemes();
        syncForm();
        renderGroups();
        renderRanks();
        renderTitles();
        renderGender();
        updateStats();
        render();
      });
      box.appendChild(btn);
    });
  }

  /* ------------------------------------------------------------------ *
   * 性别切换 / 标题预设 / 成人向开关
   * ------------------------------------------------------------------ */
  function groupDef(name) {
    var meta = groupsMeta(theme());
    for (var i = 0; i < meta.length; i++) {
      if (meta[i].name === name) return meta[i];
    }
    return null;
  }

  /** 该板块在当前性别下可见的词条总数 */
  function groupVisibleTotal(name) {
    var d = groupDef(name);
    if (!d) return 0;
    return (d.tags || []).filter(function (def) {
      var m = tagMeta(def);
      return m.text && tagVisible({ sex: m.sex });
    }).length;
  }

  /** 拿到这个板块徽章要选多少条：可见条数的 35%，最少 4 条 */
  function badgeNeed(name) {
    return Math.max(4, Math.ceil(groupVisibleTotal(name) * 0.35));
  }

  function renderGender() {
    var wrap = $("genderWrap");
    if (!wrap) return;
    var on = genderOn();
    wrap.hidden = !on;
    if (!on) return;
    var seg = $("genderSeg");
    seg.innerHTML = "";
    [
      ["f", "♀ 雌性"],
      ["m", "♂ 雄性"],
    ].forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn" + (state.gender === p[0] ? " active" : "");
      b.textContent = p[1];
      b.addEventListener("click", function () {
        state.gender = p[0];
        save();
        renderGender();
        renderTitles();
        renderGroups();
        updateStats();
        render();
      });
      seg.appendChild(b);
    });
    var note = $("genderNote");
    if (note) {
      var all = themeData().tags.length;
      note.textContent =
        "词库共 " + all + " 条 · 当前性别可见 " + visibleTags().length + " 条 · 换性别会换掉可见词与分值";
    }
  }

  function renderTitles() {
    var wrap = $("titleWrap");
    if (!wrap) return;
    var t = theme();
    var list = (t.titles && (t.titles[state.gender] || t.titles.f)) || [];
    wrap.hidden = !list.length;
    if (!list.length) return;
    var box = $("titlePresets");
    var cur = themeData().form.cardLabel || "";
    box.innerHTML = "";
    list.forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (name === cur ? " on" : "");
      b.textContent = name;
      b.setAttribute("aria-pressed", String(name === cur));
      b.addEventListener("click", function () {
        themeData().form.cardLabel = name;
        $("fCardLabel").value = name;
        save();
        renderTitles();
        render();
      });
      box.appendChild(b);
    });
  }

  function adultThemeCount() {
    return THEMES.filter(function (t) {
      return t.adult;
    }).length;
  }

  function renderGate() {
    var box = $("adultBox");
    if (!box) return;
    box.innerHTML = "";
    var p = document.createElement("p");
    p.className = "adult-note";
    if (adultOk()) {
      p.textContent =
        "已解锁成人向词库" +
        (adultThemeCount() ? "（" + adultThemeCount() + " 套主题）" : "") +
        "。词表只加载到你自己的浏览器里，不会上传。";
      var off = document.createElement("button");
      off.type = "button";
      off.className = "btn ghost tiny";
      off.textContent = "收起成人内容";
      off.addEventListener("click", hideAdult);
      box.appendChild(p);
      box.appendChild(off);
      return;
    }
    p.textContent =
      "另有一套成人向词库：19 个板块 / 1050 条词条 / 每条带性别与分值，含露骨成人内容。" +
      "点确认后才会下载词表，未确认前页面里不存在任何一条。";
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn tiny";
    yes.textContent = "我已满 18 岁，加载词库";
    yes.addEventListener("click", enableAdult);
    var no = document.createElement("button");
    no.type = "button";
    no.className = "btn ghost tiny";
    no.textContent = "未满 18 岁";
    no.addEventListener("click", function () {
      toast("已保持收起，成人向词库不会被加载");
    });
    box.appendChild(p);
    var row = document.createElement("div");
    row.className = "row";
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
  }

  /** 动态注入成人向词库；同一页面只加载一次 */
  function loadAdultPack() {
    if (window.CERT_ADULT_THEMES) return Promise.resolve(mergeAdultThemes());
    if (adultLoading) return adultLoading;
    adultLoading = new Promise(function (resolve) {
      var el = document.createElement("script");
      /* 单文件离线版把词库内联成一个 text/plain 块，转成 Blob URL 再当脚本加载，
       * 这样 file:// 下也能解锁成人向主题（普通相对路径在 file:// 取不到） */
      var inline = document.getElementById("cert-adult-pack");
      if (inline && inline.textContent && inline.textContent.length > 100) {
        el.src = URL.createObjectURL(new Blob([inline.textContent], { type: "text/javascript" }));
      } else {
        el.src = ADULT_SRC + "?v=20261022c";
      }
      el.onload = function () {
        adultLoading = null;
        resolve(mergeAdultThemes());
      };
      el.onerror = function () {
        adultLoading = null;
        resolve(0);
      };
      document.head.appendChild(el);
    });
    return adultLoading;
  }

  /** 把加载到的成人主题并进 THEMES（服务端主题包里已有同 id 的就不重复） */
  function mergeAdultThemes() {
    var added = 0;
    (window.CERT_ADULT_THEMES || []).forEach(function (t) {
      if (!t || !t.id) return;
      for (var i = 0; i < THEMES.length; i++) {
        if (THEMES[i].id === t.id) return;
      }
      THEMES.push(t);
      added += 1;
    });
    return added;
  }

  function enableAdult() {
    setAdultOk(true);
    loadAdultPack().then(function () {
      var next = THEMES.filter(function (t) {
        return t.adult;
      })[0];
      if (next) state.themeId = next.id;
      save();
      renderThemes();
      renderStyles();
      renderGate();
      renderGender();
      syncForm();
      renderTitles();
      renderGroups();
      renderRanks();
      updateStats();
      render();
      toast(next ? "成人向词库已加载（19 个板块）" : "词库加载失败：themes-adult.js 没取到");
    });
  }

  function hideAdult() {
    setAdultOk(false);
    /* 收起成人内容时，如果正停在成人向版式上，先回落到普通版式，
     * 否则画布会留着一张「已经不该看见」的卡。 */
    var cur = R.findStyle(state.styleId);
    if (cur.adult) {
      for (var i = 0; i < R.STYLES.length; i++) {
        if (!R.STYLES[i].adult) {
          state.styleId = R.STYLES[i].id;
          break;
        }
      }
    }
    THEMES = THEMES.filter(function (t) {
      return !t.adult;
    });
    var list = visibleThemes();
    if (
      !list.some(function (t) {
        return t.id === state.themeId;
      })
    ) {
      state.themeId = list.length ? list[0].id : "";
    }
    save();
    renderThemes();
    renderStyles();
    renderGate();
    renderGender();
    syncForm();
    renderTitles();
    renderGroups();
    renderRanks();
    updateStats();
    render();
    toast("已收起成人内容");
  }

  function syncForm() {
    var f = themeData().form;
    $("fIssuer").value = f.issuer || "";
    $("fSubtitle").value = f.subtitle || "";
    $("fCardLabel").value = f.cardLabel || "";
    $("fSealText").value = f.sealText || "";
    $("fName").value = state.shared.name || "";
    $("fSigner").value = readSigner();
    $("fNo").value = state.shared.no || "";
    $("fIssueDate").value = state.shared.issueDate || "";
    $("fValidUntil").value = state.shared.validUntil || "";
    $("fQr").value = state.shared.qr || "";
    $("autoPct").checked = state.autoPct;
    $("manualPct").disabled = state.autoPct;
    $("manualPct").value = state.manualPct;
  }

  /* ------------------------------------------------------------------ *
   * 分组标签库
   * ------------------------------------------------------------------ */
  var editingGroups = {}; // 组名 -> true（展开管理行）
  var addingGroup = null; // 正在添加标签的组名

  function groupsOf() {
    var meta = groupsMeta(theme()).map(function (g) {
      return { emoji: g.emoji || "🏷️", name: g.name, badge: g.badge || "", tags: [], hidden: 0 };
    });
    var byName = {};
    meta.forEach(function (g) {
      g.tags = [];
      byName[g.name] = g;
    });
    themeData().tags.forEach(function (t) {
      if (!byName[t.g]) {
        var ng = { emoji: "🏷️", name: t.g, badge: "", tags: [], hidden: 0 };
        meta.push(ng);
        byName[t.g] = ng;
      }
      if (tagVisible(t)) byName[t.g].tags.push(t);
      else byName[t.g].hidden += 1;
    });
    return meta;
  }

  function renderGroups() {
    var box = $("groupList");
    box.innerHTML = "";
    var groups = groupsOf();
    if (!groups.length) return;

    groups.forEach(function (g) {
      var sec = document.createElement("section");
      sec.className = "group";

      var on = g.tags.filter(function (t) {
        return t.on;
      }).length;
      var head = document.createElement("div");
      head.className = "group-head";
      var need = g.badge ? badgeNeed(g.name) : 0;
      var got = !!g.badge && on >= need;
      head.innerHTML =
        '<span class="g-emoji">' +
        esc(g.emoji) +
        "</span>" +
        '<span class="g-name">' +
        esc(g.name) +
        "</span>" +
        '<span class="g-count">' +
        on +
        " / " +
        g.tags.length +
        "</span>" +
        (g.hidden ? '<span class="g-hidden" title="当前性别下不显示的词条数">' + g.hidden + " 条异性词</span>" : "") +
        (g.badge
          ? '<span class="g-badge' +
            (got ? " on" : "") +
            '" title="' +
            esc(got ? "已解锁：" + g.badge : "再选 " + Math.max(0, need - on) + " 条解锁：" + g.badge) +
            '">' +
            esc(g.emoji) +
            " " +
            esc(g.badge) +
            "</span>"
          : "");
      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "g-edit" + (editingGroups[g.name] ? " on" : "");
      editBtn.textContent = editingGroups[g.name] ? "完成" : "编辑";
      editBtn.title = "重命名或删除该组标签";
      editBtn.addEventListener("click", function () {
        editingGroups[g.name] = !editingGroups[g.name];
        renderGroups();
      });
      head.appendChild(editBtn);
      sec.appendChild(head);

      var chips = document.createElement("div");
      chips.className = "chips";
      g.tags.forEach(function (tag) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (tag.on ? " on" : "");
        chip.textContent = tag.text;
        chip.setAttribute("aria-pressed", String(!!tag.on));
        chip.addEventListener("click", function () {
          tag.on = !tag.on;
          save();
          chip.classList.toggle("on", tag.on);
          chip.setAttribute("aria-pressed", String(tag.on));
          updateGroupCount(sec, g);
          updateStats();
          render();
        });
        chips.appendChild(chip);
      });

      if (addingGroup === g.name) {
        var wrap = document.createElement("span");
        wrap.className = "add-wrap";
        var input = document.createElement("input");
        input.type = "text";
        input.className = "add-input";
        input.placeholder = "标签文字，回车确认";
        /* Enter 提交会把 input 从 DOM 移除，随之触发的 blur 不能再提交一次 */
        var committed = false;
        var commit = function () {
          if (committed) return;
          committed = true;
          var text = input.value.trim();
          addingGroup = null;
          if (text) {
            themeData().tags.push({ id: uid("t"), text: text, on: true, g: g.name });
            save();
            renderGroups();
            updateStats();
            render();
          } else {
            renderGroups();
          }
        };
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            addingGroup = null;
            renderGroups();
          }
        });
        input.addEventListener("blur", commit);
        wrap.appendChild(input);
        chips.appendChild(wrap);
        setTimeout(function () {
          input.focus();
        }, 0);
      } else {
        var add = document.createElement("button");
        add.type = "button";
        add.className = "chip add";
        add.textContent = "+ 自己加";
        add.addEventListener("click", function () {
          addingGroup = g.name;
          renderGroups();
        });
        chips.appendChild(add);
      }
      sec.appendChild(chips);

      if (editingGroups[g.name]) {
        var rows = document.createElement("div");
        rows.className = "manage-rows";
        g.tags.forEach(function (tag) {
          var row = document.createElement("div");
          row.className = "manage-row";
          var name = document.createElement("input");
          name.type = "text";
          name.value = tag.text;
          name.addEventListener("input", function () {
            tag.text = name.value;
            save();
            render();
          });
          var del = document.createElement("button");
          del.type = "button";
          del.className = "del";
          del.textContent = "×";
          del.title = "删除该标签";
          del.addEventListener("click", function () {
            themeData().tags = themeData().tags.filter(function (x) {
              return x.id !== tag.id;
            });
            save();
            renderGroups();
            updateStats();
            render();
          });
          row.appendChild(name);
          row.appendChild(del);
          rows.appendChild(row);
        });
        sec.appendChild(rows);
      }

      box.appendChild(sec);
    });
  }

  function updateGroupCount(sec, g) {
    var on = g.tags.filter(function (t) {
      return t.on;
    }).length;
    var el = sec.querySelector(".g-count");
    if (el) el.textContent = on + " / " + g.tags.length;
    /* 徽章要跟着勾选实时点亮，否则只有整块重绘才会更新 */
    if (g.badge) {
      var need = badgeNeed(g.name);
      var badge = sec.querySelector(".g-badge");
      if (badge) {
        var got = on >= need;
        badge.classList.toggle("on", got);
        badge.title = got ? "已解锁：" + g.badge : "再选 " + Math.max(0, need - on) + " 条解锁：" + g.badge;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 等级称号
   * ------------------------------------------------------------------ */
  function sortRanks() {
    themeData().ranks.sort(function (a, b) {
      return a.min - b.min;
    });
  }

  function renderRanks() {
    var box = $("rankList");
    box.innerHTML = "";
    var ranks = themeData().ranks;
    var hit = hitRank(percent());
    var score = isScoreTheme();
    var hi = score ? 999 : 100;
    ranks.forEach(function (r, idx) {
      var row = document.createElement("div");
      row.className = "rank-row" + (hit.raw === r ? " hit" : "");

      var min = document.createElement("input");
      min.type = "number";
      min.min = "0";
      min.max = String(hi);
      min.value = r.min;
      min.title = "区间下限";
      min.addEventListener("change", function () {
        r.min = clamp(Math.round(num(min.value, r.min)), 0, hi);
        min.value = r.min;
        sortRanks();
        save();
        renderRanks();
        updateStats();
        render();
      });

      var max = document.createElement("input");
      max.type = "number";
      max.min = "0";
      max.max = String(hi);
      max.value = r.max;
      max.title = "区间上限";
      max.addEventListener("change", function () {
        r.max = clamp(Math.round(num(max.value, r.max)), 0, hi);
        max.value = r.max;
        sortRanks();
        save();
        renderRanks();
        updateStats();
        render();
      });

      var nm = document.createElement("input");
      nm.type = "text";
      nm.className = "name";
      nm.value = r.name || "";
      nm.placeholder = rankView(r).name;
      nm.title = "等级称号（留空则按名字从该性别的候选里固定抽一个）";
      nm.addEventListener("input", function () {
        r.name = nm.value;
        save();
        renderRanks();
        updateStats();
        render();
      });

      var del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.title = "删除该档位";
      del.textContent = "×";
      del.addEventListener("click", function () {
        if (themeData().ranks.length <= 1) {
          toast("至少保留一档等级");
          return;
        }
        themeData().ranks.splice(idx, 1);
        save();
        renderRanks();
        updateStats();
        render();
      });

      row.appendChild(min);
      row.appendChild(max);
      row.appendChild(nm);
      if (r.grade || r.rare) {
        var gb = document.createElement("span");
        gb.className = "rank-grade";
        gb.textContent = [r.grade, r.rare].filter(Boolean).join(" / ");
        gb.title = "等级 / 稀有度";
        row.appendChild(gb);
      }
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function renderPhotos() {
    var box = $("photoList");
    box.innerHTML = "";
    photos.forEach(function (p) {
      var btn = document.createElement("div");
      btn.className = "photo-item";
      btn.setAttribute("aria-pressed", String(!!p.on));
      btn.title = p.on ? "点击从卡片上移出" : "点击排到卡片上（最多 " + PHOTO_MAX + " 张）";

      var img = document.createElement("img");
      img.src = p.url;
      img.alt = "";
      btn.appendChild(img);

      /* 排上卡的显示 1..N 序号；没排上的留空心圆点 */
      var pick = document.createElement("span");
      pick.className = "pick" + (p.on ? " on" : "");
      pick.textContent = p.on ? String(cardIndex(p.id)) : "";
      btn.appendChild(pick);

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "移除这张照片";
      rm.addEventListener("click", function (e) {
        e.stopPropagation();
        removePhoto(p.id);
      });
      btn.appendChild(rm);

      btn.addEventListener("click", function () {
        togglePhoto(p.id);
      });
      box.appendChild(btn);
    });
    updatePhotoMeta();
  }

  /** 这张照片在卡上的第几张（1 起）；没排上返回 0 */
  function cardIndex(id) {
    var k = 0;
    for (var i = 0; i < photos.length; i++) {
      if (photos[i].on) {
        k += 1;
        if (photos[i].id === id) return k;
      }
    }
    return 0;
  }

  /** 点缩略图 = 上卡 / 下卡 */
  function togglePhoto(id) {
    var p = null;
    for (var i = 0; i < photos.length; i++) {
      if (photos[i].id === id) p = photos[i];
    }
    if (!p) return;
    if (!p.on && pickedCount() >= PHOTO_MAX) {
      toast("一张卡最多排 " + PHOTO_MAX + " 张，先取消一张");
      return;
    }
    p.on = !p.on;
    renderPhotos();
    render();
  }

  /** 缩略图下方的计数提示 */
  function updatePhotoMeta() {
    var el = $("photoMeta");
    if (!el) return;
    if (!photos.length) {
      el.textContent = "";
      return;
    }
    var n = pickedCount();
    var multi = n > 1;
    el.textContent =
      "已排到卡片 " +
      n +
      " / " +
      PHOTO_MAX +
      " 张 · " +
      (multi ? "多图自动拼贴，可切换版式「拍立得照片墙 / 印样联片」" : "单张直接铺满照片位");
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 1900);
  }

  /* ------------------------------------------------------------------ *
   * 照片
   * ------------------------------------------------------------------ */
  function addFiles(fileList) {
    var added = 0;
    Array.prototype.slice.call(fileList || []).forEach(function (f) {
      if (!f || !/^image\//.test(f.type)) return;
      var url = URL.createObjectURL(f);
      var img = new Image();
      var entry = { id: uid("p"), url: url, img: img, on: false };
      /* 立刻进数组：onload 是乱序回来的，等它 push 会打乱用户选择的顺序 */
      photos.push(entry);
      /* 默认排到卡上，直到排满 9 张；多的先放缩略图里待命 */
      if (pickedCount() < PHOTO_MAX) entry.on = true;
      img.onload = function () {
        renderPhotos();
        render();
      };
      img.onerror = function () {
        photos = photos.filter(function (p) {
          return p.id !== entry.id;
        });
        URL.revokeObjectURL(url);
        renderPhotos();
        render();
      };
      img.src = url;
      added += 1;
    });
    if (!added) toast("没有可识别的图片文件");
    else {
      renderPhotos();
      render();
    }
  }

  function removePhoto(id) {
    photos = photos.filter(function (p) {
      if (p.id !== id) return true;
      URL.revokeObjectURL(p.url);
      return false;
    });
    renderPhotos();
    render();
  }

  var PHOTO_MODES = [
    { id: "collage", name: "多图拼贴" },
    { id: "single", name: "只放第一张" },
  ];

  /** 多图排法的分段控件 + 「照片上压姓名」开关 */
  function renderPhotoModes() {
    var box = $("photoModeSeg");
    if (box) {
      box.innerHTML = "";
      var cur = state.photoMode || "collage";
      PHOTO_MODES.forEach(function (m) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "seg-btn" + (cur === m.id ? " active" : "");
        b.textContent = m.name;
        b.setAttribute("aria-pressed", String(cur === m.id));
        b.addEventListener("click", function () {
          state.photoMode = m.id;
          save();
          renderPhotoModes();
          render();
        });
        box.appendChild(b);
      });
    }
    var chk = $("photoOverlayChk");
    if (chk) chk.checked = !!state.photoOverlay;
  }

  /** 批量勾选：all = 前 9 张全上，first = 只留第一张 */
  function setAllPicks(mode) {
    if (!photos.length) {
      toast("先加几张照片");
      return;
    }
    photos.forEach(function (p, i) {
      p.on = mode === "all" ? i < PHOTO_MAX : i === 0;
    });
    if (mode === "all" && photos.length > PHOTO_MAX) {
      toast("一张卡最多 " + PHOTO_MAX + " 张，只排上前 " + PHOTO_MAX + " 张");
    }
    renderPhotos();
    render();
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */
  /**
   * 导出文件名。扩展名跟着 blob 的真实类型走——卡图现在优先导出 WebP，
   * 名字还写 .png 的话，用户下载下来双击会被系统当成损坏文件。
   */
  function fileName(mime) {
    var ext = "png";
    if (mime === "image/webp") ext = "webp";
    else if (mime === "image/jpeg") ext = "jpg";
    var parts = ["认证卡"];
    if (state.shared.name) parts.push(state.shared.name);
    if (state.shared.no) parts.push(state.shared.no);
    return parts.join("-").replace(/[\\/:*?"<>|]/g, "_") + "." + ext;
  }

  /** 原图附件扩展名：跟着实际编码走，避免 Telegram 收到 .png 的 WebP 字节。 */
  function sourceExt(mime) {
    if (mime === "image/webp") return ".webp";
    if (mime === "image/jpeg") return ".jpg";
    return ".png";
  }

  /* ------------------------------------------------------------------ *
   * 完成制作时同步到作品频道 + 导出后的投稿提示
   *
   * 三条原则（与 src/http/cert-share.ts 的注释对应）：
   *   - 静默同步：界面不再提供勾选框，导出即上传（产品决定）；
   *     若将来把同步勾选框（fShare）加回界面，shareOptIn() 会自动改以
   *     勾选状态为准，不需要动这里的其他逻辑；
   *   - 失败静默：导出已经成功了，同步只是旁路，失败只写 console.warn；
   *   - 提示只弹一次：导出/复制成功后出现一次（本浏览器），之后靠页面里
   *     常驻的「一键投稿 →」链接，不再打扰。
   * ------------------------------------------------------------------ */
  var shareEnabled = null;
  var PUBLISH_PROMPT_KEY = "cert-card-maker:publish-prompt:v1";

  async function shareAvailable() {
    if (shareEnabled !== null) return shareEnabled;
    try {
      var res = await fetch("/api/cert/share", { headers: { accept: "application/json" } });
      var data = await res.json();
      shareEnabled = !!(data && data.enabled);
    } catch (e) {
      shareEnabled = false;
    }
    return shareEnabled;
  }

  function publishPromptSeen() {
    try {
      return localStorage.getItem(PUBLISH_PROMPT_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function markPublishPromptSeen() {
    try {
      localStorage.setItem(PUBLISH_PROMPT_KEY, "1");
    } catch (e) {
      /* ignore */
    }
  }

  /** 导出成功后的投稿提示。只弹一次，之后不再打扰。 */
  function showPublishPrompt() {
    if (publishPromptSeen()) return;
    var el = $("publishPrompt");
    if (!el) return;
    el.hidden = false;
    markPublishPromptSeen();
  }

  function closePublishPrompt() {
    var el = $("publishPrompt");
    if (el) el.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   * 上传前的图片归一化 —— 与 admin/src/lib/image-publish.ts 同一套参数。
   *
   * cert/ 是零依赖的离线单文件（还要被 scripts/build-cert-single.mjs 内联），
   * 不能 import React 那边的模块，所以这里保留一份同参数实现。
   * tests/unit/media/image-publish-parity.test.ts 会读这两个文件并断言常量
   * 一致——改一边不改另一边，测试直接红。
   * ------------------------------------------------------------------ */
  var PUBLISH_MAX_EDGE = 1600;
  var PUBLISH_QUALITY = 0.86;
  var PUBLISH_MIME = "image/webp";
  var PUBLISH_SKIP_UNDER_BYTES = 320 * 1024;
  /** 卡面是渲染产物，比照片更吃质量，所以导出质量单独一档。 */
  var CARD_EXPORT_QUALITY = 0.92;

  /**
   * 超过最长边或体积阈值才重编码；任何一步失败都返回原 blob。
   * 与原图比较后取更小的那个——压缩绝不该让上传变大。
   */
  function normalizeForPublish(blob) {
    if (
      !blob ||
      !/^image\//.test(blob.type || "") ||
      blob.type === "image/gif" ||
      blob.type === "image/svg+xml" ||
      typeof createImageBitmap !== "function"
    ) {
      return Promise.resolve(blob);
    }
    return createImageBitmap(blob)
      .then(function (bitmap) {
        var edge = Math.max(bitmap.width, bitmap.height);
        function release() {
          if (bitmap.close) bitmap.close();
        }
        if (edge <= PUBLISH_MAX_EDGE && blob.size <= PUBLISH_SKIP_UNDER_BYTES) {
          release();
          return blob;
        }
        var scale = Math.min(1, PUBLISH_MAX_EDGE / edge);
        var w = Math.max(1, Math.round(bitmap.width * scale));
        var h = Math.max(1, Math.round(bitmap.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        if (!ctx) {
          release();
          return blob;
        }
        ctx.drawImage(bitmap, 0, 0, w, h);
        release();
        return new Promise(function (resolve) {
          canvas.toBlob(
            function (out) {
              resolve(out && out.size < blob.size ? out : blob);
            },
            PUBLISH_MIME,
            PUBLISH_QUALITY,
          );
        });
      })
      .catch(function () {
        return blob;
      });
  }

  /** 卡图导出：优先 WebP（同画质小一个量级），不支持就退回 PNG。 */
  function exportCardBlob(done) {
    var card = $("card");
    card.toBlob(
      function (blob) {
        if (blob) return done(blob);
        card.toBlob(done, "image/png");
      },
      PUBLISH_MIME,
      CARD_EXPORT_QUALITY,
    );
  }

  /** 卡上正在展示的原图（按勾选顺序），取回字节用于上传 */
  function pickedPhotoBlobs() {
    var picked = [];
    for (var i = 0; i < photos.length && picked.length < PHOTO_MAX; i++) {
      if (photos[i].on) picked.push(photos[i]);
    }
    return Promise.all(
      picked.map(function (p) {
        return fetch(p.url)
          .then(function (r) {
            return r.blob();
          })
          .then(function (blob) {
            return normalizeForPublish(blob);
          })
          .catch(function () {
            return null;
          });
      }),
    );
  }

  async function shareToChannel(cardBlob) {
    /* 用户取消了「同步一份到作品频道」就一个字节都不发。
     * 这是本文件唯一的上传出口，判断放在最前面，后面所有分支都不会绕过它。 */
    if (!shareOptIn()) return;
    if (!(await shareAvailable())) return;

    var form = new FormData();
    form.append("card", cardBlob, fileName(cardBlob.type));
    var blobs = await pickedPhotoBlobs();
    var n = 0;
    blobs.forEach(function (blob) {
      if (!blob) return;
      form.append("source" + n, blob, "source-" + n + sourceExt(blob.type));
      n += 1;
    });
    form.append(
      "meta",
      JSON.stringify({
        style: (R.findStyle(state.styleId) || {}).name || "",
        ratio: (R.findRatio(state.ratioId) || {}).name || "",
        theme: (theme() || {}).name || state.themeId || "",
        /* 下面三项是给频道认人用的：署名（谁做的）、卡片上的姓名、勾选的标签 */
        signer: readSigner(),
        name: state.shared.name || "",
        tags: selectedTagTexts(),
      }),
    );

    try {
      var res = await fetch("/api/cert/share", {
        method: "POST",
        headers: { "x-cert-share-origin": "cert-generator" },
        body: form,
      });
      if (!res.ok) console.warn("认证卡同步未完成", res.status);
    } catch (e) {
      console.warn("认证卡同步失败", e);
    }
  }

  /** 延迟触发：先让下载/复制落地，再发上传，避免占住下载的事件循环。 */
  async function scheduleShare(blob) {
    if (shareOptIn() && (await shareAvailable())) {
      setTimeout(function () {
        shareToChannel(blob);
      }, 300);
    }
    showPublishPrompt();
  }

  /** 是否同步到作品频道。
   *  界面已改为静默上传（不再有勾选框），所以「找不到开关」= 同步。
   *  若将来把同步勾选框（fShare）加回界面，这里会自动改以勾选状态为准，
   *  但刻意不回退到 localStorage：存储只能证明「以前勾过」，不能证明
   *  「这次同意」，上传这种一次性动作必须以当次界面状态为准。 */
  function shareOptIn() {
    var box = $("fShare");
    if (!box) return true;
    return !!box.checked;
  }

  function refreshAfterTagChange() {
    save();
    updateStats();
    render();
  }

  function bind() {
    /* 署名只写 localStorage，不动 state、不触发重绘：它不参与卡片渲染 */
    $("fSigner").addEventListener("input", function () {
      writeSigner($("fSigner").value.trim());
    });

    /* 预热一次服务端状态，让首次导出不必多等一次往返。
     *
     * 守卫保留：CDN 上 app.js 与 index.html 的缓存寿命不同步，可能短暂出现
     * 「新 HTML（已无勾选框）+ 旧 JS」或反过来的组合。$("fShare") 为 null 时
     * 直接 addEventListener 会抛错并中断整个 bind()，后面的输入框、按钮全部
     * 失效。同步开关有没有都是可选的，不该有这种权力。 */
    var shareBox = $("fShare");
    if (shareBox) {
      shareBox.addEventListener("change", function () {
        if (shareBox.checked) shareAvailable();
      });
    }
    shareAvailable();

    var promptClose = $("publishClose");
    if (promptClose) promptClose.addEventListener("click", closePublishPrompt);
    /* 点「去投稿」也关掉弹窗：新标签页打开后回到本页时不该还被挡一层。 */
    var promptSubmit = $("publishSubmit");
    if (promptSubmit) promptSubmit.addEventListener("click", closePublishPrompt);
    var promptEl = $("publishPrompt");
    if (promptEl) {
      promptEl.addEventListener("click", function (e) {
        if (e.target === promptEl) closePublishPrompt();
      });
    }

    [
      ["fName", "name"],
      ["fNo", "no"],
      ["fIssueDate", "issueDate"],
      ["fValidUntil", "validUntil"],
      ["fQr", "qr"],
    ].forEach(function (p) {
      $(p[0]).addEventListener("input", function () {
        state.shared[p[1]] = $(p[0]).value;
        save();
        render();
      });
    });

    [
      ["fIssuer", "issuer"],
      ["fSubtitle", "subtitle"],
      ["fCardLabel", "cardLabel"],
      ["fSealText", "sealText"],
    ].forEach(function (p) {
      $(p[0]).addEventListener("input", function () {
        themeData().form[p[1]] = $(p[0]).value;
        save();
        render();
      });
    });

    $("autoPct").addEventListener("change", function () {
      state.autoPct = $("autoPct").checked;
      $("manualPct").disabled = state.autoPct;
      save();
      renderRanks();
      updateStats();
      render();
    });

    $("manualPct").addEventListener("input", function () {
      state.manualPct = clamp(Math.round(num($("manualPct").value, 0)), 0, 100);
      save();
      renderRanks();
      updateStats();
      render();
    });

    /* 帮我选：随机勾选一批 */
    $("randomBtn").addEventListener("click", function () {
      var tags = themeData().tags.filter(tagVisible);
      if (!tags.length) {
        toast("先在分组里添加一些标签");
        return;
      }
      if (isScoreTheme()) {
        /* 分值制：先抽一个目标骚度（跨各档位），再随机凑到它。
         * 直接按比例随机的话，1050 条词会一键刷出四位数骚度，没有意义。 */
        /* 按档位均匀抽：每个等级区间内部随机取一个百分比，再折算回原始分值，
         * 这样一键出来的卡每次都落在不同档位，而不是永远顶到最高档。 */
        var bands = themeData().ranks;
        var pick = Math.floor(Math.pow(Math.random(), 1.35) * bands.length);
        var band = bands[clamp(pick, 0, bands.length - 1)] || { min: 0, max: 40 };
        var lo = clamp(band.min, 0, 900);
        var hiPct = clamp(band.max, lo, 900);
        var targetPct = lo + Math.random() * (hiPct - lo);
        var target = Math.round((targetPct * scoreDivisor()) / 100);
        tags.forEach(function (t) {
          t.on = false;
        });
        var pool = tags.slice();
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = pool[i];
          pool[i] = pool[j];
          pool[j] = tmp;
        }
        var raw = 0;
        pool.forEach(function (t) {
          if (raw >= target) return;
          var sc = tagScore(t);
          if (raw > 0 && raw + sc > target + 2) return;
          t.on = true;
          raw += sc;
        });
      } else {
        var ratio = 0.3 + Math.random() * 0.6;
        tags.forEach(function (t) {
          t.on = Math.random() < ratio;
        });
        if (
          !tags.some(function (t) {
            return t.on;
          })
        ) {
          tags[Math.floor(Math.random() * tags.length)].on = true;
        }
      }
      renderGroups();
      refreshAfterTagChange();
    });

    /* 清空勾选 */
    $("clearTagsBtn").addEventListener("click", function () {
      themeData().tags.forEach(function (t) {
        t.on = false;
      });
      renderGroups();
      refreshAfterTagChange();
    });

    /* 去认证：滚到预览并高亮 */
    $("certifyBtn").addEventListener("click", function () {
      var stage = $("stage");
      stage.scrollIntoView({ behavior: "smooth", block: "start" });
      render();
      var wrap = stage.querySelector(".canvas-wrap");
      wrap.classList.remove("flash");
      setTimeout(function () {
        wrap.classList.add("flash");
      }, 350);
      setTimeout(function () {
        wrap.classList.remove("flash");
      }, 1400);
    });

    /* 复制分享链接 */
    $("shareBtn").addEventListener("click", function () {
      var url = shareUrl();
      var done = function () {
        toast("分享链接已复制，打开即是同款卡片");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () {
          toast("复制被浏览器拒绝，请手动复制地址栏链接");
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {
          toast("复制失败，请手动复制地址栏链接");
        }
        ta.remove();
      }
    });

    /* 主题选择面板 */
    $("themePickerBtn").addEventListener("click", openThemeSheet);
    $("themeSheetClose").addEventListener("click", closeThemeSheet);
    $("themeSheetCloseBtn").addEventListener("click", closeThemeSheet);

    $("addRank").addEventListener("click", function () {
      var ranks = themeData().ranks;
      var hi = isScoreTheme() ? 999 : 100;
      var last = ranks[ranks.length - 1] || { min: 0, max: hi };
      ranks.push({ min: clamp(last.max, 0, hi - 1), max: hi, name: "新等级" });
      save();
      renderRanks();
      render();
    });

    var dz = $("dropzone");
    var input = $("fileInput");
    dz.addEventListener("click", function () {
      input.click();
    });
    dz.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", function () {
      addFiles(input.files);
      input.value = "";
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        dz.classList.add("over");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        dz.classList.remove("over");
      });
    });
    dz.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    var pAll = $("photoAll");
    if (pAll)
      pAll.addEventListener("click", function () {
        setAllPicks("all");
      });
    var pFirst = $("photoFirst");
    if (pFirst)
      pFirst.addEventListener("click", function () {
        setAllPicks("first");
      });
    var pOver = $("photoOverlayChk");
    if (pOver)
      pOver.addEventListener("change", function () {
        state.photoOverlay = !!pOver.checked;
        save();
        render();
      });

    $("downloadBtn").addEventListener("click", function () {
      exportCardBlob(function (blob) {
        if (!blob) {
          toast("导出失败");
          return;
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = fileName(blob.type);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        toast(blob.type === "image/webp" ? "已导出 WebP" : "已导出 PNG");
        scheduleShare(blob);
      });
    });

    $("copyBtn").addEventListener("click", function () {
      if (!navigator.clipboard || !window.ClipboardItem) {
        toast("当前浏览器不支持复制图片，请改用下载");
        return;
      }
      exportCardBlob(function (blob) {
        if (!blob) {
          toast("复制失败");
          return;
        }
        /* ClipboardItem 的键必须和 blob 的真实类型一致，否则浏览器直接拒写。 */
        var item = {};
        item[blob.type === "image/webp" ? "image/webp" : "image/png"] = blob;
        navigator.clipboard
          .write([new window.ClipboardItem(item)])
          .then(function () {
            toast("图片已复制到剪贴板");
            scheduleShare(blob);
          })
          .catch(function () {
            toast("复制被浏览器拒绝，请改用下载");
          });
      });
    });

    $("resetAll").addEventListener("click", function () {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
      state = blankState();
      if (
        !visibleThemes().some(function (t) {
          return t.id === state.themeId;
        })
      )
        state.themeId = visibleThemes().length ? visibleThemes()[0].id : "";
      photos.forEach(function (p) {
        URL.revokeObjectURL(p.url);
      });
      photos = [];
      renderStyles();
      renderRatios();
      renderThemes();
      renderGate();
      renderGender();
      syncForm();
      renderTitles();
      renderGroups();
      renderRanks();
      renderPhotos();
      renderPhotoModes();
      updateStats();
      applyPreset();
      render();
      toast("已恢复默认内容");
    });
  }

  function init() {
    if (!window.CERT_THEMES || !R) {
      document.body.innerHTML =
        '<p style="padding:24px">资源加载失败：脚本没取到。若是网络被拦截，请用「离线单文件版」。</p>';
      return;
    }
    /* 启动成功才置标记：index.html 的看门狗 5 秒内没见到它就显示「打不开」提示 */
    Promise.resolve()
      .then(boot)
      .then(function () {
        document.documentElement.setAttribute("data-cert-ready", "1");
      })
      .catch(function (e) {
        if (window.console && console.error) console.error("[cert] 启动失败", e);
      });
  }

  /** 拉取管理端发布的主题包；拿不到就用 themes.js 的内置默认。 */
  function fetchServerPack() {
    /* 单文件离线版跑在 file:// 下，根本没有后端，直接跳过这次注定失败的请求 */
    if (location.protocol !== "http:" && location.protocol !== "https:") return Promise.resolve(null);
    return fetch("/api/cert-content", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        var raw = data && data.pack && Array.isArray(data.pack.themes) ? data.pack.themes : null;
        if (!raw || !raw.length) return null;
        var list = [];
        for (var i = 0; i < raw.length; i++) {
          var t = normalizePackTheme(raw[i], i);
          if (t) list.push(t);
        }
        return list.length ? list : null;
      })
      .catch(function () {
        return null;
      });
  }

  function normalizePackTheme(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    var t = window.CERT_THEMES[0] || {};
    var pal = raw.palette && typeof raw.palette === "object" ? raw.palette : {};
    function str(v, fallback) {
      var s = String(v == null ? "" : v).trim();
      return s || fallback;
    }
    function color(v, fallback) {
      var s = String(v == null ? "" : v).trim();
      return /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
    }
    var groups = null;
    if (Array.isArray(raw.groups)) {
      groups = raw.groups
        .map(function (g) {
          if (!g || typeof g !== "object") return null;
          var tags = (Array.isArray(g.tags) ? g.tags : [])
            .map(function (x) {
              return String(x == null ? "" : x).trim();
            })
            .filter(Boolean)
            .slice(0, 60);
          if (!tags.length) return null;
          return { emoji: str(g.emoji, "🏷️").slice(0, 4), name: str(g.name, "标签").slice(0, 12), tags: tags };
        })
        .filter(Boolean)
        .slice(0, 12);
      if (!groups.length) groups = null;
    }
    var flatTags = Array.isArray(raw.tags)
      ? raw.tags
          .map(function (x) {
            return String(x == null ? "" : x).trim();
          })
          .filter(Boolean)
      : [];
    var ranks = Array.isArray(raw.ranks)
      ? raw.ranks
          .map(function (r) {
            var row = r && typeof r === "object" ? r : {};
            var min = Math.round(Number(row.min));
            var max = Math.round(Number(row.max));
            return {
              min: isFinite(min) ? Math.max(0, Math.min(100, min)) : 0,
              max: isFinite(max) ? Math.max(0, Math.min(100, max)) : 100,
              name: str(row.name, ""),
            };
          })
          .filter(function (r) {
            return r.name;
          })
          .sort(function (a, b) {
            return a.min - b.min;
          })
      : [];
    if ((!groups && !flatTags.length) || !ranks.length) return null;
    if (!groups) groups = [{ emoji: "🏷️", name: "全部", tags: flatTags }];
    var basePal = t.palette || {};
    return {
      id: str(raw.id, "pack-" + (index + 1)),
      name: str(raw.name, "自定义主题"),
      cardLabel: str(raw.cardLabel, "认证卡"),
      issuer: str(raw.issuer, "趣味认证中心"),
      subtitle: str(raw.subtitle, "FUN CERTIFICATE"),
      sealText: str(raw.sealText, "趣味认证专用章"),
      palette: {
        primary: color(pal.primary, basePal.primary || "#1e3a8a"),
        primary2: color(pal.primary2, basePal.primary2 || "#2563eb"),
        accent: color(pal.accent, basePal.accent || "#f59e0b"),
        ink: color(pal.ink, basePal.ink || "#0f172a"),
        muted: color(pal.muted, basePal.muted || "#64748b"),
        paper: color(pal.paper, basePal.paper || "#f7f9fc"),
      },
      groups: groups,
      ranks: ranks,
    };
  }

  async function boot() {
    THEMES = window.CERT_THEMES.slice();
    var pack = await fetchServerPack();
    if (pack && pack.length) THEMES = pack;
    /* 之前确认过 18+ 的话，先同步把成人词库注入进来，再恢复存档，
     * 否则上次选的成人主题会因为「主题不存在」而回落到第一套。 */
    if (adultOk()) await loadAdultPack();
    state = load();
    applyShareFromHash();
    buildThemeSheet();
    applyPreset();
    bind();
    renderStyles();
    renderRatios();
    renderThemes();
    renderGate();
    renderGender();
    syncForm();
    renderTitles();
    renderGroups();
    renderRanks();
    renderPhotos();
    renderPhotoModes();
    updateStats();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
