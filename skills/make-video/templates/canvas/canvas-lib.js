// canvas-lib：确定性程序化电影画面原语库
// 铁律：一切随机必须走种子（mulberry32），渲染器按帧 seek，画面必须逐帧可复现。
(function (global) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  // 0→1 平滑缓动
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function easeOutCubic(t) { t = clamp01(t); return 1 - Math.pow(1 - t, 3); }

  // ---- 星空 ----
  // 生成静态星表（种子确定）；twinkle 相位独立于帧时间。
  function makeStars(seed, count, w, h) {
    var rnd = mulberry32(seed);
    var stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: rnd() * w,
        y: rnd() * h,
        r: 0.4 + rnd() * rnd() * 1.6,
        c: rnd(),
        tw: 0.5 + rnd() * 2.0,
        ph: rnd() * Math.PI * 2,
        depth: 0.3 + rnd() * 0.7, // 视差/缩放深度
      });
    }
    return stars;
  }

  function starColor(v) {
    // 0 冷蓝白 → 0.5 纯白 → 1 暖黄
    if (v < 0.5) {
      var t = v / 0.5;
      return 'rgb(' + Math.round(lerp(190, 255, t)) + ',' + Math.round(lerp(210, 255, t)) + ',255)';
    }
    var t2 = (v - 0.5) / 0.5;
    return 'rgb(255,' + Math.round(lerp(255, 235, t2)) + ',' + Math.round(lerp(255, 190, t2)) + ')';
  }

  // opts: { cx, cy, lens(引力透镜强度 px), horizon(阴影半径), drift(视差位移), zoom(整体缩放), alpha }
  function drawStars(ctx, stars, time, opts) {
    opts = opts || {};
    var lens = opts.lens || 0;
    var horizon = opts.horizon || 0;
    var driftX = (opts.driftX || 0);
    var driftY = (opts.driftY || 0);
    var zoom = opts.zoom || 1;
    var alpha = opts.alpha == null ? 1 : opts.alpha;
    var cx = opts.cx == null ? 960 : opts.cx;
    var cy = opts.cy == null ? 540 : opts.cy;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var x = cx + (s.x - cx) * zoom + driftX * s.depth;
      var y = cy + (s.y - cy) * zoom + driftY * s.depth;
      var tw = 0.65 + 0.35 * Math.sin(time * s.tw + s.ph);
      var a = alpha * tw * (0.35 + 0.65 * s.depth);
      if (lens > 0 && horizon > 0) {
        var dx = x - cx, dy = y - cy;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < horizon * 1.05) continue; // 落入阴影的星被吞没
        // 引力透镜：视线偏折近似——星光绕开阴影，近处星被推离
        var push = (lens * lens) / d;
        x = cx + (dx / d) * (d + push * 0.35);
        y = cy + (dy / d) * (d + push * 0.35);
        a = Math.min(1, a + push / (lens * 6)); // 环带增亮
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = starColor(s.c);
      ctx.beginPath();
      ctx.arc(x, y, s.r * (zoom * 0.5 + 0.5), 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 发光体（径向渐变，禁 shadowBlur：渲染帧成本过高）----
  function glow(ctx, x, y, r, inner, outer) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();
  }

  // ---- 吸积盘粒子（种子确定，多普勒增亮：一侧更亮）----
  function makeDisk(seed, count) {
    var rnd = mulberry32(seed);
    var pts = [];
    for (var i = 0; i < count; i++) {
      pts.push({
        a: rnd() * Math.PI * 2,                 // 初始角
        r: 0.75 + Math.pow(rnd(), 1.6) * 0.75,  // 归一化半径
        sp: 0.55 + rnd() * 0.5,                 // 角速度系数（内快外慢另乘）
        sz: 0.8 + rnd() * 2.2,
        warm: rnd(),
      });
    }
    return pts;
  }

  // opts: { cx, cy, r0, r1, speed, brightLeft }
  function drawDisk(ctx, pts, time, opts) {
    opts = opts || {};
    var cx = opts.cx, cy = opts.cy;
    var r0 = opts.r0, r1 = opts.r1;
    var speed = opts.speed || 1;
    var brightLeft = opts.brightLeft !== false;
    ctx.save();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var rr = lerp(r0, r1, p.r);
      var w = (p.sp * speed) / Math.pow(p.r, 1.5); // 开普勒：内圈快
      var ang = p.a + time * w;
      var x = cx + Math.cos(ang) * rr;
      var y = cy + Math.sin(ang) * rr * 0.32;      // 倾斜盘面
      // 多普勒增亮：朝向观察者一侧（左）更亮更白
      var beam = brightLeft ? (0.5 - 0.5 * Math.cos(ang)) : (0.5 + 0.5 * Math.cos(ang));
      var heat = clamp01(1.15 - p.r); // 内热外冷
      var cr = Math.round(lerp(255, 255, heat));
      var cg = Math.round(lerp(190, 140, 1 - heat) + beam * 50);
      var cb = Math.round(lerp(90, 40, 1 - heat) + beam * 60);
      ctx.globalAlpha = clamp01(0.25 + beam * 0.6) * clamp01(1.2 - p.r * 0.55);
      ctx.fillStyle = 'rgba(' + cr + ',' + Math.min(255, cg) + ',' + Math.min(255, cb) + ',1)';
      ctx.beginPath();
      ctx.arc(x, y, p.sz * (0.7 + heat * 0.6), 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 电影包装：暗角 + letterbox ----
  function vignette(ctx, w, h, strength) {
    var g = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (strength == null ? 0.45 : strength) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  function letterbox(ctx, w, h, frac) {
    var bar = h * (frac == null ? 0.055 : frac);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
  }

  global.CV = {
    mulberry32: mulberry32,
    lerp: lerp,
    clamp01: clamp01,
    smooth: smooth,
    easeOutCubic: easeOutCubic,
    makeStars: makeStars,
    drawStars: drawStars,
    glow: glow,
    makeDisk: makeDisk,
    drawDisk: drawDisk,
    vignette: vignette,
    letterbox: letterbox,
  };
})(window);
