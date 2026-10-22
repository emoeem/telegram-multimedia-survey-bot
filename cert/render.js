/* 认证卡生成器 —— 样式渲染层
 *
 * 每个样式都是 (ctx, model) => void，只依赖画布的 W/H 做比例布局，
 * 因此同一套样式可以套用在任意导出比例（1:1 / 4:5 / 3:4 / 9:16 / 长图）上。
 *
 * model 字段：
 *   W, H        画布尺寸
 *   pal         主题配色 {primary, primary2, accent, ink, muted, paper}
 *   form        {issuer, subtitle, cardLabel, sealText}
 *   shared      {name, no, issueDate, validUntil, qr}
 *   pct         百分比数字
 *   rank        {name}
 *   tags        已勾选的标签文本数组
 *   allTags     全部标签文本数组
 *   photo       HTMLImageElement 或 null（等于 photos[0]，给旧调用兜底）
 *   photos      HTMLImageElement[]  卡上要展示的全部照片；多张时自动拼贴
 *   photoMode   "collage"（多图拼贴）| "single"（只放第一张）
 *   photoOverlay true 时在照片左下压一层姓名/日期
 *   photoGrid   网格上限张数（默认 9），超出部分在最后一格显示 +N
 *   qrText      二维码内容
 */
window.CERT_RENDER = (function () {
  "use strict";

  var FONT =
    '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
  var MONO = 'Consolas,"Liberation Mono",Menlo,"Courier New",monospace';
  var SERIF = '"Times New Roman",Georgia,"Songti SC","SimSun",serif';

  /* ---------------- 基础工具 ---------------- */

  function font(ctx, size, weight, family) {
    ctx.font = (weight ? weight + " " : "") + size + "px " + (family || FONT);
  }

  function trunc(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    var out = String(s);
    while (out.length > 1 && ctx.measureText(out + "…").width > maxW) out = out.slice(0, -1);
    return out + "…";
  }

  function spaced(ctx, s, x, y, sp) {
    var chars = Array.from(String(s));
    var ws = chars.map(function (c) {
      return ctx.measureText(c).width;
    });
    var total = ws.reduce(function (a, b) {
      return a + b + sp;
    }, 0) - sp;
    var cx = x;
    if (ctx.textAlign === "center") cx = x - total / 2;
    else if (ctx.textAlign === "right") cx = x - total;
    ctx.textAlign = "left";
    for (var i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], cx, y);
      cx += ws[i] + sp;
    }
  }

  function txt(ctx, s, x, y, o) {
    o = o || {};
    font(ctx, o.size || 16, o.weight || 500, o.family);
    ctx.fillStyle = o.color || "#000";
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = o.baseline || "alphabetic";
    var out = o.maxW ? trunc(ctx, s, o.maxW) : s;
    if (o.spacing) spaced(ctx, out, x, y, o.spacing);
    else ctx.fillText(out, x, y);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    return out;
  }

  function measure(ctx, s, size, weight, family) {
    font(ctx, size, weight, family);
    return ctx.measureText(s).width;
  }

  function rr(ctx, x, y, w, h, r) {
    var rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  }

  function hash(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** 确定性伪随机（同一内容每次渲染位置一致） */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  function cover(ctx, img, x, y, w, h, r) {
    ctx.save();
    rr(ctx, x, y, w, h, r || 0);
    ctx.clip();
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) {
      ctx.restore();
      return;
    }
    var k = Math.max(w / iw, h / ih);
    var dw = iw * k;
    var dh = ih * k;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }

  /* ---------------- 多图照片位 ---------------- */

  /** 取 model 里的照片列表；老调用只给 m.photo 时包成单元素数组 */
  function photoList(m) {
    if (m.photos && m.photos.length) return m.photos;
    return m.photo ? [m.photo] : [];
  }

  /** 按张数与区域长宽比选网格 [列, 行] */
  function gridFor(n, w, h) {
    if (n <= 1) return [1, 1];
    /* 在候选行列里挑「空格最少 + 单格长宽比最接近原图位」的组合 */
    var best = null;
    for (var cols = 1; cols <= 4; cols++) {
      var rows = Math.ceil(n / cols);
      if (rows > 4 || cols * rows < n) continue;
      var holes = cols * rows - n;
      var cellAspect = w / cols / (h / rows);
      var cost = holes * 0.9 + Math.abs(Math.log(cellAspect)) * 1.15;
      if (!best || cost < best.cost) best = { cols: cols, rows: rows, cost: cost };
    }
    return best ? [best.cols, best.rows] : [3, 3];
  }

  /** 多图拼贴：等大格子铺满 (x,y,w,h)，外层按 r 裁形，缝隙露相纸白 */
  function collage(ctx, imgs, x, y, w, h, r, o) {
    o = o || {};
    var max = o.max || 9;
    var list = imgs.slice(0, max);
    var n = list.length;
    if (!n || w <= 0 || h <= 0) return;
    var g = gridFor(n, w, h);
    var cols = g[0];
    var rows = g[1];
    var gap = o.gap == null ? Math.max(2, Math.min(w, h) * 0.014) : o.gap;

    ctx.save();
    rr(ctx, x, y, w, h, r || 0);
    ctx.clip();
    ctx.fillStyle = o.mat || "#ffffff";
    ctx.fillRect(x, y, w, h);

    var cellW = (w - gap * (cols - 1)) / cols;
    var cellH = (h - gap * (rows - 1)) / rows;
    var inner = r ? Math.min(r * 0.5, Math.min(w, h) * 0.02) : 0;
    for (var i = 0; i < n; i++) {
      var cx = i % cols;
      var cy = Math.floor(i / cols);
      cover(ctx, list[i], x + cx * (cellW + gap), y + cy * (cellH + gap), cellW, cellH, inner);
    }

    /* 超过上限时在最后一格盖 +N */
    if (imgs.length > max && n >= 2) {
      var lx = x + ((n - 1) % cols) * (cellW + gap);
      var ly = y + Math.floor((n - 1) / cols) * (cellH + gap);
      ctx.save();
      rr(ctx, lx, ly, cellW, cellH, inner);
      ctx.clip();
      ctx.fillStyle = "rgba(10,14,24,0.6)";
      ctx.fillRect(lx, ly, cellW, cellH);
      txt(ctx, "+" + (imgs.length - max), lx + cellW / 2, ly + cellH / 2, {
        size: Math.max(11, Math.min(cellW, cellH) * 0.3),
        weight: 700,
        color: "#fff",
        align: "center",
        baseline: "middle",
      });
      ctx.restore();
    }
    ctx.restore();
  }

  /** 照片上压姓名 / 日期；太小的照片位自动跳过 */
  function photoCaption(ctx, m, x, y, w, h, r) {
    if (h < 72 || w < 120) return;
    var band = Math.min(h * 0.32, Math.max(34, w * 0.14));
    ctx.save();
    rr(ctx, x, y, w, h, r || 0);
    ctx.clip();
    var g = ctx.createLinearGradient(x, y + h - band, x, y + h);
    g.addColorStop(0, "rgba(8,12,20,0)");
    g.addColorStop(1, "rgba(8,12,20,0.66)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y + h - band, w, band);
    var fs = Math.max(10, Math.min(band * 0.4, w * 0.055));
    var pad2 = Math.max(6, w * 0.032);
    if (m.shared && m.shared.name) {
      txt(ctx, m.shared.name, x + pad2, y + h - pad2, {
        size: fs,
        weight: 700,
        color: "#ffffff",
        maxW: w * 0.6,
        baseline: "bottom",
      });
    }
    if (m.shared && m.shared.issueDate) {
      txt(ctx, m.shared.issueDate, x + w - pad2, y + h - pad2, {
        size: fs * 0.82,
        color: "rgba(255,255,255,0.88)",
        align: "right",
        maxW: w * 0.4,
        baseline: "bottom",
      });
    }
    ctx.restore();
  }

  /** 照片位：单张直接铺，多张自动拼贴 */
  function photoBox(ctx, m, x, y, w, h, r) {
    var list = photoList(m);
    if (!list.length) {
      placeholder(ctx, x, y, w, h, r || 0);
    } else if (list.length === 1 || m.photoMode === "single") {
      cover(ctx, list[0], x, y, w, h, r || 0);
    } else {
      collage(ctx, list, x, y, w, h, r || 0, { max: m.photoGrid || 9 });
    }
    if (list.length && m.photoOverlay) photoCaption(ctx, m, x, y, w, h, r || 0);
    if (r) {
      rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
      ctx.strokeStyle = "rgba(15,23,42,0.14)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function placeholder(ctx, x, y, w, h, r) {
    ctx.save();
    rr(ctx, x, y, w, h, r || 0);
    ctx.clip();
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, "#e9eef5");
    g.addColorStop(1, "#d7dfe9");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#b8c2d0";
    var cx = x + w / 2;
    ctx.beginPath();
    ctx.arc(cx, y + h * 0.4, w * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, y + h * 0.95, w * 0.35, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (h > 90) {
      txt(ctx, "上传证件照", cx, y + h - h * 0.08, {
        size: Math.max(11, w * 0.08),
        color: "#8494a6",
        align: "center",
        baseline: "middle",
      });
    }
  }

  function seal(ctx, cx, cy, r, text, color, angle) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle === undefined ? -0.28 : angle);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.6, r * 0.055);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.8, r * 0.022);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    arcText(ctx, text, 0, 0, r * 0.62, Math.PI * 1.08, Math.PI * 1.92, r * 0.2);
    star(ctx, 0, r * 0.06, r * 0.24, r * 0.1, 5);
    ctx.restore();
  }

  function arcText(ctx, text, cx, cy, r, from, to, size) {
    var chars = Array.from(String(text));
    if (!chars.length) return;
    var step = (to - from) / chars.length;
    font(ctx, size, 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (var i = 0; i < chars.length; i++) {
      var a = from + step * (i + 0.5);
      ctx.save();
      ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.rotate(a + Math.PI / 2);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function star(ctx, cx, cy, outer, inner, points) {
    ctx.beginPath();
    for (var i = 0; i < points * 2; i++) {
      var rad = i % 2 === 0 ? outer : inner;
      var a = -Math.PI / 2 + (i * Math.PI) / points;
      var px = cx + Math.cos(a) * rad;
      var py = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  function sparkle(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx, cy, cx + r, cy);
    ctx.quadraticCurveTo(cx, cy, cx, cy + r);
    ctx.quadraticCurveTo(cx, cy, cx - r, cy);
    ctx.quadraticCurveTo(cx, cy, cx, cy - r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function qr(ctx, text, x, y, size, dark, light) {
    ctx.save();
    rr(ctx, x, y, size, size, Math.min(8, size * 0.08));
    ctx.fillStyle = light || "#ffffff";
    ctx.fill();
    try {
      var q = qrcode(0, "M");
      q.addData(text || " ");
      q.make();
      var n = q.getModuleCount();
      var cell = size / (n + 8);
      var off = cell * 4;
      ctx.fillStyle = dark;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (q.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell + 0.6, cell + 0.6);
        }
      }
    } catch (e) {
      txt(ctx, "QR", x + size / 2, y + size / 2, { size: size * 0.2, color: dark, align: "center", baseline: "middle" });
    }
    ctx.restore();
  }

  /* ---------------- 标签芯片 ---------------- */

  function chipsLayout(ctx, items, maxW, o) {
    font(ctx, o.fontPx, 500);
    var all = items.map(function (t) {
      return { text: t, w: Math.min(ctx.measureText(t).width + o.padX * 2, maxW) };
    });
    var lines = [];
    var cur = [];
    var curW = 0;
    all.forEach(function (it) {
      var need = cur.length ? o.gapX + it.w : it.w;
      if (cur.length && curW + need > maxW) {
        lines.push({ items: cur, w: curW });
        cur = [it];
        curW = it.w;
      } else {
        cur.push(it);
        curW += need;
      }
    });
    if (cur.length) lines.push({ items: cur, w: curW });
    if (lines.length > o.maxLines) {
      var kept = lines.slice(0, o.maxLines - 1);
      var rest = [];
      lines.slice(o.maxLines - 1).forEach(function (l) {
        rest = rest.concat(l.items);
      });
      var last = [];
      var w = 0;
      var moreW = ctx.measureText("+99").width + o.padX * 2 + o.gapX;
      for (var i = 0; i < rest.length; i++) {
        var need = last.length ? o.gapX + rest[i].w : rest[i].w;
        if (w + need + moreW > maxW) break;
        last.push(rest[i]);
        w += need;
      }
      var left = rest.length - last.length;
      if (left > 0) {
        var t = "+" + left;
        last.push({ text: t, w: ctx.measureText(t).width + o.padX * 2 });
      }
      kept.push({ items: last, w: w });
      return kept;
    }
    return lines;
  }

  function chipsHeight(lines, o) {
    return lines.length * (o.chipH + o.gapY) - o.gapY;
  }

  function chipsDraw(ctx, lines, o, x, y, maxW, center, pal, chipFill) {
    var cy = y;
    lines.forEach(function (line) {
      var totalW = line.items.reduce(function (s, it, i) {
        return s + it.w + (i ? o.gapX : 0);
      }, 0);
      var cx = center ? x + (maxW - totalW) / 2 : x;
      line.items.forEach(function (it) {
        rr(ctx, cx, cy, it.w, o.chipH, o.chipH / 2);
        ctx.globalAlpha = chipFill ? 1 : 0.09;
        ctx.fillStyle = chipFill || pal.primary;
        ctx.fill();
        if (!chipFill) {
          ctx.globalAlpha = 0.28;
          ctx.strokeStyle = pal.primary;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        txt(ctx, it.text, cx + it.w / 2, cy + o.chipH / 2 + 1, {
          size: o.fontPx,
          color: chipFill ? "#ffffff" : pal.primary,
          align: "center",
          baseline: "middle",
        });
        cx += it.w + o.gapX;
      });
      cy += o.chipH + o.gapY;
    });
    return cy;
  }

  /** 按可用高度自动挑一个合适的芯片尺寸 */
  function chipOpts(ctx, items, maxW, maxH, u) {
    var sizes = [
      { fontPx: 20 * u, chipH: 44 * u, padX: 20 * u },
      { fontPx: 18 * u, chipH: 40 * u, padX: 18 * u },
      { fontPx: 16 * u, chipH: 36 * u, padX: 16 * u },
      { fontPx: 14 * u, chipH: 32 * u, padX: 14 * u },
      { fontPx: 12 * u, chipH: 27 * u, padX: 12 * u },
    ];
    var best = sizes[sizes.length - 1];
    for (var i = 0; i < sizes.length; i++) {
      var o = {
        fontPx: sizes[i].fontPx,
        chipH: sizes[i].chipH,
        padX: sizes[i].padX,
        gapX: 10 * u,
        gapY: 9 * u,
        maxLines: Math.max(1, Math.floor(maxH / (sizes[i].chipH + 9 * u))),
      };
      var lines = chipsLayout(ctx, items, maxW, o);
      if (chipsHeight(lines, o) <= maxH) return { o: o, lines: lines };
      best = { o: o, lines: lines };
    }
    return best;
  }

  /* ---------------- 背景 ---------------- */

  function paper(ctx, m, opts) {
    opts = opts || {};
    ctx.save();
    if (opts.radius) {
      rr(ctx, 0, 0, m.W, m.H, opts.radius);
      ctx.clip();
    }
    ctx.fillStyle = opts.color || m.pal.paper;
    ctx.fillRect(0, 0, m.W, m.H);
    if (opts.texture !== false) {
      ctx.globalAlpha = 0.045;
      ctx.strokeStyle = m.pal.primary;
      ctx.lineWidth = Math.max(1, m.W * 0.002);
      for (var i = -m.H; i < m.W + m.H; i += Math.max(12, m.W * 0.018)) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + m.H, m.H);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function noise(ctx, x, y, w, h, count, color, alpha) {
    var r = rng(1234);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (var i = 0; i < count; i++) {
      ctx.fillRect(x + r() * w, y + r() * h, Math.max(1, w * 0.0016), Math.max(1, w * 0.0016));
    }
    ctx.restore();
  }

  function bandTop(ctx, m, h) {
    var g = ctx.createLinearGradient(0, 0, m.W, h);
    g.addColorStop(0, m.pal.primary);
    g.addColorStop(1, m.pal.primary2);
    ctx.save();
    if (m.radius) {
      rr(ctx, 0, 0, m.W, m.H, m.radius);
      ctx.clip();
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, m.W, h);
    ctx.restore();
  }

  function bandBottom(ctx, m, h) {
    var g = ctx.createLinearGradient(0, m.H - h, m.W, m.H);
    g.addColorStop(0, m.pal.primary);
    g.addColorStop(1, m.pal.primary2);
    ctx.save();
    if (m.radius) {
      rr(ctx, 0, 0, m.W, m.H, m.radius);
      ctx.clip();
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, m.H - h, m.W, h);
    ctx.restore();
  }

  function bar(ctx, x, y, w, h, pct, pal) {
    rr(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = "rgba(15,23,42,0.09)";
    ctx.fill();
    var fw = Math.max(h, (w * pct) / 100);
    ctx.save();
    rr(ctx, x, y, w, h, h / 2);
    ctx.clip();
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, pal.accent);
    g.addColorStop(1, pal.primary2);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, fw, h);
    ctx.restore();
  }

  function headBlock(ctx, m, h, opts) {
    opts = opts || {};
    bandTop(ctx, m, h);
    var pad = m.W * 0.055;
    txt(ctx, m.form.issuer, pad, h * 0.5, {
      size: h * 0.29,
      weight: 700,
      color: "#ffffff",
      maxW: m.W - pad * 2 - (opts.badge ? m.W * 0.28 : 0),
    });
    txt(ctx, m.form.subtitle, pad, h * 0.78, {
      size: h * 0.14,
      color: "rgba(255,255,255,0.72)",
      spacing: Math.max(1, h * 0.02),
      maxW: m.W - pad * 2 - (opts.badge ? m.W * 0.28 : 0),
    });
    if (opts.badge) {
      var bw = m.W * 0.24;
      var bh = h * 0.34;
      var bx = m.W - pad - bw;
      var by = (h - bh) / 2;
      rr(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = m.pal.accent;
      ctx.fill();
      txt(ctx, m.form.cardLabel, bx + bw / 2, by + bh / 2 + 1, {
        size: bh * 0.48,
        weight: 700,
        color: "#ffffff",
        align: "center",
        baseline: "middle",
        maxW: bw - 12,
      });
    }
  }

  function footBlock(ctx, m, top, h) {
    var pad = m.W * 0.055;
    var colW = (m.W - pad * 2) / 2;
    var lh = h * 0.2;
    txt(ctx, "发证机构 / ISSUED BY", pad, top + lh, { size: lh * 0.62, color: m.pal.muted, spacing: 1.4 });
    txt(ctx, m.form.issuer, pad, top + lh * 2.4, { size: h * 0.22, weight: 700, color: m.pal.ink, maxW: colW - 10 });
    txt(ctx, "发证日期 / DATE", pad, top + h * 0.66, { size: lh * 0.62, color: m.pal.muted, spacing: 1.4 });
    txt(ctx, m.shared.issueDate, pad, top + h * 0.9, { size: h * 0.19, weight: 600, color: m.pal.ink, maxW: colW - 10 });
    txt(ctx, "有效期至 / VALID", pad + colW, top + h * 0.66, { size: lh * 0.62, color: m.pal.muted, spacing: 1.4 });
    txt(ctx, m.shared.validUntil, pad + colW, top + h * 0.9, {
      size: h * 0.19,
      weight: 600,
      color: m.pal.ink,
      maxW: colW - 10,
    });
  }

  /* ---------------- 成人向装饰：等级角标 / 板块徽章 / 倾向叙述 ---------------- */

  /** 等级称号 + 等级角标（F/E/D/C/B/A/S/SS/SSS 与稀有度） */
  function rankLabel(m) {
    var name = (m.rank && m.rank.name) || "未评级";
    var grade = m.rank && m.rank.grade;
    if (!grade) return name;
    /* 名称本身已经含等级时不重复标（自定义称号常见这种情况）。
     * 只带等级字母不带稀有度：SSS/UR 这种组合会把长称号挤到省略号。 */
    if (name.indexOf(grade) >= 0) return name;
    return name + " · " + grade;
  }

  /** 一行小字：该性别下的倾向叙述（来自 RANKS[].say） */
  function sayLine(ctx, m, x, y, w, size, dark) {
    if (!m.score || !m.score.on || !m.say) return;
    txt(ctx, m.say, x + w / 2, y, {
      size: size,
      weight: 500,
      color: dark ? "rgba(255,255,255,0.8)" : m.pal.muted,
      align: "center",
      maxW: w,
    });
  }

  /** 板块徽章胶囊行：居中排布，超宽时从尾部丢，仍超宽则缩字号。y 为顶边 */
  function badgeRow(ctx, m, x, y, w, size, dark) {
    if (!m.score || !m.score.on || !m.badges || !m.badges.length) return;
    var labels = m.badges.slice(0, 3).map(function (b) {
      return b.emoji + " " + b.name;
    });
    var gap = size * 0.5;
    var padX = size * 1;
    var slack = 3;
    var h = Math.round(size * 1.9);
    var widths = [];
    var total = 0;
    for (var guard = 0; guard < 10; guard++) {
      widths = labels.map(function (s2) {
        return Math.min(measure(ctx, s2, size, 600) + padX * 2 + slack, w);
      });
      total = widths.reduce(function (a, b) {
        return a + b;
      }, 0) + gap * Math.max(0, labels.length - 1);
      if (total <= w) break;
      if (labels.length > 1 && guard < 3) {
        labels.pop();
        continue;
      }
      size *= 0.9;
      padX = size * 1;
      slack = 3;
      gap = size * 0.5;
      h = Math.round(size * 1.9);
    }
    var cx = x + Math.max(0, (w - total) / 2);
    labels.forEach(function (s2, i) {
      var bw = widths[i];
      ctx.fillStyle = dark ? "rgba(255,255,255,0.16)" : "rgba(120,120,120,0.14)";
      rr(ctx, cx, y, bw, h, h / 2);
      ctx.fill();
      /* 截断交给 txt 自己做：量宽与绘制用同一套 font，不会再出现「量得下、画不下」 */
      txt(ctx, s2, cx + bw / 2, y + h / 2 + size * 0.35, {
        size: size,
        weight: 600,
        color: dark ? "rgba(255,255,255,0.94)" : m.pal.ink,
        align: "center",
        maxW: bw - padX * 2 - slack,
      });
      cx += bw + gap;
    });
  }

  /* ================================================================= *
   * 样式 1：资格证（横版证件卡风格，任意比例自适应）
   * ================================================================= */
  function styleIdcard(ctx, m) {
    var u = m.W / 1000;
    if (m.H / m.W > 1.25) return styleIdcardTall(ctx, m);
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius });

    var headH = Math.min(m.H * 0.16, 110 * u);
    var footH = Math.min(m.H * 0.18, 120 * u);
    headBlock(ctx, m, headH, { badge: true });

    var pad = m.W * 0.055;
    var top = headH + pad;
    var bodyH = m.H - headH - footH - pad * 2;

    // 证件照尽量填满正文高度
    var photoW = Math.min(m.W * 0.32, bodyH * 0.78);
    var photoH = photoW * 4 / 3;
    if (photoH > bodyH) {
      photoH = bodyH;
      photoW = photoH * 3 / 4;
    }
    var photoY = top + (bodyH - photoH) / 2;
    photoBox(ctx, m, pad, photoY, photoW, photoH, 10 * u);

    var ix = pad + photoW + pad;
    var iw = m.W - pad - ix;

    // 先量出标签墙高度，再决定剩余空间怎么分
    var chipBlock = null;
    var chipsY = top + bodyH;
    if (m.tags.length) {
      chipBlock = chipOpts(ctx, m.tags, iw, Math.max(30 * u, bodyH - 190 * u), u);
      chipsY = top + bodyH - chipsHeight(chipBlock.lines, chipBlock.o) - 8 * u;
    }

    var y = top;
    txt(ctx, m.shared.name || "未填写姓名", ix, y + 34 * u, {
      size: Math.min(40 * u, iw / Math.max(4, (m.shared.name || "未填写").length) * 1.6),
      weight: 700,
      color: m.pal.ink,
      maxW: iw,
    });
    y += 34 * u + 26 * u;
    txt(ctx, "No. " + (m.shared.no || "—"), ix, y, { size: 15 * u, color: m.pal.muted, maxW: iw });
    y += 18 * u;

    ctx.strokeStyle = "rgba(15,23,42,0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ix, y + 0.5);
    ctx.lineTo(ix + iw, y + 0.5);
    ctx.stroke();

    // 等级 + 进度条放在剩余空间的垂直居中处
    var rankTop = y + Math.max(34 * u, (chipsY - y - 120 * u) / 2);
    txt(ctx, "认证等级 / RANK", ix, rankTop, { size: 11.5 * u, color: m.pal.muted, spacing: 1.6 });
    txt(ctx, rankLabel(m), ix, rankTop + 44 * u, {
      size: 34 * u,
      weight: 700,
      color: m.pal.accent,
      maxW: iw * 0.72,
    });
    txt(ctx, m.pct + "%", ix + iw, rankTop + 44 * u, { size: 26 * u, weight: 700, color: m.pal.ink, align: "right" });
    bar(ctx, ix, rankTop + 64 * u, iw, 15 * u, m.pct, m.pal);

    if (chipBlock) {
      chipsDraw(ctx, chipBlock.lines, chipBlock.o, ix, chipsY, iw, false, m.pal);
    } else {
      txt(ctx, "勾选左侧标签后，这里会生成标签墙", ix, chipsY - 20 * u, {
        size: 14 * u,
        color: m.pal.muted,
      });
    }

    var footTop = m.H - footH - (18 * u < m.H * 0.03 ? 18 * u : m.H * 0.03);
    badgeRow(ctx, m, pad, footTop - 48 * u, m.W - pad * 2, 13 * u, false);
    sayLine(ctx, m, pad, footTop - 12 * u, m.W - pad * 2, 11.5 * u, false);
    footBlock(ctx, m, footTop, footH);
    bandBottom(ctx, m, Math.min(20 * u, m.H * 0.03));

    var qrSize = Math.min(footH * 0.85, m.W * 0.11);
    qr(ctx, m.qrText, m.W - pad - qrSize, m.H - footH - qrSize * 0.1 - Math.min(20 * u, m.H * 0.03), qrSize, m.pal.ink, "#ffffff");
    seal(ctx, pad + photoW * 0.82, photoY + photoH * 0.84, photoW * 0.3, m.form.sealText, m.pal.accent);
  }

  /** 资格证的竖版排布（比例高于 5:4 时自动切换） */
  function styleIdcardTall(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius });

    var pad = m.W * 0.06;
    var headH = Math.min(m.H * 0.11, 110 * u);
    var footH = Math.min(m.H * 0.13, 130 * u);
    headBlock(ctx, m, headH, { badge: true });

    var top = headH + pad;
    var availH = m.H - headH - footH - pad * 2;
    var cx = m.W / 2;

    var photoH = Math.min(availH * 0.58, m.H * 0.55);
    var photoW = Math.min(m.W * 0.62, photoH * 0.75);
    var photoY = top;
    photoBox(ctx, m, cx - photoW / 2, photoY, photoW, photoH, 12 * u);

    var y = photoY + photoH + 44 * u;
    txt(ctx, m.shared.name || "未填写姓名", cx, y, {
      size: 40 * u,
      weight: 700,
      color: m.pal.ink,
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += 44 * u;
    txt(ctx, "No. " + (m.shared.no || "—"), cx, y, { size: 15 * u, color: m.pal.muted, align: "center" });
    y += 40 * u;

    txt(ctx, "认证等级 / RANK", cx, y, { size: 12 * u, color: m.pal.muted, align: "center", spacing: 1.8 });
    y += 46 * u;
    txt(ctx, rankLabel(m), cx, y, {
      size: 40 * u,
      weight: 700,
      color: m.pal.accent,
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += 30 * u;
    bar(ctx, pad, y, m.W - pad * 2, 16 * u, m.pct, m.pal);
    y += 40 * u;
    txt(ctx, m.pct + "%", cx, y, { size: 18 * u, weight: 700, color: m.pal.ink, align: "center" });
    y += 28 * u;

    var chipsBottom = m.H - footH - pad;
    if (m.tags.length && chipsBottom - y > 30 * u) {
      var c = chipOpts(ctx, m.tags, m.W - pad * 2, chipsBottom - y, u);
      chipsDraw(ctx, c.lines, c.o, pad, y, m.W - pad * 2, true, m.pal);
    }

    var footTop = m.H - footH;
    badgeRow(ctx, m, pad, footTop - 46 * u, m.W - pad * 2, 12.5 * u, false);
    sayLine(ctx, m, pad, footTop - 10 * u, m.W - pad * 2, 11 * u, false);
    footBlock(ctx, m, footTop, footH);
    bandBottom(ctx, m, Math.min(18 * u, m.H * 0.02));
    var qrSize = Math.min(footH * 0.8, m.W * 0.11);
    qr(ctx, m.qrText, m.W - pad - qrSize, m.H - footH + (footH - qrSize) / 2, qrSize, m.pal.ink, "#ffffff");
    seal(ctx, cx + photoW * 0.4, photoY + photoH * 0.86, photoW * 0.26, m.form.sealText, m.pal.accent);
  }

  /* ================================================================= *
   * 样式 2：环绕词云
   * ================================================================= */
  function styleRingCloud(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius, texture: false });
    var cx = m.W / 2;
    var cy = m.H * 0.46;
    var R = Math.min(m.W, m.H) * 0.42;

    // 中心圆盘
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, m.pal.primary);
    g.addColorStop(1, m.pal.primary2);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    var centerSize = Math.min(m.W * 0.42, m.H * 0.3);
    photoBox(ctx, m, cx - centerSize / 2, cy - centerSize / 2, centerSize, centerSize, centerSize / 2);

    // 环绕排布
    /* 两圈封顶：三圈的外圈半径会超过画布半宽，词被裁在边上 */
    var items = (m.tags.length ? m.tags : ["还没有勾选标签"]).slice(0, 14);
    var rings = items.length > 7 ? 2 : 1;
    var perRing = Math.ceil(items.length / rings);
    var idx = 0;
    for (var r = 0; r < rings; r++) {
      var radius = R * (rings === 1 ? 0.98 : 0.8 + r * 0.19);
      var count = Math.min(perRing, items.length - idx);
      for (var i = 0; i < count; i++) {
        var a = -Math.PI / 2 + (i / count) * Math.PI * 2 + r * 0.3;
        var px = cx + Math.cos(a) * radius;
        var py = cy + Math.sin(a) * radius * 0.92;
        var size = (rings === 1 ? 22 : 19 - r * 2) * u;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(a + Math.PI / 2 > Math.PI / 2 ? 0 : 0);
        txt(ctx, items[idx], 0, 0, {
          size: size,
          weight: 700,
          color: r === 0 ? m.pal.primary : m.pal.muted,
          align: "center",
          baseline: "middle",
          maxW: Math.max(60 * u, m.W * 0.3),
        });
        ctx.restore();
        idx++;
      }
    }

    // 顶部与底部信息
    txt(ctx, m.form.issuer, m.W / 2, m.H * 0.075, {
      size: 22 * u,
      weight: 700,
      color: m.pal.primary,
      align: "center",
      maxW: m.W * 0.9,
    });
    badgeRow(ctx, m, m.W * 0.1, m.H * 0.9 - 54 * u, m.W * 0.8, 13 * u, false);
    txt(ctx, rankLabel(m), m.W / 2, m.H * 0.9, {
      size: 40 * u,
      weight: 700,
      color: m.pal.accent,
      align: "center",
      maxW: m.W * 0.9,
    });
    txt(ctx, m.pct + "%", m.W / 2, m.H * 0.955, {
      size: 20 * u,
      weight: 600,
      color: m.pal.muted,
      align: "center",
    });
    seal(ctx, m.W * 0.82, m.H * 0.16, Math.min(m.W, m.H) * 0.075, m.form.sealText, m.pal.accent, 0.2);
  }

  /* ================================================================= *
   * 样式 3：混乱词云
   * ================================================================= */
  function styleChaosCloud(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius, texture: false });
    var pad = m.W * 0.06;
    var headH = m.H * 0.1;
    var footH = m.H * 0.13;

    txt(ctx, m.form.issuer, pad, headH * 0.62, { size: 20 * u, weight: 700, color: m.pal.primary, maxW: m.W - pad * 2 });
    txt(ctx, rankLabel(m), m.W - pad, headH * 0.62, {
      size: 22 * u,
      weight: 700,
      color: m.pal.accent,
      align: "right",
      maxW: m.W * 0.5,
    });

    var items = m.tags.length ? m.tags : ["还没有勾选标签"];
    var box = { x: pad, y: headH, w: m.W - pad * 2, h: m.H - headH - footH };
    var placed = [];
    var rand = rng(hash(m.shared.name + m.shared.no + items.join("|")));

    items.forEach(function (t, i) {
      var size = (16 + Math.round(rand() * 30)) * u;
      var w = measure(ctx, t, size, 700);
      var h = size * 1.25;
      var ok = false;
      var px = 0;
      var py = 0;
      for (var attempt = 0; attempt < 220 && !ok; attempt++) {
        px = box.x + rand() * Math.max(1, box.w - w);
        py = box.y + rand() * Math.max(1, box.h - h);
        ok = true;
        for (var j = 0; j < placed.length; j++) {
          var p = placed[j];
          if (px < p.x + p.w + 6 * u && px + w + 6 * u > p.x && py < p.y + p.h + 4 * u && py + h + 4 * u > p.y) {
            ok = false;
            break;
          }
        }
        if (ok && py + h > box.y + box.h) ok = false;
      }
      if (!ok) return;
      placed.push({ x: px, y: py, w: w, h: h });
      var alpha = 0.55 + (i % 3) * 0.15;
      ctx.save();
      ctx.globalAlpha = alpha;
      var color = i % 4 === 0 ? m.pal.accent : m.pal.primary;
      if (i % 7 === 3) color = m.pal.primary2;
      txt(ctx, t, px, py + h * 0.8, { size: size, weight: 700, color: color });
      ctx.restore();
    });

    /* 这张卡的通栏就是词本身，任何附加小字都会糊在词上，故不画徽章/判词 */
    bar(ctx, pad, m.H - footH - 6 * u, m.W - pad * 2, 14 * u, m.pct, m.pal);
    txt(ctx, m.pct + "% · " + (rankLabel(m)), m.W - pad, m.H - footH - 26 * u, {
      size: 17 * u,
      weight: 700,
      color: m.pal.ink,
      align: "right",
      maxW: m.W * 0.7,
    });
    txt(ctx, "No. " + (m.shared.no || "—"), pad, m.H - footH * 0.28, {
      size: 13 * u,
      color: m.pal.muted,
      maxW: m.W * 0.6,
    });
    seal(ctx, m.W * 0.84, m.H * 0.82, Math.min(m.W, m.H) * 0.07, m.form.sealText, m.pal.accent, -0.5);
  }

  /* ================================================================= *
   * 样式 4：印章满屏
   * ================================================================= */
  function styleStampWall(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius, texture: false });

    var r = Math.min(m.W, m.H) * 0.085;
    var step = r * 2.1;
    var rand = rng(99);
    ctx.save();
    for (var y = -r; y < m.H + r; y += step) {
      for (var x = -r; x < m.W + r; x += step) {
        ctx.save();
        ctx.globalAlpha = 0.12 + rand() * 0.1;
        ctx.translate(x + (y / step % 2 ? step / 2 : 0), y);
        ctx.rotate(-0.3 + rand() * 0.6);
        ctx.strokeStyle = rand() > 0.5 ? m.pal.accent : m.pal.primary;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = Math.max(1.4, r * 0.06);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        arcText(ctx, m.form.sealText, 0, 0, r * 0.62, Math.PI * 1.08, Math.PI * 1.92, r * 0.19);
        star(ctx, 0, r * 0.06, r * 0.22, r * 0.09, 5);
        ctx.restore();
      }
    }
    ctx.restore();

    // 中央卡片
    var cw = m.W * 0.74;
    var ch = Math.min(m.H * 0.72, cw * 1.25);
    var cx = (m.W - cw) / 2;
    var cy = (m.H - ch) / 2;
    ctx.save();
    rr(ctx, cx, cy, cw, ch, 18 * u);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.94;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = m.pal.primary;
    ctx.lineWidth = 2 * u;
    ctx.stroke();
    ctx.restore();

    var pad = cw * 0.07;
    var y = cy + pad + 30 * u;
    txt(ctx, m.form.issuer, m.W / 2, y, {
      size: 20 * u,
      weight: 700,
      color: m.pal.primary,
      align: "center",
      maxW: cw - pad * 2,
    });
    y += 34 * u;
    var pSize = Math.min(cw * 0.42, ch * 0.34);
    photoBox(ctx, m, m.W / 2 - pSize / 2, y, pSize, pSize, 12 * u);
    y += pSize + 34 * u;
    txt(ctx, m.shared.name || "未填写姓名", m.W / 2, y, {
      size: 26 * u,
      weight: 700,
      color: m.pal.ink,
      align: "center",
      maxW: cw - pad * 2,
    });
    y += 40 * u;
    txt(ctx, rankLabel(m), m.W / 2, y, {
      size: 34 * u,
      weight: 700,
      color: m.pal.accent,
      align: "center",
      maxW: cw - pad * 2,
    });
    y += 26 * u;
    bar(ctx, cx + pad, y, cw - pad * 2, 14 * u, m.pct, m.pal);
    y += 30 * u;
    if (m.score && m.score.on) {
      badgeRow(ctx, m, cx + pad, y, cw - pad * 2, 12.5 * u, false);
      y += 34 * u;
      sayLine(ctx, m, cx + pad, y, cw - pad * 2, 11 * u, false);
      y += 26 * u;
    }

    var avail = cy + ch - pad - y;
    if (m.tags.length && avail > 28 * u) {
      var c = chipOpts(ctx, m.tags, cw - pad * 2, avail, u);
      chipsDraw(ctx, c.lines, c.o, cx + pad, y, cw - pad * 2, true, m.pal);
    }
  }

  /* ================================================================= *
   * 样式 5：宾果表
   * ================================================================= */
  function styleBingo(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    paper(ctx, m, { radius: m.radius, texture: false });
    var pad = m.W * 0.06;
    var headH = m.H * 0.12;

    txt(ctx, m.form.cardLabel + " · BINGO", m.W / 2, headH * 0.55, {
      size: 28 * u,
      weight: 700,
      color: m.pal.primary,
      align: "center",
      maxW: m.W - pad * 2,
    });
    txt(ctx, m.form.issuer, m.W / 2, headH * 0.85, {
      size: 13 * u,
      color: m.pal.muted,
      align: "center",
      maxW: m.W - pad * 2,
    });

    var n = 5;
    var gridTop = headH;
    var gridH = m.H - headH - m.H * 0.12 - pad;
    var gridW = m.W - pad * 2;
    var cell = Math.min(gridW / n, gridH / n);
    var gw = cell * n;
    var gx = (m.W - gw) / 2;
    var gy = gridTop + (gridH - cell * n) / 2;

    var cells = m.allTags.slice(0, n * n - 1);
    var on = {};
    m.tags.forEach(function (t) {
      on[t] = true;
    });

    for (var i = 0; i < n * n; i++) {
      var row = Math.floor(i / n);
      var col = i % n;
      var x = gx + col * cell;
      var y = gy + row * cell;
      var isCenter = row === 2 && col === 2;
      var label = isCenter ? "FREE" : cells[i - (i > 12 ? 1 : 0)] || "";
      var hit = isCenter || !!on[label];

      rr(ctx, x + cell * 0.03, y + cell * 0.03, cell * 0.94, cell * 0.94, cell * 0.1);
      ctx.fillStyle = hit ? m.pal.primary : "rgba(15,23,42,0.03)";
      ctx.globalAlpha = hit ? 1 : 1;
      ctx.fill();
      ctx.strokeStyle = hit ? m.pal.primary2 : "rgba(15,23,42,0.12)";
      ctx.lineWidth = Math.max(1, 1.4 * u);
      ctx.stroke();

      if (isCenter) {
        photoBox(ctx, m, x + cell * 0.08, y + cell * 0.08, cell * 0.84, cell * 0.84, cell * 0.1);
      } else {
        font(ctx, cell * 0.155, 700);
        var lines = String(label).length;
        var fs = cell * 0.155;
        if (lines > 4) fs = cell * 0.12;
        var words = wrap(ctx, label, cell * 0.8, fs, 700);
        for (var w = 0; w < words.length; w++) {
          txt(ctx, words[w], x + cell / 2, y + cell / 2 + (w - (words.length - 1) / 2) * fs * 1.25 + fs * 0.35, {
            size: fs,
            weight: 700,
            color: hit ? "#ffffff" : m.pal.muted,
            align: "center",
            baseline: "middle",
          });
        }
      }
    }

    badgeRow(ctx, m, pad, m.H - pad * 0.7 - 36 * u, m.W - pad * 2, 12 * u, false);
    txt(ctx, "连成 " + Object.keys(on).length + " 格 · " + (rankLabel(m)) + " · " + m.pct + "%", m.W / 2, m.H - pad * 0.7, {
      size: 16 * u,
      weight: 600,
      color: m.pal.ink,
      align: "center",
      maxW: m.W - pad * 2,
    });
    seal(ctx, gx + gw - cell * 0.5, gy + cell * 0.5, cell * 0.42, m.form.sealText, m.pal.accent, 0.3);
  }

  function wrap(ctx, text, maxW, size, weight) {
    font(ctx, size, weight);
    if (ctx.measureText(text).width <= maxW) return [text];
    var out = [];
    var line = "";
    var chars = Array.from(String(text));
    for (var i = 0; i < chars.length; i++) {
      var next = line + chars[i];
      if (ctx.measureText(next).width > maxW && line) {
        out.push(line);
        line = chars[i];
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
    return out.slice(0, 3);
  }

  /* ================================================================= *
   * 样式 6：化验单
   * ================================================================= */
  function styleLabReport(ctx, m) {
    var u = m.W / 1000;
    m.radius = 18 * u;
    paper(ctx, m, { radius: m.radius, color: "#ffffff", texture: false });
    var pad = m.W * 0.06;
    var y = pad;

    txt(ctx, m.form.issuer, pad, y + 24 * u, { size: 22 * u, weight: 700, color: m.pal.primary, maxW: m.W - pad * 2 });
    txt(ctx, "检测报告 / LABORATORY REPORT", pad, y + 46 * u, {
      size: 12 * u,
      color: m.pal.muted,
      spacing: 1.6,
    });
    y += 62 * u;

    ctx.strokeStyle = m.pal.primary;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(m.W - pad, y);
    ctx.stroke();
    y += 26 * u;

    var infoFs = 13 * u;
    txt(ctx, "姓名：" + (m.shared.name || "—"), pad, y, { size: infoFs, color: m.pal.ink, maxW: (m.W - pad * 2) * 0.5 });
    txt(ctx, "编号：" + (m.shared.no || "—"), m.W - pad, y, {
      size: infoFs,
      color: m.pal.ink,
      align: "right",
      maxW: (m.W - pad * 2) * 0.5,
    });
    y += 20 * u;
    txt(ctx, "送检日期：" + m.shared.issueDate, pad, y, { size: infoFs, color: m.pal.ink, maxW: (m.W - pad * 2) * 0.5 });
    txt(ctx, "有效期：" + m.shared.validUntil, m.W - pad, y, {
      size: infoFs,
      color: m.pal.ink,
      align: "right",
      maxW: (m.W - pad * 2) * 0.5,
    });
    y += 24 * u;

    // 表头
    var cols = [
      { x: pad, w: (m.W - pad * 2) * 0.46, label: "项目" },
      { x: pad + (m.W - pad * 2) * 0.46, w: (m.W - pad * 2) * 0.22, label: "结果" },
      { x: pad + (m.W - pad * 2) * 0.68, w: (m.W - pad * 2) * 0.32, label: "参考区间" },
    ];
    ctx.fillStyle = "rgba(15,23,42,0.05)";
    ctx.fillRect(pad, y - 16 * u, m.W - pad * 2, 26 * u);
    cols.forEach(function (c) {
      txt(ctx, c.label, c.x + 6 * u, y + 2 * u, { size: 12.5 * u, weight: 700, color: m.pal.ink });
    });
    y += 30 * u;

    var rows = m.allTags.length ? m.allTags : ["（暂无检测项）"];
    var rowH = Math.max(18 * u, (m.H - y - 90 * u) / Math.max(rows.length, 1));
    var on = {};
    m.tags.forEach(function (t) {
      on[t] = true;
    });
    var rand = rng(hash(rows.join("|")));

    for (var i = 0; i < rows.length; i++) {
      var ry = y + i * rowH;
      if (ry + rowH > m.H - (m.score && m.score.on ? 168 : 78) * u) break;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(15,23,42,0.025)";
        ctx.fillRect(pad, ry - rowH * 0.6, m.W - pad * 2, rowH);
      }
      var hit = !!on[rows[i]];
      var val = hit ? (60 + Math.round(rand() * 40)) + "%" : "未检出";
      txt(ctx, rows[i], cols[0].x + 6 * u, ry, { size: 13 * u, color: m.pal.ink, maxW: cols[0].w - 12 * u });
      txt(ctx, val, cols[1].x + 6 * u, ry, {
        size: 13 * u,
        weight: 700,
        color: hit ? m.pal.accent : m.pal.muted,
        maxW: cols[1].w - 12 * u,
      });
      if (hit) {
        bar(ctx, cols[2].x + 6 * u, ry - 9 * u, cols[2].w - 12 * u, 9 * u, 60 + Math.round(rand() * 40), m.pal);
      } else {
        txt(ctx, "0 – 100", cols[2].x + 6 * u, ry, { size: 12 * u, color: m.pal.muted });
      }
    }

    // 结论
    var cy2 = m.H - 58 * u;
    ctx.strokeStyle = "rgba(15,23,42,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, cy2 - 20 * u);
    ctx.lineTo(m.W - pad, cy2 - 20 * u);
    ctx.stroke();
    txt(ctx, "综合判定", pad, cy2, { size: 13 * u, color: m.pal.muted });
    if (m.score && m.score.on) {
      badgeRow(ctx, m, pad, m.H - 150 * u, m.W - pad * 2, 13 * u, false);
      sayLine(ctx, m, pad, m.H - 114 * u, m.W - pad * 2, 11.5 * u, false);
    }
    txt(ctx, rankLabel(m), pad, cy2 + 30 * u, {
      size: 26 * u,
      weight: 700,
      color: m.pal.accent,
      maxW: m.W * 0.6,
    });
    txt(ctx, m.pct + "%", m.W - pad, cy2 + 30 * u, {
      size: 30 * u,
      weight: 700,
      color: m.pal.ink,
      align: "right",
    });
    seal(ctx, m.W * 0.78, m.H * 0.58, Math.min(m.W, m.H) * 0.075, m.form.sealText, m.pal.accent, -0.2);
  }

  /* ================================================================= *
   * 样式 7：小票
   * ================================================================= */
  function styleReceipt(ctx, m) {
    var u = m.W / 1000;
    var pad = m.W * 0.07;
    var paperW = m.W - pad * 2;
    var x = pad + paperW * 0.08;
    var w = paperW * 0.84;
    var rows = m.tags.length ? m.tags : ["（未选择任何项目）"];

    // 先按内容估出纸条高度，纸条在画布里垂直居中
    var rowH = Math.max(15 * u, Math.min(26 * u, (m.H * 0.6) / Math.max(rows.length, 1)));
    var barcodeH = 60 * u;
    var decorH = m.score && m.score.on ? 62 * u : 0;
    var contentH =
      46 * u + 70 * u + rows.length * rowH + 118 * u + barcodeH + 44 * u + 24 * u + decorH;
    var paperH = Math.min(m.H - pad * 2, Math.max(contentH, 900 * u));
    var paperY = Math.max(pad, (m.H - paperH) / 2);

    // 背景 + 纸条
    ctx.save();
    if (m.radius) {
      rr(ctx, 0, 0, m.W, m.H, m.radius);
      ctx.clip();
    }
    var bgG = ctx.createLinearGradient(0, 0, 0, m.H);
    bgG.addColorStop(0, "#e8edf3");
    bgG.addColorStop(1, "#dfe5ec");
    ctx.fillStyle = bgG;
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(15,23,42,0.22)";
    ctx.shadowBlur = 26 * u;
    ctx.shadowOffsetY = 8 * u;
    ctx.fillRect(pad, paperY, paperW, paperH);
    ctx.restore();

    var teeth = Math.floor(paperW / (12 * u));
    ctx.fillStyle = "#ffffff";
    for (var i = 0; i <= teeth; i++) {
      ctx.beginPath();
      ctx.arc(pad + (i * paperW) / teeth, paperY, 6 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pad + (i * paperW) / teeth, paperY + paperH, 6 * u, 0, Math.PI * 2);
      ctx.fill();
    }

    var bottom = paperY + paperH;
    var y = paperY + 46 * u;

    txt(ctx, m.form.issuer, pad + paperW / 2, y, {
      size: 20 * u,
      weight: 700,
      color: m.pal.ink,
      align: "center",
      maxW: w,
      family: MONO,
    });
    y += 24 * u;
    txt(ctx, m.form.subtitle, pad + paperW / 2, y, {
      size: 11 * u,
      color: m.pal.muted,
      align: "center",
      maxW: w,
      family: MONO,
      spacing: 1.2,
    });
    y += 22 * u;
    dash(ctx, x, y, w, m.pal.muted, u);
    y += 26 * u;

    txt(ctx, "姓名  " + (m.shared.name || "—"), x, y, { size: 13 * u, color: m.pal.ink, family: MONO, maxW: w });
    y += 19 * u;
    txt(ctx, "编号  " + (m.shared.no || "—"), x, y, { size: 13 * u, color: m.pal.ink, family: MONO, maxW: w });
    y += 19 * u;
    txt(ctx, "日期  " + m.shared.issueDate, x, y, { size: 13 * u, color: m.pal.ink, family: MONO, maxW: w });
    y += 24 * u;
    dash(ctx, x, y, w, m.pal.muted, u);
    y += 26 * u;
    if (m.score && m.score.on) {
      badgeRow(ctx, m, x, y, w, 12 * u, false);
      y += 30 * u;
      sayLine(ctx, m, x, y, w, 11 * u, false);
      y += 22 * u;
    }

    var drawn = 0;
    for (var r = 0; r < rows.length; r++) {
      var ry = y + r * rowH;
      if (ry > bottom - 140 * u) break;
      txt(ctx, rows[r], x, ry, { size: 13 * u, color: m.pal.ink, family: MONO, maxW: w * 0.72 });
      txt(ctx, "×1", x + w, ry, { size: 13 * u, color: m.pal.muted, family: MONO, align: "right" });
      drawn = r + 1;
    }
    y += drawn * rowH + 12 * u;

    dash(ctx, x, y, w, m.pal.muted, u);
    y += 28 * u;
    txt(ctx, "合计合计", x, y, { size: 13 * u, color: m.pal.ink, family: MONO });
    txt(ctx, m.pct + "%", x + w, y, { size: 16 * u, weight: 700, color: m.pal.ink, family: MONO, align: "right" });
    y += 26 * u;
    txt(ctx, "评定等级", x, y, { size: 13 * u, color: m.pal.ink, family: MONO });
    txt(ctx, rankLabel(m), x + w, y, {
      size: 16 * u,
      weight: 700,
      color: m.pal.accent,
      family: MONO,
      align: "right",
      maxW: w * 0.6,
    });
    y += 24 * u;
    dash(ctx, x, y, w, m.pal.muted, u);
    y += 36 * u;

    var bh = Math.min(barcodeH, bottom - y - 40 * u);
    if (bh > 20 * u) {
      barcode(ctx, x, y, w, bh, m.shared.no + m.pct, m.pal.ink);
      y += bh + 20 * u;
    }
    var thanksY = Math.min(y + 16 * u, bottom - 16 * u);
    txt(ctx, "谢谢惠顾 · 请妥善保管", pad + paperW / 2, thanksY, {
      size: 11 * u,
      color: m.pal.muted,
      align: "center",
      family: MONO,
      maxW: w,
    });
    seal(ctx, pad + paperW * 0.78, bottom - 92 * u, Math.min(paperW, paperH) * 0.09, m.form.sealText, m.pal.accent, 0.35);
  }

  function dash(ctx, x, y, w, color, u) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5 * u, 4 * u]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
    ctx.restore();
  }

  function barcode(ctx, x, y, w, h, seedText, color) {
    var rand = rng(hash(seedText));
    ctx.save();
    ctx.fillStyle = color;
    var cx = x;
    while (cx < x + w - 2) {
      var bw = 1 + Math.floor(rand() * 4);
      if (rand() > 0.42) ctx.fillRect(cx, y, bw, h);
      cx += bw + 1 + Math.floor(rand() * 3);
    }
    ctx.restore();
  }

  /* ================================================================= *
   * 样式 8：狗牌
   * ================================================================= */
  function styleDogtag(ctx, m) {
    var u = m.W / 1000;
    m.radius = 20 * u;
    // 深色底
    ctx.save();
    rr(ctx, 0, 0, m.W, m.H, m.radius);
    ctx.clip();
    var bg = ctx.createLinearGradient(0, 0, 0, m.H);
    bg.addColorStop(0, "#1b2430");
    bg.addColorStop(1, "#0d131a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, m.W, m.H);
    noise(ctx, 0, 0, m.W, m.H, Math.floor(m.W * 0.6), "#ffffff", 0.04);

    // 链子
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.moveTo(m.W * 0.5, 0);
    for (var i = 0; i < 12; i++) {
      ctx.arc(m.W * 0.5 + (i % 2 ? 4 * u : -4 * u), i * (m.H * 0.045), 5 * u, 0, Math.PI);
    }
    ctx.stroke();
    ctx.restore();

    var tall = m.H / m.W > 1.15; /* 4:5 起就该用竖版居中铭牌，否则下方空一大片 */
    var tw = tall ? Math.min(m.W * 0.84, (m.H * 0.5) / 0.66) : m.W * 0.7;
    var th = Math.min(m.H * 0.62, tw * 0.66);
    var tx = (m.W - tw) / 2;
    var ty = tall ? (m.H - th) / 2 : m.H * 0.28;

    // 金属牌
    ctx.save();
    var metal = ctx.createLinearGradient(tx, ty, tx + tw, ty + th);
    metal.addColorStop(0, "#e9edf2");
    metal.addColorStop(0.35, "#b9c2cc");
    metal.addColorStop(0.5, "#dfe4ea");
    metal.addColorStop(1, "#98a3af");
    rr(ctx, tx, ty, tw, th, th * 0.22);
    ctx.fillStyle = metal;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2 * u;
    ctx.stroke();
    ctx.restore();

    // 挂孔
    ctx.save();
    ctx.beginPath();
    ctx.arc(tx + th * 0.13, ty + th * 0.16, th * 0.055, 0, Math.PI * 2);
    ctx.fillStyle = "#0d131a";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5 * u;
    ctx.stroke();
    ctx.restore();

    var ix = tx + th * 0.28;
    var iw = tw - th * 0.28 - tw * 0.05;
    var labels = [
      ["NAME", m.shared.name || "—"],
      ["NO.", m.shared.no || "—"],
      ["RANK", rankLabel(m)],
      ["LEVEL", m.pct + "%"],
      ["DATE", m.shared.issueDate],
    ];
    var top = ty + th * 0.22;
    var pitch = (th * 0.68) / labels.length;
    labels.forEach(function (p, i) {
      var y = top + i * pitch;
      txt(ctx, p[0], ix, y, { size: pitch * 0.34, color: "rgba(30,41,59,0.6)", family: MONO, spacing: 1.5 });
      txt(ctx, p[1], ix, y + pitch * 0.62, {
        size: pitch * 0.5,
        weight: 700,
        color: "#1f2937",
        family: MONO,
        maxW: iw,
      });
    });

    if (m.score && m.score.on) {
      var dgy = ty + th + 34 * u;
      badgeRow(ctx, m, m.W * 0.12, dgy, m.W * 0.76, 12.5 * u, true);
      sayLine(ctx, m, m.W * 0.12, dgy + 30 * u, m.W * 0.76, 11.5 * u, true);
    }
    txt(ctx, m.form.issuer, m.W / 2, m.H * 0.965, {
      size: 13 * u,
      color: "rgba(255,255,255,0.55)",
      align: "center",
      maxW: m.W * 0.9,
    });
    if (m.tags.length) {
      var c = chipOpts(ctx, m.tags, m.W * 0.82, m.H * 0.13, u);
      var startY = ty - c.o.chipH - m.H * 0.02;
      c.lines.slice(0, 2).forEach(function (line, li) {
        var totalW = line.items.reduce(function (s, it, i) {
          return s + it.w + (i ? c.o.gapX : 0);
        }, 0);
        var cx0 = m.W / 2 - totalW / 2;
        var cyy = startY - li * (c.o.chipH + c.o.gapY);
        if (cyy < m.H * 0.03) return;
        chipsDraw(ctx, [line], c.o, cx0, cyy, totalW, false, m.pal, "rgba(255,255,255,0.14)");
      });
    }
  }

  /* ================================================================= *
   * 样式 9：SSR 卡牌
   * ================================================================= */
  function styleSsr(ctx, m) {
    var u = m.W / 1000;
    m.radius = 24 * u;
    ctx.save();
    rr(ctx, 0, 0, m.W, m.H, m.radius);
    ctx.clip();
    var bg = ctx.createLinearGradient(0, 0, m.W, m.H);
    bg.addColorStop(0, m.pal.primary);
    bg.addColorStop(0.5, "#111827");
    bg.addColorStop(1, m.pal.primary2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, m.W, m.H);

    // 光晕
    var glow = ctx.createRadialGradient(m.W * 0.5, m.H * 0.4, 0, m.W * 0.5, m.H * 0.4, m.W * 0.7);
    glow.addColorStop(0, "rgba(255,255,255,0.22)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, m.W, m.H);

    var rand = rng(hash(m.shared.no + m.rank.name));
    for (var i = 0; i < 26; i++) {
      sparkle(ctx, rand() * m.W, rand() * m.H, (3 + rand() * 8) * u, "rgba(255,255,255," + (0.25 + rand() * 0.5) + ")");
    }
    ctx.restore();

    var pad = m.W * 0.07;
    // 稀有度徽标
    var bw = m.W * 0.17;
    var bh = bw * 0.42;
    ctx.save();
    rr(ctx, m.W - pad - bw, pad, bw, bh, bh * 0.3);
    var bg2 = ctx.createLinearGradient(m.W - pad - bw, pad, m.W - pad, pad + bh);
    bg2.addColorStop(0, "#fbbf24");
    bg2.addColorStop(1, "#f59e0b");
    ctx.fillStyle = bg2;
    ctx.fill();
    ctx.restore();
    txt(ctx, m.pct >= 80 ? "SSR" : m.pct >= 60 ? "SR" : m.pct >= 40 ? "R" : "N", m.W - pad - bw / 2, pad + bh / 2 + 1, {
      size: bh * 0.56,
      weight: 700,
      color: "#1f2937",
      align: "center",
      baseline: "middle",
      family: MONO,
    });

    txt(ctx, m.form.issuer, pad, pad + bh * 0.62, {
      size: 14 * u,
      weight: 700,
      color: "rgba(255,255,255,0.8)",
      maxW: m.W * 0.6,
    });

    // 中央插画区
    var artW = m.W * 0.62;
    var artH = Math.min(m.H * 0.42, artW * 1.15);
    var ax = (m.W - artW) / 2;
    var ay = pad + bh + m.H * 0.04;
    ctx.save();
    rr(ctx, ax, ay, artW, artH, 16 * u);
    ctx.clip();
    var ag = ctx.createLinearGradient(ax, ay, ax, ay + artH);
    ag.addColorStop(0, "rgba(255,255,255,0.16)");
    ag.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = ag;
    ctx.fillRect(ax, ay, artW, artH);
    ctx.restore();
    photoBox(ctx, m, ax, ay, artW, artH, 16 * u);
    rr(ctx, ax, ay, artW, artH, 16 * u);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2 * u;
    ctx.stroke();

    var y = ay + artH + m.H * 0.05;
    txt(ctx, rankLabel(m), m.W / 2, y, {
      size: 40 * u,
      weight: 700,
      color: "#ffffff",
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += m.H * 0.045;
    txt(ctx, m.shared.name || "未填写姓名", m.W / 2, y, {
      size: 18 * u,
      color: "rgba(255,255,255,0.75)",
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += m.H * 0.045;
    bar(ctx, pad, y, m.W - pad * 2, 14 * u, m.pct, { accent: "#fbbf24", primary2: "#f59e0b" });
    y += 30 * u;
    txt(ctx, m.score && m.score.on ? m.pct + "%" : m.pct + " / 100", m.W / 2, y, {
      size: 15 * u,
      weight: 700,
      color: "#fbbf24",
      align: "center",
      family: MONO,
    });

    y += m.H * 0.02;
    if (m.score && m.score.on) {
      badgeRow(ctx, m, pad, y, m.W - pad * 2, 12.5 * u, true);
      y += 32 * u;
      sayLine(ctx, m, pad, y, m.W - pad * 2, 11.5 * u, true);
      y += 22 * u;
    }
    y += m.H * 0.015;
    var avail = m.H - pad - y;
    if (m.tags.length && avail > 26 * u) {
      var c = chipOpts(ctx, m.tags, m.W - pad * 2, avail, u);
      c.lines.forEach(function (line, li) {
        var totalW = line.items.reduce(function (s, it, i) {
          return s + it.w + (i ? c.o.gapX : 0);
        }, 0);
        var cx0 = m.W / 2 - totalW / 2;
        var cyy = y + li * (c.o.chipH + c.o.gapY);
        if (cyy + c.o.chipH > m.H - pad) return;
        chipsDraw(ctx, [line], c.o, cx0, cyy, totalW, false, m.pal, "rgba(255,255,255,0.18)");
      });
    }
  }

  /* ================================================================= *
   * 样式 10：成分表
   * ================================================================= */
  function styleIngredient(ctx, m) {
    var u = m.W / 1000;
    m.radius = 18 * u;
    paper(ctx, m, { radius: m.radius, color: "#ffffff", texture: false });
    var pad = m.W * 0.07;
    var x = pad;
    var w = m.W - pad * 2;
    var y = pad;

    ctx.strokeStyle = m.pal.ink;
    ctx.lineWidth = 3 * u;
    ctx.strokeRect(x, y, w, m.H - pad * 2);
    y += 34 * u;

    txt(ctx, "成分分析表", x + w * 0.04, y, { size: 30 * u, weight: 700, color: m.pal.ink });
    y += 24 * u;
    txt(ctx, "NUTRITION FACTS · " + (m.form.subtitle || ""), x + w * 0.04, y, {
      size: 11 * u,
      color: m.pal.muted,
      spacing: 1.4,
      maxW: w * 0.92,
    });
    y += 14 * u;
    ctx.fillStyle = m.pal.ink;
    ctx.fillRect(x + w * 0.04, y, w * 0.92, 8 * u);
    y += 30 * u;

    txt(ctx, "品名 / NAME", x + w * 0.04, y, { size: 11 * u, color: m.pal.muted, spacing: 1.2 });
    txt(ctx, m.shared.name || "—", x + w * 0.04, y + 26 * u, {
      size: 20 * u,
      weight: 700,
      color: m.pal.ink,
      maxW: w * 0.92,
    });
    y += 46 * u;
    ctx.fillStyle = m.pal.ink;
    ctx.fillRect(x + w * 0.04, y, w * 0.92, 3 * u);
    y += 26 * u;

    txt(ctx, "每 100 单位含量", x + w * 0.04, y, { size: 12 * u, weight: 700, color: m.pal.ink });
    txt(ctx, "每日参考值 %", x + w * 0.96, y, {
      size: 12 * u,
      weight: 700,
      color: m.pal.ink,
      align: "right",
    });
    y += 16 * u;

    /* 中性主题的「成分表」列出全部成分、勾选的加亮；成人向词库有一千多条，
     * 全列会溢出画布，所以只列你选中的那些（它们本来就是 100% 的那几行）。 */
    var scoreMode = m.score && m.score.on;
    var rows = scoreMode
      ? m.tags.slice(0, 60)
      : m.allTags.length
        ? m.allTags
        : ["（暂无成分）"];
    if (!rows.length) rows = ["（暂无成分）"];
    var on = {};
    m.tags.forEach(function (t) {
      on[t] = true;
    });
    var rand = rng(hash(rows.join("|") + m.shared.no));
    /* 底部要给「机构/编号」「板块徽章」「倾向叙述」留出三行，别让成分行压上去 */
    var avail = m.H - y - (scoreMode ? 150 : 110) * u;
    var rowH = Math.max(17 * u, Math.min(90 * u, avail / Math.max(rows.length, 1)));
    /* 行高有 17u 下限，行数超过能放下的量就会顶出画布，先按可用高度裁一刀 */
    rows = rows.slice(0, Math.max(4, Math.floor(avail / rowH)));

    for (var i = 0; i < rows.length; i++) {
      var ry = y + i * rowH;
      if (ry > m.H - 100 * u) break;
      var v = on[rows[i]] ? 45 + Math.round(rand() * 55) : Math.round(rand() * 18);
      txt(ctx, rows[i], x + w * 0.04, ry, { size: 13 * u, color: m.pal.ink, maxW: w * 0.6 });
      txt(ctx, v + "%", x + w * 0.96, ry, {
        size: 13 * u,
        weight: 700,
        color: on[rows[i]] ? m.pal.accent : m.pal.muted,
        align: "right",
      });
      ctx.fillStyle = "rgba(15,23,42,0.14)";
      ctx.fillRect(x + w * 0.04, ry + 6 * u, w * 0.92, 1);
      bar(ctx, x + w * 0.04, ry + 9 * u, (w * 0.92 * v) / 100, 4 * u, 100, m.pal);
    }

    y = m.H - pad - 62 * u;
    ctx.fillStyle = m.pal.ink;
    ctx.fillRect(x + w * 0.04, y - 16 * u, w * 0.92, 6 * u);
    txt(ctx, "综合评级", x + w * 0.04, y + 8 * u, { size: 13 * u, weight: 700, color: m.pal.ink });
    txt(ctx, rankLabel(m), x + w * 0.04, y + 38 * u, {
      size: 24 * u,
      weight: 700,
      color: m.pal.accent,
      maxW: w * 0.62,
    });
    txt(ctx, m.pct + "%", x + w * 0.96, y + 38 * u, {
      size: 26 * u,
      weight: 700,
      color: m.pal.ink,
      align: "right",
    });
    badgeRow(ctx, m, x + w * 0.04, m.H - pad - 84 * u, w * 0.92, 13 * u, false);
    sayLine(ctx, m, x + w * 0.04, m.H - pad - 50 * u, w * 0.92, 11.5 * u, false);
    txt(ctx, m.form.issuer + " · No. " + (m.shared.no || "—"), x + w * 0.04, m.H - pad - 12 * u, {
      size: 10.5 * u,
      color: m.pal.muted,
      maxW: w * 0.92,
    });
  }

  /* ================================================================= *
   * 样式 11：通缉令
   * ================================================================= */
  function styleWanted(ctx, m) {
    var u = m.W / 1000;
    m.radius = 18 * u;
    paper(ctx, m, { radius: m.radius, color: "#f3e9d2", texture: false });
    noise(ctx, 0, 0, m.W, m.H, Math.floor(m.W * 1.2), "#8a6b3f", 0.07);

    var pad = m.W * 0.07;
    var y = pad + 30 * u;
    txt(ctx, "通  缉", m.W / 2, y, {
      size: 52 * u,
      weight: 700,
      color: "#3b2a17",
      align: "center",
      family: SERIF,
      spacing: 4 * u,
    });
    y += 30 * u;
    txt(ctx, "WANTED", m.W / 2, y, {
      size: 18 * u,
      weight: 700,
      color: "#6b5233",
      align: "center",
      family: SERIF,
      spacing: 8 * u,
    });
    y += 16 * u;
    ctx.strokeStyle = "#8a6b3f";
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(m.W - pad, y);
    ctx.stroke();
    y += 34 * u;

    txt(ctx, "姓名 / ALIAS", m.W / 2, y, {
      size: 12 * u,
      color: "#8a6b3f",
      align: "center",
      spacing: 2 * u,
    });
    y += 38 * u;
    txt(ctx, m.shared.name || "未填写姓名", m.W / 2, y, {
      size: 32 * u,
      weight: 700,
      color: "#3b2a17",
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += 30 * u;

    var pw = Math.min(m.W * 0.56, (m.H - y) * 0.52);
    var ph = pw * 1.15;
    photoBox(ctx, m, m.W / 2 - pw / 2, y, pw, ph, 6 * u);
    ctx.save();
    ctx.strokeStyle = "#8a6b3f";
    ctx.lineWidth = 3 * u;
    ctx.strokeRect(m.W / 2 - pw / 2, y, pw, ph);
    ctx.restore();
    y += ph + 30 * u;

    txt(ctx, "涉案标签 / CHARGES", m.W / 2, y, {
      size: 12 * u,
      color: "#8a6b3f",
      align: "center",
      spacing: 2 * u,
    });
    y += 20 * u;

    var avail = m.H - pad - 80 * u - y;
    if (m.tags.length && avail > 26 * u) {
      var c = chipOpts(ctx, m.tags, m.W - pad * 2, avail, u);
      c.lines.forEach(function (line, li) {
        var totalW = line.items.reduce(function (s, it, i) {
          return s + it.w + (i ? c.o.gapX : 0);
        }, 0);
        var cyy = y + li * (c.o.chipH + c.o.gapY);
        if (cyy + c.o.chipH > m.H - pad - 70 * u) return;
        chipsDraw(ctx, [line], c.o, m.W / 2 - totalW / 2, cyy, totalW, false, m.pal, "#6b5233");
      });
    }

    badgeRow(ctx, m, m.W * 0.08, m.H - pad - 80 * u, m.W * 0.84, 13 * u, false);
    txt(ctx, "危险等级 · " + (rankLabel(m)), m.W / 2, m.H - pad - 34 * u, {
      size: 20 * u,
      weight: 700,
      color: "#7c2d12",
      align: "center",
      maxW: m.W - pad * 2,
    });
    txt(ctx, "悬赏 " + m.pct + " 点 · " + m.form.issuer, m.W / 2, m.H - pad - 10 * u, {
      size: 12 * u,
      color: "#8a6b3f",
      align: "center",
      maxW: m.W - pad * 2,
    });
    seal(ctx, m.W * 0.8, m.H * 0.42, Math.min(m.W, m.H) * 0.08, m.form.sealText, "#7c2d12", -0.2);
  }

  /* ================================================================= *
   * 样式 12：拍立得照片墙
   *   一律以照片为主角：每张照片一张白边相纸，按序号错落旋转。
   * ================================================================= */

  /** 一组拍立得：白边相纸 + 阴影 + 角标，照片为 null 时画占位图 */
  function polaroidStack(ctx, m, imgs, x, y, w, h, o) {
    o = o || {};
    var u = m.W / 1000;
    var max = o.max || 5;
    var list = (imgs && imgs.length ? imgs : [null]).slice(0, max);
    var n = list.length;
    if (!n) return;
    /* 一行最多 3 张；4~5 张分两行，相纸之间留白，编号不会被前一张挡住 */
    var rows = n >= 4 ? 2 : 1;
    var perRow = Math.ceil(n / rows);
    var gapK = 0.1;
    var pw = Math.min(w / perRow / (1 + gapK), h / rows / 1.42);
    var ph = pw * 1.22;
    var tilt = [-0.055, 0.048, -0.028, 0.062, -0.04];
    var cx = x + w / 2;
    var cy = y + h / 2;
    var rowGap = ph * 0.14;
    var totalH = rows * ph + (rows - 1) * rowGap;
    var at = [];
    for (var r = 0; r < rows; r++) {
      var cnt = Math.min(perRow, n - r * perRow);
      if (cnt <= 0) break;
      var rowW = cnt * pw + (cnt - 1) * pw * gapK;
      for (var c = 0; c < cnt; c++) {
        at.push({
          x: cx - rowW / 2 + pw / 2 + c * pw * (1 + gapK),
          y: cy - totalH / 2 + ph / 2 + r * (ph + rowGap),
        });
      }
    }

    for (var i = 0; i < n; i++) {
      var dy = n === 1 ? 0 : (i % 2 ? 1 : -1) * ph * 0.026;
      ctx.save();
      ctx.translate(at[i].x, at[i].y + dy);
      ctx.rotate(tilt[i % tilt.length]);
      ctx.shadowColor = "rgba(24,20,12,0.3)";
      ctx.shadowBlur = 20 * u;
      ctx.shadowOffsetY = 9 * u;
      rr(ctx, -pw / 2, -ph / 2, pw, ph, 5 * u);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      var inner = Math.max(4, pw * 0.05);
      var imgH = ph - inner * 3 - ph * 0.14;
      if (list[i]) {
        cover(ctx, list[i], -pw / 2 + inner, -ph / 2 + inner, pw - inner * 2, imgH, 2 * u);
      } else {
        ctx.save();
        ctx.translate(-pw / 2 + inner, -ph / 2 + inner);
        placeholder(ctx, 0, 0, pw - inner * 2, imgH, 2 * u);
        ctx.restore();
      }
      var capY = ph / 2 - ph * 0.072;
      txt(ctx, "#" + (i + 1), -pw / 2 + inner + 2 * u, capY, {
        size: Math.max(8, pw * 0.072),
        color: "#8b8172",
        family: SERIF,
      });
      if (m.shared && m.shared.issueDate) {
        txt(ctx, m.shared.issueDate, pw / 2 - inner - 2 * u, capY, {
          size: Math.max(7, pw * 0.056),
          color: "#a3998a",
          align: "right",
          family: SERIF,
          maxW: pw * 0.44,
        });
      }
      ctx.restore();
    }
  }

  function stylePolaroid(ctx, m) {
    var u = m.W / 1000;
    m.radius = 18 * u;
    paper(ctx, m, { radius: m.radius, color: "#f7f2e8", texture: false });
    noise(ctx, 0, 0, m.W, m.H, Math.floor(m.W * 0.8), "#8b7a5a", 0.05);

    var pad = m.W * 0.07;
    txt(ctx, m.form.issuer, pad, pad + 8 * u, {
      size: 15 * u,
      weight: 700,
      color: m.pal.ink,
      maxW: m.W * 0.56,
      spacing: 1.2,
    });
    txt(ctx, m.shared.no, m.W - pad, pad + 8 * u, {
      size: 12 * u,
      color: "#9a8f7d",
      align: "right",
      family: MONO,
      maxW: m.W * 0.38,
    });

    var ty = pad + 44 * u;
    txt(ctx, m.form.cardLabel, m.W / 2, ty, {
      size: 28 * u,
      weight: 700,
      color: m.pal.primary,
      align: "center",
      spacing: 3.5 * u,
      maxW: m.W - pad * 2,
    });
    ty += 21 * u;
    txt(ctx, m.shared.name || "未填写姓名", m.W / 2, ty, {
      size: 16 * u,
      color: "#8b8172",
      align: "center",
      maxW: m.W - pad * 2,
    });

    /* 底部信息区高度按比例收，长图上下都留得下 */
    var footH = Math.min(m.H * 0.3, 250 * u);
    var stackTop = ty + 22 * u;
    var stackH = m.H - pad - footH - stackTop;
    polaroidStack(ctx, m, photoList(m), pad, stackTop, m.W - pad * 2, stackH, { max: 5 });

    /* 底部：分隔线 + 等级 + 进度条 + 标签 */
    var by = m.H - pad - footH;
    ctx.save();
    ctx.strokeStyle = "rgba(139,129,114,0.32)";
    ctx.lineWidth = 1.4 * u;
    ctx.beginPath();
    ctx.moveTo(pad, by);
    ctx.lineTo(m.W - pad, by);
    ctx.stroke();
    ctx.restore();

    var y = by + 30 * u;
    if (m.score && m.score.on && m.badges && m.badges.length) {
      badgeRow(ctx, m, pad, y - 14 * u, m.W - pad * 2, 11 * u, false);
      y += 16 * u;
    }
    txt(ctx, rankLabel(m), m.W / 2, y, {
      size: 25 * u,
      weight: 700,
      color: m.pal.primary,
      align: "center",
      maxW: m.W - pad * 2,
    });
    y += 22 * u;
    txt(ctx, m.score && m.score.on ? m.pct + "%" : m.pct + " / 100", m.W / 2, y, {
      size: 13 * u,
      weight: 700,
      color: "#8b8172",
      align: "center",
      family: MONO,
    });
    y += 14 * u;
    bar(ctx, pad + m.W * 0.08, y, m.W * 0.84, 10 * u, m.pct, m.pal);
    y += 24 * u;
    if (m.tags.length) {
      txt(ctx, m.tags.slice(0, 6).join(" · "), m.W / 2, y, {
        size: 12 * u,
        color: "#9a8f7d",
        align: "center",
        maxW: m.W - pad * 2,
      });
      y += 18 * u;
    }
    if (y < m.H - pad - 6 * u) {
      txt(ctx, m.form.subtitle || m.form.issuer, pad, m.H - pad, {
        size: 11 * u,
        color: "rgba(139,129,114,0.85)",
        maxW: m.W * 0.6,
      });
      txt(ctx, m.shared.validUntil, m.W - pad, m.H - pad, {
        size: 11 * u,
        color: "rgba(139,129,114,0.85)",
        align: "right",
        maxW: m.W * 0.34,
      });
    }
  }

  /* ================================================================= *
   * 样式 13：印样联片（底片九宫格）
   *   整卷底片印在一张相纸上，每格带序号，空格是未曝光帧。
   * ================================================================= */
  function styleContactsheet(ctx, m) {
    var u = m.W / 1000;
    m.radius = 16 * u;
    ctx.save();
    rr(ctx, 0, 0, m.W, m.H, m.radius);
    ctx.clip();
    var bg = ctx.createLinearGradient(0, 0, m.W, m.H);
    bg.addColorStop(0, "#161a22");
    bg.addColorStop(1, "#0d1016");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.restore();
    noise(ctx, 0, 0, m.W, m.H, Math.floor(m.W * 1.6), "#ffffff", 0.05);

    var pad = m.W * 0.065;
    txt(ctx, "印样 / CONTACT SHEET", pad, pad + 6 * u, {
      size: 13 * u,
      weight: 700,
      color: "rgba(255,255,255,0.82)",
      family: MONO,
      spacing: 1.6,
      maxW: m.W * 0.66,
    });
    txt(ctx, m.shared.no, m.W - pad, pad + 6 * u, {
      size: 11 * u,
      color: "rgba(255,255,255,0.5)",
      align: "right",
      family: MONO,
      maxW: m.W * 0.32,
    });
    txt(ctx, m.form.issuer, pad, pad + 26 * u, {
      size: 11 * u,
      color: "rgba(255,255,255,0.45)",
      maxW: m.W - pad * 2,
    });

    var list = photoList(m);
    var n = Math.max(1, Math.min(list.length, 9));
    var cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
    var rows = Math.ceil(n / cols);

    var footH = Math.min(m.H * 0.3, 240 * u);
    var gridTop = pad + 40 * u;
    var gridH = m.H - footH - pad - gridTop;
    var gap = 10 * u;
    var cellW = (m.W - pad * 2 - gap * (cols - 1)) / cols;
    var cellH = (gridH - gap * (rows - 1)) / rows;
    var side = Math.min(cellW, cellH);
    /* 保持每格正方形并居中，空格用未曝光帧补满整卷 */
    var totalW = side * cols + gap * (cols - 1);
    var totalH = side * rows + gap * (rows - 1);
    var ox = (m.W - totalW) / 2;
    var oy = gridTop + (gridH - totalH) / 2;

    for (var i = 0; i < cols * rows; i++) {
      var gx = ox + (i % cols) * (side + gap);
      var gy = oy + Math.floor(i / cols) * (side + gap);
      var img = list[i] || null;
      if (img) {
        ctx.save();
        rr(ctx, gx, gy, side, side, 3 * u);
        ctx.clip();
        cover(ctx, img, gx, gy, side, side, 3 * u);
        /* 编号小块 */
        var lb = Math.max(11, side * 0.1);
        ctx.fillStyle = "rgba(8,10,14,0.62)";
        ctx.fillRect(gx, gy + side - lb, Math.max(lb * 2.1, side * 0.22), lb);
        txt(ctx, "#" + ("0" + (i + 1)).slice(-2), gx + lb * 0.32, gy + side - lb * 0.24, {
          size: lb * 0.56,
          weight: 700,
          color: "rgba(255,255,255,0.92)",
          family: MONO,
        });
        ctx.restore();
      } else {
        ctx.save();
        rr(ctx, gx, gy, side, side, 3 * u);
        ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,0.045)";
        ctx.fillRect(gx, gy, side, side);
        ctx.restore();
        txt(ctx, "—", gx + side / 2, gy + side / 2, {
          size: side * 0.12,
          color: "rgba(255,255,255,0.14)",
          align: "center",
          baseline: "middle",
        });
      }
      ctx.save();
      rr(ctx, gx + 0.5, gy + 0.5, side - 1, side - 1, 3 * u);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1 * u;
      ctx.stroke();
      ctx.restore();
    }

    /* 底部信息条 */
    var by = m.H - pad - footH;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.moveTo(pad, by);
    ctx.lineTo(m.W - pad, by);
    ctx.stroke();
    ctx.restore();

    var y = by + 34 * u;
    txt(ctx, rankLabel(m), pad, y, {
      size: 26 * u,
      weight: 700,
      color: "#ffffff",
      maxW: m.W - pad * 2,
    });
    txt(ctx, m.score && m.score.on ? m.pct + "%" : m.pct + " / 100", m.W - pad, y, {
      size: 20 * u,
      weight: 700,
      color: "#fbbf24",
      align: "right",
      family: MONO,
      maxW: m.W * 0.3,
    });
    y += 16 * u;
    bar(ctx, pad, y, m.W - pad * 2, 10 * u, m.pct, m.pal);
    y += 26 * u;
    txt(ctx, m.shared.name || "未填写姓名", pad, y, {
      size: 15 * u,
      color: "rgba(255,255,255,0.8)",
      maxW: m.W * 0.5,
    });
    txt(ctx, m.tags.slice(0, 4).join(" · "), m.W - pad, y, {
      size: 11.5 * u,
      color: "rgba(255,255,255,0.5)",
      align: "right",
      maxW: m.W * 0.44,
    });
    y += 18 * u;
    if (m.score && m.score.on) {
      sayLine(ctx, m, pad, y, m.W - pad * 2, 11 * u, true);
      y += 18 * u;
    }
    barcode(ctx, pad, m.H - pad - 16 * u, m.W * 0.32, 16 * u, m.shared.no, "rgba(255,255,255,0.55)");
    txt(ctx, m.shared.issueDate, m.W - pad, m.H - pad, {
      size: 10.5 * u,
      color: "rgba(255,255,255,0.45)",
      align: "right",
      family: MONO,
      maxW: m.W * 0.4,
    });
  }

  /* ================================================================= *
   * 证件族（doc*）—— 拟真证件 / 牌照
   *
   * 上面 13 个是「创意版式」，这一族追求**像真的**：防伪底纹、微缩文字、
   * 金属芯片、全息标、钢印、机读码，字段名也照着真证件来（姓名 / 性别 /
   * 公民身份号码 …）。内容仍然是站内的认证数据：姓名、编号、等级、勾选标签。
   *
   * 比例适配：真证件都是横的（身份证 85.6×54mm ≈ 1.586:1）。
   *   - H/W ≤ 1.12（方形）：证件铺满画布；
   *   - 竖版（4:5 / 3:4 / 9:16 / 长图）：证件按真实长宽比居中「摆」在衬底上，
   *     下方写认证项目与等级 —— 而不是把证件拉变形。
   * ================================================================= */

  function dShade(hex, amt) {
    var c = String(hex || "#000000").replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var n = parseInt(c, 16);
    if (isNaN(n)) return "rgba(0,0,0,0)";
    var r = (n >> 16) & 255;
    var g = (n >> 8) & 255;
    var b = n & 255;
    function f(v) {
      var out = amt >= 0 ? v + (255 - v) * amt : v * (1 + amt);
      return Math.max(0, Math.min(255, Math.round(out)));
    }
    return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
  }

  function dMix(a, b, t) {
    function parse(hex) {
      var c = String(hex || "#000000").replace("#", "");
      if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
      var n = parseInt(c, 16);
      if (isNaN(n)) return [0, 0, 0];
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var x = parse(a);
    var y = parse(b);
    var k = t == null ? 0.5 : t;
    return (
      "rgb(" +
      Math.round(x[0] + (y[0] - x[0]) * k) +
      "," +
      Math.round(x[1] + (y[1] - x[1]) * k) +
      "," +
      Math.round(x[2] + (y[2] - x[2]) * k) +
      ")"
    );
  }

  function dPad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** 从编号里抽出数字，不足就按内容哈希补齐（同一个编号每次结果一样） */
  function dDigits(s, len) {
    var out = String(s == null ? "" : s).replace(/[^0-9]/g, "");
    var r = rng(hash("digits:" + (s == null ? "" : s)));
    var guard = 0;
    while (out.length < len && guard++ < 64) out += String(Math.floor(r() * 10));
    return out.slice(0, len);
  }

  /** 仿真的 18 位公民身份号码：前 17 位取自编号，末位按 GB 11643 算法算校验码 */
  function dIdNo(m) {
    var d17 = dDigits(m.shared.no, 17);
    var w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(d17.charAt(i)) * w[i];
    return d17 + "10X98765432".charAt(sum % 11);
  }

  /** 由编号哈希派生一个出生日期（不做真实计算，只是让版面有真证件的样子） */
  function dBirth(m) {
    var h = hash("birth:" + (m.shared.no || "") + "|" + (m.shared.name || "")) >>> 0;
    var y = 1972 + (h % 32);
    /* 必须用 >>> ：hash() 是 0..2^32-1，`>>` 会按有符号 32 位处理，
     * 一旦最高位是 1 就变负数，%% 也变负数 —— 日期会渲染成 "1996-0-9-0-26"。 */
    return y + "-" + dPad2(1 + ((h >>> 6) % 12)) + "-" + dPad2(1 + ((h >>> 11) % 28));
  }

  function dGender(m) {
    return m.gender === "m" ? "男" : "女";
  }

  /** 防伪底纹：交叉网纹 + 同心环，远看是纸的纹理，放大才看得出线条 */
  function guilloche(ctx, x, y, w, h, color, opts) {
    opts = opts || {};
    var step = opts.step || Math.max(9, w * 0.011);
    var alpha = opts.alpha == null ? 0.06 : opts.alpha;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.6, w * 0.0011);
    for (var i = -h; i < w + h; i += step) {
      ctx.beginPath();
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + h, y + h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    if (opts.rings !== false) {
      var cx = x + w * (opts.rx == null ? 0.5 : opts.rx);
      var cy = y + h * (opts.ry == null ? 0.5 : opts.ry);
      var maxR = Math.hypot(w, h) * 0.5;
      ctx.globalAlpha = alpha * 1.5;
      for (var r = step * 2; r < maxR; r += step * 2) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 微缩文字行（证件防伪条），画不下就停，不会拖慢渲染 */
  function microPrint(ctx, x, y, w, h, text, color, alpha) {
    if (w < 30 || h < 3) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.globalAlpha = alpha == null ? 0.45 : alpha;
    ctx.fillStyle = color;
    font(ctx, Math.max(3, h * 0.72), 400, MONO);
    var tw = ctx.measureText(text).width + h;
    if (!(tw > 0)) {
      ctx.restore();
      return;
    }
    for (var cx = x, n = 0; cx < x + w && n < 60; cx += tw, n++) {
      ctx.fillText(text, cx, y + h * 0.86);
    }
    ctx.restore();
  }

  /** 卡上的金属芯片 */
  function chipGold(ctx, x, y, w, h) {
    var g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, "#f7e9b0");
    g.addColorStop(0.45, "#d9b45a");
    g.addColorStop(1, "#a9803a");
    rr(ctx, x, y, w, h, Math.min(w, h) * 0.18);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(70,48,8,0.45)";
    ctx.lineWidth = Math.max(0.8, w * 0.02);
    ctx.stroke();
    ctx.save();
    rr(ctx, x, y, w, h, Math.min(w, h) * 0.18);
    ctx.clip();
    ctx.strokeStyle = "rgba(90,64,14,0.42)";
    ctx.lineWidth = Math.max(0.7, w * 0.014);
    for (var i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w * i) / 4, y + h * 0.06);
      ctx.lineTo(x + (w * i) / 4, y + h * 0.94);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x + w * 0.05, y + h * 0.5);
    ctx.lineTo(x + w * 0.95, y + h * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /** 全息防伪圆标 */
  function holoSeal(ctx, cx, cy, r) {
    if (r < 4) return;
    ctx.save();
    var g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, "rgba(255,255,255,0.92)");
    g.addColorStop(0.25, "rgba(150,220,255,0.7)");
    g.addColorStop(0.5, "rgba(255,190,240,0.62)");
    g.addColorStop(0.75, "rgba(190,255,210,0.62)");
    g.addColorStop(1, "rgba(255,255,255,0.88)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = "#ffffff";
    star(ctx, cx, cy, r * 0.6, r * 0.22, 5);
    ctx.restore();
  }

  /** 爪印（宠物证用） */
  function pawPrint(ctx, cx, cy, r, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 0.1 : alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.32, r * 0.6, r * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    var toes = [
      [-0.56, -0.34, 0.25],
      [-0.19, -0.62, 0.27],
      [0.2, -0.62, 0.27],
      [0.57, -0.32, 0.24],
    ];
    for (var i = 0; i < toes.length; i++) {
      ctx.beginPath();
      ctx.ellipse(
        cx + r * toes[i][0],
        cy + r * toes[i][1],
        r * toes[i][2],
        r * toes[i][2] * 1.16,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  /** 字段标签：小字 + 字距（「姓 名」这种证件的排版味） */
  function fLabel(ctx, s, x, y, o) {
    o = o || {};
    txt(ctx, s, x, y, {
      size: o.size || 13,
      weight: 400,
      color: o.color || "rgba(15,23,42,0.5)",
      spacing: o.spacing == null ? 1 : o.spacing,
      maxW: o.maxW,
      align: o.align,
    });
  }

  /** 字段值 */
  function fValue(ctx, s, x, y, o) {
    o = o || {};
    txt(ctx, s == null || s === "" ? "—" : s, x, y, {
      size: o.size || 24,
      weight: o.weight == null ? 700 : o.weight,
      color: o.color || "#111827",
      maxW: o.maxW,
      family: o.family,
      align: o.align,
    });
    return y + (o.size || 24) * 1.4;
  }

  /** 证件边框（可选双线） */
  function docBorder(ctx, m, o) {
    o = o || {};
    var u = m.W / 1000;
    var inset = o.inset == null ? m.W * 0.032 : o.inset;
    var alpha = o.alpha == null ? 0.5 : o.alpha;
    var rad = (o.radius == null ? 10 : o.radius) * u;
    ctx.save();
    ctx.strokeStyle = o.color || m.pal.primary;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(1, 1.7 * u);
    rr(ctx, inset, inset, m.W - inset * 2, m.H - inset * 2, rad);
    ctx.stroke();
    if (o.double) {
      var d = inset + 7.5 * u;
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = Math.max(0.7, 0.9 * u);
      rr(ctx, d, d, m.W - d * 2, m.H - d * 2, Math.max(1, rad - 5 * u));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 认证项目区（衬底上那一块）：标签胶囊 + 等级 + 百分比 + 二维码 + 发证信息。
   *  内容自上而下紧挨着排，剩余高度交给二维码和发证信息去撑 —— 竖长比例才不会空。 */
  function endorseStrip(ctx, m, x, y, w, h) {
    var u = m.W / 1000;
    if (h < 30 * u) return;
    /* 长图时这一块有 1000px 以上，按普通尺寸排会全挤在顶部；三种档位分开处理 */
    var tall = h > 620 * u;
    var qrSize = tall
      ? Math.min(w * 0.42, 520 * u)
      : Math.min(w * 0.26, Math.max(120 * u, h * 0.42), 300 * u);
    var gap = 20 * u;
    var leftW = w - qrSize - gap;
    fLabel(ctx, "认证项目 / ENDORSEMENTS", x, y + 11 * u, {
      size: tall ? 13 * u : 10.5 * u,
      color: "rgba(255,255,255,0.5)",
      spacing: 1.6 * u,
      maxW: leftW,
    });
    var chipsTop = y + (tall ? 30 * u : 22 * u);
    var chipsH = 0;
    var chipsMax = tall ? h * 0.5 : Math.min(h * 0.62, w * 0.5);
    if (m.tags && m.tags.length) {
      var blk = chipOpts(ctx, m.tags, leftW, chipsMax, u);
      chipsH = chipsHeight(blk.lines, blk.o);
      chipsDraw(ctx, blk.lines, blk.o, x, chipsTop, leftW, false, m.pal);
    } else {
      chipsH = 16 * u;
      txt(ctx, "勾选左侧标签后，这里会生成认证项目", x, chipsTop + 11 * u, {
        size: tall ? 13 * u : 11.5 * u,
        color: "rgba(255,255,255,0.5)",
        maxW: leftW,
      });
    }
    /* 等级块：普通比例紧贴标签；竖长比例压到底部；长图放在中段，让上下各有呼吸 */
    var by = chipsTop + chipsH + 30 * u;
    if (tall) by = Math.max(by, y + h * 0.58);
    else if (h - (by - y) > 190 * u) by = y + h - 92 * u;
    var rankSize = tall ? Math.min(40 * u, leftW / 6) : Math.min(22 * u, leftW / 8);
    /* 百分比按实际字宽收缩：maxW 卡死会把 "83%" 截成 "8…"，这行必须量出来 */
    var pctStr = m.pct + "%";
    var pctSize = tall ? Math.min(96 * u, leftW / 5) : Math.min(40 * u, leftW / 6);
    font(ctx, pctSize, 800);
    var pctW = ctx.measureText(pctStr).width;
    var pctMax = leftW * 0.36;
    if (pctW > pctMax && pctW > 0) pctSize = pctSize * (pctMax / pctW);
    txt(ctx, rankLabel(m), x, by, {
      size: rankSize,
      weight: 800,
      color: "#ffffff",
      maxW: leftW * 0.58,
    });
    txt(ctx, pctStr, x + leftW, by, {
      size: pctSize,
      weight: 800,
      color: m.pal.accent,
      align: "right",
      maxW: pctMax * 1.06,
    });
    bar(ctx, x, by + pctSize * 0.35, leftW, tall ? 18 * u : 12 * u, m.pct, m.pal);

    /* 二维码：普通比例贴着等级块；竖长/长图贴右下角，长图时它就是视觉落点 */
    var qy = tall
      ? Math.min(y + h - qrSize, by + pctSize + 90 * u)
      : Math.min(y + h - qrSize, by + 44 * u);
    qr(ctx, m.qrText, x + leftW + gap, qy, qrSize, "rgba(255,255,255,0.92)", "rgba(255,255,255,0.08)");

    var iy = y + h - 6 * u;
    txt(ctx, m.form.issuer, x, iy - (tall ? 34 * u : 26 * u), {
      size: tall ? 15 * u : 11.5 * u,
      weight: 600,
      color: "rgba(255,255,255,0.58)",
      maxW: leftW,
    });
    txt(ctx, "签发 " + m.shared.issueDate + " · 有效至 " + m.shared.validUntil, x, iy - (tall ? 12 * u : 10 * u), {
      size: tall ? 13 * u : 10 * u,
      color: "rgba(255,255,255,0.38)",
      spacing: 0.6 * u,
      maxW: leftW,
    });
  }

  /** 衬底：证件「摆」在深色台面上，返回证件矩形 */
  function docMat(ctx, m, aspect, o) {
    o = o || {};
    var u = m.W / 1000;
    var pad = m.W * (o.pad == null ? 0.07 : o.pad);
    var bottom = o.bottom == null ? m.H * 0.3 : o.bottom;
    var cardW = m.W - pad * 2;
    var cardH = cardW / aspect;
    var maxH = m.H - bottom - pad * 1.2;
    if (cardH > maxH) {
      cardH = maxH;
      cardW = cardH * aspect;
    }
    var x = (m.W - cardW) / 2;
    var y = Math.max(pad * 0.6, (m.H - bottom - cardH) / 2);
    var g = ctx.createLinearGradient(0, 0, m.W, m.H);
    g.addColorStop(0, dShade(m.pal.ink, -0.15));
    g.addColorStop(1, dShade(m.pal.primary, -0.42));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, u * 1.1);
    var cx = m.W / 2;
    var cy = y + cardH / 2;
    for (var r = u * 70; r < Math.max(m.W, m.H); r += u * 70) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = u * 34;
    ctx.shadowOffsetY = u * 14;
    rr(ctx, x, y, cardW, cardH, u * 14);
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.restore();
    return { x: x, y: y, w: cardW, h: cardH };
  }

  function docClone(m, w, h) {
    var out = {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
    out.W = w;
    out.H = h;
    out.radius = 0;
    return out;
  }

  /** 证件族统一入口：证件按真实长宽比摆在台面上，下方接认证信息与二维码。
   *  不把证件拉满画布 —— 把身份证拉成正方形就不像身份证了。 */
  function docStage(ctx, m, aspect, face) {
    var u = m.W / 1000;
    var r = m.H / m.W;
    var bottom = r >= 2 ? 0.3 : r >= 1.6 ? 0.27 : r >= 1.2 ? 0.26 : 0.2;
    var box = docMat(ctx, m, aspect, { bottom: m.H * bottom });
    ctx.save();
    ctx.translate(box.x, box.y);
    rr(ctx, 0, 0, box.w, box.h, 14 * (box.w / 1000));
    ctx.clip();
    face(ctx, docClone(m, box.w, box.h));
    ctx.restore();
    var pad = m.W * 0.07;
    var top = box.y + box.h + m.W * 0.05;
    var bottomPad = pad * 0.45;
    var avail = m.H - top - bottomPad;
    if (avail > 40 * u) {
      /* 长图（2.5:1）时给认证区加一圈细边框：否则中间那一大片留白会像漏渲染，
       * 加了框就变成「铭牌区」，留白是它的呼吸感而不是空缺。 */
      if (r >= 1.95) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = Math.max(1, 1.2 * u);
        rr(ctx, pad - 14 * u, top - 16 * u, m.W - (pad - 14 * u) * 2, avail + 30 * u, 18 * u);
        ctx.stroke();
        ctx.restore();
      }
      endorseStrip(ctx, m, pad, top, m.W - pad * 2, avail);
    }
    txt(ctx, m.form.cardLabel + " · " + m.form.issuer, m.W * 0.5, m.H - bottomPad * 0.28, {
      size: 10.5 * u,
      color: "rgba(255,255,255,0.38)",
      align: "center",
      maxW: m.W - pad * 2,
    });
  }

  /* ------------------------------------------------------------------ *
   * 1. 居民身份证
   * ------------------------------------------------------------------ */
  function docIdcardFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.058;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, dMix(pal.paper, pal.primary, 0.11));
    bg.addColorStop(0.5, pal.paper);
    bg.addColorStop(1, dMix(pal.paper, pal.accent, 0.11));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.primary, { alpha: 0.055, rx: 0.55, ry: 0.42 });
    docBorder(ctx, m, { alpha: 0.42, radius: 12 });

    /* 头部：国徽 + 双行标题 */
    var headH = H * 0.19;
    var emR = Math.min(headH * 0.3, W * 0.05);
    var emX = pad + emR;
    var emY = pad + headH * 0.45;
    ctx.save();
    ctx.fillStyle = dMix(pal.primary, "#ffffff", 0.04);
    ctx.beginPath();
    ctx.arc(emX, emY, emR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = dMix(pal.primary, "#ffffff", 0.35);
    ctx.lineWidth = Math.max(1, emR * 0.09);
    ctx.stroke();
    ctx.fillStyle = pal.accent;
    star(ctx, emX, emY, emR * 0.64, emR * 0.26, 5);
    ctx.restore();

    var tx = emX + emR + 13 * u;
    txt(ctx, "中华人民共和国", tx, emY - emR * 0.16, {
      size: 14 * u,
      color: pal.ink,
      spacing: 3 * u,
      maxW: W * 0.44,
    });
    txt(ctx, "居民身份证", tx, emY + emR * 0.86, {
      size: Math.min(32 * u, W * 0.062),
      weight: 800,
      color: pal.ink,
      spacing: 4 * u,
      maxW: W * 0.5,
    });
    txt(ctx, "RESIDENT IDENTITY CARD", W - pad, emY - emR * 0.1, {
      size: 8.5 * u,
      color: pal.muted,
      align: "right",
      spacing: 1.6 * u,
      maxW: W * 0.42,
    });
    txt(ctx, m.form.cardLabel, W - pad, emY + emR * 0.9, {
      size: 10.5 * u,
      color: dMix(pal.primary, pal.paper, 0.18),
      align: "right",
      maxW: W * 0.42,
    });

    var bodyTop = pad + headH;
    var footH = H * 0.2;
    var bodyH = H - bodyTop - footH - pad * 0.6;
    ctx.strokeStyle = dMix(pal.primary, pal.paper, 0.55);
    ctx.lineWidth = Math.max(0.8, 1.1 * u);
    ctx.beginPath();
    ctx.moveTo(pad, bodyTop + bodyH * 0.03);
    ctx.lineTo(W - pad, bodyTop + bodyH * 0.03);
    ctx.stroke();

    /* 照片在右（真身份证就是这个位置） */
    var phH = Math.min(bodyH * 0.94, H * 0.44);
    var phW = phH * 0.75;
    var phX = W - pad - phW;
    var phY = bodyTop + (bodyH - phH) / 2 + bodyH * 0.04;
    photoBox(ctx, m, phX, phY, phW, phH, 5 * u);

    var fx = pad + 2 * u;
    var fw = phX - fx - 18 * u;
    var labW = 88 * u;
    var valX = fx + labW;
    var valW = fx + fw - valX;
    var y = bodyTop + bodyH * 0.17;
    var rowGap = bodyH * 0.145;

    fLabel(ctx, "姓 名", fx, y, { size: 13 * u, maxW: labW, color: dMix(pal.primary, pal.ink, 0.35) });
    fValue(ctx, m.shared.name || "未填写姓名", valX, y + 1 * u, {
      size: Math.min(26 * u, valW / Math.max(3, (m.shared.name || "未填写姓名").length) * 1.6),
      color: pal.ink,
      maxW: valW,
    });
    y += rowGap;

    fLabel(ctx, "性 别", fx, y, { size: 13 * u, maxW: labW, color: dMix(pal.primary, pal.ink, 0.35) });
    fValue(ctx, dGender(m), valX, y + 1 * u, { size: 19 * u, color: pal.ink, maxW: 44 * u });
    var lvX = valX + valW * 0.42;
    fLabel(ctx, "等 级", lvX, y, {
      size: 13 * u,
      maxW: 56 * u,
      color: dMix(pal.primary, pal.ink, 0.35),
    });
    fValue(ctx, rankLabel(m), lvX + 56 * u, y + 1 * u, {
      size: 19 * u,
      color: pal.accent,
      maxW: valX + valW - (lvX + 56 * u),
    });
    y += rowGap;

    fLabel(ctx, "出 生", fx, y, { size: 13 * u, maxW: labW, color: dMix(pal.primary, pal.ink, 0.35) });
    fValue(ctx, dBirth(m), valX, y + 1 * u, { size: 19 * u, family: MONO, color: pal.ink, maxW: valW });
    y += rowGap;

    fLabel(ctx, "住 址", fx, y, { size: 13 * u, maxW: labW, color: dMix(pal.primary, pal.ink, 0.35) });
    var addr = wrap(ctx, m.form.issuer, valW, 15 * u, 600).slice(0, 2);
    for (var i = 0; i < addr.length; i++) {
      fValue(ctx, addr[i], valX, y + 1 * u + i * 19 * u, {
        size: 15 * u,
        weight: 600,
        color: pal.ink,
        maxW: valW,
      });
    }
    y += rowGap;

    fLabel(ctx, "公民身份号码", fx, y, {
      size: 12.5 * u,
      maxW: labW + 12 * u,
      color: dMix(pal.primary, pal.ink, 0.35),
    });
    fValue(ctx, dIdNo(m), valX + 6 * u, y + 1 * u, {
      size: Math.min(22 * u, valW / 10.4),
      family: MONO,
      color: pal.ink,
      maxW: valW,
    });

    /* 页脚：签发机关 / 有效期限 / 机读码 */
    var fy = bodyTop + bodyH;
    fLabel(ctx, "签发机关", pad, fy + 16 * u, { size: 11 * u, color: dMix(pal.primary, pal.ink, 0.35) });
    fValue(ctx, m.form.issuer, pad, fy + 36 * u, {
      size: 13.5 * u,
      weight: 700,
      color: pal.ink,
      maxW: (W - pad * 2) * 0.46,
    });
    fLabel(ctx, "有效期限", pad + (W - pad * 2) * 0.5, fy + 16 * u, {
      size: 11 * u,
      color: dMix(pal.primary, pal.ink, 0.35),
    });
    fValue(ctx, m.shared.issueDate + " — " + m.shared.validUntil, pad + (W - pad * 2) * 0.5, fy + 36 * u, {
      size: 13.5 * u,
      weight: 700,
      family: MONO,
      color: pal.ink,
      maxW: (W - pad * 2) * 0.5,
    });
    microPrint(
      ctx,
      pad,
      fy + 50 * u,
      (W - pad * 2) * 0.52,
      7 * u,
      "居民身份证 " + dIdNo(m) + " ",
      dMix(pal.primary, pal.paper, 0.3),
      0.4,
    );
    var qrSize = Math.min(footH * 0.78, W * 0.1);
    qr(
      ctx,
      m.qrText,
      W - pad - qrSize,
      fy + (footH - qrSize) / 2 - 2 * u,
      qrSize,
      pal.ink,
      "rgba(255,255,255,0.9)",
    );
    holoSeal(ctx, phX - 34 * u, phY - 4 * u, Math.min(22 * u, phW * 0.28));
  }

  function docIdcard(ctx, m) {
    docStage(ctx, m, 1.586, docIdcardFace);
  }

  /* ------------------------------------------------------------------ *
   * 2. 学生证
   * ------------------------------------------------------------------ */
  function docStudentFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.06;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.primary, { alpha: 0.05, rx: 0.3, ry: 0.6 });

    /* 顶部校色带 */
    var headH = Math.min(H * 0.22, W * 0.2);
    bandTop(ctx, m, headH);
    var emR = Math.min(headH * 0.3, W * 0.045);
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.arc(pad + emR, headH * 0.44, emR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = Math.max(1, emR * 0.1);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    star(ctx, pad + emR, headH * 0.44, emR * 0.62, emR * 0.24, 5);
    ctx.restore();
    txt(ctx, m.form.issuer, pad + emR * 2 + 12 * u, headH * 0.42, {
      size: Math.min(21 * u, W * 0.045),
      weight: 800,
      color: "#ffffff",
      maxW: W * 0.66,
    });
    txt(ctx, "学生证 · " + (m.form.subtitle || "STUDENT ID"), pad + emR * 2 + 12 * u, headH * 0.72, {
      size: 10.5 * u,
      color: "rgba(255,255,255,0.72)",
      spacing: 1.8 * u,
      maxW: W * 0.62,
    });
    txt(ctx, m.form.cardLabel, W - pad, headH * 0.5, {
      size: 11 * u,
      color: "rgba(255,255,255,0.85)",
      align: "right",
      maxW: W * 0.24,
    });

    var bodyTop = headH + pad * 0.6;
    var footH = Math.min(H * 0.24, W * 0.24);
    var bodyH = H - bodyTop - footH - pad * 0.5;

    var phH = Math.min(bodyH * 0.96, H * 0.46);
    var phW = phH * 0.75;
    var phX = pad;
    var phY = bodyTop + (bodyH - phH) / 2;
    photoBox(ctx, m, phX, phY, phW, phH, 4 * u);
    seal(ctx, phX + phW * 0.88, phY + phH * 0.9, Math.min(phW * 0.42, 52 * u), m.form.sealText, pal.primary, -0.32);

    var fx = phX + phW + 20 * u;
    var fw = W - pad - fx;
    var labW = 74 * u;
    var valX = fx + labW;
    var valW = fw - labW;
    var y = bodyTop + bodyH * 0.14;
    var gap = bodyH * 0.115;

    fLabel(ctx, "姓 名", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, m.shared.name || "未填写姓名", valX, y, { size: 22 * u, color: pal.ink, maxW: valW });
    y += gap;
    fLabel(ctx, "性 别", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, dGender(m), valX, y, { size: 17 * u, color: pal.ink, maxW: valW });
    y += gap;
    fLabel(ctx, "学 号", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, m.shared.no || "—", valX, y, { size: 17 * u, family: MONO, color: pal.ink, maxW: valW });
    y += gap;
    fLabel(ctx, "院 系", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, m.form.issuer, valX, y, { size: 15 * u, weight: 600, color: pal.ink, maxW: valW });
    y += gap;
    fLabel(ctx, "专 业", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, rankLabel(m), valX, y, { size: 17 * u, color: pal.accent, maxW: valW });
    y += gap;
    fLabel(ctx, "有效期至", fx, y, { size: 12.5 * u, maxW: labW });
    fValue(ctx, m.shared.validUntil, valX, y, { size: 15 * u, family: MONO, color: pal.ink, maxW: valW });

    /* 注册章 */
    var fy = H - footH;
    ctx.strokeStyle = dMix(pal.primary, pal.paper, 0.6);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.beginPath();
    ctx.moveTo(pad, fy);
    ctx.lineTo(W - pad, fy);
    ctx.stroke();
    fLabel(ctx, "注册记录 / REGISTERED", pad, fy + 18 * u, {
      size: 10 * u,
      spacing: 1.4 * u,
      color: pal.muted,
    });
    var sealR = Math.min(footH * 0.2, 26 * u);
    var sealY = fy + footH * 0.62;
    var labels = ["第一学年", "第二学年", "第三学年", "第四学年"];
    var stepX = Math.min((W - pad * 2) / 4, 190 * u);
    for (var i = 0; i < 4; i++) {
      var cx = pad + sealR + stepX * i;
      if (cx + sealR > W - pad - 60 * u) break;
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.strokeStyle = pal.primary;
      ctx.lineWidth = Math.max(1, sealR * 0.1);
      ctx.beginPath();
      ctx.arc(cx, sealY, sealR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = (sealR * 0.8) + "px " + FONT;
      ctx.fillStyle = pal.primary;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), cx, sealY + 1);
      ctx.restore();
      txt(ctx, labels[i], cx, sealY + sealR + 11 * u, {
        size: 8.5 * u,
        color: pal.muted,
        align: "center",
        maxW: stepX,
      });
    }
    var qrSize = Math.min(footH * 0.52, W * 0.08);
    qr(ctx, m.qrText, W - pad - qrSize, fy + (footH - qrSize) / 2, qrSize, pal.ink, "rgba(255,255,255,0.9)");

    /* 磁条 */
    ctx.fillStyle = dShade(pal.ink, -0.25);
    ctx.fillRect(0, H - 9 * u, W, 9 * u);
  }

  function docStudent(ctx, m) {
    docStage(ctx, m, 1.586, docStudentFace);
  }

  /* ------------------------------------------------------------------ *
   * 3. 工牌
   * ------------------------------------------------------------------ */
  function docWorkFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.07;
    var wide = W / H > 1.15;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.primary, { alpha: 0.04, rings: false, step: W * 0.025 });

    /* 挂绳孔 */
    var holeR = Math.min(W * 0.045, H * 0.045);
    var slotW = holeR * 2.6;
    var slotH = holeR * 0.72;
    ctx.save();
    /* 挂绳槽：一枚横椭圆，中间挖空（比圆孔更像真的工牌） */
    rr(ctx, W * 0.5 - slotW / 2, pad * 0.42, slotW, slotH, slotH / 2);
    ctx.fillStyle = dShade(pal.paper, -0.3);
    ctx.fill();
    ctx.strokeStyle = dShade(pal.paper, -0.5);
    ctx.lineWidth = Math.max(1, 1.4 * u);
    ctx.stroke();
    ctx.restore();

    var headTop = pad * 0.42 + slotH + pad * 0.34;
    var headH = Math.min(wide ? H * 0.2 : H * 0.18, W * 0.26);
    var g = ctx.createLinearGradient(0, headTop, W, headTop + headH);
    g.addColorStop(0, pal.primary);
    g.addColorStop(1, pal.primary2);
    ctx.fillStyle = g;
    ctx.fillRect(0, headTop, W, headH);
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#ffffff";
    for (var i = -2; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo((W * i) / 6, headTop + headH);
      ctx.lineTo((W * i) / 6 + headH * 0.6, headTop);
      ctx.lineTo((W * i) / 6 + headH * 0.6 + W * 0.04, headTop);
      ctx.lineTo((W * i) / 6 + W * 0.04, headTop + headH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    txt(ctx, m.form.issuer, W * 0.5, headTop + headH * 0.46, {
      size: Math.min(19 * u, W * 0.05),
      weight: 800,
      color: "#ffffff",
      align: "center",
      maxW: W - pad * 2,
    });
    txt(ctx, m.form.subtitle || "EMPLOYEE BADGE", W * 0.5, headTop + headH * 0.74, {
      size: 9.5 * u,
      color: "rgba(255,255,255,0.72)",
      align: "center",
      spacing: 2 * u,
      maxW: W - pad * 2,
    });

    var bodyTop = headTop + headH;
    var footH = Math.min(H * 0.2, W * 0.2);
    var bodyH = H - bodyTop - footH;

    if (wide) {
      var phH = Math.min(bodyH * 0.82, H * 0.36);
      var phW = phH * 0.75;
      var phX = pad;
      var phY = bodyTop + (bodyH - phH) / 2;
      photoBox(ctx, m, phX, phY, phW, phH, 8 * u);
      var ix = phX + phW + 22 * u;
      var iw = W - pad - ix;
      txt(ctx, m.shared.name || "未填写姓名", ix, phY + 26 * u, {
        size: Math.min(30 * u, iw / 4.2),
        weight: 800,
        color: pal.ink,
        maxW: iw,
      });
      txt(ctx, rankLabel(m), ix, phY + 54 * u, { size: 15 * u, weight: 700, color: pal.accent, maxW: iw });
      txt(ctx, "工号 " + (m.shared.no || "—"), ix, phY + 78 * u, {
        size: 13 * u,
        family: MONO,
        color: pal.muted,
        maxW: iw,
      });
      bar(ctx, ix, phY + 92 * u, iw * 0.8, 10 * u, m.pct, pal);
      txt(ctx, m.pct + "%", ix + iw * 0.8 + 8 * u, phY + 94 * u, { size: 12 * u, weight: 700, color: pal.ink });
    } else {
      var phH2 = Math.min(bodyH * 0.52, W * 0.62);
      var phW2 = Math.min(W - pad * 2, phH2 * 0.92);
      phH2 = phW2 / 0.92;
      var phX2 = (W - phW2) / 2;
      var phY2 = bodyTop + Math.max(6 * u, (bodyH * 0.5 - phH2) / 2);
      photoBox(ctx, m, phX2, phY2, phW2, phH2, Math.min(18 * u, phW2 * 0.08));
      var ny = phY2 + phH2 + Math.min(34 * u, bodyH * 0.1);
      txt(ctx, m.shared.name || "未填写姓名", W * 0.5, ny, {
        size: Math.min(32 * u, W * 0.075),
        weight: 800,
        color: pal.ink,
        align: "center",
        maxW: W - pad * 2,
      });
      txt(ctx, rankLabel(m), W * 0.5, ny + 26 * u, {
        size: 15 * u,
        weight: 700,
        color: pal.accent,
        align: "center",
        maxW: W - pad * 2,
      });
      txt(ctx, "工号 " + (m.shared.no || "—"), W * 0.5, ny + 48 * u, {
        size: 12.5 * u,
        family: MONO,
        color: pal.muted,
        align: "center",
        maxW: W - pad * 2,
      });
      var bw = Math.min(W - pad * 3, 320 * u);
      bar(ctx, (W - bw) / 2, ny + 60 * u, bw, 10 * u, m.pct, pal);
    }

    /* 页脚：条码 + 二维码 */
    var fy = H - footH;
    ctx.strokeStyle = dMix(pal.primary, pal.paper, 0.65);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.setLineDash([5 * u, 5 * u]);
    ctx.beginPath();
    ctx.moveTo(pad, fy);
    ctx.lineTo(W - pad, fy);
    ctx.stroke();
    ctx.setLineDash([]);
    var barcodeH = Math.min(footH * 0.32, 30 * u);
    var barcodeW = Math.min(W - pad * 2 - 70 * u, W * 0.52);
    barcode(ctx, pad, fy + footH * 0.24, barcodeW, barcodeH, m.shared.no || "0000", dShade(pal.ink, -0.1));
    txt(ctx, m.shared.no || "—", pad, fy + footH * 0.24 + barcodeH + 12 * u, {
      size: 9 * u,
      family: MONO,
      color: pal.muted,
      spacing: 2 * u,
      maxW: barcodeW,
    });
    var qrSize = Math.min(footH * 0.6, W * 0.11);
    qr(ctx, m.qrText, W - pad - qrSize, fy + (footH - qrSize) / 2, qrSize, pal.ink, "rgba(255,255,255,0.9)");
  }

  function docWorkBadge(ctx, m) {
    docStage(ctx, m, 0.66, docWorkFace);
  }

  /* ------------------------------------------------------------------ *
   * 4. 机动车驾驶证
   * ------------------------------------------------------------------ */
  function docDriverFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.055;
    var dark = dShade(pal.primary, -0.55);
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, dark);
    g.addColorStop(0.55, dShade(pal.primary, -0.32));
    g.addColorStop(1, dShade(pal.primary2, -0.45));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, "#ffffff", { alpha: 0.045, rx: 0.5, ry: 0.5 });
    docBorder(ctx, m, { color: pal.accent, alpha: 0.6, radius: 10, double: true });

    var headH = H * 0.2;
    txt(ctx, "中华人民共和国", pad, pad + headH * 0.3, {
      size: 13 * u,
      color: "rgba(255,255,255,0.75)",
      spacing: 3 * u,
      maxW: W * 0.5,
    });
    txt(ctx, "机动车驾驶证", pad, pad + headH * 0.72, {
      size: Math.min(29 * u, W * 0.058),
      weight: 800,
      color: "#ffffff",
      spacing: 4 * u,
      maxW: W * 0.62,
    });
    txt(ctx, "DRIVING LICENSE OF THE P.R.C.", W - pad, pad + headH * 0.3, {
      size: 8.5 * u,
      color: "rgba(255,255,255,0.55)",
      align: "right",
      spacing: 1.5 * u,
      maxW: W * 0.4,
    });
    txt(ctx, m.form.cardLabel, W - pad, pad + headH * 0.74, {
      size: 11 * u,
      color: pal.accent,
      align: "right",
      maxW: W * 0.4,
    });

    var bodyTop = pad + headH;
    var footH = H * 0.17;
    var bodyH = H - bodyTop - footH - pad * 0.4;
    var phH = Math.min(bodyH * 0.9, H * 0.4);
    var phW = phH * 0.75;
    var phX = W - pad - phW;
    var phY = bodyTop + (bodyH - phH) / 2;
    photoBox(ctx, m, phX, phY, phW, phH, 4 * u);

    var fx = pad;
    var fw = phX - fx - 18 * u;
    var labW = 82 * u;
    var valX = fx + labW;
    var valW = fw - labW;
    var y = bodyTop + bodyH * 0.16;
    var gap = bodyH * 0.15;
    var labCol = "rgba(255,255,255,0.55)";
    var valCol = "#ffffff";

    fLabel(ctx, "证 号", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    fValue(ctx, m.shared.no || "—", valX, y, { size: 16 * u, family: MONO, color: valCol, maxW: valW });
    y += gap;
    fLabel(ctx, "姓 名", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    fValue(ctx, m.shared.name || "未填写姓名", valX, y, { size: 21 * u, color: valCol, maxW: valW * 0.55 });
    fLabel(ctx, "性 别", valX + valW * 0.6, y, { size: 12 * u, maxW: labW * 0.6, color: labCol });
    fValue(ctx, dGender(m), valX + valW * 0.6 + labW * 0.6, y, { size: 17 * u, color: valCol });
    y += gap;
    fLabel(ctx, "国 籍", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    fValue(ctx, "中国 (CHN)", valX, y, { size: 16 * u, color: valCol, maxW: valW });
    y += gap;
    fLabel(ctx, "住 址", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    var addr = wrap(ctx, m.form.issuer, valW, 13 * u, 600).slice(0, 2);
    for (var i = 0; i < addr.length; i++) {
      fValue(ctx, addr[i], valX, y + i * 16 * u, { size: 13 * u, weight: 600, color: valCol, maxW: valW });
    }
    y += gap;
    fLabel(ctx, "出生日期", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    fValue(ctx, dBirth(m), valX, y, { size: 16 * u, family: MONO, color: valCol, maxW: valW });
    y += gap;
    fLabel(ctx, "准驾车型", fx, y, { size: 12 * u, maxW: labW, color: labCol });
    fValue(ctx, rankLabel(m), valX, y, { size: 17 * u, color: pal.accent, maxW: valW });

    var fy = bodyTop + bodyH;
    fLabel(ctx, "初次领证", pad, fy + 14 * u, { size: 10.5 * u, color: labCol });
    fValue(ctx, m.shared.issueDate, pad, fy + 32 * u, {
      size: 13 * u,
      family: MONO,
      color: valCol,
      maxW: (W - pad * 2) * 0.3,
    });
    fLabel(ctx, "有效期限", pad + (W - pad * 2) * 0.34, fy + 14 * u, { size: 10.5 * u, color: labCol });
    fValue(ctx, m.shared.validUntil, pad + (W - pad * 2) * 0.34, fy + 32 * u, {
      size: 13 * u,
      family: MONO,
      color: valCol,
      maxW: (W - pad * 2) * 0.32,
    });
    microPrint(
      ctx,
      pad,
      fy + 42 * u,
      (W - pad * 2) * 0.5,
      7 * u,
      "DRIVING LICENSE " + dIdNo(m) + " ",
      "rgba(255,255,255,0.75)",
      0.3,
    );
    var qrSize = Math.min(footH * 0.72, W * 0.09);
    qr(ctx, m.qrText, W - pad - qrSize, fy + (footH - qrSize) / 2, qrSize, "rgba(255,255,255,0.95)", "rgba(255,255,255,0.1)");
    seal(ctx, phX + phW * 0.5, phY + phH * 0.52, Math.min(phW * 0.6, 60 * u), m.form.sealText, pal.accent, -0.3);
  }

  function docDriver(ctx, m) {
    docStage(ctx, m, 1.586, docDriverFace);
  }

  /* ------------------------------------------------------------------ *
   * 5. 结婚证
   * ------------------------------------------------------------------ */
  function docMarriageFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.06;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.accent, { alpha: 0.05, rx: 0.5, ry: 0.5 });

    /* 囍 水印 */
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = dShade(pal.accent, -0.1);
    font(ctx, Math.min(W * 0.3, H * 0.34), 800, SERIF);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("囍", W * 0.5, H * 0.5);
    ctx.restore();

    docBorder(ctx, m, { color: dShade(pal.accent, -0.1), alpha: 0.75, radius: 6, double: true });

    var headH = H * 0.24;
    txt(ctx, "结婚证", W * 0.5, pad + headH * 0.52, {
      size: Math.min(46 * u, W * 0.1),
      weight: 800,
      family: SERIF,
      color: dShade(pal.accent, -0.28),
      align: "center",
      spacing: 8 * u,
      maxW: W * 0.7,
    });
    txt(ctx, "MARRIAGE CERTIFICATE", W * 0.5, pad + headH * 0.8, {
      size: 9.5 * u,
      color: pal.muted,
      align: "center",
      spacing: 3 * u,
      maxW: W * 0.6,
    });
    txt(ctx, m.form.cardLabel, W * 0.5, pad + headH * 0.94, {
      size: 10.5 * u,
      color: dMix(pal.accent, pal.ink, 0.3),
      align: "center",
      maxW: W * 0.6,
    });

    var bodyTop = pad + headH;
    var footH = H * 0.22;
    var bodyH = H - bodyTop - footH - pad * 0.2;
    var list = photoList(m);
    var twoUp = list.length >= 2 && m.photoMode !== "single";

    if (twoUp) {
      var gap = 8 * u;
      var phW = (W * 0.38 - gap) / 2;
      var phH = Math.min(bodyH * 0.96, phW * 1.28);
      var phY = bodyTop + (bodyH - phH) / 2;
      var startX = W * 0.06;
      cover(ctx, list[0], startX, phY, phW, phH, 6 * u);
      cover(ctx, list[1], startX + phW + gap, phY, phW, phH, 6 * u);
      ctx.strokeStyle = dMix(pal.accent, pal.paper, 0.45);
      ctx.lineWidth = Math.max(1, 1.4 * u);
      rr(ctx, startX, phY, phW, phH, 6 * u);
      ctx.stroke();
      rr(ctx, startX + phW + gap, phY, phW, phH, 6 * u);
      ctx.stroke();
    } else {
      var phH1 = Math.min(bodyH * 0.94, H * 0.4);
      var phW1 = phH1 * 0.78;
      var phY1 = bodyTop + (bodyH - phH1) / 2;
      photoBox(ctx, m, W * 0.075, phY1, phW1, phH1, 6 * u);
    }

    var fx = twoUp ? W * 0.48 : W * 0.075 + phH1 * 0.78 + 22 * u;
    var fw = W - pad - fx;
    var y = bodyTop + bodyH * 0.2;
    var gap2 = bodyH * 0.19;

    fLabel(ctx, "持证人", fx, y, { size: 12 * u, maxW: fw * 0.4, color: pal.muted });
    fValue(ctx, m.shared.name || "未填写姓名", fx, y + 22 * u, {
      size: Math.min(24 * u, fw / 5),
      color: pal.ink,
      maxW: fw,
    });
    y += gap2;
    fLabel(ctx, "等 级", fx, y, { size: 12 * u, maxW: fw * 0.4, color: pal.muted });
    fValue(ctx, rankLabel(m), fx, y + 22 * u, { size: 18 * u, color: dShade(pal.accent, -0.2), maxW: fw });
    y += gap2;
    fLabel(ctx, "结婚证字号", fx, y, { size: 12 * u, maxW: fw * 0.4, color: pal.muted });
    fValue(ctx, m.shared.no || "—", fx, y + 22 * u, {
      size: 15 * u,
      family: MONO,
      color: pal.ink,
      maxW: fw,
    });

    var fy = bodyTop + bodyH;
    fLabel(ctx, "登记日期", pad, fy + 14 * u, { size: 10.5 * u, color: pal.muted });
    fValue(ctx, m.shared.issueDate, pad, fy + 33 * u, {
      size: 13 * u,
      family: MONO,
      color: pal.ink,
      maxW: (W - pad * 2) * 0.3,
    });
    fLabel(ctx, "登记机关", pad + (W - pad * 2) * 0.36, fy + 14 * u, { size: 10.5 * u, color: pal.muted });
    fValue(ctx, m.form.issuer, pad + (W - pad * 2) * 0.36, fy + 33 * u, {
      size: 13 * u,
      weight: 700,
      color: pal.ink,
      maxW: (W - pad * 2) * 0.4,
    });
    seal(
      ctx,
      W - pad - Math.min(footH * 0.34, W * 0.09),
      fy + footH * 0.52,
      Math.min(footH * 0.34, W * 0.09),
      m.form.sealText,
      dShade(pal.accent, -0.3),
      -0.24,
    );
  }

  function docMarriage(ctx, m) {
    docStage(ctx, m, 1.586, docMarriageFace);
  }

  /* ------------------------------------------------------------------ *
   * 6. 就诊卡
   * ------------------------------------------------------------------ */
  function docMedicalFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.058;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, dMix("#ffffff", pal.primary, 0.1));
    g.addColorStop(1, "#ffffff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.primary, { alpha: 0.04, rx: 0.75, ry: 0.3 });

    /* 磁条 */
    ctx.fillStyle = dShade(pal.ink, -0.3);
    ctx.fillRect(0, 0, W, H * 0.055);

    /* 十字标 + 医院名 */
    var chX = pad + 18 * u;
    var chY = H * 0.16;
    var chS = 15 * u;
    ctx.save();
    ctx.fillStyle = pal.primary;
    rr(ctx, chX - chS / 2, chY - chS / 2, chS, chS, 3 * u);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(chX - chS * 0.11, chY - chS * 0.34, chS * 0.22, chS * 0.68);
    ctx.fillRect(chX - chS * 0.34, chY - chS * 0.11, chS * 0.68, chS * 0.22);
    ctx.restore();
    txt(ctx, m.form.issuer, chX + chS * 0.9, chY - 2 * u, {
      size: Math.min(19 * u, W * 0.045),
      weight: 800,
      color: pal.ink,
      maxW: W * 0.58,
    });
    txt(ctx, "就诊卡 · " + (m.form.subtitle || "PATIENT CARD"), chX + chS * 0.9, chY + 20 * u, {
      size: 10 * u,
      color: pal.muted,
      spacing: 1.6 * u,
      maxW: W * 0.58,
    });
    txt(ctx, m.form.cardLabel, W - pad, chY, {
      size: 11 * u,
      color: dMix(pal.primary, pal.ink, 0.25),
      align: "right",
      maxW: W * 0.3,
    });

    var bodyTop = H * 0.3;
    var footH = H * 0.2;
    var bodyH = H - bodyTop - footH;
    var fx = pad;
    var fw = (W - pad * 2) * 0.56;
    var labW = 66 * u;
    var y = bodyTop + bodyH * 0.16;
    var gap = bodyH * 0.2;

    fLabel(ctx, "卡 号", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.shared.no || "—", fx + labW, y, { size: 15 * u, family: MONO, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "姓 名", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.shared.name || "未填写姓名", fx + labW, y, { size: 21 * u, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "性 别", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, dGender(m), fx + labW, y, { size: 16 * u, color: pal.ink, maxW: fw * 0.3 });
    fLabel(ctx, "科 室", fx + fw * 0.42, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, rankLabel(m), fx + fw * 0.42 + labW, y, { size: 16 * u, color: pal.accent, maxW: fw * 0.5 });
    y += gap;
    fLabel(ctx, "有效期至", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.shared.validUntil, fx + labW, y, { size: 14 * u, family: MONO, color: pal.ink, maxW: fw - labW });

    /* 右侧：条形码 + 二维码 */
    var bx = W * 0.62;
    var bw = W - pad - bx;
    barcode(ctx, bx, bodyTop + bodyH * 0.24, bw, Math.min(bodyH * 0.22, 28 * u), m.shared.no || "0000", dShade(pal.ink, -0.1));
    txt(ctx, m.shared.no || "—", bx + bw / 2, bodyTop + bodyH * 0.24 + Math.min(bodyH * 0.22, 28 * u) + 13 * u, {
      size: 8.5 * u,
      family: MONO,
      color: pal.muted,
      align: "center",
      spacing: 1.6 * u,
      maxW: bw,
    });
    var qrSize = Math.min(bodyH * 0.4, bw * 0.8);
    qr(ctx, m.qrText, bx + (bw - qrSize) / 2, bodyTop + bodyH * 0.55, qrSize, pal.ink, "rgba(255,255,255,0.9)");

    /* 页脚提示 */
    var fy = H - footH;
    ctx.fillStyle = dMix(pal.primary, "#ffffff", 0.9);
    ctx.fillRect(0, fy, W, footH);
    ctx.strokeStyle = dMix(pal.primary, "#ffffff", 0.7);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.beginPath();
    ctx.moveTo(0, fy);
    ctx.lineTo(W, fy);
    ctx.stroke();
    txt(ctx, "就诊时请出示此卡 · 本卡仅限本人使用", pad, fy + footH * 0.36, {
      size: 11 * u,
      color: dMix(pal.ink, pal.muted, 0.4),
      maxW: W * 0.62,
    });
    txt(ctx, "发卡：" + m.shared.issueDate, pad, fy + footH * 0.68, {
      size: 10 * u,
      color: pal.muted,
      maxW: W * 0.6,
    });
    bar(ctx, W - pad - W * 0.24, fy + footH * 0.42, W * 0.24, 9 * u, m.pct, pal);
  }

  function docMedical(ctx, m) {
    docStage(ctx, m, 1.586, docMedicalFace);
  }

  /* ------------------------------------------------------------------ *
   * 7. 会员卡 / 黑金卡
   * ------------------------------------------------------------------ */
  function docMemberFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.07;
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#141821");
    g.addColorStop(0.45, "#1f2531");
    g.addColorStop(1, "#0e1118");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, pal.accent, { alpha: 0.05, rx: 0.3, ry: 0.7 });

    /* 金色描边 + 角饰 */
    docBorder(ctx, m, { color: pal.accent, alpha: 0.5, radius: 12 });
    ctx.save();
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, 1.6 * u);
    var arm = 22 * u;
    var corners = [
      [pad * 0.7, pad * 0.7, 1, 1],
      [W - pad * 0.7, pad * 0.7, -1, 1],
      [pad * 0.7, H - pad * 0.7, 1, -1],
      [W - pad * 0.7, H - pad * 0.7, -1, -1],
    ];
    corners.forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0] + arm * c[2], c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + arm * c[3]);
      ctx.stroke();
    });
    ctx.restore();

    var g2 = ctx.createLinearGradient(pad, 0, W * 0.55, 0);
    g2.addColorStop(0, "#f8e7b4");
    g2.addColorStop(0.5, pal.accent);
    g2.addColorStop(1, "#c79a3f");
    txt(ctx, "BLACK", pad, pad + 22 * u, {
      size: 15 * u,
      weight: 800,
      color: g2,
      spacing: 4 * u,
      maxW: W * 0.4,
    });
    txt(ctx, m.form.issuer, pad, pad + 44 * u, {
      size: 11.5 * u,
      color: "rgba(255,255,255,0.62)",
      maxW: W * 0.5,
    });
    txt(ctx, rankLabel(m), W - pad, pad + 24 * u, {
      size: 16 * u,
      weight: 800,
      color: pal.accent,
      align: "right",
      spacing: 1.5 * u,
      maxW: W * 0.34,
    });
    txt(ctx, m.form.subtitle || "MEMBERSHIP CARD", W - pad, pad + 46 * u, {
      size: 8.5 * u,
      color: "rgba(255,255,255,0.4)",
      align: "right",
      spacing: 1.6 * u,
      maxW: W * 0.34,
    });

    /* 芯片 */
    var chipW = Math.min(W * 0.11, 78 * u);
    var chipH = chipW * 0.76;
    var chipY = H * 0.4;
    chipGold(ctx, pad, chipY, chipW, chipH);
    /* NFC 波纹 */
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.lineWidth = Math.max(1, 1.6 * u);
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(pad + chipW * 0.35, chipY + chipH * 0.5, chipW * (0.5 + i * 0.22), -0.9, 0.9);
      ctx.stroke();
      ctx.save();
      ctx.restore();
    }
    ctx.restore();

    /* 卡号 */
    var seg = dDigits(m.shared.no, 16).replace(/(\d{4})(?=\d)/g, "$1 ");
    txt(ctx, seg, pad, H * 0.66, {
      size: Math.min(26 * u, W * 0.045),
      weight: 600,
      family: MONO,
      color: "#f4f6fb",
      spacing: 3 * u,
      maxW: W - pad * 2,
    });

    fLabel(ctx, "持卡人 / CARDHOLDER", pad, H * 0.79, {
      size: 8.5 * u,
      color: "rgba(255,255,255,0.42)",
      spacing: 1.4 * u,
      maxW: W * 0.4,
    });
    txt(ctx, (m.shared.name || "未填写姓名").toUpperCase(), pad, H * 0.89, {
      size: Math.min(19 * u, W * 0.035),
      weight: 700,
      color: "#ffffff",
      spacing: 1.5 * u,
      maxW: W * 0.5,
    });
    fLabel(ctx, "VALID THRU", W * 0.62, H * 0.79, {
      size: 8.5 * u,
      color: "rgba(255,255,255,0.42)",
      spacing: 1.4 * u,
      maxW: W * 0.2,
    });
    txt(ctx, m.shared.validUntil, W * 0.62, H * 0.89, {
      size: 14 * u,
      weight: 600,
      family: MONO,
      color: "#ffffff",
      maxW: W * 0.2,
    });
    txt(ctx, "积分 " + Math.round(m.pct * 128), W - pad, H * 0.89, {
      size: 13 * u,
      weight: 700,
      color: pal.accent,
      align: "right",
      maxW: W * 0.22,
    });
    holoSeal(ctx, W - pad - 20 * u, H * 0.4 + chipH * 0.4, Math.min(24 * u, W * 0.05));
  }

  function docMember(ctx, m) {
    docStage(ctx, m, 1.586, docMemberFace);
  }

  /* ------------------------------------------------------------------ *
   * 8. 准考证
   * ------------------------------------------------------------------ */
  function docAdmitFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.07;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    docBorder(ctx, m, { alpha: 0.7, radius: 4, double: true });

    var headH = H * 0.19;
    txt(ctx, m.form.issuer, W * 0.5, pad + headH * 0.2, {
      size: 12 * u,
      color: pal.muted,
      align: "center",
      spacing: 1.6 * u,
      maxW: W - pad * 2,
    });
    txt(ctx, "准 考 证", W * 0.5, pad + headH * 0.56, {
      size: Math.min(38 * u, W * 0.08),
      weight: 800,
      color: pal.ink,
      align: "center",
      spacing: 8 * u,
      maxW: W - pad * 2,
    });
    txt(ctx, m.form.cardLabel, W * 0.5, pad + headH * 0.8, {
      size: 12 * u,
      color: dMix(pal.primary, pal.ink, 0.2),
      align: "center",
      maxW: W - pad * 2,
    });
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = Math.max(1.6, 3 * u);
    ctx.beginPath();
    ctx.moveTo(pad, pad + headH * 0.9);
    ctx.lineTo(W - pad, pad + headH * 0.9);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.beginPath();
    ctx.moveTo(pad, pad + headH * 0.9 + 5 * u);
    ctx.lineTo(W - pad, pad + headH * 0.9 + 5 * u);
    ctx.stroke();

    var bodyTop = pad + headH * 0.9 + 18 * u;
    var footH = Math.min(H * 0.26, W * 0.3);
    var bodyH = H - bodyTop - footH - pad;

    var phH = Math.min(bodyH * 0.66, H * 0.32);
    var phW = phH * 0.75;
    var phX = W - pad - phW;
    var phY = bodyTop + 6 * u;
    photoBox(ctx, m, phX, phY, phW, phH, 3 * u);
    txt(ctx, "（近期免冠照片）", phX + phW / 2, phY + phH + 12 * u, {
      size: 8.5 * u,
      color: pal.muted,
      align: "center",
      maxW: phW,
    });

    var fx = pad;
    var fw = phX - fx - 30 * u;
    var labW = 70 * u;
    var y = bodyTop + bodyH * 0.14;
    var gap = bodyH * 0.14;

    fLabel(ctx, "考生号", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.shared.no || "—", fx + labW, y, { size: 15 * u, family: MONO, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "姓 名", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.shared.name || "未填写姓名", fx + labW, y, { size: 20 * u, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "性 别", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, dGender(m), fx + labW, y, { size: 15 * u, color: pal.ink, maxW: fw * 0.3 });
    fLabel(ctx, "报考等级", fx + fw * 0.4, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, rankLabel(m), fx + fw * 0.4 + labW, y, { size: 15 * u, color: pal.accent, maxW: fw * 0.55 });
    y += gap;
    fLabel(ctx, "考 点", fx, y, { size: 11.5 * u, maxW: labW });
    fValue(ctx, m.form.issuer, fx + labW, y, { size: 13 * u, weight: 600, color: pal.ink, maxW: fw - labW });

    /* 考场 / 座位 / 时间 */
    var h0 = hash(String(m.shared.no || "") + String(m.shared.name || "")) >>> 0;
    var cells = [
      ["考 场", "第 " + (1 + (h0 % 40)) + " 考场"],
      ["座 位", String(1 + ((h0 >>> 6) % 30)) + " 号"],
      ["考试日期", m.shared.issueDate],
    ];
    var boxTop = bodyTop + bodyH * 0.78;
    var boxH = Math.min(bodyH * 0.24, 70 * u);
    var cellW = (W - pad * 2) / 3;
    ctx.save();
    ctx.strokeStyle = dMix(pal.ink, "#ffffff", 0.55);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    for (var i = 0; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(pad + cellW * i, boxTop);
      ctx.lineTo(pad + cellW * i, boxTop + boxH);
      ctx.stroke();
    }
    ctx.strokeRect(pad, boxTop, cellW * 3, boxH);
    ctx.restore();
    for (var j = 0; j < 3; j++) {
      fLabel(ctx, cells[j][0], pad + cellW * j + 10 * u, boxTop + boxH * 0.34, { size: 9.5 * u, maxW: cellW - 16 * u });
      txt(ctx, cells[j][1], pad + cellW * j + 10 * u, boxTop + boxH * 0.74, {
        size: Math.min(15 * u, cellW / 7),
        weight: 700,
        family: j === 2 ? MONO : FONT,
        color: pal.ink,
        maxW: cellW - 16 * u,
      });
    }

    /* 页脚：条码 + 须知 */
    var fy = H - footH;
    ctx.strokeStyle = dMix(pal.ink, "#ffffff", 0.55);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.setLineDash([4 * u, 4 * u]);
    ctx.beginPath();
    ctx.moveTo(pad, fy);
    ctx.lineTo(W - pad, fy);
    ctx.stroke();
    ctx.setLineDash([]);
    var bw = Math.min(W * 0.42, W - pad * 2 - 80 * u);
    barcode(ctx, pad, fy + footH * 0.18, bw, Math.min(footH * 0.26, 26 * u), m.shared.no || "0000", pal.ink);
    txt(ctx, m.shared.no || "—", pad, fy + footH * 0.18 + Math.min(footH * 0.26, 26 * u) + 12 * u, {
      size: 8.5 * u,
      family: MONO,
      color: pal.muted,
      spacing: 2 * u,
      maxW: bw,
    });
    fLabel(ctx, "考生须知", pad + bw + 18 * u, fy + footH * 0.26, { size: 9.5 * u, maxW: W * 0.3 });
    var notes = ["1. 凭本证与有效身份证件入场", "2. 开考 15 分钟后不得入场", "3. 禁止携带电子设备", "4. 本证为趣味生成，不作为凭证"];
    for (var k = 0; k < notes.length; k++) {
      txt(ctx, notes[k], pad + bw + 18 * u, fy + footH * 0.26 + 16 * u + k * 13 * u, {
        size: 8 * u,
        color: pal.muted,
        maxW: W - (pad + bw + 18 * u) - pad,
      });
    }
  }

  function docAdmit(ctx, m) {
    docStage(ctx, m, 0.72, docAdmitFace);
  }

  /* ------------------------------------------------------------------ *
   * 9. 宠物登记证
   * ------------------------------------------------------------------ */
  function docPetFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.06;
    ctx.fillStyle = dMix("#f6efe0", pal.paper, 0.45);
    ctx.fillRect(0, 0, W, H);
    noise(ctx, 0, 0, W, H, 260, "#8a6a3a", 0.06);
    pawPrint(ctx, W * 0.86, H * 0.78, W * 0.09, dShade(pal.ink, 0.2), 0.07);
    pawPrint(ctx, W * 0.1, H * 0.16, W * 0.06, dShade(pal.ink, 0.2), 0.06);
    docBorder(ctx, m, { color: dShade(pal.accent, -0.2), alpha: 0.6, radius: 8, double: true });

    var headH = H * 0.22;
    txt(ctx, "养犬登记证", pad, pad + headH * 0.44, {
      size: Math.min(32 * u, W * 0.062),
      weight: 800,
      family: SERIF,
      color: dShade(pal.ink, -0.05),
      spacing: 4 * u,
      maxW: W * 0.6,
    });
    txt(ctx, "PET LICENSE · " + (m.form.subtitle || ""), pad, pad + headH * 0.72, {
      size: 9.5 * u,
      color: pal.muted,
      spacing: 1.8 * u,
      maxW: W * 0.6,
    });
    txt(ctx, m.form.cardLabel, W - pad, pad + headH * 0.46, {
      size: 12 * u,
      color: dShade(pal.accent, -0.25),
      align: "right",
      maxW: W * 0.32,
    });
    txt(ctx, m.form.issuer, W - pad, pad + headH * 0.72, {
      size: 10 * u,
      color: pal.muted,
      align: "right",
      maxW: W * 0.34,
    });

    var bodyTop = pad + headH;
    var footH = H * 0.2;
    var bodyH = H - bodyTop - footH;
    var phH = Math.min(bodyH * 0.95, H * 0.42);
    var phW = phH * 0.82;
    var phX = pad;
    var phY = bodyTop + (bodyH - phH) / 2;
    photoBox(ctx, m, phX, phY, phW, phH, 8 * u);
    seal(ctx, phX + phW * 0.5, phY + phH * 0.55, Math.min(phW * 0.5, 54 * u), m.form.sealText, dShade(pal.accent, -0.2), -0.3);

    var fx = phX + phW + 22 * u;
    var fw = W - pad - fx;
    var labW = 70 * u;
    var y = bodyTop + bodyH * 0.16;
    var gap = bodyH * 0.15;

    fLabel(ctx, "犬牌号", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.shared.no || "—", fx + labW, y, { size: 15 * u, family: MONO, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "犬 名", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.shared.name || "未填写名字", fx + labW, y, { size: 20 * u, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "品 种", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, rankLabel(m), fx + labW, y, { size: 16 * u, color: dShade(pal.accent, -0.2), maxW: fw - labW });
    y += gap;
    fLabel(ctx, "性 别", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.gender === "m" ? "公" : "母", fx + labW, y, { size: 15 * u, color: pal.ink, maxW: fw * 0.3 });
    fLabel(ctx, "免疫", fx + fw * 0.42, y, { size: 11 * u, maxW: labW * 0.6 });
    fValue(ctx, "已接种", fx + fw * 0.42 + labW * 0.6, y, {
      size: 15 * u,
      color: dMix(pal.primary, pal.ink, 0.1),
      maxW: fw * 0.5,
    });
    y += gap;
    fLabel(ctx, "监护人", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.form.issuer, fx + labW, y, { size: 12.5 * u, weight: 600, color: pal.ink, maxW: fw - labW });

    var fy = bodyTop + bodyH;
    fLabel(ctx, "签发日期", pad, fy + 14 * u, { size: 10 * u });
    fValue(ctx, m.shared.issueDate, pad, fy + 33 * u, { size: 13 * u, family: MONO, color: pal.ink, maxW: W * 0.28 });
    fLabel(ctx, "有效期至", pad + W * 0.32, fy + 14 * u, { size: 10 * u });
    fValue(ctx, m.shared.validUntil, pad + W * 0.32, fy + 33 * u, {
      size: 13 * u,
      family: MONO,
      color: pal.ink,
      maxW: W * 0.28,
    });
    var qrSize = Math.min(footH * 0.62, W * 0.075);
    qr(ctx, m.qrText, W - pad - qrSize, fy + (footH - qrSize) / 2, qrSize, pal.ink, "rgba(255,255,255,0.9)");
  }

  function docPet(ctx, m) {
    docStage(ctx, m, 1.586, docPetFace);
  }

  /* ------------------------------------------------------------------ *
   * 10. 荣誉证书
   * ------------------------------------------------------------------ */
  function docHonorFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.07;
    ctx.fillStyle = "#fdfbf6";
    ctx.fillRect(0, 0, W, H);
    guilloche(ctx, 0, 0, W, H, dShade(pal.accent, -0.1), { alpha: 0.04, rx: 0.5, ry: 0.5 });

    /* 红金双线 + 角花 */
    ctx.save();
    ctx.strokeStyle = dShade(pal.accent, -0.15);
    ctx.lineWidth = Math.max(2, 4 * u);
    rr(ctx, pad * 0.5, pad * 0.5, W - pad, H - pad, 4 * u);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.4 * u);
    var inset = pad * 0.5 + 9 * u;
    rr(ctx, inset, inset, W - inset * 2, H - inset * 2, 3 * u);
    ctx.stroke();
    ctx.fillStyle = dShade(pal.accent, -0.05);
    ctx.globalAlpha = 0.85;
    var cn = [
      [inset, inset, 1, 1],
      [W - inset, inset, -1, 1],
      [inset, H - inset, 1, -1],
      [W - inset, H - inset, -1, -1],
    ];
    var arm = 30 * u;
    cn.forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0] + arm * c[2], c[1]);
      ctx.lineTo(c[0] + arm * c[2], c[1] + 6 * u * c[3]);
      ctx.lineTo(c[0] + 6 * u * c[2], c[1] + 6 * u * c[3]);
      ctx.lineTo(c[0], c[1] + arm * c[3]);
      ctx.stroke();
    });
    ctx.restore();

    var headH = H * 0.26;
    txt(ctx, "荣 誉 证 书", W * 0.5, pad + headH * 0.52, {
      size: Math.min(52 * u, W * 0.11),
      weight: 800,
      family: SERIF,
      color: dShade(pal.accent, -0.35),
      align: "center",
      spacing: 10 * u,
      maxW: W * 0.8,
    });
    txt(ctx, "CERTIFICATE OF HONOR", W * 0.5, pad + headH * 0.74, {
      size: 9.5 * u,
      color: pal.muted,
      align: "center",
      spacing: 3 * u,
      maxW: W * 0.6,
    });
    ctx.strokeStyle = dShade(pal.accent, -0.1);
    ctx.lineWidth = Math.max(1, 1.4 * u);
    ctx.beginPath();
    ctx.moveTo(W * 0.32, pad + headH * 0.84);
    ctx.lineTo(W * 0.68, pad + headH * 0.84);
    ctx.stroke();

    /* 正文 */
    var bodyTop = pad + headH * 0.92;
    var bodyH = H * 0.44;
    var fs = Math.min(17 * u, W * 0.032);
    var lineH = fs * 1.9;
    var text =
      "兹证明 " +
      (m.shared.name || "（未填写姓名）") +
      " 在「" +
      m.form.cardLabel +
      "」认证中累计通过 " +
      m.tags.length +
      " 项认证项目，达成 " +
      m.pct +
      "% 的认证强度，获评「" +
      rankLabel(m) +
      "」。特发此证，以资鼓励。";
    var lines = wrap(ctx, text, W - pad * 3, fs, 500).slice(0, 4);
    var ty = bodyTop + (bodyH - lines.length * lineH) / 2 + fs;
    for (var i = 0; i < lines.length; i++) {
      txt(ctx, lines[i], W * 0.5, ty + i * lineH, {
        size: fs,
        weight: 500,
        family: SERIF,
        color: pal.ink,
        align: "center",
        maxW: W - pad * 3,
      });
    }

    /* 落款 + 印章 */
    var fy = H - pad * 1.6;
    txt(ctx, m.form.issuer, W * 0.62, fy - 26 * u, {
      size: Math.min(14 * u, W * 0.028),
      weight: 700,
      color: pal.ink,
      align: "center",
      maxW: W * 0.4,
    });
    txt(ctx, m.shared.issueDate, W * 0.62, fy, {
      size: 12 * u,
      family: MONO,
      color: pal.muted,
      align: "center",
      maxW: W * 0.34,
    });
    seal(ctx, W * 0.8, fy - 22 * u, Math.min(H * 0.09, W * 0.075), m.form.sealText, dShade(pal.accent, -0.3), -0.2);

    /* 认证项目：左下角贴底，与右下角落款分列，不压行 */
    if (m.tags.length) {
      var blk = chipOpts(ctx, m.tags, W * 0.46, H * 0.14, u);
      var bh = chipsHeight(blk.lines, blk.o);
      chipsDraw(ctx, blk.lines, blk.o, pad * 1.15, H - pad * 1.05 - bh, W * 0.46, false, pal);
    }
    var qrSize = Math.min(H * 0.11, W * 0.062);
    qr(ctx, m.qrText, W - pad * 1.15 - qrSize, pad * 1.15, qrSize, pal.ink, "rgba(255,255,255,0.9)");
  }

  function docHonor(ctx, m) {
    docStage(ctx, m, 1.414, docHonorFace);
  }

  /* ------------------------------------------------------------------ *
   * 11–13. 成人向证件（18+ 门禁后才出现在选择器里）
   *
   * 和成人向词库同一套规矩：不确认就不出现，也不出现在初始 HTML 里。
   * 卡面本身只是「证件外壳」，露骨内容全部来自用户自己勾选的词条 ——
   * 这样卡是卡、词是词，导出物由用户自己决定写到什么程度。
   * ------------------------------------------------------------------ */

  /** 签名线 */
  function signLine(ctx, x, y, w, label, color) {
    var u = w / 1000;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
    ctx.restore();
  }

  /** 手印：一圈一圈的纹路，别画成实心圆 */
  function fingerprint(ctx, cx, cy, r, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 0.45 : alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.8, r * 0.045);
    for (var i = 1; i <= 6; i++) {
      var rr2 = (r * i) / 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr2 * 0.72, rr2, 0.16, 0.4, Math.PI * 2 - 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 认主契约 ---------------- */
  function docContractFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.065;
    ctx.fillStyle = "#fbf6ea";
    ctx.fillRect(0, 0, W, H);
    noise(ctx, 0, 0, W, H, 200, "#8a6a3a", 0.05);
    guilloche(ctx, 0, 0, W, H, dShade(pal.accent, -0.15), { alpha: 0.035, rx: 0.5, ry: 0.5 });
    docBorder(ctx, m, { color: dShade(pal.accent, -0.3), alpha: 0.62, radius: 3, double: true });

    var headH = H * 0.22;
    txt(ctx, "认 主 契 约", W * 0.5, pad + headH * 0.46, {
      size: Math.min(44 * u, W * 0.092),
      weight: 800,
      family: SERIF,
      color: dShade(pal.accent, -0.38),
      align: "center",
      spacing: 8 * u,
      maxW: W - pad * 2,
    });
    txt(ctx, "OWNERSHIP CONTRACT", W * 0.5, pad + headH * 0.66, {
      size: 9 * u,
      color: pal.muted,
      align: "center",
      spacing: 3 * u,
      maxW: W * 0.6,
    });
    ctx.strokeStyle = dShade(pal.accent, -0.1);
    ctx.lineWidth = Math.max(1, 1.3 * u);
    ctx.beginPath();
    ctx.moveTo(W * 0.3, pad + headH * 0.76);
    ctx.lineTo(W * 0.7, pad + headH * 0.76);
    ctx.stroke();

    var bodyTop = pad + headH * 0.86;
    var bodyH = H * 0.46;
    var leftW = W * 0.36;

    var y = bodyTop + bodyH * 0.14;
    var gap = bodyH * 0.17;
    fLabel(ctx, "立 约 方", pad, y, { size: 10.5 * u, maxW: leftW });
    fValue(ctx, m.form.issuer, pad, y + 18 * u, { size: 13 * u, weight: 700, color: pal.ink, maxW: leftW });
    y += gap;
    fLabel(ctx, "受 约 方", pad, y, { size: 10.5 * u, maxW: leftW });
    fValue(ctx, m.shared.name || "未填写姓名", pad, y + 20 * u, {
      size: Math.min(22 * u, leftW / 5),
      color: pal.ink,
      maxW: leftW,
    });
    y += gap;
    fLabel(ctx, "契约编号", pad, y, { size: 10.5 * u, maxW: leftW });
    fValue(ctx, m.shared.no || "—", pad, y + 18 * u, { size: 13 * u, family: MONO, color: pal.ink, maxW: leftW });
    y += gap;
    fLabel(ctx, "生效日期", pad, y, { size: 10.5 * u, maxW: leftW });
    fValue(ctx, m.shared.issueDate, pad, y + 18 * u, { size: 13 * u, family: MONO, color: pal.ink, maxW: leftW * 0.6 });
    y += gap;
    fLabel(ctx, "契约等级", pad, y, { size: 10.5 * u, maxW: leftW });
    fValue(ctx, rankLabel(m), pad, y + 18 * u, { size: 14 * u, color: dShade(pal.accent, -0.2), maxW: leftW });

    /* 条款：勾选的词条逐条编号，这正是这张卡存在的意义 */
    var rx = pad + leftW + 22 * u;
    var rw = W - pad - rx;
    fLabel(ctx, "条 款 / TERMS", rx, bodyTop + bodyH * 0.1, { size: 10.5 * u, maxW: rw });
    var terms = m.tags || [];
    var lineH = 17 * u;
    var maxLines = Math.max(1, Math.floor((bodyH * 0.92) / lineH));
    var nums = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"];
    if (!terms.length) {
      txt(ctx, "勾选左侧词条后，这里会逐条列为契约条款", rx, bodyTop + bodyH * 0.1 + 22 * u, {
        size: 11 * u,
        color: pal.muted,
        maxW: rw,
      });
    }
    for (var i = 0; i < Math.min(terms.length, maxLines); i++) {
      var ty = bodyTop + bodyH * 0.1 + 24 * u + i * lineH;
      txt(ctx, "第" + nums[i] + "条", rx, ty, { size: 9.5 * u, color: dShade(pal.accent, -0.25), maxW: 40 * u });
      txt(ctx, terms[i], rx + 42 * u, ty, {
        size: 11.5 * u,
        weight: 500,
        family: SERIF,
        color: pal.ink,
        maxW: rw - 42 * u,
      });
    }
    if (terms.length > maxLines) {
      txt(ctx, "…… 另 " + (terms.length - maxLines) + " 条见附页", rx + 42 * u, bodyTop + bodyH * 0.1 + 24 * u + maxLines * lineH, {
        size: 9.5 * u,
        color: pal.muted,
        maxW: rw,
      });
    }

    /* 签名区：三栏铺满，印章盖在立约方那一栏（真合同的盖章位置），手印放最右 */
    var fy = H - pad * 1.5;
    var colGap = 22 * u;
    var colW = (W - pad * 2 - colGap * 2) / 3;
    var cols = [
      { x: pad, label: "立约方签章" },
      { x: pad + colW + colGap, label: "受约方签名" },
      { x: pad + (colW + colGap) * 2, label: "日 期" },
    ];
    for (var ci = 0; ci < cols.length; ci++) {
      signLine(ctx, cols[ci].x, fy, colW, "", dShade(pal.ink, 0.2));
      txt(ctx, cols[ci].label, cols[ci].x, fy + 13 * u, {
        size: 9 * u,
        color: pal.muted,
        maxW: colW,
      });
    }
    seal(
      ctx,
      pad + colW * 0.5,
      fy - Math.min(H * 0.055, W * 0.045),
      Math.min(H * 0.06, W * 0.05),
      m.form.sealText,
      dShade(pal.accent, -0.35),
      -0.2,
    );
    fingerprint(
      ctx,
      cols[2].x + colW * 0.62,
      fy - Math.min(H * 0.06, W * 0.05),
      Math.min(H * 0.05, W * 0.042),
      dShade(pal.accent, -0.25),
      0.4,
    );
    var qrSize = Math.min(H * 0.1, W * 0.06);
    qr(ctx, m.qrText, W - pad - qrSize, pad * 0.75, qrSize, pal.ink, "rgba(255,255,255,0.9)");
  }

  function docContract(ctx, m) {
    docStage(ctx, m, 1.414, docContractFace);
  }

  /* ---------------- 畜籍登记证 ---------------- */
  function docLivestockFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.058;
    ctx.fillStyle = "#f7f1e4";
    ctx.fillRect(0, 0, W, H);
    /* 斜条纹底（档案卡纸的观感） */
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = dShade(pal.ink, 0.25);
    ctx.lineWidth = Math.max(2, 7 * u);
    for (var i = -H; i < W + H; i += 26 * u) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + H, H);
      ctx.stroke();
    }
    ctx.restore();
    docBorder(ctx, m, { color: dShade(pal.ink, 0.1), alpha: 0.45, radius: 8, double: true });

    var headH = H * 0.24;
    /* 耳标 */
    var tagW = Math.min(W * 0.13, 130 * u);
    var tagH = tagW * 0.66;
    var tagX = pad;
    var tagY = pad + headH * 0.28;
    ctx.save();
    rr(ctx, tagX, tagY, tagW, tagH, 6 * u);
    ctx.fillStyle = dShade(pal.accent, -0.05);
    ctx.fill();
    ctx.strokeStyle = dShade(pal.accent, -0.4);
    ctx.lineWidth = Math.max(1, 1.6 * u);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(tagX + 12 * u, tagY + tagH / 2, 5 * u, 0, Math.PI * 2);
    ctx.fill();
    txt(ctx, dDigits(m.shared.no, Math.max(4, Math.floor(tagW / (11 * u)))), tagX + tagW / 2 + 6 * u, tagY + tagH * 0.62, {
      size: Math.min(15 * u, tagW * 0.14),
      weight: 800,
      family: MONO,
      color: "#ffffff",
      align: "center",
      maxW: tagW - 18 * u,
    });
    ctx.restore();

    txt(ctx, "畜籍登记证", tagX + tagW + 16 * u, tagY + tagH * 0.42, {
      size: Math.min(30 * u, W * 0.058),
      weight: 800,
      family: SERIF,
      color: pal.ink,
      spacing: 3 * u,
      maxW: W * 0.56,
    });
    txt(ctx, "LIVESTOCK REGISTRY · " + (m.form.subtitle || ""), tagX + tagW + 16 * u, tagY + tagH * 0.7, {
      size: 9 * u,
      color: pal.muted,
      spacing: 1.6 * u,
      maxW: W * 0.56,
    });
    txt(ctx, m.form.cardLabel, W - pad, tagY + tagH * 0.3, {
      size: 12 * u,
      weight: 700,
      color: dShade(pal.ink, 0.15),
      align: "right",
      maxW: W * 0.3,
    });
    txt(ctx, m.form.issuer, W - pad, tagY + tagH * 0.58, {
      size: 10 * u,
      color: pal.muted,
      align: "right",
      maxW: W * 0.34,
    });

    var bodyTop = pad + headH;
    var footH = H * 0.2;
    var bodyH = H - bodyTop - footH;
    var phH = Math.min(bodyH * 0.92, H * 0.38);
    var phW = phH * 0.8;
    var phY = bodyTop + (bodyH - phH) / 2;
    photoBox(ctx, m, pad, phY, phW, phH, 6 * u);
    /* 打码条：档案照上常见的遮眼条 */
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = dShade(pal.ink, -0.1);
    ctx.fillRect(pad, phY + phH * 0.36, phW, phH * 0.1);
    ctx.restore();
    seal(ctx, pad + phW * 0.5, phY + phH * 0.72, Math.min(phW * 0.42, 48 * u), m.form.sealText, dShade(pal.accent, -0.15), -0.28);

    var fx = pad + phW + 20 * u;
    var fw = W - pad - fx;
    var labW = 68 * u;
    var y = bodyTop + bodyH * 0.16;
    var gap = bodyH * 0.15;
    fLabel(ctx, "畜 名", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.shared.name || "未填写名字", fx + labW, y, { size: 20 * u, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "畜 种", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.form.cardLabel, fx + labW, y, { size: 15 * u, color: pal.ink, maxW: fw - labW });
    y += gap;
    fLabel(ctx, "评 级", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, rankLabel(m), fx + labW, y, { size: 17 * u, color: dShade(pal.accent, -0.2), maxW: fw - labW });
    y += gap;
    fLabel(ctx, "性 别", fx, y, { size: 11 * u, maxW: labW });
    fValue(ctx, m.gender === "m" ? "公" : "母", fx + labW, y, { size: 15 * u, color: pal.ink, maxW: fw * 0.3 });
    fLabel(ctx, "检 疫", fx + fw * 0.42, y, { size: 11 * u, maxW: labW * 0.7 });
    fValue(ctx, "已检", fx + fw * 0.42 + labW * 0.7, y, { size: 15 * u, color: pal.ink, maxW: fw * 0.4 });

    /* 特征：勾选词条 */
    var ty = bodyTop + bodyH * 0.78;
    fLabel(ctx, "特 征", fx, ty, { size: 11 * u, maxW: labW });
    if (m.tags && m.tags.length) {
      var blk = chipOpts(ctx, m.tags, fw - labW, bodyH * 0.22, u);
      chipsDraw(ctx, blk.lines, blk.o, fx + labW, ty - blk.o.chipH * 0.75, fw - labW, false, pal);
    } else {
      txt(ctx, "勾选词条后显示特征", fx + labW, ty, { size: 10.5 * u, color: pal.muted, maxW: fw - labW });
    }

    var fy = H - footH;
    ctx.strokeStyle = dMix(pal.ink, "#ffffff", 0.6);
    ctx.lineWidth = Math.max(0.8, 1 * u);
    ctx.beginPath();
    ctx.moveTo(pad, fy);
    ctx.lineTo(W - pad, fy);
    ctx.stroke();
    fLabel(ctx, "登记日期", pad, fy + 15 * u, { size: 10 * u });
    fValue(ctx, m.shared.issueDate, pad, fy + 33 * u, { size: 12.5 * u, family: MONO, color: pal.ink, maxW: W * 0.26 });
    fLabel(ctx, "有效期至", pad + W * 0.3, fy + 15 * u, { size: 10 * u });
    fValue(ctx, m.shared.validUntil, pad + W * 0.3, fy + 33 * u, { size: 12.5 * u, family: MONO, color: pal.ink, maxW: W * 0.26 });
    var barcodeH = Math.min(footH * 0.3, 26 * u);
    barcode(ctx, W * 0.58, fy + footH * 0.26, W * 0.26, barcodeH, m.shared.no || "0000", dShade(pal.ink, -0.1));
    var qrSize = Math.min(footH * 0.5, W * 0.062);
    qr(ctx, m.qrText, W - pad - qrSize, fy + (footH - qrSize) / 2, qrSize, pal.ink, "rgba(255,255,255,0.9)");
  }

  function docLivestock(ctx, m) {
    docStage(ctx, m, 1.586, docLivestockFace);
  }

  /* ---------------- 身份识别卡（成人向） ---------------- */
  function docIdentifierFace(ctx, m) {
    var u = m.W / 1000;
    var W = m.W;
    var H = m.H;
    var pal = m.pal;
    var pad = W * 0.065;
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#1b1017");
    g.addColorStop(0.5, "#241420");
    g.addColorStop(1, "#120a12");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    for (var i = 0; i < W + H; i += 14 * u) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i - H, H);
      ctx.stroke();
    }
    ctx.restore();
    docBorder(ctx, m, { color: pal.accent, alpha: 0.45, radius: 10 });

    /* 磁条 */
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, H * 0.055, W, H * 0.075);

    var headTop = H * 0.19;
    txt(ctx, "身份识别卡", pad, headTop, {
      size: Math.min(26 * u, W * 0.05),
      weight: 800,
      color: "#ffffff",
      spacing: 3 * u,
      maxW: W * 0.6,
    });
    txt(ctx, "IDENTIFICATION · AUTHORIZED USE ONLY", pad, headTop + 17 * u, {
      size: 8.5 * u,
      color: "rgba(255,255,255,0.45)",
      spacing: 1.8 * u,
      maxW: W * 0.6,
    });
    txt(ctx, rankLabel(m), W - pad, headTop + 2 * u, {
      size: 15 * u,
      weight: 800,
      color: pal.accent,
      align: "right",
      spacing: 1.2 * u,
      maxW: W * 0.34,
    });
    txt(ctx, m.form.issuer, W - pad, headTop + 18 * u, {
      size: 9 * u,
      color: "rgba(255,255,255,0.42)",
      align: "right",
      maxW: W * 0.34,
    });

    var bodyTop = headTop + 34 * u;
    var bodyH = H * 0.5;
    var phH = Math.min(bodyH * 0.98, H * 0.4);
    var phW = phH * 0.75;
    photoBox(ctx, m, pad, bodyTop, phW, phH, 5 * u);

    var fx = pad + phW + 20 * u;
    var fw = W - pad - fx;
    fLabel(ctx, "编 号 / ID", fx, bodyTop + 12 * u, {
      size: 9.5 * u,
      color: "rgba(255,255,255,0.45)",
      maxW: fw,
    });
    txt(ctx, dDigits(m.shared.no, 12).replace(/(\d{4})(?=\d)/g, "$1 "), fx, bodyTop + 34 * u, {
      size: Math.min(20 * u, fw / 8),
      weight: 700,
      family: MONO,
      color: "#ffffff",
      spacing: 2 * u,
      maxW: fw,
    });
    txt(ctx, m.shared.name || "未填写姓名", fx, bodyTop + 62 * u, {
      size: Math.min(24 * u, fw / 5),
      weight: 800,
      color: "#ffffff",
      maxW: fw,
    });
    txt(ctx, "等 级 " + m.pct + "%", fx, bodyTop + 82 * u, {
      size: 12 * u,
      weight: 700,
      color: pal.accent,
      maxW: fw,
    });
    bar(ctx, fx, bodyTop + 90 * u, fw * 0.9, 9 * u, m.pct, pal);

    /* 服务项目 = 勾选词条 */
    var sy = bodyTop + 106 * u;
    fLabel(ctx, "可用项目 / SERVICES", fx, sy, {
      size: 9 * u,
      color: "rgba(255,255,255,0.42)",
      maxW: fw,
    });
    if (m.tags && m.tags.length) {
      var blk = chipOpts(ctx, m.tags, fw, Math.max(24 * u, H * 0.2), u);
      chipsDraw(ctx, blk.lines, blk.o, fx, sy + 10 * u, fw, false, pal);
    } else {
      txt(ctx, "勾选词条后显示", fx, sy + 18 * u, { size: 10.5 * u, color: "rgba(255,255,255,0.4)", maxW: fw });
    }

    /* 底部条码 + 二维码 + 有效期 */
    var fy = H - pad * 0.9;
    var barcodeH = Math.min(26 * u, H * 0.07);
    barcode(ctx, pad, fy - barcodeH, Math.min(W * 0.4, W - pad * 2 - 80 * u), barcodeH, m.shared.no || "0000", "rgba(255,255,255,0.75)");
    txt(ctx, m.shared.no || "—", pad, fy, {
      size: 8.5 * u,
      family: MONO,
      color: "rgba(255,255,255,0.55)",
      spacing: 2 * u,
      maxW: W * 0.4,
    });
    txt(ctx, "VALID THRU " + m.shared.validUntil, W - pad, fy, {
      size: 9 * u,
      family: MONO,
      color: "rgba(255,255,255,0.5)",
      align: "right",
      maxW: W * 0.36,
    });
    var qrSize = Math.min(H * 0.13, W * 0.075);
    qr(ctx, m.qrText, W - pad - qrSize, fy - barcodeH - qrSize - 4 * u, qrSize, "rgba(255,255,255,0.9)", "rgba(255,255,255,0.08)");
  }

  function docIdentifier(ctx, m) {
    docStage(ctx, m, 1.586, docIdentifierFace);
  }

  /* ================================================================= *
   * 注册
   * ================================================================= */
  var STYLES = [
    /* ---- 证件族：按真证件的版式与字段来，一眼认得出是什么证 ---- */
    { id: "doc_id", name: "身份证", group: "doc", render: docIdcard },
    { id: "doc_student", name: "学生证", group: "doc", render: docStudent },
    { id: "doc_work", name: "工牌", group: "doc", render: docWorkBadge },
    { id: "doc_driver", name: "驾驶证", group: "doc", render: docDriver },
    { id: "doc_marriage", name: "结婚证", group: "doc", render: docMarriage },
    { id: "doc_medical", name: "就诊卡", group: "doc", render: docMedical },
    { id: "doc_member", name: "会员卡", group: "doc", render: docMember },
    { id: "doc_admit", name: "准考证", group: "doc", render: docAdmit },
    { id: "doc_pet", name: "宠物证", group: "doc", render: docPet },
    { id: "doc_honor", name: "荣誉证书", group: "doc", render: docHonor },
    /* 成人向证件：确认 18+ 后才出现在选择器里（app.js 过滤，不是 CSS 隐藏） */
    { id: "doc_contract", name: "认主契约", group: "doc", adult: true, render: docContract },
    { id: "doc_livestock", name: "畜籍证", group: "doc", adult: true, render: docLivestock },
    { id: "doc_identifier", name: "识别卡", group: "doc", adult: true, render: docIdentifier },
    /* ---- 创意版式 ---- */
    { id: "idcard", name: "资格证", group: "fun", render: styleIdcard },
    { id: "ring_cloud", name: "环绕词云", group: "fun", render: styleRingCloud },
    { id: "chaos_cloud", name: "混乱词云", group: "fun", render: styleChaosCloud },
    { id: "stamp_wall", name: "印章满屏", group: "fun", render: styleStampWall },
    { id: "bingo", name: "宾果表", group: "fun", render: styleBingo },
    { id: "lab_report", name: "化验单", group: "fun", render: styleLabReport },
    { id: "receipt", name: "小票", group: "fun", render: styleReceipt },
    { id: "dogtag", name: "狗牌", group: "fun", render: styleDogtag },
    { id: "ssr", name: "SSR 卡牌", group: "fun", render: styleSsr },
    { id: "ingredient", name: "成分表", group: "fun", render: styleIngredient },
    { id: "wanted", name: "通缉令", group: "fun", render: styleWanted },
    { id: "polaroid", name: "拍立得照片墙", group: "fun", render: stylePolaroid },
    { id: "contactsheet", name: "印样联片", group: "fun", render: styleContactsheet },
  ];

  var RATIOS = [
    { id: "1:1", name: "1:1", w: 1080, h: 1080 },
    { id: "4:5", name: "4:5", w: 1080, h: 1350 },
    { id: "3:4", name: "3:4", w: 1080, h: 1440 },
    { id: "9:16", name: "9:16", w: 1080, h: 1920 },
    { id: "long", name: "长图", w: 1080, h: 2700 },
  ];

  function findStyle(id) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i];
    return STYLES[0];
  }

  function findRatio(id) {
    for (var i = 0; i < RATIOS.length; i++) if (RATIOS[i].id === id) return RATIOS[i];
    return RATIOS[0];
  }

  return { STYLES: STYLES, RATIOS: RATIOS, findStyle: findStyle, findRatio: findRatio };
})();
