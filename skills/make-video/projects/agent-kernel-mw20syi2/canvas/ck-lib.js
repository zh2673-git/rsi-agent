// ck-lib（亮色版 morning-paper）：三支宣传片共用的程序化画布原语
// 画面 = f(t, D)，确定性可复现。视觉体系：纸白基底 / 墨蓝结构 / 青×琥珀双强调 / 柔光渗染
// 与暗色版 API 完全一致（CK.*），仅调色与后处理策略不同：
//   - backdrop 把调用方传入的深色（每镜各自的色温倾向）统一"paperize"成纸白偏色
//   - vignette 由黑角改为暖灰柔角（亮画面不能压黑）
//   - grain 用墨点（亮底上白点不可见）
//   - glow 降 alpha 变柔光扩散
(function (global) {
  'use strict';

  var PAL = {
    ink: '#0e151d',        // 最深的墨（画面上最重的一笔）
    deep: '#e3dccb',       // 纸底偏暖（比纸面暗一档，给面板留位）
    slate: '#f0ebdf',      // 纸面主体
    steel: '#4d5a67',      // 中灰蓝：次要线条与说明文字（亮底上要够深）
    steelDim: '#8494a3',   // 淡结构线
    pale: '#131b24',       // 原本的"白"→ 墨色：主文字与主轮廓
    cyan: '#0d6e86',       // 青（冷强调）
    cyanDim: '#7fa9b6',    // 青的淡线
    amber: '#a8620f',      // 琥珀（暖强调，代表"人"）
    amberHot: '#c0741c',   // 琥珀亮块
    ember: '#a63a22',      // 余烬红（警示）
  };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function out(x) { return 1 - Math.pow(1 - clamp01(x), 3); }
  function inn(x) { return Math.pow(clamp01(x), 3); }
  function win(t, a, b, f) {
    f = f == null ? 0.45 : f;
    return smooth((t - a) / f) * (1 - smooth((t - b) / f));
  }

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return { r: 240, g: 238, b: 232 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    function c(x) { var v = Math.round(Math.max(0, Math.min(255, x))).toString(16); return v.length === 1 ? '0' + v : v; }
    return '#' + c(r) + c(g) + c(b);
  }
  function toHsl(hex) {
    var c = hexToRgb(hex);
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h, s: s, l: l };
  }
  function hslToHex(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s < 0) s = 0;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
  }

  // 把任意"深色底"压成亮纸色：色相保留、饱和度大幅收窄、明度锁定
  function paperize(hex, l, sMax) {
    var hsl = toHsl(hex);
    var lim = sMax == null ? 0.26 : sMax;
    var s = Math.min(hsl.s * 0.34, lim);
    return hslToHex(hsl.h, s, l == null ? 0.94 : l);
  }

  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  // 纸面底色（三层微渐变）+ 中心柔光渗染
  // 明度定在 0.80-0.90：真纸白不是纯白，纯白会让结构糊掉、成片像过曝
  function backdrop(ctx, w, h, o) {
    o = o || {};
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, paperize(o.top || '#04070d', 0.855));
    g.addColorStop(0.55, paperize(o.mid || '#060c16', 0.815));
    g.addColorStop(1, paperize(o.bottom || '#02040a', 0.755));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    var hx = o.hx == null ? 0.5 : o.hx;
    var hy = o.hy == null ? h * 0.62 : o.hy;
    var hg = ctx.createRadialGradient(w * hx, hy, 0, w * hx, hy, w * 0.62);
    // 渗染只做"染色"不做"打光"：明度压在纸底之下，否则中心过曝把主体吃掉
    var hazeCol = paperize(o.haze || '#16304a', 0.78, 0.3);
    hg.addColorStop(0, rgba(hazeCol, Math.min(0.45, (o.hazeA == null ? 0.5 : o.hazeA) * 0.9)));
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);
  }

  // 柔光（径向渐变；亮底上用低 alpha 做"渗光"而非辉光）
  function glow(ctx, x, y, r, color, a) {
    if (r <= 0) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    var al = (a == null ? 0.85 : a) * 0.5;
    g.addColorStop(0, rgba(color, al));
    g.addColorStop(0.42, rgba(color, al * 0.3));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();
  }

  function stars(n, w, h, seed) {
    var r = mulberry32(seed || 7);
    var list = [];
    for (var i = 0; i < n; i += 1) {
      list.push({ x: r() * w, y: r() * h * 0.92, s: 0.5 + r() * 1.6, p: r() * 6.28, a: 0.2 + r() * 0.65 });
    }
    return list;
  }
  // 亮底上星点退成极淡的纸纹（不再是星空）
  function drawStars(ctx, list, t) {
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i];
      var tw = 0.6 + 0.4 * Math.sin(t * 1.7 + s.p);
      ctx.fillStyle = rgba(PAL.steelDim, s.a * tw * 0.22);
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
  }

  function dust(n, w, h, seed) {
    var r = mulberry32(seed || 21);
    var list = [];
    for (var i = 0; i < n; i += 1) {
      list.push({ x: r() * w, y: r() * h, r: 0.6 + r() * 2.2, v: 4 + r() * 18, p: r() * 6.28, a: 0.1 + r() * 0.4 });
    }
    return list;
  }
  function drawDust(ctx, list, t, h) {
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i];
      var y = ((d.y - t * d.v) % h + h) % h;
      var x = d.x + Math.sin(t * 0.6 + d.p) * 12;
      ctx.fillStyle = rgba(PAL.steel, d.a * 0.55);
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, 6.2832);
      ctx.fill();
    }
  }

  function floorGrid(ctx, o) {
    var w = o.w, h = o.h, vx = o.vx == null ? w * 0.5 : o.vx, vy = o.vy;
    var a = o.alpha == null ? 0.22 : o.alpha;
    var col = o.color || PAL.cyanDim;
    var scroll = o.scroll || 0;
    var span = w * 0.95;
    ctx.save();
    ctx.lineWidth = 1;
    for (var i = -7; i <= 7; i += 1) {
      ctx.strokeStyle = rgba(col, a * (1 - Math.abs(i) / 9) * 1.5);
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(vx + (i / 7) * span, h + 40);
      ctx.stroke();
    }
    for (var k = 0; k < 16; k += 1) {
      var p = ((k / 16) + scroll) % 1;
      var y = vy + Math.pow(p, 2.6) * (h - vy) * 1.06;
      if (y < vy + 4) continue;
      ctx.strokeStyle = rgba(col, a * (0.16 + p * 0.9) * 1.6);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function ring(ctx, x, y, r, o) {
    o = o || {};
    var col = o.color || PAL.cyan;
    var a = o.alpha == null ? 0.5 : o.alpha;
    ctx.save();
    ctx.strokeStyle = rgba(col, a);
    ctx.lineWidth = o.width || 1.6;
    ctx.beginPath();
    if (o.from != null) ctx.arc(x, y, r, o.from, o.to == null ? 6.2832 : o.to);
    else ctx.arc(x, y, r, 0, 6.2832);
    ctx.stroke();
    if (o.ticks) {
      for (var i = 0; i < o.ticks; i += 1) {
        var ang = (i / o.ticks) * 6.2832 + (o.rot || 0);
        var r1 = r * 0.94, r2 = r * (i % 4 === 0 ? 0.86 : 0.9);
        ctx.strokeStyle = rgba(col, a * (i % 4 === 0 ? 0.9 : 0.42));
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
        ctx.lineTo(x + Math.cos(ang) * r2, y + Math.sin(ang) * r2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 等距立方（结构件）：亮底上用墨蓝三面 + 落影，保持"实体感"
  function cube(ctx, x, y, s, hh, o) {
    o = o || {};
    var a = o.alpha == null ? 1 : o.alpha;
    ctx.save();
    ctx.globalAlpha = a;
    // 落影
    ctx.fillStyle = 'rgba(60,52,40,0.13)';
    ctx.beginPath();
    ctx.ellipse(x, y + s * 0.5 + hh + 6, s * 1.0, s * 0.22, 0, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = o.top || '#8fa2b4';
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.5); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s * 0.5); ctx.lineTo(x - s, y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = o.left || '#3f5266';
    ctx.beginPath();
    ctx.moveTo(x - s, y); ctx.lineTo(x, y + s * 0.5); ctx.lineTo(x, y + s * 0.5 + hh); ctx.lineTo(x - s, y + hh);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = o.right || '#2a3a4c';
    ctx.beginPath();
    ctx.moveTo(x + s, y); ctx.lineTo(x, y + s * 0.5); ctx.lineTo(x, y + s * 0.5 + hh); ctx.lineTo(x + s, y + hh);
    ctx.closePath(); ctx.fill();
    if (o.edge) {
      ctx.strokeStyle = rgba(o.edge, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.5); ctx.lineTo(x + s, y); ctx.lineTo(x + s, y + hh);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 剪影人形：亮底上必须是"重墨"才立得住
  function figure(ctx, x, baseY, hgt, o) {
    o = o || {};
    ctx.save();
    ctx.fillStyle = o.color || '#1b2430';
    ctx.globalAlpha = o.alpha == null ? 0.92 : o.alpha;
    var hr = hgt * 0.115;
    ctx.beginPath(); ctx.arc(x, baseY - hgt + hr, hr, 0, 6.2832); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - hgt * 0.1, baseY - hgt + hr * 1.7);
    ctx.lineTo(x + hgt * 0.1, baseY - hgt + hr * 1.7);
    ctx.lineTo(x + hgt * 0.16, baseY - hgt * 0.42);
    ctx.lineTo(x + hgt * 0.055, baseY - hgt * 0.42);
    ctx.lineTo(x + hgt * 0.05, baseY);
    ctx.lineTo(x - hgt * 0.05, baseY);
    ctx.lineTo(x - hgt * 0.055, baseY - hgt * 0.42);
    ctx.lineTo(x - hgt * 0.16, baseY - hgt * 0.42);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // 光束：亮底上是"窗光柱"（暖白 + 边界柔）
  function beam(ctx, x1, y1, x2, y2, width, color, a) {
    var g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, rgba(color, a * 0.85));
    g.addColorStop(1, rgba(color, 0));
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x1 - width / 2, y1);
    ctx.lineTo(x1 + width / 2, y1);
    ctx.lineTo(x2 + width * 0.16, y2);
    ctx.lineTo(x2 - width * 0.16, y2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function sparks(ctx, list, t, color) {
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i];
      var p = ((t * s.v + s.p) % 1);
      var x = s.x + Math.cos(s.ang) * s.len * p;
      var y = s.y + Math.sin(s.ang) * s.len * p + p * p * 60;
      ctx.fillStyle = rgba(color || PAL.amber, (1 - p) * s.a * 1.2);
      ctx.fillRect(x, y, s.r, s.r);
    }
  }

  // 颗粒：亮底上用墨点（暗色版是白点）
  function grain(ctx, w, h, amount, t) {
    if (amount <= 0) return;
    var r = mulberry32(Math.floor(t * 24) + 11);
    ctx.save();
    ctx.globalAlpha = amount * 0.5;
    ctx.fillStyle = '#2c2418';
    for (var i = 0; i < 900; i += 1) {
      ctx.fillRect(r() * w, r() * h, 1, 1);
    }
    ctx.restore();
  }
  // 暗角：亮画面不能压黑——改暖灰柔角，并把调用方给的强度统一打折
  function vignette(ctx, w, h, a) {
    var k = (a == null ? 0.2 : a) * 0.34;
    var g = ctx.createRadialGradient(w * 0.5, h * 0.48, h * 0.3, w * 0.5, h * 0.5, h * 0.95);
    g.addColorStop(0, 'rgba(74,62,44,0)');
    g.addColorStop(1, 'rgba(74,62,44,' + k.toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // 宽幅遮幅：好莱坞画幅，亮色风格同样保留（这是"胶片感"不是"暗调"）
  function letterbox(ctx, w, h, k) {
    var bar = h * (k == null ? 0.075 : k);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
  }

  function label(ctx, text, x, y, size, color, a, align) {
    ctx.save();
    ctx.globalAlpha = a == null ? 0.8 : a;
    ctx.fillStyle = color || PAL.steel;
    ctx.font = '400 ' + size + 'px Consolas, "SF Mono", monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  function title(ctx, text, x, y, size, color, a) {
    ctx.save();
    ctx.globalAlpha = a == null ? 1 : a;
    ctx.fillStyle = color || PAL.pale;
    ctx.font = '700 ' + size + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,255,255,0.85)';
    ctx.shadowBlur = 18;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  global.CK = {
    PAL: PAL,
    mulberry32: mulberry32,
    clamp01: clamp01,
    smooth: smooth,
    lerp: lerp,
    out: out,
    inn: inn,
    win: win,
    rgba: rgba,
    paperize: paperize,
    backdrop: backdrop,
    glow: glow,
    stars: stars,
    drawStars: drawStars,
    dust: dust,
    drawDust: drawDust,
    floorGrid: floorGrid,
    ring: ring,
    cube: cube,
    figure: figure,
    beam: beam,
    sparks: sparks,
    grain: grain,
    vignette: vignette,
    letterbox: letterbox,
    label: label,
    title: title,
  };
})(window);
