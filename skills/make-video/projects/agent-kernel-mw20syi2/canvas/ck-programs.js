// ck-programs：agent-kernel 宣传片逐镜画面程序（确定性：draw(t) 是时间的纯函数）
// 画布文字只用英文/数字，避免与旁白文字重合（V-SCENE-005 对位铁律）
(function (global) {
  'use strict';
  var CK = global.CK;
  var PAL = CK.PAL;
  var W = 1920, H = 1080;

  function frame(ctx, t, D, o) {
    o = o || {};
    CK.backdrop(ctx, W, H, o.bg || {});
    if (o.stars) CK.drawStars(ctx, o.stars, t);
    if (o.dust) CK.drawDust(ctx, o.dust, t, H);
  }
  function finish(ctx, t, o) {
    o = o || {};
    CK.grain(ctx, W, H, o.grain == null ? 0.1 : o.grain, t);
    CK.vignette(ctx, W, H, o.vig == null ? 0.62 : o.vig);
    CK.letterbox(ctx, W, H, 0.075);
  }

  var P = {};

  /* s01 诞生：黑暗中浮现一个巨大的机械剪影，第一缕光照亮它的"手" */
  P.s01 = {
    setup: function (seed) { return { st: CK.stars(180, W, H, seed), du: CK.dust(50, W, H, seed + 1) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, dust: S.du, bg: { haze: '#5a5245', hazeA: 0.34 } });
      var rise = CK.out(t / (D * 0.8));
      var cx = W * 0.5, baseY = H * 0.9;
      var scap = 0.9 + rise * 0.1;
      // 巨构台座
      ctx.save();
      ctx.fillStyle = CK.rgba('#6d6355', 0.95);
      ctx.beginPath();
      ctx.moveTo(cx - 520 * scap, baseY);
      ctx.lineTo(cx - 300 * scap, baseY - 150);
      ctx.lineTo(cx + 300 * scap, baseY - 150);
      ctx.lineTo(cx + 520 * scap, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // 躯干剪影（逐步"显影"）
      var bodyA = CK.smooth(t / (D * 0.55));
      ctx.save();
      ctx.globalAlpha = 0.28 + bodyA * 0.62;
      ctx.fillStyle = '#6d6355';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx - 150, baseY - 620 * scap, 300, 480 * scap, 26) : ctx.rect(cx - 150, baseY - 620 * scap, 300, 480 * scap);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, baseY - 660 * scap, 74, 0, 6.2832);
      ctx.fill();
      ctx.restore();
      // 从上方打下唯一一道冷光（单光源）
      var lampA = 0.16 + CK.smooth((t - D * 0.12) / (D * 0.6)) * 0.5;
      CK.beam(ctx, cx - 40, -80, cx + 130, baseY - 180, 300, '#257eb1', lampA * 0.5);
      CK.glow(ctx, cx + 60, baseY - 300, 340, '#1e9db8', lampA * 0.16);
      // 手：一束琥珀色的、正在张开的机械爪（"人"的色温）
      var open = CK.smooth((t - D * 0.42) / (D * 0.5));
      var hx = cx + 250, hy = baseY - 300;
      ctx.save();
      ctx.translate(hx, hy);
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.15 + open * 0.8);
      ctx.lineWidth = 5;
      for (var i = 0; i < 5; i += 1) {
        var a = -0.55 + i * 0.28 - open * 0.32;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(Math.cos(a) * 60, Math.sin(a) * 40, Math.cos(a) * (110 + open * 55), Math.sin(a) * (70 + open * 40));
        ctx.stroke();
      }
      ctx.restore();
      CK.glow(ctx, hx, hy, 150 + open * 90, PAL.amber, 0.14 + open * 0.2);
      CK.label(ctx, 'ORIGIN  /  T+0', 96, H * 0.82, 22, PAL.steelDim, 0.85);
      CK.label(ctx, 'SILHOUETTE RIG  01', W - 96, H * 0.82, 22, PAL.steelDim, 0.85, 'right');
      finish(ctx, t, { vig: 0.72 });
    },
  };

  /* s02 三件事：三根巨柱立在雾中，各自一块铭牌 */
  P.s02 = {
    setup: function (seed) { return { st: CK.stars(120, W, H, seed), du: CK.dust(60, W, H, seed + 2) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, dust: S.du, bg: { haze: '#5a5245', hazeA: 0.42, hy: H * 0.7 } });
      var cols = [
        { x: W * 0.27, k: 'SPACE', s: 'isolate' },
        { x: W * 0.5, k: 'TIME', s: 'schedule' },
        { x: W * 0.73, k: 'RULES', s: 'enforce' },
      ];
      var baseY = H * 0.82;
      for (var i = 0; i < 3; i += 1) {
        var c = cols[i];
        var grow = CK.smooth((t - 0.15 - i * 0.22) / (D * 0.5));
        var hgt = 560 * grow;
        if (hgt < 6) continue;
        var bw = 132;
        var g = ctx.createLinearGradient(c.x - bw / 2, 0, c.x + bw / 2, 0);
        g.addColorStop(0, '#6d6355');
        g.addColorStop(0.5, '#9a907e');
        g.addColorStop(1, '#6d6355');
        ctx.fillStyle = g;
        ctx.fillRect(c.x - bw / 2, baseY - hgt, bw, hgt);
        // 柱面刻度（时间的暗示）
        ctx.strokeStyle = CK.rgba(PAL.cyanDim, 0.5);
        ctx.lineWidth = 1;
        for (var k = 0; k < 14; k += 1) {
          var y = baseY - (k / 14) * hgt;
          if (y < baseY - hgt) break;
          ctx.beginPath();
          ctx.moveTo(c.x - bw / 2 + 14, y);
          ctx.lineTo(c.x + bw / 2 - 14, y);
          ctx.stroke();
        }
        // 顶部光刃
        CK.glow(ctx, c.x, baseY - hgt, 120, PAL.cyan, 0.2 * grow);
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.8 * grow);
        ctx.fillRect(c.x - bw / 2 - 6, baseY - hgt - 4, bw + 12, 3);
        CK.label(ctx, c.k, c.x, baseY - hgt - 46, 34, PAL.pale, 0.2 + grow * 0.8, 'center');
        CK.label(ctx, '0' + (i + 1) + ' / ' + c.s, c.x, baseY - hgt - 84, 20, PAL.steelDim, 0.75 * grow, 'center');
      }
      // 地面反射
      CK.floorGrid(ctx, { w: W, h: H, vx: W * 0.5, vy: H * 0.82, alpha: 0.16, scroll: (t / D) * 0.06 });
      CK.label(ctx, 'KERNEL  PRIMITIVES  =  3', 96, H * 0.16, 22, PAL.steelDim, 0.8);
      finish(ctx, t);
    },
  };

  /* s03 手工活：一堆焊死的线缆缠成一团，越拉越紧 */
  P.s03 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var cab = [];
      for (var i = 0; i < 26; i += 1) {
        cab.push({ a: r() * 6.28, len: 260 + r() * 420, ph: r() * 6.28, w: 1 + r() * 3.2, curl: 0.4 + r() * 0.9 });
      }
      return { cab: cab };
    },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var cx = W * 0.5, cy = H * 0.5;
      CK.glow(ctx, cx, cy, 520, PAL.ember, 0.12);
      var tighten = CK.smooth(t / D);
      ctx.lineWidth = 2;
      for (var i = 0; i < S.cab.length; i += 1) {
        var c = S.cab[i];
        var len = c.len * (1 - tighten * 0.28);
        ctx.strokeStyle = CK.rgba(i % 5 === 0 ? PAL.ember : PAL.steelDim, 0.35 + (i % 3) * 0.12);
        ctx.lineWidth = c.w;
        ctx.beginPath();
        for (var k = 0; k <= 26; k += 1) {
          var p = k / 26;
          var ang = c.a + Math.sin(p * 3.4 + c.ph + t * 0.7) * c.curl;
          var rr = len * p;
          var x = cx + Math.cos(ang) * rr * 1.25;
          var y = cy + Math.sin(ang) * rr * 0.72 + Math.sin(p * 6 + c.ph) * 18;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // 焊点（几处死结）
      var knots = [[0.42, 0.38], [0.58, 0.62], [0.5, 0.5], [0.36, 0.64]];
      for (var j = 0; j < knots.length; j += 1) {
        var kx = W * knots[j][0], ky = H * knots[j][1];
        var pulse = 0.6 + 0.4 * Math.sin(t * 5 + j * 1.7);
        CK.glow(ctx, kx, ky, 46 * pulse, PAL.ember, 0.5);
        ctx.fillStyle = CK.rgba(PAL.amberHot, 0.85);
        ctx.beginPath(); ctx.arc(kx, ky, 4.5, 0, 6.2832); ctx.fill();
      }
      // 断裂的火花：越拉越紧
      if (!S.sp) {
        var r = CK.mulberry32(99); S.sp = [];
        for (var m = 0; m < 40; m += 1) S.sp.push({ x: cx + (r() - 0.5) * 420, y: cy + (r() - 0.5) * 300, ang: r() * 6.28, len: 40 + r() * 130, v: 0.5 + r(), p: r(), a: 0.4 + r() * 0.5, r: 1 + r() * 2 });
      }
      CK.sparks(ctx, S.sp, t * (0.6 + tighten), PAL.amber);
      CK.label(ctx, 'HANDWIRED  /  COUPLING: HIGH', 96, H * 0.16, 22, PAL.ember, 0.85);
      CK.label(ctx, 'MODEL  x  7  EDIT  POINTS', W - 96, H * 0.16, 22, PAL.steelDim, 0.8, 'right');
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s04 改七处：一张系统图，七个红点亮起，主循环处有一处致命 */
  P.s04 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var nodes = [];
      for (var i = 0; i < 9; i += 1) {
        nodes.push({ x: W * (0.2 + (i % 3) * 0.3), y: H * (0.3 + Math.floor(i / 3) * 0.2), hot: i < 7 });
      }
      var edges = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 5], [3, 4], [4, 5], [3, 6], [4, 7], [5, 8], [6, 7], [7, 8]];
      return { nodes: nodes, edges: edges, jitter: r };
    },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      // 连线
      ctx.lineWidth = 1.4;
      for (var e = 0; e < S.edges.length; e += 1) {
        var a = S.nodes[S.edges[e][0]], b = S.nodes[S.edges[e][1]];
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.55);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        // 数据包
        var p = ((t * 0.35 + e * 0.11) % 1);
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.55);
        ctx.fillRect(CK.lerp(a.x, b.x, p) - 2, CK.lerp(a.y, b.y, p) - 2, 4, 4);
      }
      // 节点：七个红点依次亮起
      for (var i = 0; i < S.nodes.length; i += 1) {
        var n = S.nodes[i];
        var litAt = 0.1 + i * 0.11;
        var on = CK.win(t / D, litAt, litAt + 2, 0.18);
        var col = n.hot ? PAL.ember : PAL.cyanDim;
        ctx.strokeStyle = CK.rgba(n.hot ? PAL.ember : PAL.steel, 0.5 + on * 0.5);
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(n.x, n.y, 26, 0, 6.2832); ctx.stroke();
        if (on > 0.02) CK.glow(ctx, n.x, n.y, 66 * on, col, 0.5 * on);
        ctx.fillStyle = CK.rgba(n.hot ? PAL.amberHot : PAL.steel, 0.5 + on * 0.5);
        ctx.beginPath(); ctx.arc(n.x, n.y, 3.6, 0, 6.2832); ctx.fill();
      }
      // 主循环：唯一一颗心脏，越跳越快
      var hxp = W * 0.5, hyp = H * 0.7;
      var beat = 0.5 + 0.5 * Math.sin(t * (3 + t * 0.6));
      CK.ring(ctx, hxp, hyp, 96, { color: PAL.ember, alpha: 0.35 + beat * 0.4, width: 2, ticks: 24, rot: t * 0.4 });
      CK.glow(ctx, hxp, hyp, 120, PAL.ember, 0.2 + beat * 0.24);
      CK.label(ctx, 'MAIN LOOP', hxp, hyp + 132, 24, PAL.ember, 0.9, 'center');
      CK.label(ctx, '7 / 9  TOUCHED', 96, H * 0.16, 22, PAL.ember, 0.8);
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s05 拆两半：画面被一刀剖开，左半"能变"随波，右半"不该变"稳如基岩 */
  P.s05 = {
    setup: function (seed) { return { du: CK.dust(70, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#5a5245', hazeA: 0.36 } });
      var cut = CK.smooth((t - D * 0.1) / (D * 0.45));
      var mid = W * 0.5;
      // 左：流体（能变的）
      var wob = 0;
      for (var i = 0; i < 12; i += 1) {
        wob += 0.3;
        var y = H * (0.16 + i * 0.062);
        ctx.strokeStyle = CK.rgba(PAL.cyan, 0.1 + i * 0.016);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var x = 0; x <= mid; x += 16) {
          var yy = y + Math.sin(x * 0.006 + t * (1.1 + i * 0.13) + i) * (16 + i * 2.4);
          if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      // 右：结构（不该变的）—— 砖石矩阵
      for (var r2 = 0; r2 < 8; r2 += 1) {
        for (var c2 = 0; c2 < 6; c2 += 1) {
          var bx = mid + 60 + c2 * 118;
          var by = H * 0.2 + r2 * 84;
          if (bx > W - 50) continue;
          var a = 0.18 + 0.3 * (1 - r2 / 8);
          ctx.fillStyle = CK.rgba('#5a5245', a);
          ctx.fillRect(bx, by, 104, 70);
          ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.4);
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, 104, 70);
        }
      }
      // 剖切刀口：一道白热的光，慢慢走下来
      var yTop = H * 0.05, yBot = H * 0.95;
      var tip = CK.lerp(yTop, yBot, cut);
      var g = ctx.createLinearGradient(mid - 4, 0, mid + 4, 0);
      g.addColorStop(0, CK.rgba(PAL.cyan, 0));
      g.addColorStop(0.5, CK.rgba(PAL.pale, 0.95));
      g.addColorStop(1, CK.rgba(PAL.cyan, 0));
      ctx.fillStyle = g;
      ctx.fillRect(mid - 4, yTop, 8, tip - yTop);
      CK.glow(ctx, mid, tip, 260, PAL.cyan, 0.5);
      CK.label(ctx, 'MUTABLE', 96, H * 0.16, 30, PAL.cyan, 0.85);
      CK.label(ctx, 'IMMUTABLE', W - 96, H * 0.16, 30, PAL.steel, 0.85, 'right');
      finish(ctx, t);
    },
  };

  /* s06 内核：一颗立方核心 + 五个轨道环（注册表/生命周期/调度/门控/热替换） */
  P.s06 = {
    setup: function (seed) { return { st: CK.stars(140, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.4 } });
      var cx = W * 0.5, cy = H * 0.5;
      var breathe = 0.5 + 0.5 * Math.sin(t * 1.3);
      CK.glow(ctx, cx, cy, 330 + breathe * 60, PAL.cyan, 0.2);
      // 五个轨道环，各自倾角
      var names = ['REGISTRY', 'LIFECYCLE', 'SCHEDULER', 'GATE', 'HOTSWAP'];
      for (var i = 0; i < 5; i += 1) {
        var rr = 210 + i * 52;
        var tilt = 0.24 + i * 0.08;
        var spin = t * (0.24 + i * 0.07) * (i % 2 ? -1 : 1);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, tilt);
        CK.ring(ctx, 0, 0, rr, { color: i === 3 ? PAL.amber : PAL.cyan, alpha: 0.26 + i * 0.03, width: 1.4 });
        // 轨道上的插件点
        var ang = spin;
        var px = Math.cos(ang) * rr, py = Math.sin(ang) * rr;
        ctx.fillStyle = CK.rgba(i === 3 ? PAL.amberHot : PAL.pale, 0.9);
        ctx.beginPath(); ctx.arc(px, py, 4.2, 0, 6.2832); ctx.fill();
        ctx.restore();
        // 标签沿右上对角线排布
        var lx = cx + rr * 0.72, ly = cy - rr * tilt - 18;
        CK.label(ctx, names[i], lx, ly, 19, i === 3 ? PAL.amber : PAL.steel, 0.62 + 0.2 * Math.sin(t + i));
      }
      // 核心立方（等距，三段明面）
      var s = 96 + breathe * 8;
      ctx.fillStyle = '#5a5245'; ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx - s, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a907e'; ctx.beginPath();
      ctx.moveTo(cx - s, cy); ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx, cy + s * 0.5 + s * 1.15); ctx.lineTo(cx - s, cy + s * 1.15); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a907e'; ctx.beginPath();
      ctx.moveTo(cx + s, cy); ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx, cy + s * 0.5 + s * 1.15); ctx.lineTo(cx + s, cy + s * 1.15); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.7); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx + s, cy); ctx.lineTo(cx + s, cy + s * 1.15); ctx.stroke();
      CK.label(ctx, 'agent-kernel  /  core', cx, cy + s * 2.1, 22, PAL.pale, 0.8, 'center');
      finish(ctx, t);
    },
  };

  /* s07 插件：六个卫星绕核心公转，各自不同半径与转速 */
  P.s07 = {
    setup: function (seed) {
      var names = ['LLM', 'TOOLS', 'MEMORY', 'ORCH', 'PROMPT', 'VECTOR'];
      var arr = [];
      for (var i = 0; i < 6; i += 1) arr.push({ n: names[i], r: 250 + i * 42, sp: 0.3 + i * 0.06, ph: i * 1.05 });
      return { arr: arr, st: CK.stars(90, W, H, seed + 3) };
    },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.34 } });
      var cx = W * 0.5, cy = H * 0.52;
      CK.glow(ctx, cx, cy, 280, PAL.cyan, 0.16);
      // 核心
      var s = 62;
      ctx.fillStyle = '#5a5245';
      ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx - s, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a907e';
      ctx.beginPath(); ctx.moveTo(cx - s, cy); ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx, cy + s * 0.5 + s); ctx.lineTo(cx - s, cy + s); ctx.closePath(); ctx.fill();
      // 卫星
      for (var i = 0; i < S.arr.length; i += 1) {
        var p = S.arr[i];
        var ang = p.ph + t * p.sp;
        var x = cx + Math.cos(ang) * p.r * 1.5;
        var y = cy + Math.sin(ang) * p.r * 0.52;
        var near = 0.5 + 0.5 * Math.sin(ang);
        // 轨道弧
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.35);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.3);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, p.r * 1.5, 0, 6.2832); ctx.stroke();
        ctx.restore();
        // 插件方块
        var sz = 17 + near * 6;
        ctx.fillStyle = CK.rgba('#9a907e', 0.92);
        ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2);
        ctx.strokeStyle = CK.rgba(PAL.cyan, 0.4 + near * 0.5);
        ctx.lineWidth = 1.3;
        ctx.strokeRect(x - sz, y - sz, sz * 2, sz * 2);
        CK.glow(ctx, x, y, 44 + near * 26, PAL.cyan, 0.12 + near * 0.16);
        CK.label(ctx, p.n, x, y - sz - 16, 17, PAL.steel, 0.55 + near * 0.4, 'center');
      }
      CK.label(ctx, 'EVERYTHING ELSE  =  PLUGIN', 96, H * 0.16, 22, PAL.steelDim, 0.85);
      finish(ctx, t);
    },
  };

  /* s08 只能看见 SDK：整面墙是黑的，只有一扇小窗透光 */
  P.s08 = {
    setup: function (seed) { return { du: CK.dust(40, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.2 } });
      // 墙
      ctx.fillStyle = '#6d6355';
      ctx.fillRect(0, 0, W, H);
      var wx = W * 0.5, wy = H * 0.46, ww = 300, wh = 190;
      // 墙体细纹
      ctx.strokeStyle = CK.rgba('#9a907e', 0.9);
      ctx.lineWidth = 1;
      for (var i = 0; i < 40; i += 1) {
        var x = (i / 40) * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      // 窗：唯一的可见面
      var open = CK.smooth((t - D * 0.1) / (D * 0.5));
      var hh = wh * open;
      ctx.save();
      ctx.beginPath(); ctx.rect(wx - ww / 2, wy - hh / 2, ww, hh); ctx.clip();
      var g = ctx.createLinearGradient(wx, wy - hh / 2, wx, wy + hh / 2);
      g.addColorStop(0, CK.rgba(PAL.cyan, 0.5));
      g.addColorStop(0.6, CK.rgba('#5a5245', 0.75));
      g.addColorStop(1, CK.rgba('#9a907e', 0.85));
      ctx.fillStyle = g; ctx.fillRect(wx - ww / 2, wy - hh / 2, ww, hh);
      // 窗内：一行 SDK 面签名（英文，不引中文）
      ctx.fillStyle = CK.rgba(PAL.pale, 0.8);
      ctx.font = '400 17px Consolas, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      var lines = ['use agent_kernel_sdk::*;', 'impl Plugin for MyAgent {', '  async fn on_event(&self, env) {}', '}'];
      for (var k = 0; k < lines.length; k += 1) {
        ctx.globalAlpha = CK.smooth((t - D * 0.28 - k * 0.12) / 0.5) * 0.85;
        ctx.fillText(lines[k], wx - ww / 2 + 22, wy - hh / 2 + 42 + k * 30);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      // 窗框
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.85);
      ctx.lineWidth = 2;
      ctx.strokeRect(wx - ww / 2, wy - hh / 2, ww, hh);
      // 光锥从窗口洒出
      CK.beam(ctx, wx, wy + hh / 2, wx, H * 1.02, ww * 0.9, PAL.cyan, 0.1 * open);
      CK.glow(ctx, wx, wy, 460, PAL.cyan, 0.14 * open);
      CK.label(ctx, 'VISIBLE  SURFACE  =  1', 96, H * 0.14, 22, PAL.cyan, 0.85);
      CK.label(ctx, 'KERNEL INTERNALS  :  NOT REACHABLE', W - 96, H * 0.14, 22, PAL.steelDim, 0.8, 'right');
      finish(ctx, t, { vig: 0.78, grain: 0.12 });
    },
  };

  /* s09 允许/不允许：一道巨大的门，门缝里透着光；门前站着影子 */
  P.s09 = {
    setup: function (seed) { return { du: CK.dust(55, W, H, seed + 5) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#5a5245', hazeA: 0.24 } });
      var cx = W * 0.5;
      // 墙 + 门洞
      ctx.fillStyle = '#6d6355';
      ctx.fillRect(0, 0, W, H);
      var dw = 420, dh = 760, dy = H * 0.94 - dh;
      var open = CK.smooth((t - D * 0.2) / (D * 0.5));
      var gap = 40 + open * 150;
      // 门后光
      var g = ctx.createLinearGradient(cx, dy, cx, dy + dh);
      g.addColorStop(0, CK.rgba(PAL.pale, 0.9));
      g.addColorStop(1, CK.rgba(PAL.cyan, 0.25));
      ctx.fillStyle = g;
      ctx.fillRect(cx - gap / 2, dy, gap, dh);
      CK.glow(ctx, cx, dy + dh * 0.5, 420, PAL.cyan, 0.32 * open);
      // 两扇门板（石质，带铆钉）
      function panel(dir) {
        var x0 = dir < 0 ? cx - dw / 2 - gap / 2 : cx + gap / 2;
        var wPanel = dw / 2;
        var grd = ctx.createLinearGradient(x0, 0, x0 + wPanel * dir, 0);
        grd.addColorStop(0, '#9a907e');
        grd.addColorStop(1, '#6d6355');
        ctx.fillStyle = grd;
        ctx.fillRect(dir < 0 ? x0 : x0, dy, wPanel, dh);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
        ctx.lineWidth = 2;
        ctx.strokeRect(dir < 0 ? x0 : x0, dy, wPanel, dh);
        ctx.fillStyle = CK.rgba(PAL.steelDim, 0.35);
        for (var r = 0; r < 9; r += 1) {
          for (var c = 0; c < 2; c += 1) {
            ctx.beginPath();
            ctx.arc(x0 + (c + 0.5) * (wPanel / 2), dy + 60 + r * 82, 3.4, 0, 6.2832);
            ctx.fill();
          }
        }
      }
      panel(-1); panel(1);
      // 影子：一个人形贴在门缝前，光把它打成剪影
      var fig = CK.smooth((t - D * 0.45) / (D * 0.4));
      CK.figure(ctx, cx + 26, H * 0.94, 430, { color: '#6d6355', alpha: 0.5 + fig * 0.45 });
      CK.label(ctx, 'CAPABILITY GATE  /  DENY BY DEFAULT', 96, H * 0.12, 22, PAL.steel, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s10 三种隔离：三层同心壳，由内到外越来越厚 */
  P.s10 = {
    setup: function (seed) { return { st: CK.stars(110, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.34 } });
      var cx = W * 0.5, cy = H * 0.5;
      var layers = [
        { r: 150, n: 'IN-PROCESS', d: '0.4 us', c: PAL.cyan, a: 0.9 },
        { r: 268, n: 'WASM', d: 'linear mem', c: '#30a65a', a: 0.75 },
        { r: 400, n: 'PROCESS', d: 'self-heal', c: PAL.amber, a: 0.7 },
      ];
      for (var i = 0; i < layers.length; i += 1) {
        var L = layers[i];
        var grow = CK.smooth((t - 0.1 - i * 0.28) / (D * 0.5));
        if (grow <= 0.01) continue;
        var rr = L.r * grow;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.62);
        CK.ring(ctx, 0, 0, rr, { color: L.c, alpha: 0.4 + i * 0.08, width: 2.4 - i * 0.4 });
        // 壳层填充（极淡）
        var g = ctx.createRadialGradient(0, 0, rr * 0.82, 0, 0, rr);
        g.addColorStop(0, CK.rgba(L.c, 0));
        g.addColorStop(1, CK.rgba(L.c, 0.1));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, 6.2832); ctx.fill();
        ctx.restore();
        CK.label(ctx, L.n, cx + rr * 0.74, cy + rr * 0.62 * 0.62 + (i === 2 ? 26 : 0), 20, L.c, 0.85 * grow);
        CK.label(ctx, L.d, cx + rr * 0.74, cy + rr * 0.62 * 0.62 + (i === 2 ? 50 : 24), 16, PAL.steelDim, 0.7 * grow);
      }
      // 核心一颗点
      var beat = 0.6 + 0.4 * Math.sin(t * 3);
      CK.glow(ctx, cx, cy, 60 * beat, PAL.cyan, 0.7);
      ctx.fillStyle = PAL.pale;
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 6.2832); ctx.fill();
      CK.label(ctx, 'ISOLATION COST  ~  SELECTABLE', 96, H * 0.14, 22, PAL.steelDim, 0.85);
      finish(ctx, t);
    },
  };

  /* s11 一份线协议：三条不同颜色的输入线，汇成同一束光 */
  P.s11 = {
    setup: function (seed) { return { du: CK.dust(45, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#5a5245', hazeA: 0.3 } });
      var midY = H * 0.5;
      var langs = [
        { y: H * 0.26, n: 'RUST', c: '#b45622' },
        { y: H * 0.5, n: 'PYTHON', c: '#1e66b8' },
        { y: H * 0.74, n: 'TYPESCRIPT', c: '#b8a21e' },
      ];
      var convX = W * 0.62;
      for (var i = 0; i < langs.length; i += 1) {
        var L = langs[i];
        var draw01 = CK.smooth((t - i * 0.15) / (D * 0.5));
        ctx.strokeStyle = CK.rgba(L.c, 0.18 + draw01 * 0.6);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        var steps = 40;
        for (var k = 0; k <= steps; k += 1) {
          var p = (k / steps) * draw01;
          var x = CK.lerp(150, convX, p);
          var y = CK.lerp(L.y, midY, Math.pow(p, 2.2));
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        CK.label(ctx, L.n, 96, L.y, 24, L.c, 0.55 + draw01 * 0.45);
        // 流动的数据点
        var flow = ((t * 0.4 + i * 0.2) % 1);
        var fx = CK.lerp(150, convX, flow);
        var fy = CK.lerp(L.y, midY, Math.pow(flow, 2.2));
        ctx.fillStyle = CK.rgba(L.c, 0.9);
        ctx.fillRect(fx - 3, fy - 3, 6, 6);
      }
      // 汇合后的单一束：粗白热光柱向右延伸到边缘
      var mergeA = CK.smooth((t - D * 0.42) / (D * 0.4));
      if (mergeA > 0.01) {
        var g = ctx.createLinearGradient(convX, 0, W, 0);
        g.addColorStop(0, CK.rgba(PAL.pale, 0.9 * mergeA));
        g.addColorStop(0.35, CK.rgba(PAL.cyan, 0.5 * mergeA));
        g.addColorStop(1, CK.rgba(PAL.cyan, 0));
        ctx.fillStyle = g;
        ctx.fillRect(convX, midY - 6 * mergeA, W - convX, 12 * mergeA);
        CK.glow(ctx, convX, midY, 320, PAL.cyan, 0.3 * mergeA);
      }
      CK.label(ctx, 'ONE WIRE PROTOCOL  /  ONE CONTRACT', 96, H * 0.86, 22, PAL.steel, 0.85);
      CK.label(ctx, 'kernel.proto   kernel.wit', W - 96, H * 0.86, 20, PAL.steelDim, 0.8, 'right');
      finish(ctx, t);
    },
  };

  /* s12 那一刻：秒针逼近刻度，全画面屏息 */
  P.s12 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var cx = W * 0.5, cy = H * 0.5;
      var R = 300;
      CK.ring(ctx, cx, cy, R, { color: PAL.steel, alpha: 0.34, width: 2 });
      CK.ring(ctx, cx, cy, R * 0.86, { color: PAL.steelDim, alpha: 0.22, width: 1 });
      // 60 刻度
      for (var i = 0; i < 60; i += 1) {
        var a = (i / 60) * 6.2832 - Math.PI / 2;
        var major = i % 5 === 0;
        var r1 = R * 0.94, r2 = R * (major ? 0.86 : 0.9);
        ctx.strokeStyle = CK.rgba(major ? PAL.pale : PAL.steelDim, major ? 0.6 : 0.35);
        ctx.lineWidth = major ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.stroke();
      }
      // 秒针：最后一秒被拉长（屏息）
      var prog = CK.smooth(t / D);
      var ang = -Math.PI / 2 + prog * 6.2832 * 0.995;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.strokeStyle = CK.rgba(PAL.amberHot, 0.95);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-30, 0); ctx.lineTo(R * 0.88, 0); ctx.stroke();
      ctx.restore();
      CK.glow(ctx, cx + Math.cos(ang) * R * 0.86, cy + Math.sin(ang) * R * 0.86, 90, PAL.amber, 0.5);
      // 中心：即将被替换的方块
      var pre = CK.smooth((t - D * 0.72) / (D * 0.25));
      var sz = 34;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(pre * 0.6);
      ctx.fillStyle = CK.rgba('#9a907e', 0.95);
      ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.4 + pre * 0.6);
      ctx.lineWidth = 2;
      ctx.strokeRect(-sz, -sz, sz * 2, sz * 2);
      ctx.restore();
      CK.label(ctx, 'T  -  0.001 s', W * 0.5, H * 0.86, 26, PAL.amber, 0.85, 'center');
      finish(ctx, t, { vig: 0.7, grain: 0.11 });
    },
  };

  /* s13 交接：两个方块互换位置，中间一束请求粒子不间断穿过 */
  P.s13 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var ps = [];
      for (var i = 0; i < 70; i += 1) ps.push({ y: r(), sp: 0.35 + r() * 0.7, p: r(), a: 0.3 + r() * 0.6, s: 1 + r() * 2 });
      return { ps: ps };
    },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#5a5245', hazeA: 0.34 } });
      var L = W * 0.3, Rr = W * 0.7, cy = H * 0.5;
      var swap = CK.smooth((t - D * 0.18) / (D * 0.42));
      var sz = 78;
      // 在途请求流：永不断流（画的顺序在方块之下）
      for (var i = 0; i < S.ps.length; i += 1) {
        var p = S.ps[i];
        var x = ((p.p + t * p.sp * 0.22) % 1) * W;
        var y = H * 0.24 + p.y * H * 0.52;
        // 绕过交接区时轻微上抬（不丢包）
        var bump = Math.exp(-Math.pow((x - W * 0.5) / 260, 2)) * 30;
        ctx.fillStyle = CK.rgba(PAL.cyan, p.a * 0.85);
        ctx.fillRect(x, y - bump, p.s * 2.2, p.s);
      }
      // 两个方块：左旧（琥珀），右新（青）
      function box(x, col, alpha, txt, tag) {
        ctx.fillStyle = CK.rgba('#9a907e', alpha);
        ctx.fillRect(x - sz, cy - sz, sz * 2, sz * 2);
        ctx.strokeStyle = CK.rgba(col, 0.55 + alpha * 0.4);
        ctx.lineWidth = 2.2;
        ctx.strokeRect(x - sz, cy - sz, sz * 2, sz * 2);
        CK.label(ctx, txt, x, cy - 8, 26, col, alpha, 'center');
        CK.label(ctx, tag, x, cy + 26, 17, PAL.steelDim, alpha * 0.9, 'center');
        CK.glow(ctx, x, cy, 150, col, 0.16 * alpha);
      }
      var ax = CK.lerp(L, Rr, swap);
      var bx = CK.lerp(Rr, L, swap);
      var fadeOut = 1 - swap;
      var fadeIn = swap;
      box(ax, PAL.amber, 0.25 + fadeOut * 0.75, 'v1.0', 'DRAINING');
      box(bx, PAL.cyan, 0.25 + fadeIn * 0.75, 'v1.1', 'READY');
      // 状态迁移的光带：从旧到新
      if (swap > 0.05 && swap < 0.98) {
        var g = ctx.createLinearGradient(ax, cy, bx, cy);
        g.addColorStop(0, CK.rgba(PAL.amber, 0.5));
        g.addColorStop(1, CK.rgba(PAL.cyan, 0.5));
        ctx.strokeStyle = g;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(ax, cy + sz + 40);
        ctx.quadraticCurveTo((ax + bx) / 2, cy + sz + 120, bx, cy + sz + 40);
        ctx.stroke();
      }
      CK.label(ctx, 'IN-FLIGHT  :  0  LOST', 96, H * 0.14, 22, PAL.cyan, 0.85);
      CK.label(ctx, 'SNAPSHOT -> RESTORE', W - 96, H * 0.14, 22, PAL.steelDim, 0.8, 'right');
      finish(ctx, t);
    },
  };

  /* s14 一次事务：六个环节沿一条轨道依次点亮 */
  P.s14 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var steps = ['VALIDATE', 'LOAD', 'SNAPSHOT', 'RESTORE', 'DRAIN', 'DESTROY'];
      var y = H * 0.52;
      var x0 = 190, x1 = W - 190;
      // 轨道
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      var prog = CK.smooth(t / D);
      // 进度光
      var grad = ctx.createLinearGradient(x0, y, x1, y);
      grad.addColorStop(0, CK.rgba(PAL.cyan, 0.85));
      grad.addColorStop(1, CK.rgba(PAL.amber, 0.85));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(CK.lerp(x0, x1, prog), y); ctx.stroke();
      for (var i = 0; i < steps.length; i += 1) {
        var sx = CK.lerp(x0, x1, i / (steps.length - 1));
        var on = CK.win(prog, i / steps.length - 0.04, i / steps.length + 0.16, 0.06);
        var done = prog > (i + 0.5) / steps.length;
        var col = done ? (i < 4 ? PAL.cyan : PAL.amber) : PAL.steelDim;
        CK.glow(ctx, sx, y, 58 * (0.4 + on), col, 0.2 + on * 0.4);
        ctx.fillStyle = CK.rgba(col, done ? 0.95 : 0.45);
        ctx.beginPath(); ctx.arc(sx, y, done ? 9 : 6, 0, 6.2832); ctx.fill();
        // 编号与名字交错上下
        var up = i % 2 === 0;
        CK.label(ctx, '0' + (i + 1), sx, y + (up ? -46 : 46), 22, col, 0.6 + on * 0.4, 'center');
        CK.label(ctx, steps[i], sx, y + (up ? -76 : 76), 20, PAL.steel, 0.45 + on * 0.5, 'center');
      }
      CK.label(ctx, 'HOT SWAP  =  ONE TRANSACTION', W * 0.5, H * 0.2, 26, PAL.pale, 0.8, 'center');
      finish(ctx, t);
    },
  };

  /* s15 换刀：一柄刀从画面右侧推入，刃口反光扫过 */
  P.s15 = {
    setup: function (seed) { return { du: CK.dust(35, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.28 } });
      var push = CK.smooth(t / (D * 0.55));
      var bx = CK.lerp(W * 0.86, W * 0.42, push);
      var by = H * 0.5;
      // 刀柄（木质暗调）
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(-0.16);
      ctx.fillStyle = '#9a907e';
      ctx.fillRect(-10, -22, 300, 44);
      ctx.fillStyle = CK.rgba('#5a5245', 0.9);
      for (var i = 0; i < 7; i += 1) ctx.fillRect(20 + i * 40, -20, 6, 40);
      // 护手
      ctx.fillStyle = '#a67530';
      ctx.fillRect(-26, -46, 18, 92);
      // 刃
      var g = ctx.createLinearGradient(-480, 0, -26, 0);
      g.addColorStop(0, '#306da6');
      g.addColorStop(0.45, '#306da6');
      g.addColorStop(0.75, '#2e6ba8');
      g.addColorStop(1, '#306da6');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-26, -20);
      ctx.lineTo(-470, -9);
      ctx.lineTo(-506, 0);
      ctx.lineTo(-470, 10);
      ctx.lineTo(-26, 22);
      ctx.closePath();
      ctx.fill();
      // 刃口反光
      var sh = ((t * 0.55) % 1);
      var sx = CK.lerp(-500, -30, sh);
      var sg = ctx.createLinearGradient(sx - 40, 0, sx + 40, 0);
      sg.addColorStop(0, CK.rgba('#ffffff', 0));
      sg.addColorStop(0.5, CK.rgba('#ffffff', 0.9));
      sg.addColorStop(1, CK.rgba('#ffffff', 0));
      ctx.fillStyle = sg;
      ctx.fillRect(sx - 40, -22, 80, 44);
      ctx.restore();
      // 被切开的两半空间（暗处裂口）
      var split = CK.smooth((t - D * 0.4) / (D * 0.4));
      if (split > 0.02) {
        ctx.fillStyle = CK.rgba(PAL.amber, 0.08 * split);
        ctx.fillRect(0, H * 0.5 - 2 * split, W, 4 * split);
        CK.glow(ctx, bx, by, 420, PAL.amber, 0.18 * split);
      }
      CK.label(ctx, 'NO RESTART  /  LIVE SWAP', 96, H * 0.14, 22, PAL.amber, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s16 三道闸：门控/熔断/超时，三组拦截正在发生 */
  P.s16 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var reqs = [];
      for (var i = 0; i < 26; i += 1) reqs.push({ p: r(), y: r(), sp: 0.2 + r() * 0.3, blocked: r() > 0.55 });
      return { reqs: reqs };
    },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#5a5245', hazeA: 0.3 } });
      var xs = [W * 0.34, W * 0.56, W * 0.78];
      // 三扇闸门（竖立的栅格）
      for (var g = 0; g < 3; g += 1) {
        var x = xs[g];
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.55);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, H * 0.18); ctx.lineTo(x, H * 0.88); ctx.stroke();
        for (var k = 0; k < 12; k += 1) {
          var y = H * (0.2 + k * 0.058);
          ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.3);
          ctx.beginPath(); ctx.moveTo(x - 26, y); ctx.lineTo(x + 26, y); ctx.stroke();
        }
        CK.label(ctx, ['GATE', 'BREAKER', 'TIMEOUT'][g], x, H * 0.13, 20, PAL.steel, 0.8, 'center');
      }
      // 请求点：越权的撞在闸门上被截停（溅出火花）
      for (var i = 0; i < S.reqs.length; i += 1) {
        var q = S.reqs[i];
        var gate = Math.floor(q.p * 3);
        var startX = W * (0.06 + (q.p % 0.2));
        var gx = xs[gate];
        var speed = 0.16 + q.sp * 0.2;
        var travel = ((t * speed + q.p) % 1);
        var px = q.blocked ? CK.lerp(startX, gx - 8, Math.min(1, travel * 1.6)) : CK.lerp(startX, W * 0.96, travel);
        var py = H * (0.24 + q.y * 0.58);
        var stopped = q.blocked && travel * 1.6 >= 1;
        var col = stopped ? PAL.ember : PAL.cyan;
        ctx.fillStyle = CK.rgba(col, stopped ? 0.9 : 0.6);
        ctx.fillRect(px, py, 9, 3);
        if (stopped) {
          var sp = Math.exp(-(travel * 1.6 - 1) * 4);
          CK.glow(ctx, px + 8, py + 1, 26 * sp, PAL.amber, 0.5 * sp);
        }
      }
      CK.label(ctx, 'VIOLATION  X  BLOCKED', 96, H * 0.92, 22, PAL.ember, 0.9);
      finish(ctx, t);
    },
  };

  /* s17 工具箱自改：一架工具墙，一只机械臂伸向自己的工具 */
  P.s17 = {
    setup: function (seed) { return { du: CK.dust(40, W, H, seed + 9) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.22 } });
      // 工具墙格架
      var cols = 6, rows = 3;
      for (var c = 0; c < cols; c += 1) {
        for (var r = 0; r < rows; r += 1) {
          var x = W * 0.42 + c * 92, y = H * 0.22 + r * 116;
          ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
          ctx.lineWidth = 1.4;
          ctx.strokeRect(x, y, 78, 96);
          // 工具剪影
          ctx.fillStyle = CK.rgba('#9a907e', 0.95);
          ctx.fillRect(x + 22, y + 20, 10, 56);
          ctx.fillRect(x + 14, y + 68, 26, 8);
          if ((c + r) % 4 === 0) {
            var hot = 0.5 + 0.5 * Math.sin(t * 2.4 + c + r);
            CK.glow(ctx, x + 39, y + 48, 40 * hot, PAL.amber, 0.22 * hot);
          }
        }
      }
      // 机械臂：从左侧伸入，指向其中一把工具（琥珀色描边）
      var reach = CK.smooth((t - D * 0.12) / (D * 0.5));
      var j1 = { x: -80, y: H * 0.78 };
      var j2 = { x: CK.lerp(180, 420, reach), y: CK.lerp(H * 0.86, H * 0.62, reach) };
      var tx = W * 0.42 + 4 * 92 + 39, ty = H * 0.22 + 1 * 116 + 48;
      var j3 = { x: CK.lerp(j2.x, tx, reach * 0.92), y: CK.lerp(j2.y, ty, reach * 0.92) };
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.75);
      ctx.lineWidth = 13;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(j1.x, j1.y);
      ctx.lineTo(j2.x, j2.y);
      ctx.lineTo(j3.x, j3.y);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.strokeStyle = CK.rgba(PAL.amberHot, 0.7);
      ctx.stroke();
      // 关节
      [[j2.x, j2.y], [j3.x, j3.y]].forEach(function (p) {
        ctx.fillStyle = '#9a907e';
        ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.9);
        ctx.lineWidth = 2.4;
        ctx.stroke();
      });
      // 指尖光
      if (reach > 0.9) CK.glow(ctx, j3.x, j3.y, 70, PAL.amber, 0.4);
      CK.label(ctx, 'SELF-MODIFY  /  TARGET: OWN TOOLSET', 96, H * 0.12, 22, PAL.amber, 0.85);
      finish(ctx, t);
    },
  };

  /* s18 测/评/准入：三枚印章依次落下 */
  P.s18 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var items = ['TEST', 'EVAL', 'ADMIT'];
      var cx = W * 0.5, cy = H * 0.5;
      for (var i = 0; i < 3; i += 1) {
        var appear = CK.smooth((t - 0.2 - i * (D * 0.24)) / (D * 0.28));
        if (appear <= 0.01) continue;
        var ang = -0.5 + i * 0.5;
        var px = cx + Math.cos(ang) * 380;
        var py = cy + Math.sin(ang) * 110;
        var sc = 0.7 + appear * 0.3;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-0.1 + i * 0.1);
        ctx.scale(sc, sc);
        // 印章圆环
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.35 + appear * 0.6);
        ctx.lineWidth = 3.4;
        ctx.beginPath(); ctx.arc(0, 0, 98, 0, 6.2832); ctx.stroke();
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, 84, 0, 6.2832); ctx.stroke();
        CK.label(ctx, items[i], 0, -6, 30, PAL.amberHot, 0.4 + appear * 0.6, 'center');
        CK.label(ctx, 'PASS', 0, 34, 16, PAL.steel, 0.4 + appear * 0.5, 'center');
        ctx.restore();
        CK.glow(ctx, px, py, 190, PAL.amber, 0.1 * appear);
      }
      // 底下一条证据线
      var line = CK.smooth((t - D * 0.55) / (D * 0.35));
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.5 * line);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(W * 0.2, H * 0.8); ctx.lineTo(W * 0.2 + W * 0.6 * line, H * 0.8); ctx.stroke();
      CK.label(ctx, 'EVIDENCE CHAIN  -  NO HUMAN WATCHING', W * 0.5, H * 0.87, 22, PAL.steel, 0.8, 'center');
      finish(ctx, t);
    },
  };

  /* s19 地基：巨大的板体在虚空中升起，上面承载微小的建筑 */
  P.s19 = {
    setup: function (seed) { return { st: CK.stars(200, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, bg: { haze: '#9a907e', hazeA: 0.4, hy: H * 0.72 } });
      var cx = W * 0.5;
      var rise = CK.smooth(t / (D * 0.7));
      var fy = CK.lerp(H * 1.12, H * 0.68, rise);
      // 板体（等距厚板）
      ctx.save();
      var pw = 620, ph = 40, th = 90;
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx, fy - ph);
      ctx.lineTo(cx + pw, fy);
      ctx.lineTo(cx, fy + ph);
      ctx.lineTo(cx - pw, fy);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx - pw, fy);
      ctx.lineTo(cx, fy + ph);
      ctx.lineTo(cx, fy + ph + th);
      ctx.lineTo(cx - pw, fy + th);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx + pw, fy);
      ctx.lineTo(cx, fy + ph);
      ctx.lineTo(cx, fy + ph + th);
      ctx.lineTo(cx + pw, fy + th);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.6);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx - pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx + pw, fy); ctx.stroke();
      ctx.restore();
      // 板上的微小建筑（三个小立方 = 三仓）
      var up = Math.max(0, rise - 0.35) / 0.65;
      CK.cube(ctx, cx - 150, fy - 26, 44 * up, 60 * up, { edge: PAL.cyan });
      CK.cube(ctx, cx + 10, fy - 34, 52 * up, 74 * up, { edge: PAL.cyan });
      CK.cube(ctx, cx + 168, fy - 24, 40 * up, 54 * up, { edge: PAL.amber });
      CK.glow(ctx, cx, fy + 20, 520, PAL.cyan, 0.14);
      CK.label(ctx, 'FOUNDATION  /  LOAD-BEARING', 96, H * 0.88, 24, PAL.cyan, 0.85);
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s20 进化：镜头拉远，地基变小，星场扩散 */
  P.s20 = {
    setup: function (seed) { return { st: CK.stars(260, W, H, seed), du: CK.dust(60, W, H, seed + 4) }; },
    draw: function (ctx, t, D, S) {
      frame(ctx, t, D, { stars: S.st, dust: S.du, bg: { haze: '#5a5245', hazeA: 0.36, hy: H * 0.6 } });
      var pull = CK.smooth(t / D);
      var sc = CK.lerp(1.0, 0.34, pull);
      var cx = W * 0.5, cy = CK.lerp(H * 0.62, H * 0.5, pull);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(sc, sc);
      ctx.translate(-cx, -cy);
      // 板体
      var pw = 560, ph = 34, th = 76, fy = H * 0.66;
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx, fy - ph); ctx.lineTo(cx + pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx - pw, fy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx - pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx, fy + ph + th); ctx.lineTo(cx - pw, fy + th); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.55); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx - pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx + pw, fy); ctx.stroke();
      CK.cube(ctx, cx - 140, fy - 30, 46, 62, { edge: PAL.cyan });
      CK.cube(ctx, cx + 6, fy - 38, 54, 78, { edge: PAL.cyan });
      CK.cube(ctx, cx + 156, fy - 26, 40, 56, { edge: PAL.amber });
      ctx.restore();
      // 上升的光粒（进化）
      for (var i = 0; i < 46; i += 1) {
        var p = ((t * 0.14 + i * 0.037) % 1);
        var x = W * 0.18 + ((i * 137) % W) * 0.64;
        var y = H * 0.9 - p * H * 0.8;
        ctx.fillStyle = CK.rgba(i % 5 === 0 ? PAL.amber : PAL.cyan, (1 - p) * 0.6);
        ctx.fillRect(x, y, 2, 2 + p * 3);
      }
      CK.glow(ctx, W * 0.5, H * 0.5, 620, PAL.cyan, 0.14);
      CK.title(ctx, 'agent-kernel', W * 0.5, H * 0.19, 54, PAL.pale, CK.smooth((t - D * 0.35) / (D * 0.3)));
      CK.label(ctx, 'github.com/zh2673-git/agent-kernel', W * 0.5, H * 0.19 + 46, 24, PAL.cyan, CK.smooth((t - D * 0.45) / (D * 0.3)) * 0.9, 'center');
      finish(ctx, t, { vig: 0.6 });
    },
  };

  global.CK_PROGRAMS = P;
})(window);
