// ra-programs：react-agent 宣传片逐镜画面程序（画面 = f(t, D)，逐帧可复现）
// 视觉体系：暖金属 / 冷界面青 / 琥珀"手"；ReAct 四拍是贯穿母题（四个呼吸节点）
(function (global) {
  'use strict';
  var CK = global.CK;
  var PAL = CK.PAL;
  var W = 1920, H = 1080;
  var WARM = { metal: '#a66f30', metalLit: '#ab732c', warm: '#b46222', deepWarm: '#9a907e' };

  function base(ctx, t, o) {
    o = o || {};
    CK.backdrop(ctx, W, H, o.bg || {});
  }
  function finish(ctx, t, o) {
    o = o || {};
    CK.grain(ctx, W, H, o.grain == null ? 0.1 : o.grain, t);
    CK.vignette(ctx, W, H, o.vig == null ? 0.64 : o.vig);
    CK.letterbox(ctx, W, H, 0.075);
  }

  var P = {};

  /* s01 机器醒来：一片黑暗里，一对眼睛状的光点缓缓睁开 */
  P.s01 = {
    setup: function (seed) { return { st: CK.stars(70, W, H, seed), du: CK.dust(30, W, H, seed + 2) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, dust: S.du, bg: { haze: '#9a907e', hazeA: 0.3 } });
      var open = CK.smooth((t - D * 0.2) / (D * 0.55));
      var cy = H * 0.46;
      // 头部轮廓（极暗，只靠一线光勾出）
      ctx.save();
      ctx.strokeStyle = CK.rgba(WARM.metalLit, 0.18 + open * 0.32);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(W * 0.5, cy, 240, 290, 0, Math.PI * 1.06, Math.PI * 1.94);
      ctx.stroke();
      ctx.restore();
      // 两只"眼睛"：横向光缝逐渐张开
      for (var i = 0; i < 2; i += 1) {
        var ex = W * 0.5 + (i ? 74 : -74);
        var hh = 2 + open * 22;
        var g = ctx.createLinearGradient(ex - 54, 0, ex + 54, 0);
        g.addColorStop(0, CK.rgba(PAL.cyan, 0));
        g.addColorStop(0.5, CK.rgba(i ? PAL.cyan : PAL.amberHot, 0.35 + open * 0.6));
        g.addColorStop(1, CK.rgba(PAL.cyan, 0));
        ctx.fillStyle = g;
        ctx.fillRect(ex - 54, cy - hh / 2, 108, hh);
        CK.glow(ctx, ex, cy, 90 + open * 70, i ? PAL.cyan : PAL.amber, 0.16 + open * 0.3);
      }
      // 第一次"看"：一束扫光向左横扫（看向自己的手）
      var sweep = CK.win(t, D * 0.5, D * 0.86, 0.5);
      if (sweep > 0.01) {
        var sx = CK.lerp(W * 0.62, W * 0.28, CK.smooth((t - D * 0.5) / (D * 0.36)));
        ctx.fillStyle = CK.rgba(PAL.amber, 0.1 * sweep);
        ctx.beginPath();
        ctx.moveTo(W * 0.5, cy);
        ctx.lineTo(sx - 120, H * 0.95);
        ctx.lineTo(sx + 120, H * 0.95);
        ctx.closePath();
        ctx.fill();
        CK.glow(ctx, sx, H * 0.86, 200, PAL.amber, 0.22 * sweep);
      }
      CK.label(ctx, 'WAKE  /  FIRST LOOK', 96, H * 0.86, 22, WARM.metal, 0.85);
      finish(ctx, t, { vig: 0.78 });
    },
  };

  /* s02 手：一只结构化的机械手，五指逐节亮起 */
  P.s02 = {
    setup: function (seed) { return { du: CK.dust(40, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.34, hy: H * 0.6 } });
      var cx = W * 0.5, cy = H * 0.62;
      var lit = CK.smooth(t / (D * 0.7));
      // 手掌
      ctx.fillStyle = '#6d6355';
      ctx.strokeStyle = CK.rgba(WARM.metal, 0.7);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx - 90, cy - 40, 180, 150, 18) : ctx.rect(cx - 90, cy - 40, 180, 150);
      ctx.fill(); ctx.stroke();
      // 五指：每指两节，逐指点亮（从拇指到小指）
      for (var f = 0; f < 5; f += 1) {
        var on = CK.win(lit, f * 0.16, f * 0.16 + 0.5, 0.12);
        var ang = -0.9 + f * 0.34;
        var baseX = cx - 66 + f * 33, baseY = cy - 30;
        var L = f === 0 ? 90 : 130 - Math.abs(f - 2) * 10;
        var col = on > 0.2 ? PAL.amberHot : WARM.metal;
        for (var s = 0; s < 2; s += 1) {
          var sx = baseX + Math.cos(ang) * L * (s * 0.5);
          var sy = baseY + Math.sin(ang) * L * (s * 0.5);
          var ex2 = baseX + Math.cos(ang) * L * ((s + 1) * 0.5);
          var ey2 = baseY + Math.sin(ang) * L * ((s + 1) * 0.5);
          ctx.strokeStyle = CK.rgba(col, 0.35 + on * 0.6);
          ctx.lineWidth = 9 - s * 2;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex2, ey2); ctx.stroke();
          ctx.fillStyle = '#6d6355';
          ctx.beginPath(); ctx.arc(ex2, ey2, 6 - s, 0, 6.2832); ctx.fill();
          ctx.strokeStyle = CK.rgba(col, 0.5 + on * 0.4);
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(ex2, ey2, 6 - s, 0, 6.2832); ctx.stroke();
        }
        if (on > 0.15) CK.glow(ctx, baseX, baseY - 10, 90 * on, PAL.amber, 0.2 * on);
      }
      CK.glow(ctx, cx, cy + 40, 340, PAL.amber, 0.1 + lit * 0.12);
      CK.label(ctx, 'GRIP  /  REWRITE', 96, H * 0.86, 22, WARM.metal, 0.85);
      CK.label(ctx, 'EFFECTOR  :  SELF', W - 96, H * 0.86, 22, PAL.steelDim, 0.8, 'right');
      finish(ctx, t, { vig: 0.72 });
    },
  };

  /* s03 ReAct 四拍：四个节点沿环依次点亮，箭头连成循环 */
  P.s03 = {
    setup: function (seed) { return { st: CK.stars(90, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.32 } });
      var cx = W * 0.5, cy = H * 0.52, R = 270;
      var names = ['PERCEIVE', 'PLAN', 'ACT', 'OBSERVE'];
      // 环
      CK.ring(ctx, cx, cy, R, { color: PAL.steelDim, alpha: 0.4, width: 2 });
      var prog = CK.smooth(t / D);
      // 四段弧，依次被"点燃"
      for (var i = 0; i < 4; i += 1) {
        var a0 = -Math.PI / 2 + i * (Math.PI / 2);
        var on = CK.win(prog, i * 0.22, i * 0.22 + 0.34, 0.08);
        ctx.strokeStyle = CK.rgba(on > 0.2 ? PAL.amber : PAL.steelDim, 0.3 + on * 0.6);
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.arc(cx, cy, R, a0 + 0.10, a0 + Math.PI / 2 - 0.10);
        ctx.stroke();
        // 节点
        var nx = cx + Math.cos(a0) * R, ny = cy + Math.sin(a0) * R;
        var nn = CK.win(prog, i * 0.22 - 0.02, i * 0.22 + 0.5, 0.07);
        CK.glow(ctx, nx, ny, 90 * (0.3 + nn), on > 0.2 ? PAL.amber : PAL.cyanDim, 0.16 + nn * 0.3);
        ctx.fillStyle = CK.rgba(on > 0.2 ? PAL.amberHot : PAL.steel, 0.5 + nn * 0.5);
        ctx.beginPath(); ctx.arc(nx, ny, 7 + nn * 3, 0, 6.2832); ctx.fill();
        CK.label(ctx, names[i], nx + Math.cos(a0) * 74, ny + Math.sin(a0) * 74, 21, on > 0.2 ? PAL.amberHot : PAL.steel, 0.5 + nn * 0.5, 'center');
      }
      // 中心：一颗"轮"计数
      var beat = 0.5 + 0.5 * Math.sin(t * 2.6);
      CK.glow(ctx, cx, cy, 130, PAL.cyan, 0.12 + beat * 0.1);
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.5);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, 52, 0, 6.2832); ctx.stroke();
      CK.label(ctx, 'LOOP', cx, cy - 8, 20, PAL.cyan, 0.9, 'center');
      CK.label(ctx, 'n = 1', cx, cy + 20, 16, PAL.steel, 0.7, 'center');
      finish(ctx, t);
    },
  };

  /* s04 一轮一轮逼近：同心的推动波，从中心向外扩，越扩越亮 */
  P.s04 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#5a5245', hazeA: 0.3 } });
      var cx = W * 0.5, cy = H * 0.52;
      // 三层同心波，错相扩散
      for (var k = 0; k < 4; k += 1) {
        var p = ((t * 0.28 + k * 0.25) % 1);
        var r = 60 + p * 760;
        var a = (1 - p) * 0.5;
        ctx.strokeStyle = CK.rgba(k % 2 ? PAL.cyan : PAL.amber, a * 0.7);
        ctx.lineWidth = 2.4 - p * 1.6;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.stroke();
      }
      // 中心：一颗持续收敛的核
      var beat = 0.5 + 0.5 * Math.sin(t * 3.4);
      CK.glow(ctx, cx, cy, 70 + beat * 40, PAL.amber, 0.4 + beat * 0.3);
      ctx.fillStyle = PAL.amberHot;
      ctx.beginPath(); ctx.arc(cx, cy, 5 + beat * 3, 0, 6.2832); ctx.fill();
      // 一条向外的轨迹：答数逐渐逼近
      var reach = CK.smooth(t / (D * 0.85));
      ctx.strokeStyle = CK.rgba(PAL.pale, 0.35);
      ctx.lineWidth = 1.4;
      ctx.setLineDash && ctx.setLineDash([8, 12]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(W * 0.92, cy); ctx.stroke();
      ctx.setLineDash && ctx.setLineDash([]);
      ctx.fillStyle = CK.rgba(PAL.pale, 0.9);
      ctx.fillRect(cx + reach * (W * 0.42) - 3, cy - 3, 6, 6);
      CK.label(ctx, 'ROUND  1 .. N', 96, H * 0.18, 24, PAL.cyan, 0.8);
      CK.label(ctx, 'CONVERGE', W - 96, H * 0.18, 24, PAL.amber, 0.8, 'right');
      finish(ctx, t);
    },
  };

  /* s05 简单？：一行干净的四拍，被一道裂缝穿过 */
  P.s05 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var y = H * 0.5;
      var labels = ['01', '02', '03', '04'];
      for (var i = 0; i < 4; i += 1) {
        var x = W * (0.22 + i * 0.19);
        ctx.strokeStyle = CK.rgba(PAL.steel, 0.5);
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 46, y - 46, 92, 92);
        CK.label(ctx, labels[i], x, y, 30, PAL.pale, 0.8, 'center');
      }
      // 裂缝：一道裂纹从中心横向撕开，越拉越大
      var crack = CK.smooth((t - D * 0.3) / (D * 0.55));
      if (crack > 0.01) {
        var jitterSeed = 7;
        ctx.strokeStyle = CK.rgba(PAL.ember, 0.3 + crack * 0.6);
        ctx.lineWidth = 2 + crack * 4;
        ctx.beginPath();
        var r = CK.mulberry32(jitterSeed);
        for (var k = 0; k <= 30; k += 1) {
          var p = k / 30;
          var xx = CK.lerp(W * 0.06, W * 0.94, p);
          var yy = y + (r() - 0.5) * 120 * crack;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
        CK.glow(ctx, W * 0.5, y, 460, PAL.ember, 0.16 * crack);
      }
      CK.label(ctx, 'SOUNDS  SIMPLE', W * 0.5, H * 0.2, 26, PAL.steel, 0.75, 'center');
      CK.label(ctx, 'EVERY BEAT CAN BREAK', W * 0.5, H * 0.84, 24, PAL.ember, 0.85 * CK.smooth((t - D * 0.45) / (D * 0.3)), 'center');
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s06 四种崩法：四个象限各自出事（越权/卡死/爆掉/不听话） */
  P.s06 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var quads = [
        { x: W * 0.28, y: H * 0.3, k: 'OVERRUN', s: 'tool' },
        { x: W * 0.72, y: H * 0.3, k: 'STALL', s: 'round' },
        { x: W * 0.28, y: H * 0.7, k: 'OVERFLOW', s: 'context' },
        { x: W * 0.72, y: H * 0.7, k: 'DISOBEY', s: 'model' },
      ];
      for (var i = 0; i < quads.length; i += 1) {
        var q = quads[i];
        var on = CK.win(t / D, i * 0.2, i * 0.2 + 1.2, 0.12);
        var col = on > 0.15 ? PAL.ember : PAL.steelDim;
        // 边框
        ctx.strokeStyle = CK.rgba(col, 0.4 + on * 0.5);
        ctx.lineWidth = 2;
        ctx.strokeRect(q.x - 180, q.y - 120, 360, 240);
        // 内部：故障图示
        ctx.save();
        ctx.beginPath(); ctx.rect(q.x - 176, q.y - 116, 352, 232); ctx.clip();
        if (q.s === 'tool') {
          // 越权：一条线冲出边界
          var push = CK.smooth((t - D * 0.1) / (D * 0.5));
          ctx.strokeStyle = CK.rgba(PAL.amber, 0.7);
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(q.x - 150, q.y + 60); ctx.lineTo(q.x - 150 + push * 340, q.y + 60 - push * 130); ctx.stroke();
        } else if (q.s === 'round') {
          // 卡死：一个转不完的环
          CK.ring(ctx, q.x, q.y, 60, { color: PAL.amber, alpha: 0.5 + on * 0.4, width: 3, from: t * 2, to: t * 2 + 4.2 });
          CK.ring(ctx, q.x, q.y, 30, { color: PAL.steelDim, alpha: 0.4, width: 1.4 });
        } else if (q.s === 'context') {
          // 爆掉：堆叠的方块溢出
          var r = CK.mulberry32(13);
          for (var b = 0; b < 12; b += 1) {
            var bx = q.x - 140 + r() * 280;
            var by = q.y + 70 - b * 14 * (1 + on * 0.4);
            ctx.fillStyle = CK.rgba(PAL.amber, 0.1 + on * 0.25);
            ctx.fillRect(bx, by, 26, 12);
          }
        } else {
          // 不听话：两条本应重合的线分岔
          ctx.strokeStyle = CK.rgba(PAL.pale, 0.55);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(q.x - 140, q.y); ctx.lineTo(q.x + (0.5 + on * 0.4) * 260, q.y - on * 90); ctx.stroke();
          ctx.strokeStyle = CK.rgba(PAL.ember, 0.8);
          ctx.beginPath(); ctx.moveTo(q.x - 140, q.y); ctx.lineTo(q.x + (0.5 + on * 0.4) * 260, q.y + on * 100); ctx.stroke();
        }
        ctx.restore();
        CK.glow(ctx, q.x, q.y, 220, col, 0.1 * on);
        CK.label(ctx, q.k, q.x, q.y - 96, 24, col, 0.5 + on * 0.5, 'center');
        CK.label(ctx, q.s, q.x, q.y + 96, 17, PAL.steelDim, 0.7, 'center');
      }
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s07 没有黑箱：一面玻璃墙后，所有管道都可见 */
  P.s07 = {
    setup: function (seed) { return { du: CK.dust(45, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { dust: S.du, bg: { haze: '#5a5245', hazeA: 0.34 } });
      // 后面的管道系统（可见）
      var rows = 5;
      for (var r = 0; r < rows; r += 1) {
        var y = H * (0.24 + r * 0.13);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.55);
        ctx.lineWidth = 9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (var x = 60; x <= W - 60; x += 30) {
          var yy = y + Math.sin(x * 0.004 + r * 1.3 + t * 0.4) * 16;
          if (x === 60) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
        // 流动的介质
        var flow = ((t * 0.3 + r * 0.2) % 1);
        var fx = CK.lerp(60, W - 60, flow);
        var fy = y + Math.sin(fx * 0.004 + r * 1.3 + t * 0.4) * 16;
        CK.glow(ctx, fx, fy, 40, r % 2 ? PAL.cyan : PAL.amber, 0.4);
      }
      // 玻璃墙：一层高光斜带 + 边框
      var shine = ((t * 0.18) % 1);
      var gx = CK.lerp(-400, W + 400, shine);
      var g = ctx.createLinearGradient(gx - 300, 0, gx + 300, H);
      g.addColorStop(0, CK.rgba(PAL.pale, 0));
      g.addColorStop(0.5, CK.rgba(PAL.pale, 0.07));
      g.addColorStop(1, CK.rgba(PAL.pale, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.4);
      ctx.lineWidth = 2;
      ctx.strokeRect(W * 0.1, H * 0.14, W * 0.8, H * 0.72);
      CK.label(ctx, 'GLASS BOX  /  NOTHING HIDDEN', 96, H * 0.88, 22, PAL.cyan, 0.85);
      finish(ctx, t);
    },
  };

  /* s08 管住工具：九个工具格 + 三个池 + 一条白名单闸 */
  P.s08 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#5a5245', hazeA: 0.3 } });
      var names = ['read', 'write', 'edit', 'ls', 'grep', 'bash', 'web', 'read', 'sym'];
      var cols = 3, rows = 3, sz = 116, gap = 42;
      var x0 = W * 0.44, y0 = H * 0.26;
      for (var i = 0; i < 9; i += 1) {
        var c = i % cols, r = Math.floor(i / cols);
        var x = x0 + c * (sz + gap), y = y0 + r * (sz + gap);
        var on = CK.win(t / D, i * 0.06, i * 0.06 + 0.9, 0.1);
        ctx.fillStyle = CK.rgba('#9a907e', 0.9);
        ctx.fillRect(x, y, sz, sz);
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.cyan : PAL.steelDim, 0.4 + on * 0.5);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(x, y, sz, sz);
        CK.label(ctx, names[i], x + sz / 2, y + sz / 2, 20, on > 0.1 ? PAL.pale : PAL.steelDim, 0.5 + on * 0.5, 'center');
        // 角标
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.5 * on);
        ctx.fillRect(x + sz - 10, y + 6, 4, 4);
      }
      // 左侧三池
      var pools = ['BUILT-IN', 'SKILL', 'MCP'];
      for (var k = 0; k < 3; k += 1) {
        var py = H * (0.3 + k * 0.16);
        var pw = 300, ph = 72;
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.6);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(W * 0.05, py, pw, ph);
        CK.label(ctx, pools[k], W * 0.05 + 22, py + ph / 2, 21, PAL.steel, 0.85);
        // 连接到闸
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.4);
        ctx.beginPath(); ctx.moveTo(W * 0.05 + pw, py + ph / 2); ctx.lineTo(W * 0.4, H * 0.5); ctx.stroke();
      }
      // 白名单闸：一条竖线，逐个放行
      var gateOn = CK.smooth((t - D * 0.4) / (D * 0.4));
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.3 + gateOn * 0.6);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(W * 0.4, H * 0.16); ctx.lineTo(W * 0.4, H * 0.86); ctx.stroke();
      CK.glow(ctx, W * 0.4, H * 0.5, 300, PAL.amber, 0.1 + gateOn * 0.14);
      CK.label(ctx, 'WHITELIST', W * 0.4, H * 0.12, 22, PAL.amber, 0.85, 'center');
      finish(ctx, t);
    },
  };

  /* s09 每次落笔都留痕：纸面上三行笔迹，每一笔都在旁边留下副本 */
  P.s09 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      // 主纸面（暖白但压暗）
      var px = W * 0.16, py = H * 0.2, pw = W * 0.42, ph = H * 0.62;
      ctx.fillStyle = '#9a907e';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.6);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(px, py, pw, ph);
      // 三行"笔迹"（代码行示意，逐行写出）
      for (var i = 0; i < 8; i += 1) {
        var appear = CK.smooth((t - 0.12 - i * 0.08) / 0.4);
        var lw = (90 + ((i * 137) % 240)) * appear;
        ctx.fillStyle = CK.rgba(PAL.pale, 0.1 + (i % 3) * 0.06);
        ctx.fillRect(px + 40, py + 56 + i * 40, lw, 11);
      }
      // 右侧：留痕栏 —— 每一笔一个复本方块（回滚位）
      var bx = W * 0.64;
      for (var k = 0; k < 6; k += 1) {
        var on = CK.win(t / D, 0.12 + k * 0.12, 0.12 + k * 0.12 + 1.4, 0.1);
        var y = py + 60 + k * 78;
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.35 + on * 0.5);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(bx, y, 120, 58);
        ctx.fillStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.12 + on * 0.2);
        ctx.fillRect(bx + 6, y + 6, 108, 46);
        // 连接线（复本 ← 原文）
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.3 * on);
        ctx.beginPath(); ctx.moveTo(px + pw, y + 29); ctx.lineTo(bx, y + 29); ctx.stroke();
        CK.label(ctx, 'R' + (k + 1), bx + 60, y + 29, 16, on > 0.1 ? PAL.amberHot : PAL.steelDim, 0.5 + on * 0.5, 'center');
      }
      CK.label(ctx, 'EVERY  WRITE  ->  A  TRACE', 96, H * 0.87, 22, PAL.amber, 0.85);
      CK.label(ctx, 'ROLLBACK  :  1  CLICK', W - 96, H * 0.87, 22, PAL.steelDim, 0.8, 'right');
      finish(ctx, t);
    },
  };

  /* s10 同一条追溯路：两条路径汇成一路，证明 bash 也不漏 */
  P.s10 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var jx = W * 0.52, jy = H * 0.5;
      // 上路：write_file
      var p1 = CK.smooth((t - D * 0.05) / (D * 0.45));
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.2 + p1 * 0.65);
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(120, H * 0.3); ctx.lineTo(CK.lerp(120, jx, p1), CK.lerp(H * 0.3, jy, p1)); ctx.stroke();
      CK.label(ctx, 'write_file', 128, H * 0.3 - 30, 22, PAL.cyan, 0.6 + p1 * 0.4);
      // 下路：bash
      var p2 = CK.smooth((t - D * 0.15) / (D * 0.45));
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.2 + p2 * 0.65);
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (var k = 0; k <= 24; k += 1) {
        var pp = (k / 24) * p2;
        var x = CK.lerp(120, jx, pp);
        var y = CK.lerp(H * 0.72, jy, pp) + Math.sin(pp * 9) * 22 * (1 - pp);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      CK.label(ctx, 'bash', 128, H * 0.72 + 34, 22, PAL.amber, 0.6 + p2 * 0.4);
      // 汇合后的单一路径
      var p3 = CK.smooth((t - D * 0.5) / (D * 0.4));
      if (p3 > 0.01) {
        ctx.strokeStyle = CK.rgba(PAL.pale, 0.7 * p3);
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(CK.lerp(jx, W - 110, p3), jy); ctx.stroke();
        // 三个复本点
        for (var m = 0; m < 3; m += 1) {
          var dx = jx + (W - 110 - jx) * ((m + 1) / 4) * p3;
          CK.glow(ctx, dx, jy, 60, PAL.pale, 0.3 * p3);
          ctx.fillStyle = CK.rgba(PAL.pale, 0.9 * p3);
          ctx.fillRect(dx - 3, jy - 3, 6, 6);
        }
      }
      CK.glow(ctx, jx, jy, 200, PAL.pale, 0.1 * p1);
      CK.label(ctx, 'ONE  TRACE  PATH', W - 96, H * 0.2, 24, PAL.pale, 0.85, 'right');
      finish(ctx, t);
    },
  };

  /* s11 接得住：四路模型适配，各自接一组插口 */
  P.s11 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#5a5245', hazeA: 0.32 } });
      var hosts = [
        { n: 'OpenAI', c: '#1e9db8', y: H * 0.24 },
        { n: 'Anthropic', c: '#b46222', y: H * 0.42 },
        { n: 'Ollama', c: '#30a65a', y: H * 0.60 },
        { n: 'mock', c: '#306ba6', y: H * 0.78 },
      ];
      var busX = W * 0.56;
      // 垂直总线
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.55);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(busX, H * 0.18); ctx.lineTo(busX, H * 0.86); ctx.stroke();
      for (var i = 0; i < hosts.length; i += 1) {
        var h = hosts[i];
        var on = CK.win(t / D, i * 0.18, i * 0.18 + 1.5, 0.12);
        // 插头（方块）
        ctx.fillStyle = CK.rgba('#9a907e', 0.95);
        ctx.fillRect(W * 0.22, h.y - 30, 130, 60);
        ctx.strokeStyle = CK.rgba(h.c, 0.4 + on * 0.55);
        ctx.lineWidth = 2;
        ctx.strokeRect(W * 0.22, h.y - 30, 130, 60);
        CK.label(ctx, h.n, W * 0.22 + 65, h.y, 21, h.c, 0.55 + on * 0.45, 'center');
        // 接线 + 数据流
        var plugX = W * 0.22 + 130;
        ctx.strokeStyle = CK.rgba(h.c, 0.22 + on * 0.5);
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(plugX, h.y); ctx.lineTo(busX, h.y); ctx.stroke();
        var f = ((t * 0.5 + i * 0.25) % 1);
        ctx.fillStyle = CK.rgba(h.c, 0.9);
        ctx.fillRect(CK.lerp(plugX, busX, f) - 3, h.y - 3, 6, 6);
        // 插口（总线上的凹槽）
        ctx.fillStyle = CK.rgba(h.c, 0.6 * (0.4 + on * 0.6));
        ctx.fillRect(busX - 5, h.y - 9, 10, 18);
        CK.glow(ctx, busX, h.y, 70, h.c, 0.14 * on);
      }
      // 总线出口
      ctx.strokeStyle = CK.rgba(PAL.pale, 0.6);
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(busX, H * 0.5); ctx.lineTo(W * 0.9, H * 0.5); ctx.stroke();
      CK.label(ctx, 'ADAPTER  /  ONE  SHAPE', W - 96, H * 0.16, 22, PAL.steel, 0.85, 'right');
      finish(ctx, t);
    },
  };

  /* s12 断网也能跑：一根被剪断的网线，机器照常运转 */
  P.s12 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.24 } });
      // 剪断的网线（左上）
      var cut = CK.smooth((t - D * 0.15) / (D * 0.4));
      ctx.lineCap = 'round';
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.7);
      ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(60, H * 0.26); ctx.lineTo(CK.lerp(420, 300, cut), H * 0.26); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CK.lerp(560, 700, cut), H * 0.26); ctx.lineTo(W * 0.42, H * 0.26); ctx.stroke();
      // 断口火花
      if (cut > 0.5) {
        var sp = Math.exp(-(cut - 0.5) * 8);
        CK.glow(ctx, 500, H * 0.26, 120 * sp, PAL.amber, 0.6 * sp);
      }
      CK.label(ctx, 'OFFLINE', 96, H * 0.36, 24, PAL.ember, 0.85);
      // 机器照常：本地环持续旋转（Ollama/mock 自转）
      var cx = W * 0.66, cy = H * 0.58;
      CK.ring(ctx, cx, cy, 170, { color: PAL.steel, alpha: 0.35, width: 2, ticks: 32, rot: t * 0.4 });
      CK.ring(ctx, cx, cy, 120, { color: '#30a65a', alpha: 0.5, width: 2.4, from: t * 1.2, to: t * 1.2 + 3.2 });
      CK.ring(ctx, cx, cy, 74, { color: PAL.cyan, alpha: 0.45, width: 2, from: -t * 1.6, to: -t * 1.6 + 2.4 });
      var beat = 0.5 + 0.5 * Math.sin(t * 3);
      CK.glow(ctx, cx, cy, 60 + beat * 30, '#30a65a', 0.4 + beat * 0.2);
      CK.label(ctx, 'LOCAL  ENGINE  RUNNING', cx, cy + 230, 22, '#30a65a', 0.85, 'center');
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s13 记得住：日志页边累积，右侧一条时间轴逐格加长 */
  P.s13 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      // 日志条目（左侧层叠，逐条落下）
      var n = 9;
      for (var i = 0; i < n; i += 1) {
        var appear = CK.smooth((t - 0.1 - i * 0.11) / 0.5);
        if (appear <= 0.01) continue;
        var y = H * 0.22 + i * 66;
        var w = 420 * appear;
        ctx.fillStyle = CK.rgba('#9a907e', 0.92);
        ctx.fillRect(W * 0.1, y, w, 52);
        ctx.strokeStyle = CK.rgba(PAL.cyanDim, 0.55);
        ctx.lineWidth = 1;
        ctx.strokeRect(W * 0.1, y, w, 52);
        // 内容行
        ctx.fillStyle = CK.rgba(PAL.steel, 0.5);
        ctx.fillRect(W * 0.1 + 18, y + 20, 90 + (i % 3) * 50, 10);
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.6);
        ctx.fillRect(W * 0.1 + 130, y + 20, 60, 10);
      }
      // 右侧时间轴：逐格加长
      var tx = W * 0.76;
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.55);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, H * 0.18); ctx.lineTo(tx, H * 0.86); ctx.stroke();
      var grow = CK.smooth(t / (D * 0.8));
      for (var k = 0; k < 9; k += 1) {
        var p = k / 9;
        if (p > grow) break;
        var ty = CK.lerp(H * 0.18, H * 0.86, p);
        ctx.fillStyle = CK.rgba(PAL.amber, 0.85);
        ctx.fillRect(tx - 5, ty - 2, 10, 4);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.4);
        ctx.beginPath(); ctx.moveTo(tx + 10, ty); ctx.lineTo(tx + 120, ty); ctx.stroke();
      }
      CK.glow(ctx, tx, CK.lerp(H * 0.18, H * 0.86, grow), 90, PAL.amber, 0.35);
      CK.label(ctx, 'SESSION  LOG  /  REPLAY', 96, H * 0.14, 22, PAL.cyan, 0.85);
      finish(ctx, t);
    },
  };

  /* s14 全都在：一张对照表，左右两版逐行对齐，差异被高亮 */
  P.s14 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var rowN = 8;
      for (var i = 0; i < rowN; i += 1) {
        var on = CK.win(t / D, i * 0.1, i * 0.1 + 1.1, 0.1);
        var y = H * 0.2 + i * 78;
        // 左右两栏
        ctx.fillStyle = CK.rgba('#9a907e', 0.9);
        ctx.fillRect(W * 0.14, y, W * 0.3, 62);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.45);
        ctx.lineWidth = 1;
        ctx.strokeRect(W * 0.14, y, W * 0.3, 62);
        ctx.fillRect(W * 0.56, y, W * 0.3, 62);
        ctx.strokeRect(W * 0.56, y, W * 0.3, 62);
        // 差异行被强调
        var diff = i % 3 === 0;
        if (diff && on > 0.1) {
          ctx.fillStyle = CK.rgba(PAL.amber, 0.1 * on);
          ctx.fillRect(W * 0.56, y, W * 0.3, 62);
          ctx.strokeStyle = CK.rgba(PAL.amber, 0.6 * on);
          ctx.lineWidth = 1.6;
          ctx.strokeRect(W * 0.56, y, W * 0.3, 62);
          CK.glow(ctx, W * 0.71, y + 31, 140, PAL.amber, 0.12 * on);
        }
        // 行内容
        ctx.fillStyle = CK.rgba(PAL.steel, 0.35 + on * 0.3);
        ctx.fillRect(W * 0.14 + 16, y + 26, 120 + (i % 4) * 40, 10);
        ctx.fillRect(W * 0.56 + 16, y + 26, 120 + (i % 3) * 55, 10);
        // 中缝的双向箭头
        ctx.strokeStyle = CK.rgba(diff ? PAL.amber : PAL.steelDim, 0.3 + on * 0.4);
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(W * 0.45, y + 31); ctx.lineTo(W * 0.55, y + 31); ctx.stroke();
      }
      CK.label(ctx, 'before  /  after', W * 0.5, H * 0.14, 22, PAL.steel, 0.85, 'center');
      CK.label(ctx, 'DIFF  :  EVERY  ROUND', W * 0.5, H * 0.89, 22, PAL.amber, 0.8, 'center');
      finish(ctx, t);
    },
  };

  /* s15 子代理：母体分出一颗子球，子球独立运转后回收 */
  P.s15 = {
    setup: function (seed) { return { st: CK.stars(80, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.32 } });
      var mx = W * 0.34, my = H * 0.52;
      var split = CK.smooth((t - D * 0.08) / (D * 0.35));
      var back = CK.smooth((t - D * 0.72) / (D * 0.28));
      var sx = CK.lerp(mx + 90, W * 0.66, split) - back * (W * 0.66 - mx - 90);
      var sy = my + Math.sin(t * 1.4) * 26;
      // 母体
      var beatM = 0.5 + 0.5 * Math.sin(t * 2.2);
      CK.glow(ctx, mx, my, 190 + beatM * 40, PAL.cyan, 0.2);
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.75);
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.arc(mx, my, 96, 0, 6.2832); ctx.stroke();
      CK.label(ctx, 'PARENT', mx, my, 22, PAL.pale, 0.9, 'center');
      // 连接脐带
      ctx.strokeStyle = CK.rgba(PAL.steel, 0.4);
      ctx.lineWidth = 2;
      ctx.setLineDash && ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.moveTo(mx + 96, my); ctx.lineTo(sx - 60, sy); ctx.stroke();
      ctx.setLineDash && ctx.setLineDash([]);
      // 子体
      if (split > 0.05) {
        var beatS = 0.5 + 0.5 * Math.sin(t * 3 + 1);
        CK.glow(ctx, sx, sy, 130 + beatS * 30, PAL.amber, 0.22);
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.8);
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.arc(sx, sy, 62, 0, 6.2832); ctx.stroke();
        CK.label(ctx, 'SUB', sx, sy, 20, PAL.amberHot, 0.9, 'center');
        // 内部活动
        CK.ring(ctx, sx, sy, 40, { color: PAL.amber, alpha: 0.5, width: 1.4, from: t * 2, to: t * 2 + 3 });
      }
      // 深度闸（禁止套娃）：第三层被拦住
      var third = CK.smooth((t - D * 0.4) / (D * 0.3));
      if (third > 0.02) {
        var tx = W * 0.86, ty = H * 0.36;
        ctx.strokeStyle = CK.rgba(PAL.ember, 0.7 * third);
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(tx - 26, ty - 26); ctx.lineTo(tx + 26, ty + 26); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx + 26, ty - 26); ctx.lineTo(tx - 26, ty + 26); ctx.stroke();
        CK.label(ctx, 'DEPTH  =  1', tx, ty - 52, 18, PAL.ember, 0.85 * third, 'center');
      }
      CK.label(ctx, 'DELEGATE  /  NO  RECURSION', 96, H * 0.86, 22, PAL.steel, 0.85);
      finish(ctx, t);
    },
  };

  /* s16 自己造工具：一个空槽被填上，工具从对话里"长"出来 */
  P.s16 = {
    setup: function (seed) { return { du: CK.dust(35, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.24 } });
      // 对话气泡（左）
      var bub = CK.smooth(t / (D * 0.4));
      ctx.fillStyle = CK.rgba('#9a907e', 0.95);
      ctx.strokeStyle = CK.rgba(PAL.cyanDim, 0.6);
      ctx.lineWidth = 1.6;
      var bx = W * 0.08, by = H * 0.22, bw = 420, bh = 130;
      ctx.strokeRect(bx, by, bw, bh * bub);
      // 气泡内三行
      for (var i = 0; i < 3; i += 1) {
        var on = CK.win(t / D, 0.05 + i * 0.1, 0.05 + i * 0.1 + 1, 0.1);
        ctx.fillStyle = CK.rgba(PAL.steel, 0.25 + on * 0.4);
        ctx.fillRect(bx + 24, by + 26 + i * 30, (150 + i * 60) * on, 9);
      }
      // 中间：一个空工具槽，工具正在成型
      var gx = W * 0.52, gy = H * 0.5;
      var grow = CK.smooth((t - D * 0.3) / (D * 0.45));
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.6);
      ctx.lineWidth = 2;
      ctx.setLineDash && ctx.setLineDash([12, 10]);
      ctx.strokeRect(gx - 90, gy - 90, 180, 180);
      ctx.setLineDash && ctx.setLineDash([]);
      if (grow > 0.02) {
        // 成型中的工具（扳手状）
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(-0.4);
        ctx.strokeStyle = CK.rgba(PAL.amberHot, 0.8 * grow);
        ctx.lineWidth = 14 * grow;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-46, 46); ctx.lineTo(30, -30); ctx.stroke();
        ctx.lineWidth = 10 * grow;
        ctx.beginPath(); ctx.arc(40, -40, 22 * grow, 0.6, 5.2); ctx.stroke();
        ctx.restore();
        CK.glow(ctx, gx, gy, 220, PAL.amber, 0.2 * grow);
      }
      // 右侧：技能卡片（SKILL.md 具象）
      var card = CK.smooth((t - D * 0.55) / (D * 0.35));
      if (card > 0.02) {
        var cx2 = W * 0.78;
        ctx.fillStyle = CK.rgba('#9a907e', 0.95);
        ctx.fillRect(cx2 - 130, H * 0.3, 260, 280 * card);
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.7);
        ctx.lineWidth = 1.8;
        ctx.strokeRect(cx2 - 130, H * 0.3, 260, 280 * card);
        CK.label(ctx, 'SKILL.md', cx2, H * 0.3 + 40, 22, PAL.amberHot, card, 'center');
        for (var k = 0; k < 5; k += 1) {
          ctx.fillStyle = CK.rgba(PAL.steel, 0.35 * card);
          ctx.fillRect(cx2 - 100, H * 0.3 + 80 + k * 32, 150 - k * 14, 8);
        }
      }
      CK.label(ctx, 'SELF-EXTEND  /  L1  SKILL', 96, H * 0.86, 22, PAL.amber, 0.85);
      finish(ctx, t);
    },
  };

  /* s17 装载≠启用：一个电源开关，先插上，再扳开 */
  P.s17 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var cx = W * 0.5, cy = H * 0.5;
      // 三态：插上 → 待启 → 通电
      var plug = CK.smooth((t - D * 0.1) / (D * 0.3));
      var flip = CK.smooth((t - D * 0.5) / (D * 0.35));
      // 底座
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.7);
      ctx.lineWidth = 2.4;
      ctx.strokeRect(cx - 210, cy - 110, 420, 220);
      // 插头
      ctx.fillStyle = CK.rgba('#9a907e', 0.95);
      ctx.fillRect(cx - 260 + plug * 40, cy - 34, 70, 68);
      ctx.strokeStyle = CK.rgba(plug > 0.9 ? PAL.cyan : PAL.steel, 0.8);
      ctx.lineWidth = 1.8;
      ctx.strokeRect(cx - 260 + plug * 40, cy - 34, 70, 68);
      // 插座（两孔）
      ctx.fillStyle = CK.rgba(PAL.steelDim, 0.8);
      ctx.fillRect(cx - 116, cy - 22, 10, 44);
      ctx.fillRect(cx - 96, cy - 22, 10, 44);
      // 开关（横向扳片：待启在左，通电在右）
      var sx0 = cx - 150, sx1 = cx + 150;
      var handleX = CK.lerp(sx0, sx1, flip);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.8);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx0, cy + 66); ctx.lineTo(sx1, cy + 66); ctx.stroke();
      var on = flip > 0.65;
      ctx.fillStyle = CK.rgba(on ? PAL.cyan : '#3e4a56', 0.95);
      ctx.fillRect(handleX - 40, cy + 46, 80, 40);
      ctx.strokeStyle = CK.rgba(on ? PAL.pale : PAL.steel, 0.9);
      ctx.lineWidth = 2;
      ctx.strokeRect(handleX - 40, cy + 46, 80, 40);
      CK.label(ctx, on ? 'ENABLED' : 'LOADED', handleX, cy + 66, 17, on ? PAL.pale : PAL.steel, 0.9, 'center');
      // 通电后的光
      if (on) {
        CK.glow(ctx, cx, cy - 20, 320, PAL.cyan, 0.16 * flip);
        CK.glow(ctx, cx - 110, cy, 70, PAL.cyan, 0.5);
      }
      // 两行状态：loaded / enabled
      CK.label(ctx, 'LOADED', W * 0.24, H * 0.24, 24, plug > 0.9 ? PAL.cyan : PAL.steelDim, 0.6 + plug * 0.4);
      CK.label(ctx, 'ENABLED', W * 0.76, H * 0.24, 24, on ? PAL.amber : PAL.steelDim, 0.5 + flip * 0.5);
      // 中间箭头
      ctx.strokeStyle = CK.rgba(flip > 0.6 ? PAL.amber : PAL.steelDim, 0.6);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(W * 0.4, H * 0.24); ctx.lineTo(W * 0.6, H * 0.24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W * 0.58, H * 0.24 - 8); ctx.lineTo(W * 0.6, H * 0.24); ctx.lineTo(W * 0.58, H * 0.24 + 8); ctx.stroke();
      CK.label(ctx, 'LOAD  !=  ENABLE  !=  VISIBLE', W * 0.5, H * 0.86, 24, PAL.steel, 0.85, 'center');
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s18 三个人的活：三顶帽子 / 三个角色环，逐个戴上 */
  P.s18 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#5a5245', hazeA: 0.3 } });
      var roles = ['ORCHESTRATE', 'EXECUTE', 'OBSERVE'];
      for (var i = 0; i < 3; i += 1) {
        var cx = W * (0.26 + i * 0.24), cy = H * 0.5 - (i === 1 ? 40 : 0);
        var on = CK.win(t / D, i * 0.22, i * 0.22 + 1.6, 0.12);
        // 角色环
        CK.ring(ctx, cx, cy, 130, { color: on > 0.15 ? PAL.amber : PAL.steelDim, alpha: 0.3 + on * 0.5, width: 2.4, ticks: 24, rot: t * (0.2 + i * 0.1) });
        CK.ring(ctx, cx, cy, 96, { color: PAL.cyanDim, alpha: 0.35, width: 1.2 });
        // 中心图标：三种不同几何
        ctx.strokeStyle = CK.rgba(on > 0.15 ? PAL.amberHot : PAL.steel, 0.5 + on * 0.5);
        ctx.lineWidth = 2.6;
        if (i === 0) {
          // 编排：分支图
          ctx.beginPath(); ctx.moveTo(cx - 40, cy); ctx.lineTo(cx, cy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 36, cy - 30); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 36, cy + 30); ctx.stroke();
          ctx.beginPath(); ctx.arc(cx + 40, cy - 30, 5, 0, 6.2832); ctx.stroke();
          ctx.beginPath(); ctx.arc(cx + 40, cy + 30, 5, 0, 6.2832); ctx.stroke();
        } else if (i === 1) {
          // 执行：齿轮
          var teeth = 8, r1 = 34, r2 = 26;
          ctx.beginPath();
          for (var k = 0; k < teeth * 2; k += 1) {
            var a = (k / (teeth * 2)) * 6.2832 + t * 0.8;
            var rr = k % 2 === 0 ? r1 : r2;
            var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.stroke();
        } else {
          // 观测：波形
          ctx.beginPath();
          for (var m = 0; m <= 40; m += 1) {
            var px2 = cx - 44 + (m / 40) * 88;
            var py2 = cy + Math.sin(m * 0.5 + t * 2) * 16;
            if (m === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
          }
          ctx.stroke();
        }
        if (on > 0.15) CK.glow(ctx, cx, cy, 160, PAL.amber, 0.1 * on);
        CK.label(ctx, roles[i], cx, cy + 176, 22, on > 0.15 ? PAL.amberHot : PAL.steel, 0.5 + on * 0.5, 'center');
        CK.label(ctx, '0' + (i + 1), cx, cy - 176, 20, PAL.steelDim, 0.6, 'center');
      }
      finish(ctx, t);
    },
  };

  /* s19 地基是另一个仓库：脚下的板体向远方延伸，上层建筑只与契约对接 */
  P.s19 = {
    setup: function (seed) { return { st: CK.stars(170, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#9a907e', hazeA: 0.4, hy: H * 0.74 } });
      var cx = W * 0.5;
      var rise = CK.smooth(t / (D * 0.6));
      var fy = CK.lerp(H * 1.1, H * 0.74, rise);
      // 地基板（远小近大）
      var pw = 640, ph = 42, th = 96;
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx, fy - ph); ctx.lineTo(cx + pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx - pw, fy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9a907e';
      ctx.beginPath();
      ctx.moveTo(cx - pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx, fy + ph + th); ctx.lineTo(cx - pw, fy + th); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.55);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx - pw, fy); ctx.lineTo(cx, fy + ph); ctx.lineTo(cx + pw, fy); ctx.stroke();
      // 地基上的刻字（仓库标签，英文避免旁白重复）
      CK.label(ctx, 'agent-kernel', cx, fy + 8, 26, PAL.cyan, 0.85 * rise, 'center');
      // 上层建筑（三个塔）只落在契约层上
      var up = CK.smooth((t - D * 0.3) / (D * 0.5));
      if (up > 0.02) {
        for (var i = 0; i < 3; i += 1) {
          var bx = cx + (i - 1) * 190;
          var bh = (150 + i * 40) * up;
          ctx.fillStyle = CK.rgba('#5a5245', 0.95);
          ctx.fillRect(bx - 46, fy - 20 - bh, 92, bh);
          ctx.strokeStyle = CK.rgba(PAL.pale, 0.3 * up);
          ctx.lineWidth = 1.2;
          ctx.strokeRect(bx - 46, fy - 20 - bh, 92, bh);
          // 窗口光点
          for (var r = 0; r < Math.floor(bh / 34); r += 1) {
            for (var c = 0; c < 2; c += 1) {
              ctx.fillStyle = CK.rgba(i === 2 ? PAL.amber : PAL.cyan, 0.25 + 0.4 * Math.abs(Math.sin(t + r + c + i)));
              ctx.fillRect(bx - 28 + c * 34, fy - 20 - bh + 20 + r * 34, 12, 8);
            }
          }
        }
        // 契约层：一条发光细线把塔与地基隔开
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.6 * up);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - 340, fy - 22); ctx.lineTo(cx + 340, fy - 22); ctx.stroke();
        CK.label(ctx, 'CONTRACT  LAYER', cx + 400, fy - 22, 19, PAL.amber, 0.85 * up, 'left');
        // 一条"零改动"的标注线指向地基
        ctx.strokeStyle = CK.rgba(PAL.cyan, 0.45 * up);
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(cx - 380, fy + 30); ctx.lineTo(cx - 520, fy + 60); ctx.stroke();
        CK.label(ctx, 'ZERO  KERNEL  EDITS', cx - 528, fy + 66, 19, PAL.cyan, 0.85 * up, 'right');
      }
      CK.glow(ctx, cx, fy + 40, 620, PAL.cyan, 0.12 * rise);
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s20 收尾：机器与它的手在星空下合成一个剪影，片名落定 */
  P.s20 = {
    setup: function (seed) { return { st: CK.stars(240, W, H, seed), du: CK.dust(50, W, H, seed + 6) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, dust: S.du, bg: { haze: '#5a5245', hazeA: 0.36, hy: H * 0.58 } });
      var pull = CK.smooth(t / D);
      var cx = W * 0.5, cy = CK.lerp(H * 0.55, H * 0.5, pull);
      // 剪影：人形 + 抬起的手（极简两笔）
      var a = CK.smooth((t - D * 0.08) / (D * 0.5));
      ctx.save();
      ctx.globalAlpha = 0.85 * a;
      CK.figure(ctx, cx - 40, H * 0.82, 420, { color: '#6d6355', alpha: 0.9 });
      // 抬起的手臂（一条粗线 + 张开的指）
      ctx.strokeStyle = '#6d6355';
      ctx.lineWidth = 26;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 30, H * 0.62); ctx.lineTo(cx + 120, H * 0.38); ctx.stroke();
      for (var f = 0; f < 4; f += 1) {
        var ang = -0.7 + f * 0.32;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(cx + 120, H * 0.38);
        ctx.lineTo(cx + 120 + Math.cos(ang) * 74, H * 0.38 + Math.sin(ang) * 74);
        ctx.stroke();
      }
      ctx.restore();
      // 指尖的琥珀光
      CK.glow(ctx, cx + 190, H * 0.3, 160, PAL.amber, 0.18 * a);
      // 片名
      var ta = CK.smooth((t - D * 0.42) / (D * 0.3));
      CK.title(ctx, 'react-agent', W * 0.5, H * 0.19, 56, PAL.pale, ta);
      CK.label(ctx, 'github.com/zh2673-git/react-agent', W * 0.5, H * 0.19 + 50, 24, PAL.cyan, ta * 0.9, 'center');
      finish(ctx, t, { vig: 0.62 });
    },
  };

  global.RA_PROGRAMS = P;
})(window);
