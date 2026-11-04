// rsi-programs：rsi-agent 宣传片逐镜画面程序（画面 = f(t, D)，逐帧可复现）
// 母题：生产线（十工位）+ 账本（刻度/证据）+ 检验章；视觉沿用深空/冷钢/琥珀
(function (global) {
  'use strict';
  var CK = global.CK;
  var PAL = CK.PAL;
  var W = 1920, H = 1080;
  var PAPER = { ink: '#6d6355', sheet: '#9a907e', rule: '#5a5245' };

  function base(ctx, t, o) {
    o = o || {};
    CK.backdrop(ctx, W, H, o.bg || {});
    if (o.stars) CK.drawStars(ctx, o.stars, t);
    if (o.dust) CK.drawDust(ctx, o.dust, t, H);
  }
  function finish(ctx, t, o) {
    o = o || {};
    CK.grain(ctx, W, H, o.grain == null ? 0.11 : o.grain, t);
    CK.vignette(ctx, W, H, o.vig == null ? 0.64 : o.vig);
    CK.letterbox(ctx, W, H, 0.075);
  }

  var P = {};

  /* s01 两百万次没升职：汪洋一样的运行记录，每一行都是同一条 */
  P.s01 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var rows = [];
      for (var i = 0; i < 40; i += 1) rows.push({ y: i * 26, w: 120 + r() * 620, a: 0.06 + r() * 0.14 });
      return { rows: rows, st: CK.stars(60, W, H, seed) };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#9a907e', hazeA: 0.26 } });
      var roll = (t * 22) % 26;
      for (var i = 0; i < S.rows.length; i += 1) {
        var r = S.rows[i];
        var y = r.y - roll;
        if (y < -30 || y > H) continue;
        ctx.fillStyle = CK.rgba(PAL.steel, r.a);
        ctx.fillRect(80, y, r.w, 9);
        // 每行末端的同一个"✓"
        ctx.fillStyle = CK.rgba(PAL.cyanDim, r.a * 2.2);
        ctx.fillRect(80 + r.w + 16, y, 10, 9);
      }
      // 中间压一个巨大的计数器
      var n = Math.floor(2000000 * CK.smooth(t / D));
      CK.title(ctx, n.toLocaleString('en-US'), W * 0.5, H * 0.5, 96, PAL.pale, 0.9);
      CK.label(ctx, 'RUNS', W * 0.5, H * 0.5 + 84, 26, PAL.steel, 0.8, 'center');
      // 计数器周围一圈"零晋升"的标记
      CK.ring(ctx, W * 0.5, H * 0.5, 300, { color: PAL.steelDim, alpha: 0.28, width: 1.6, ticks: 40, rot: t * 0.1 });
      CK.label(ctx, 'PROMOTIONS  :  0', 96, H * 0.12, 24, PAL.ember, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s02 不靠资历靠证据：一枚天平，左侧堆运行次数，右侧只有一枚砝码 */
  P.s02 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var cx = W * 0.5, cy = H * 0.52;
      var tilt = CK.smooth(t / (D * 0.8)) * 0.3; // 左侧越来越重 → 天平向证据一侧平
      // 支架
      ctx.strokeStyle = CK.rgba(PAL.steel, 0.7);
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx, cy + 250); ctx.lineTo(cx, cy - 40); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 90, cy + 250); ctx.lineTo(cx + 90, cy + 250); ctx.stroke();
      // 横梁（倾斜）
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.strokeStyle = CK.rgba(PAL.pale, 0.8);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(-330, 0); ctx.lineTo(330, 0); ctx.stroke();
      // 两只托盘
      function pan(x, kind) {
        var y = 92;
        ctx.strokeStyle = CK.rgba(PAL.steel, 0.6);
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y - 40); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 90, y); ctx.lineTo(x + 90, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 90, y); ctx.lineTo(x, y + 14); ctx.lineTo(x + 90, y); ctx.stroke();
        if (kind === 'runs') {
          // 一堆小方块（次数）
          for (var i = 0; i < 26; i += 1) {
            var r = CK.mulberry32(i * 7 + 3);
            ctx.fillStyle = CK.rgba(PAL.steelDim, 0.5 + r() * 0.35);
            ctx.fillRect(x - 68 + r() * 130, y - 10 - (i % 6) * 12, 16, 10);
          }
        } else {
          // 一枚亮砝码
          ctx.fillStyle = CK.rgba(PAL.amberHot, 0.9);
          ctx.beginPath();
          ctx.moveTo(x, y - 78); ctx.lineTo(x + 40, y - 12); ctx.lineTo(x - 40, y - 12);
          ctx.closePath(); ctx.fill();
          CK.glow(ctx, x, y - 46, 140, PAL.amber, 0.4);
        }
      }
      pan(-330, 'runs');
      pan(330, 'evidence');
      ctx.restore();
      CK.label(ctx, 'COUNT', cx - 330, cy + 190, 22, PAL.steelDim, 0.8, 'center');
      CK.label(ctx, 'EVIDENCE', cx + 330, cy + 190, 22, PAL.amber, 0.9, 'center');
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s03 四件家当：契约 / 案例 / 状态机 / 账本，四页证件一字排开 */
  P.s03 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var names = ['CONTRACT', 'CASES', 'STATE', 'LEDGER'];
      for (var i = 0; i < 4; i += 1) {
        var on = CK.smooth((t - 0.12 - i * 0.14) / (D * 0.42));
        if (on <= 0.01) continue;
        var x = W * (0.15 + i * 0.235) - 90;
        var y = H * 0.3 + (1 - on) * 60;
        var w = 180, h = 380 * on;
        // 证件
        ctx.fillStyle = CK.rgba(PAPER.sheet, 0.95);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.8);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(x, y, w, h);
        if (on > 0.85) {
          // 内容行
          for (var k = 0; k < 7; k += 1) {
            ctx.fillStyle = CK.rgba(PAL.steel, 0.22);
            ctx.fillRect(x + 20, y + 60 + k * 40, 60 + ((k * 53) % 80), 8);
          }
          // 顶部封条
          ctx.fillStyle = CK.rgba(i === 3 ? PAL.amber : PAL.cyan, 0.7);
          ctx.fillRect(x + 20, y + 22, w - 40, 6);
          CK.label(ctx, names[i], x + w / 2, y + h - 26, 19, i === 3 ? PAL.amber : PAL.cyan, 0.9, 'center');
        }
        CK.glow(ctx, x + w / 2, H * 0.5, 190, i === 3 ? PAL.amber : PAL.cyan, 0.08 * on);
      }
      CK.label(ctx, 'ARTIFACTS  /  NOT  SCRIPTS', 96, H * 0.14, 24, PAL.steel, 0.85);
      finish(ctx, t);
    },
  };

  /* s04 第一步 进场：一道门，四栏表格要被填满才放行 */
  P.s04 = {
    setup: function (seed) { return { du: CK.dust(35, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { dust: S.du, bg: { haze: '#9a907e', hazeA: 0.26 } });
      // 门框
      var dx = W * 0.2, dy = H * 0.16, dw = W * 0.6, dh = H * 0.68;
      ctx.fillStyle = '#6d6355';
      ctx.fillRect(dx, dy, dw, dh);
      ctx.strokeStyle = CK.rgba(PAL.steel, 0.65);
      ctx.lineWidth = 3;
      ctx.strokeRect(dx, dy, dw, dh);
      // 四栏（表单字段），逐格填写
      var fields = ['DO', 'WHEN', 'IN', 'OUT'];
      for (var i = 0; i < 4; i += 1) {
        var fy = dy + 70 + i * 132;
        var fill = CK.smooth((t - D * 0.14 - i * 0.16) / (D * 0.3));
        ctx.strokeStyle = CK.rgba(PAL.rgba ? PAL.steelDim : PAL.steelDim, 0.7);
        ctx.lineWidth = 1.4;
        ctx.strokeRect(dx + 60, fy, dw - 120, 96);
        CK.label(ctx, fields[i], dx + 84, fy + 30, 20, PAL.steel, 0.8);
        // 填入的内容（横线渐变）
        if (fill > 0.02) {
          ctx.fillStyle = CK.rgba(PAL.cyan, 0.18 + fill * 0.3);
          ctx.fillRect(dx + 84, fy + 52, (dw - 260) * fill, 18);
          // 对勾
          if (fill > 0.9) {
            var cxp = dx + dw - 120, cyp = fy + 48;
            ctx.strokeStyle = CK.rgba(PAL.amber, 0.95);
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(cxp - 16, cyp); ctx.lineTo(cxp - 4, cyp + 14); ctx.lineTo(cxp + 20, cyp - 18); ctx.stroke();
          }
        }
      }
      // 门缝里透出的光：四格全填才亮
      var openAll = CK.smooth((t - D * 0.7) / (D * 0.25));
      if (openAll > 0.02) {
        var g = ctx.createLinearGradient(dx, dy, dx, dy + dh);
        g.addColorStop(0, CK.rgba(PAL.pale, 0.5 * openAll));
        g.addColorStop(1, CK.rgba(PAL.cyan, 0.12 * openAll));
        ctx.fillStyle = g;
        ctx.fillRect(dx + dw / 2 - 6, dy, 12, dh);
        CK.glow(ctx, dx + dw / 2, dy + dh / 2, 460, PAL.cyan, 0.2 * openAll);
      }
      CK.label(ctx, 'STEP  01  /  INTAKE', 96, H * 0.9, 22, PAL.steel, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s05 说不清不许进：一张草稿被红叉按回去 */
  P.s05 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.24 } });
      // 草稿（歪斜的纸）
      var push = CK.smooth((t - D * 0.35) / (D * 0.4));
      var cx = W * 0.5, cy = H * 0.5 + push * 90;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.06 + push * 0.1);
      ctx.fillStyle = CK.rgba(PAPER.sheet, 0.95 - push * 0.4);
      ctx.fillRect(-210, -270, 420, 540);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.7);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(-210, -270, 420, 540);
      // 潦草的行
      var r = CK.mulberry32(31);
      for (var i = 0; i < 10; i += 1) {
        ctx.fillStyle = CK.rgba(PAL.steel, 0.18);
        ctx.fillRect(-170, -220 + i * 48, 120 + r() * 240, 10);
      }
      ctx.restore();
      // 红叉
      var xa = CK.smooth((t - D * 0.5) / (D * 0.25));
      if (xa > 0.02) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.strokeStyle = CK.rgba(PAL.ember, 0.85 * xa);
        ctx.lineWidth = 14 * xa;
        ctx.lineCap = 'round';
        var s2 = 250 * xa;
        ctx.beginPath(); ctx.moveTo(-s2 * 0.7, -s2 * 0.7); ctx.lineTo(s2 * 0.7, s2 * 0.7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s2 * 0.7, -s2 * 0.7); ctx.lineTo(-s2 * 0.7, s2 * 0.7); ctx.stroke();
        ctx.restore();
        CK.glow(ctx, cx, cy, 480, PAL.ember, 0.16 * xa);
      }
      CK.label(ctx, 'REJECTED  /  INCOMPLETE', 96, H * 0.14, 24, PAL.ember, 0.9 * CK.smooth((t - D * 0.55) / (D * 0.2)));
      finish(ctx, t, { vig: 0.72 });
    },
  };

  /* s06 第二步 回放：时间轴上的一串运行记录，被一条"倒带"扫过 */
  P.s06 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var marks = [];
      for (var i = 0; i < 26; i += 1) marks.push({ p: i / 26, ok: r() > 0.32, h: 20 + r() * 70 });
      return { marks: marks };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var y = H * 0.52, x0 = 120, x1 = W - 120;
      // 主轴
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.65);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      // 记录条（成功青、失败红）
      for (var i = 0; i < S.marks.length; i += 1) {
        var m = S.marks[i];
        var x = CK.lerp(x0, x1, m.p);
        ctx.fillStyle = CK.rgba(m.ok ? PAL.cyan : PAL.ember, m.ok ? 0.5 : 0.75);
        ctx.fillRect(x - 4, y - m.h, 8, m.h);
      }
      // 倒带扫针：从右向左
      var scanP = 1 - CK.smooth(t / (D * 0.8));
      var sx = CK.lerp(x0, x1, scanP);
      ctx.strokeStyle = CK.rgba(PAL.pale, 0.85);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx, y - 150); ctx.lineTo(sx, y + 60); ctx.stroke();
      CK.glow(ctx, sx, y - 40, 220, PAL.pale, 0.24);
      // 被扫过的记录被"读"出来：短暂放大
      for (var k = 0; k < S.marks.length; k += 1) {
        var mm = S.marks[k];
        var xx = CK.lerp(x0, x1, mm.p);
        var near = Math.exp(-Math.pow((xx - sx) / 90, 2));
        if (near > 0.05) {
          CK.glow(ctx, xx, y - mm.h / 2, 90 * near, mm.ok ? PAL.cyan : PAL.ember, 0.4 * near);
        }
      }
      CK.label(ctx, 'REPLAY  /  WHAT  HAPPENED', 96, H * 0.14, 24, PAL.cyan, 0.85);
      CK.label(ctx, 'ok', W - 96, H * 0.14, 22, PAL.cyan, 0.8, 'right');
      CK.label(ctx, 'failed', W - 96, H * 0.14 + 30, 22, PAL.ember, 0.8, 'right');
      finish(ctx, t);
    },
  };

  /* s07 第三步 裁决：三扇门只有一扇会亮（造 / 修 / 不造） */
  P.s07 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var names = ['BUILD', 'REPAIR', 'SKIP'];
      var winner = 2; // 这一轮的裁决是不造
      var decided = CK.smooth((t - D * 0.5) / (D * 0.3));
      for (var i = 0; i < 3; i += 1) {
        var cx = W * (0.26 + i * 0.24), cy = H * 0.52;
        var w = 220, h = 460;
        var isWin = i === winner;
        var lit = isWin ? decided : 0;
        ctx.fillStyle = CK.rgba('#6d6355', 0.95);
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.strokeStyle = CK.rgba(lit > 0.1 ? PAL.amber : PAL.steelDim, 0.55 + lit * 0.45);
        ctx.lineWidth = 2.2;
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
        // 门内竖线（门缝）
        if (lit > 0.05) {
          var g = ctx.createLinearGradient(cx - 10, 0, cx + 10, 0);
          g.addColorStop(0, CK.rgba(PAL.amber, 0));
          g.addColorStop(0.5, CK.rgba(PAL.amberHot, 0.7 * lit));
          g.addColorStop(1, CK.rgba(PAL.amber, 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - 10, cy - h / 2, 20, h);
          CK.glow(ctx, cx, cy, 320, PAL.amber, 0.2 * lit);
        }
        CK.label(ctx, names[i], cx, cy - h / 2 + 46, 26, lit > 0.1 ? PAL.amberHot : PAL.steel, 0.6 + lit * 0.4, 'center');
        CK.label(ctx, '0' + (i + 1), cx, cy + h / 2 - 40, 20, PAL.steelDim, 0.6, 'center');
      }
      CK.label(ctx, 'STEP  03  /  DECIDE', 96, H * 0.88, 22, PAL.steel, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s08 不造也是结论：一次"未发生"被计成收益（省下的工时） */
  P.s08 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var cx = W * 0.5, cy = H * 0.5;
      // 一个大大的"0"（没有新技能）
      var a = CK.smooth(t / (D * 0.6));
      CK.title(ctx, '0', cx, cy - 40, 220, PAL.pale, 0.18 + a * 0.5);
      CK.label(ctx, 'NEW  SKILLS  THIS  ROUND', cx, cy + 110, 24, PAL.steel, 0.85, 'center');
      // 省下的工时：一堆没被消耗的筹码
      var saved = Math.floor(38 * CK.smooth(t / D));
      CK.title(ctx, saved + ' h', cx + W * 0.3, cy - 120, 64, '#30a65a', 0.85 * a);
      CK.label(ctx, 'SAVED', cx + W * 0.3, cy - 56, 20, '#30a65a', 0.7 * a, 'center');
      // 上升的光点（收益）
      for (var i = 0; i < 30; i += 1) {
        var p = ((t * 0.2 + i * 0.055) % 1);
        var x = cx - W * 0.24 + ((i * 61) % (W * 0.48));
        var y = H * 0.86 - p * H * 0.5;
        ctx.fillStyle = CK.rgba('#30a65a', (1 - p) * 0.4);
        ctx.fillRect(x, y, 2, 3);
      }
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s09 第四步 写：一支笔在纸上写出一套规矩，规矩自己立成了框架 */
  P.s09 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var px = W * 0.22, py = H * 0.18, pw = W * 0.56, ph = H * 0.64;
      // 纸
      ctx.fillStyle = CK.rgba(PAPER.sheet, 0.96);
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.7);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(px, py, pw, ph);
      // 写出的规矩：四段（角色/工件/验收/裁决），逐段落笔
      var secs = ['ROLES', 'ARTIFACTS', 'ACCEPTANCE', 'VERDICT'];
      for (var i = 0; i < 4; i += 1) {
        var on = CK.win(t / D, 0.1 + i * 0.18, 0.1 + i * 0.18 + 1.4, 0.1);
        var y = py + 60 + i * 150;
        ctx.fillStyle = CK.rgba(i === 2 ? PAL.amber : PAL.cyan, 0.5 + on * 0.4);
        ctx.fillRect(px + 40, y, 6, 110);
        CK.label(ctx, secs[i], px + 62, y + 16, 20, i === 2 ? PAL.amber : PAL.cyan, 0.5 + on * 0.5);
        for (var k = 0; k < 4; k += 1) {
          var lw = (140 + ((k * 71) % 200)) * on;
          ctx.fillStyle = CK.rgba(PAL.steel, 0.16 + on * 0.2);
          ctx.fillRect(px + 62, y + 42 + k * 18, lw, 7);
        }
        CK.glow(ctx, px + 40, y + 55, 140, i === 2 ? PAL.amber : PAL.cyan, 0.1 * on);
      }
      // 笔尖：沿纸面推进
      var prog = CK.smooth(t / (D * 0.9));
      var bx = px + 40;
      var by = CK.lerp(py + 60, py + 60 + 3 * 150 + 100, prog);
      ctx.strokeStyle = CK.rgba(PAL.pale, 0.85);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(bx + 30, by - 60); ctx.lineTo(bx, by); ctx.stroke();
      CK.glow(ctx, bx, by, 70, PAL.amber, 0.5);
      CK.label(ctx, 'STEP  04  /  AUTHOR', 96, H * 0.9, 22, PAL.steel, 0.85);
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s10 不是提示词是规矩：左边一段随意的提示，右边一套可判定的条款 */
  P.s10 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var split = CK.smooth((t - D * 0.12) / (D * 0.4));
      // 左：一段模糊的文本（逐渐被压暗）
      var lx = W * 0.1, ly = H * 0.26, lw = W * 0.3;
      ctx.fillStyle = CK.rgba(PAL.steel, 0.1 * (1 - split * 0.6));
      ctx.fillRect(lx, ly, lw, H * 0.44);
      var r = CK.mulberry32(5);
      for (var i = 0; i < 12; i += 1) {
        ctx.fillStyle = CK.rgba(PAL.steel, 0.2 * (1 - split * 0.6));
        ctx.fillRect(lx + 16, ly + 24 + i * 32, 80 + r() * 260, 9);
      }
      CK.label(ctx, 'PROMPT', lx + lw / 2, H * 0.76, 24, PAL.steelDim, 0.7, 'center');
      // 右：一套结构化条款（表格 + 判定列）
      var rx = W * 0.56, ry = H * 0.24, rw = W * 0.34;
      var rows = 6;
      for (var k = 0; k < rows; k += 1) {
        var on = CK.win(t / D, 0.12 + k * 0.11, 0.12 + k * 0.11 + 1.4, 0.1);
        var y = ry + k * 74;
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.35 + on * 0.45);
        ctx.lineWidth = 1.4;
        ctx.strokeRect(rx, y, rw, 62);
        // 条款文字
        ctx.fillStyle = CK.rgba(PAL.pale, 0.16 + on * 0.28);
        ctx.fillRect(rx + 16, y + 26, 120 + ((k * 47) % 140) * on, 9);
        // 判定列：✓ / ✗
        var pass = k % 4 !== 1;
        ctx.strokeStyle = CK.rgba(pass ? '#30a65a' : PAL.ember, 0.3 + on * 0.6);
        ctx.lineWidth = 2.6;
        var cxp = rx + rw - 40, cyp = y + 31;
        if (pass) {
          ctx.beginPath(); ctx.moveTo(cxp - 12, cyp); ctx.lineTo(cxp - 3, cyp + 10); ctx.lineTo(cxp + 14, cyp - 12); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(cxp - 10, cyp - 10); ctx.lineTo(cxp + 10, cyp + 10); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cxp + 10, cyp - 10); ctx.lineTo(cxp - 10, cyp + 10); ctx.stroke();
        }
      }
      CK.label(ctx, 'RULES  /  JUDGEABLE', W * 0.75, H * 0.76, 24, PAL.amber, 0.5 + split * 0.45, 'center');
      // 中缝箭头
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.3 + split * 0.5);
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(W * 0.44, H * 0.48); ctx.lineTo(W * 0.53, H * 0.48); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W * 0.51, H * 0.48 - 10); ctx.lineTo(W * 0.53, H * 0.48); ctx.lineTo(W * 0.51, H * 0.48 + 10); ctx.stroke();
      finish(ctx, t);
    },
  };

  /* s11 第五步 验：静态校验器逐条扫地，一行行变红又变绿 */
  P.s11 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var lines = [];
      for (var i = 0; i < 14; i += 1) lines.push({ ok: r() > 0.42 });
      return { lines: lines };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var x0 = W * 0.18, y0 = H * 0.18, w = W * 0.64;
      // 检查表外框
      ctx.strokeStyle = CK.rgba(PAL.steel, 0.6);
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, y0, w, H * 0.62);
      // 扫描线：自上而下
      var scanY = CK.lerp(y0, y0 + H * 0.62, CK.smooth(t / (D * 0.85)));
      for (var i = 0; i < S.lines.length; i += 1) {
        var y = y0 + 40 + i * 44;
        var passed = y < scanY;
        var L = S.lines[i];
        // 行标记
        ctx.fillStyle = CK.rgba(!passed ? PAL.steelDim : L.ok ? '#30a65a' : PAL.ember, 0.7);
        ctx.fillRect(x0 + 24, y, 10, 10);
        // 行文字
        ctx.fillStyle = CK.rgba(PAL.pale, passed ? 0.3 : 0.14);
        ctx.fillRect(x0 + 52, y, 120 + ((i * 83) % 300), 10);
        // 判定标签
        if (passed) {
          CK.label(ctx, L.ok ? 'PASS' : 'FAIL', x0 + w - 30, y + 6, 16, L.ok ? '#30a65a' : PAL.ember, 0.9, 'right');
        }
      }
      // 扫描光带
      ctx.fillStyle = CK.rgba(PAL.cyan, 0.1);
      ctx.fillRect(x0, scanY - 30, w, 60);
      ctx.strokeStyle = CK.rgba(PAL.cyan, 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, scanY); ctx.lineTo(x0 + w, scanY); ctx.stroke();
      CK.glow(ctx, x0 + w / 2, scanY, 420, PAL.cyan, 0.16);
      CK.label(ctx, 'STEP  05  /  VALIDATE', 96, H * 0.88, 22, PAL.steel, 0.85);
      finish(ctx, t);
    },
  };

  /* s12 卡掉一半：半数的草稿被挡在闸外（一堆灰纸落下） */
  P.s12 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var sheets = [];
      for (var i = 0; i < 18; i += 1) sheets.push({ x: 0.1 + r() * 0.8, p: r(), rot: (r() - 0.5) * 0.7, dead: i % 2 === 0 });
      return { sheets: sheets };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.24 } });
      // 闸门线（水平）
      var gy = H * 0.44;
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.7);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(W * 0.08, gy); ctx.lineTo(W * 0.92, gy); ctx.stroke();
      CK.label(ctx, 'GATE', W * 0.5, gy - 24, 22, PAL.amber, 0.9, 'center');
      // 纸片下落：活着的穿过，死的被挡
      for (var i = 0; i < S.sheets.length; i += 1) {
        var s2 = S.sheets[i];
        var prog = ((t * 0.28 + s2.p) % 1);
        var y = CK.lerp(-80, H + 80, prog);
        var blockedY = gy - 40;
        if (s2.dead && y > blockedY) y = blockedY + Math.sin(t * 4 + i) * 6;
        var x = W * s2.x;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(s2.rot + (s2.dead ? 0 : t * 0.3));
        ctx.fillStyle = CK.rgba(s2.dead ? '#5a5245' : PAPER.sheet, 0.9);
        ctx.fillRect(-40, -54, 80, 108);
        ctx.strokeStyle = CK.rgba(s2.dead ? PAL.ember : PAL.steelDim, 0.6);
        ctx.lineWidth = 1;
        ctx.strokeRect(-40, -54, 80, 108);
        if (s2.dead) {
          ctx.strokeStyle = CK.rgba(PAL.ember, 0.7);
          ctx.lineWidth = 2.4;
          ctx.beginPath(); ctx.moveTo(-24, -34); ctx.lineTo(24, 34); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(24, -34); ctx.lineTo(-24, 34); ctx.stroke();
        }
        ctx.restore();
      }
      CK.label(ctx, '~50%  REJECTED', W - 96, H * 0.88, 24, PAL.ember, 0.85, 'right');
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s13 第六步 评：三张评分卡（案例 / 盲评 / 基线），分数逐格攀升 */
  P.s13 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var cards = ['CASES', 'BLIND', 'BASELINE'];
      for (var i = 0; i < 3; i += 1) {
        var cx = W * (0.24 + i * 0.26), cy = H * 0.5;
        var w = 260, h = 340;
        ctx.fillStyle = CK.rgba(PAPER.sheet, 0.95);
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.75);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
        CK.label(ctx, cards[i], cx, cy - h / 2 + 36, 21, PAL.cyan, 0.85, 'center');
        // 纵向条形：逐条充能
        var nbar = 5;
        for (var b = 0; b < nbar; b += 1) {
          var on = CK.win(t / D, 0.1 + i * 0.16 + b * 0.05, 0.1 + i * 0.16 + b * 0.05 + 1.4, 0.1);
          var bh = 40 + b * 26;
          var bx = cx - 88 + b * 36;
          var by = cy + h / 2 - 60;
          ctx.fillStyle = CK.rgba('#9a907e', 0.9);
          ctx.fillRect(bx, by - bh, 24, bh);
          ctx.fillStyle = CK.rgba(b === 2 ? PAL.amber : PAL.cyan, 0.25 + on * 0.5);
          ctx.fillRect(bx, by - bh * (0.3 + on * 0.6), 24, bh * (0.3 + on * 0.6));
          ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by - bh, 24, bh);
        }
        // 分数
        var score = (0.62 + i * 0.1 + CK.smooth(t / D) * 0.2).toFixed(2);
        CK.label(ctx, score, cx, cy - h / 2 + 84, 42, PAL.pale, 0.9, 'center');
        CK.glow(ctx, cx, cy, 220, i === 2 ? PAL.amber : PAL.cyan, 0.07);
      }
      CK.label(ctx, 'STEP  06  /  EVALUATE', 96, H * 0.88, 22, PAL.steel, 0.85);
      finish(ctx, t);
    },
  };

  /* s14 不许退化也不算自评：一张旧案例卡被翻回去，旁边一个"自评"被划掉 */
  P.s14 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      // 旧案例卡
      var cx = W * 0.36, cy = H * 0.5;
      var flip = CK.smooth((t - D * 0.1) / (D * 0.4));
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 - flip * 0.22, 1);
      ctx.fillStyle = CK.rgba(PAPER.sheet, 0.95);
      ctx.fillRect(-160, -210, 320, 420);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.8);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(-160, -210, 320, 420);
      CK.label(ctx, 'CASE  #017', 0, -170, 20, PAL.steel, 0.85, 'center');
      // 绿勾（未退化）
      var ok = CK.smooth((t - D * 0.45) / (D * 0.25));
      if (ok > 0.02) {
        ctx.strokeStyle = CK.rgba('#30a65a', 0.9 * ok);
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-60, -10); ctx.lineTo(-14, 44); ctx.lineTo(76, -70); ctx.stroke();
        CK.glow(ctx, 0, 0, 200, '#30a65a', 0.16 * ok);
      }
      ctx.restore();
      // 右侧：被划掉的"自评"
      var sx = W * 0.74, sy = H * 0.5;
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.8);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(sx - 170, sy - 120, 340, 240);
      CK.label(ctx, 'SELF  SCORE', sx, sy - 70, 24, PAL.steel, 0.8, 'center');
      CK.label(ctx, '0.94', sx, sy + 10, 54, PAL.steel, 0.55, 'center');
      var strike = CK.smooth((t - D * 0.55) / (D * 0.25));
      if (strike > 0.02) {
        ctx.strokeStyle = CK.rgba(PAL.ember, 0.9);
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(sx - 170, sy - 120 + 240 * strike);
        ctx.lineTo(sx + 170, sy - 120 + 240 * strike);
        ctx.stroke();
        CK.label(ctx, 'NOT  COUNTED', sx, sy + 82, 20, PAL.ember, 0.9 * strike, 'center');
      }
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s15 第七步 跑：真实任务跑起来（终端里滚动的执行流） */
  P.s15 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var lines = [];
      for (var i = 0; i < 30; i += 1) lines.push({ w: 80 + r() * 520, c: r() > 0.7 ? 1 : 0 });
      return { lines: lines };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.3 } });
      var x0 = W * 0.1, y0 = H * 0.14, w = W * 0.8, h = H * 0.7;
      ctx.fillStyle = CK.rgba('#6d6355', 0.96);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.7);
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, y0, w, h);
      // 顶部三个点
      for (var d = 0; d < 3; d += 1) {
        ctx.fillStyle = CK.rgba(PAL.steelDim, 0.8);
        ctx.beginPath(); ctx.arc(x0 + 26 + d * 22, y0 + 22, 5, 0, 6.2832); ctx.fill();
      }
      // 滚动行
      var offset = (t * 90) % 34;
      for (var i = 0; i < S.lines.length; i += 1) {
        var y = y0 + 58 + i * 34 - offset;
        if (y < y0 + 40 || y > y0 + h - 20) continue;
        var L = S.lines[i];
        // 提示符
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.7);
        ctx.fillRect(x0 + 34, y, 8, 10);
        // 命令行
        ctx.fillStyle = CK.rgba(L.c ? PAL.amber : PAL.pale, L.c ? 0.5 : 0.28);
        ctx.fillRect(x0 + 54, y, L.w, 10);
        // 结果标记
        ctx.fillStyle = CK.rgba('#30a65a', 0.55);
        ctx.fillRect(x0 + w - 60, y, 12, 10);
      }
      // 光标闪烁
      if (Math.floor(t * 2) % 2 === 0) {
        ctx.fillStyle = CK.rgba(PAL.pale, 0.8);
        ctx.fillRect(x0 + 54, y0 + h - 44, 14, 18);
      }
      CK.label(ctx, 'STEP  07  /  EXECUTE', x0, y0 - 26, 22, PAL.cyan, 0.85);
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s16 第八步 验（测试闸门）：一条红色测试条，被修成绿的 */
  P.s16 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.26 } });
      var cx = W * 0.5, cy = H * 0.5;
      var fix = CK.smooth((t - D * 0.45) / (D * 0.3));
      var col = fix < 0.5 ? PAL.ember : '#30a65a';
      var colMix = fix < 0.5 ? PAL.ember : '#30a65a';
      // 三条测试条
      for (var i = 0; i < 3; i += 1) {
        var y = cy - 90 + i * 90;
        var w = 420;
        ctx.fillStyle = CK.rgba('#6d6355', 0.95);
        ctx.fillRect(cx - w / 2, y - 26, w, 52);
        ctx.strokeStyle = CK.rgba(i === 1 ? colMix : '#30a65a', 0.55 + (i === 1 ? fix * 0.4 : 0.35));
        ctx.lineWidth = 1.8;
        ctx.strokeRect(cx - w / 2, y - 26, w, 52);
        // 状态
        var okRow = i !== 1 || fix > 0.5;
        CK.label(ctx, okRow ? 'PASS' : 'FAIL', cx + w / 2 - 20, y, 20, okRow ? '#30a65a' : PAL.ember, 0.9, 'right');
        ctx.fillStyle = CK.rgba(PAL.pale, 0.18);
        ctx.fillRect(cx - w / 2 + 22, y - 5, 160 + i * 60, 9);
        if (i === 1 && fix < 0.5) CK.glow(ctx, cx, y, 260, PAL.ember, 0.14);
        if (i === 1 && fix > 0.5) CK.glow(ctx, cx, y, 260, '#30a65a', 0.14);
      }
      // 修的那一下：一道白光扫过中间那条
      if (fixedScan(t, D)) {
        var sx = CK.lerp(cx - 220, cx + 220, CK.smooth((t - D * 0.4) / (D * 0.2)));
        ctx.fillStyle = CK.rgba(PAL.pale, 0.16);
        ctx.fillRect(sx - 30, cy - 120, 60, 240);
      }
      CK.label(ctx, 'STEP  08  /  VERIFY  (GATE)', 96, H * 0.88, 22, PAL.steel, 0.85);
      finish(ctx, t, { vig: 0.7 });
    },
  };

  /* s17 第九步 复盘：一张时间分配表，慢的段落被标出来 */
  P.s17 = {
    setup: function (seed) {
      var r = CK.mulberry32(seed);
      var segs = [];
      for (var i = 0; i < 14; i += 1) segs.push({ w: 0.4 + r() * 1.6, slow: r() > 0.68 });
      return { segs: segs };
    },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var x0 = W * 0.12, y0 = H * 0.3, w = W * 0.76;
      var total = S.segs.reduce(function (a, s) { return a + s.w; }, 0);
      var acc = 0;
      var grow = CK.smooth(t / (D * 0.8));
      for (var i = 0; i < S.segs.length; i += 1) {
        var s2 = S.segs[i];
        var sw = (s2.w / total) * w * grow;
        var x = x0 + acc;
        ctx.fillStyle = CK.rgba(s2.slow ? PAL.ember : PAL.cyanDim, s2.slow ? 0.55 : 0.3);
        ctx.fillRect(x, y0, sw - 3, 90);
        if (s2.slow) {
          CK.glow(ctx, x + sw / 2, y0 + 45, 100, PAL.ember, 0.2);
          ctx.fillStyle = CK.rgba(PAL.ember, 0.9);
          ctx.fillRect(x, y0 - 14, sw - 3, 6);
        }
        acc += sw;
      }
      // 标尺
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y0 + 120); ctx.lineTo(x0 + w, y0 + 120); ctx.stroke();
      for (var k = 0; k <= 8; k += 1) {
        var tx = x0 + (k / 8) * w;
        ctx.beginPath(); ctx.moveTo(tx, y0 + 112); ctx.lineTo(tx, y0 + 128); ctx.stroke();
      }
      CK.label(ctx, 'STEP  09  /  RETRO', 96, H * 0.86, 22, PAL.steel, 0.85);
      CK.label(ctx, 'SLOW  SEGMENTS', W - 96, H * 0.86, 22, PAL.ember, 0.85, 'right');
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s18 第十步 晋升：一枚印章落在证书上；退路是退回草稿或退役 */
  P.s18 = {
    setup: function (seed) { return {}; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { bg: { haze: '#9a907e', hazeA: 0.28 } });
      var cx = W * 0.5, cy = H * 0.5;
      // 证书
      ctx.fillStyle = CK.rgba(PAPER.sheet, 0.96);
      ctx.fillRect(cx - 340, cy - 230, 680, 460);
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.6);
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 340, cy - 230, 680, 460);
      ctx.strokeRect(cx - 320, cy - 210, 640, 420);
      CK.label(ctx, 'SKILL  /  LIFECYCLE', cx, cy - 160, 24, PAL.amber, 0.85, 'center');
      // 三个阶段：draft → candidate → active
      var stages = ['draft', 'candidate', 'active'];
      for (var i = 0; i < 3; i += 1) {
        var on = CK.win(t / D, 0.1 + i * 0.2, 0.1 + i * 0.2 + 1.6, 0.1);
        var sx = cx - 190 + i * 190, sy = cy + 20;
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.4 + on * 0.5);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, 44, 0, 6.2832); ctx.stroke();
        CK.label(ctx, stages[i], sx, sy + 76, 18, on > 0.1 ? PAL.amberHot : PAL.steel, 0.5 + on * 0.5, 'center');
        if (i < 2) {
          ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.5);
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(sx + 52, sy); ctx.lineTo(sx + 138, sy); ctx.stroke();
        }
      }
      // 印章落下
      var stamp = CK.smooth((t - D * 0.62) / (D * 0.22));
      if (stamp > 0.02) {
        var sc = 1.4 - stamp * 0.4;
        ctx.save();
        ctx.translate(cx + 150, cy + 20);
        ctx.rotate(-0.18);
        ctx.scale(sc, sc);
        ctx.globalAlpha = stamp;
        ctx.strokeStyle = CK.rgba(PAL.amberHot, 0.9);
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(0, 0, 62, 0, 6.2832); ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 50, 0, 6.2832); ctx.stroke();
        CK.label(ctx, 'PROMOTED', 0, 0, 16, PAL.amberHot, 0.95, 'center');
        ctx.restore();
        CK.glow(ctx, cx + 150, cy + 20, 260, PAL.amber, 0.22 * stamp);
      }
      // 退路：两条淡淡的箭头（退回/退役）
      CK.label(ctx, 'FALLBACK  :  DRAFT  /  RETIRE', cx, cy + 176, 20, PAL.steel, 0.7, 'center');
      finish(ctx, t, { vig: 0.68 });
    },
  };

  /* s19 十步走完：十枚工位灯依次全亮，串成一条生产线 */
  P.s19 = {
    setup: function (seed) { return { st: CK.stars(80, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#5a5245', hazeA: 0.32 } });
      var n = 10;
      var y = H * 0.52;
      var x0 = W * 0.1, x1 = W * 0.9;
      // 传送带
      ctx.strokeStyle = CK.rgba(PAL.steelDim, 0.6);
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(x0, y + 70); ctx.lineTo(x1, y + 70); ctx.stroke();
      for (var i = 0; i < n; i += 1) {
        var x = CK.lerp(x0, x1, i / (n - 1));
        var on = CK.win(t / D, i * 0.075, i * 0.075 + 1.6, 0.06);
        // 工位柱
        ctx.fillStyle = CK.rgba('#9a907e', 0.9);
        ctx.fillRect(x - 24, y - 60, 48, 130);
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.4 + on * 0.6);
        ctx.lineWidth = 1.6;
        ctx.strokeRect(x - 24, y - 60, 48, 130);
        // 灯
        var lit = on > 0.5;
        ctx.fillStyle = CK.rgba(lit ? PAL.amberHot : '#5a5245', 0.95);
        ctx.beginPath(); ctx.arc(x, y - 34, 8, 0, 6.2832); ctx.fill();
        if (lit) CK.glow(ctx, x, y - 34, 80, PAL.amber, 0.35);
        CK.label(ctx, String(i + 1).padStart(2, '0'), x, y + 104, 18, lit ? PAL.amberHot : PAL.steelDim, 0.6 + on * 0.4, 'center');
        // 流向：光点沿传送带
        var f = ((t * 0.35 + i * 0.05) % 1);
        ctx.fillStyle = CK.rgba(PAL.cyan, 0.5);
        ctx.fillRect(CK.lerp(x0, x1, f) - 3, y + 67, 6, 6);
      }
      CK.label(ctx, 'TEN  STAGES  /  ONE  LINE', W * 0.5, H * 0.18, 26, PAL.pale, 0.85, 'center');
      finish(ctx, t);
    },
  };

  /* s20 不靠更聪明的模型：一张对照图——模型 vs 流水线 */
  P.s20 = {
    setup: function (seed) { return { st: CK.stars(120, W, H, seed) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, bg: { haze: '#9a907e', hazeA: 0.32 } });
      var split = CK.smooth((t - D * 0.1) / (D * 0.45));
      // 左：一颗孤立的"聪明"球（逐渐变暗）
      var lx = W * 0.28, ly = H * 0.5;
      var dim = 0.9 - split * 0.55;
      CK.glow(ctx, lx, ly, 200, PAL.steel, 0.2 * dim);
      ctx.strokeStyle = CK.rgba(PAL.steel, 0.6 * dim);
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(lx, ly, 110, 0, 6.2832); ctx.stroke();
      CK.label(ctx, 'BIGGER', lx, ly - 18, 22, PAL.steel, 0.6 * dim + 0.2, 'center');
      CK.label(ctx, 'MODEL', lx, ly + 16, 22, PAL.steel, 0.6 * dim + 0.2, 'center');
      // 右：一条流水线（逐渐点亮）
      var rx = W * 0.66;
      for (var i = 0; i < 5; i += 1) {
        var on = CK.win(split, i * 0.18, i * 0.18 + 0.6, 0.12);
        var y = H * 0.3 + i * 100;
        ctx.strokeStyle = CK.rgba(on > 0.1 ? PAL.amber : PAL.steelDim, 0.35 + on * 0.55);
        ctx.lineWidth = 2;
        ctx.strokeRect(rx - 150, y - 26, 300, 52);
        ctx.fillStyle = CK.rgba(on > 0.1 ? PAL.amberHot : PAL.steelDim, 0.5 + on * 0.4);
        ctx.fillRect(rx - 140, y - 4, 90 + i * 30, 8);
        if (on > 0.3) CK.glow(ctx, rx, y, 130, PAL.amber, 0.1 * on);
      }
      CK.label(ctx, 'PIPELINE', rx, H * 0.3 + 5 * 100 - 6, 22, PAL.amber, 0.9 * split, 'center');
      // 中缝箭头
      ctx.strokeStyle = CK.rgba(PAL.amber, 0.3 + split * 0.5);
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(W * 0.45, H * 0.5); ctx.lineTo(W * 0.54, H * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W * 0.52, H * 0.5 - 10); ctx.lineTo(W * 0.54, H * 0.5); ctx.lineTo(W * 0.52, H * 0.5 + 10); ctx.stroke();
      finish(ctx, t, { vig: 0.66 });
    },
  };

  /* s21 生产可靠性：一枚印章落在"RELIABILITY"上，片名收尾 */
  P.s21 = {
    setup: function (seed) { return { st: CK.stars(200, W, H, seed), du: CK.dust(40, W, H, seed + 3) }; },
    draw: function (ctx, t, D, S) {
      base(ctx, t, { stars: S.st, dust: S.du, bg: { haze: '#5a5245', hazeA: 0.36, hy: H * 0.6 } });
      var cx = W * 0.5, cy = H * 0.54;
      var stamp = CK.smooth((t - D * 0.1) / (D * 0.4));
      // 印章圆环
      if (stamp > 0.02) {
        var sc = 1.5 - stamp * 0.5;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(sc, sc);
        ctx.globalAlpha = stamp;
        ctx.strokeStyle = CK.rgba(PAL.amber, 0.85);
        ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(0, 0, 168, 0, 6.2832); ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 148, 0, 6.2832); ctx.stroke();
        // 圆环上的刻度（账本感）
        for (var i = 0; i < 48; i += 1) {
          var a = (i / 48) * 6.2832;
          var r1 = 148, r2 = i % 4 === 0 ? 132 : 140;
          ctx.strokeStyle = CK.rgba(PAL.amber, 0.6);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
          ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
          ctx.stroke();
        }
        CK.label(ctx, 'RELIABILITY', 0, -14, 30, PAL.amberHot, 0.95, 'center');
        CK.label(ctx, 'NOT  ANSWERS', 0, 26, 18, PAL.amber, 0.85, 'center');
        ctx.restore();
        CK.glow(ctx, cx, cy, 420, PAL.amber, 0.2 * stamp);
      }
      // 片名
      var ta = CK.smooth((t - D * 0.42) / (D * 0.3));
      CK.title(ctx, 'rsi-agent', W * 0.5, H * 0.16, 54, PAL.pale, ta);
      CK.label(ctx, 'github.com/zh2673-git/rsi-agent', W * 0.5, H * 0.16 + 48, 24, PAL.cyan, ta * 0.9, 'center');
      CK.label(ctx, 'SKILL  PRODUCTION  LINE', W * 0.5, H * 0.88, 22, PAL.steel, 0.8 * ta, 'center');
      finish(ctx, t, { vig: 0.62 });
    },
  };

  function fixedScan(t, D) {
    return t > D * 0.4 && t < D * 0.62;
  }

  global.RSI_PROGRAMS = P;
})(window);
