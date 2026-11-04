// canvas-programs：逐镜定制电影画面程序（确定性，GSAP seek 驱动）
// 每个程序 = state(参数) + tweens(时间线编排) + draw(逐帧绘制)
(function (global) {
  'use strict';
  var CV = global.CV;
  var W = 1920, H = 1080, CX = 960, CY = 540;
  var BG = '#04060f';

  function backdrop(ctx, stars, t, opts) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    // 深空星云薄雾（两层低透明渐变，增加纵深）
    CV.glow(ctx, W * 0.22, H * 0.3, H * 0.75, 'rgba(38,58,110,0.10)', 'rgba(0,0,0,0)');
    CV.glow(ctx, W * 0.8, H * 0.72, H * 0.65, 'rgba(90,50,110,0.07)', 'rgba(0,0,0,0)');
    CV.drawStars(ctx, stars, t, opts || {});
  }

  // 文档级 lower-third 标题由 HTML 层承担；canvas 内不再印字。

  var Programs = {};

  // s01 钩子：星群被无形引力拉成弧线，旋入中心消失（"连光都无法逃脱"）
  Programs.s01 = {
    state: function () {
      return { lens: 0, pull: 0, spiral: 0, flash: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { lens: 340, duration: 6, ease: 'sine.out' }, 1.5);
      tl.to(st, { spiral: 1, duration: 14, ease: 'sine.inOut' }, 4);
      tl.to(st, { pull: 1, duration: 12, ease: 'sine.in' }, 6.5);
      tl.to(st, { flash: 1, duration: 0.4, ease: 'power2.out' }, 18.6);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { lens: st.lens, horizon: 6 + st.pull * 46 });
      var rnd = CV.mulberry32(77);
      // 被捕获的星流：三条旋臂逐星坠入
      for (var i = 0; i < 90; i++) {
        var baseA = rnd() * Math.PI * 2;
        var baseR = 320 + rnd() * 480;
        var arm = (i % 3) * (Math.PI * 2 / 3);
        var prog = CV.clamp01(st.spiral * (1.25 - (baseR - 320) / 480 * 0.5) - rnd() * 0.15);
        var ang = baseA + arm + prog * (5.5 + rnd());
        var r = baseR * (1 - CV.smooth(prog) * 0.94);
        if (r < 8) continue;
        var x = CX + Math.cos(ang) * r;
        var y = CY + Math.sin(ang) * r * 0.82;
        var a = CV.clamp01(prog * 4) * (1 - CV.smooth(prog) * 0.85);
        ctx.globalAlpha = a;
        ctx.fillStyle = i % 7 === 0 ? '#9dd6ff' : '#e8f1ff';
        ctx.beginPath();
        ctx.arc(x, y, 1.1 + rnd() * 1.4, 0, 6.2832);
        ctx.fill();
      }
      // 阴影本体随 pull 长大
      if (st.pull > 0.02) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(CX, CY, 6 + CV.smooth(st.pull) * 46, 0, 6.2832);
        ctx.fill();
      }
      if (st.flash > 0) {
        ctx.globalAlpha = (1 - st.flash) * 0.8;
        CV.glow(ctx, CX, CY, 220, 'rgba(200,230,255,0.9)', 'rgba(0,0,0,0)');
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.5);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s02 事件视界：黑影+光子环，光粒掠过弹开、越界即灭（"有去无回的边界"）
  Programs.s02 = {
    state: function () {
      return { ring: 0, flow: 0, pulse: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { ring: 1, duration: 5, ease: 'sine.out' }, 1);
      tl.to(st, { flow: 1, duration: 16, ease: 'none' }, 3);
      tl.to(st, { pulse: 1, duration: 10, ease: 'sine.inOut', yoyo: false }, 6);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { lens: 260, horizon: 120 });
      var R = 120;
      // 阴影
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 6.2832);
      ctx.fill();
      // 光子环（细亮圈，随 ring 浮现 + 呼吸）
      var ringA = CV.smooth(st.ring) * (0.75 + 0.25 * Math.sin(t * 2.2));
      ctx.globalAlpha = ringA;
      ctx.strokeStyle = '#ffe9c4';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R * 1.06, 0, 6.2832);
      ctx.stroke();
      ctx.globalAlpha = ringA * 0.5;
      CV.glow(ctx, CX, CY, R * 1.5, 'rgba(255,214,150,0.35)', 'rgba(0,0,0,0)');
      // 光粒流：从右侧射入，一部分被弹开（双曲轨道），落入视界的熄灭
      var rnd = CV.mulberry32(21);
      for (var i = 0; i < 60; i++) {
        var lane = rnd();
        var p = CV.clamp01(st.flow * (1.3 - lane * 0.5) - rnd() * 0.2);
        if (p <= 0 || p >= 1) continue;
        var y0 = CY + (rnd() - 0.5) * 520;
        var impact = Math.abs(y0 - CY) / 260; // 0 正对 → 1 擦边
        var x = lerpEx(W * 1.08, CX, p);
        var bend = (1 - impact) * 220 * CV.smooth(p);
        var y = y0 - (y0 > CY ? bend : -bend);
        var caught = impact < 0.32 && p > 0.62;
        if (caught) {
          // 越界：螺旋坠入并消失
          var sink = CV.clamp01((p - 0.62) / 0.38);
          var sa = Math.atan2(y - CY, x - CX) + sink * 4.2;
          var sr = Math.hypot(x - CX, y - CY) * (1 - sink);
          x = CX + Math.cos(sa) * sr;
          y = CY + Math.sin(sa) * sr;
          if (sr < R) continue;
          ctx.globalAlpha = 1 - sink;
        } else {
          ctx.globalAlpha = 0.9;
        }
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, 6.2832);
        ctx.fill();
        // 拖尾
        ctx.globalAlpha *= 0.25;
        ctx.beginPath();
        ctx.arc(x - 14, y, 1.1, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.5);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s03 时空弯曲：网格被压弯成井，测试星沿测地线滚入（"引力让时空弯曲"）
  Programs.s03 = {
    state: function () {
      return { mass: 0, roll: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { mass: 1, duration: 7, ease: 'sine.out' }, 1.5);
      tl.to(st, { roll: 1, duration: 11, ease: 'sine.inOut' }, 8);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { alpha: 0.55 });
      var dip = CV.smooth(st.mass) * 210;
      // 透视网格（网格线向中心凹陷）
      var cols = 24, rows = 14;
      ctx.strokeStyle = 'rgba(110,150,220,0.30)';
      ctx.lineWidth = 1;
      function surfaceY(x, y) {
        var d = Math.hypot(x - CX, (y - CY) * 1.6);
        var depth = dip * Math.exp(-Math.pow(d / 430, 2));
        return y + depth;
      }
      for (var c = 0; c <= cols; c++) {
        var x = (c / cols) * W;
        ctx.beginPath();
        for (var r2 = 0; r2 <= rows * 6; r2++) {
          var y = 140 + (r2 / (rows * 6)) * (H - 240);
          var sy = surfaceY(x, y);
          if (r2 === 0) ctx.moveTo(x, sy); else ctx.lineTo(x, sy);
        }
        ctx.stroke();
      }
      for (var r3 = 0; r3 <= rows; r3++) {
        var y2 = 140 + (r3 / rows) * (H - 240);
        ctx.beginPath();
        for (var c2 = 0; c2 <= cols * 6; c2++) {
          var x2 = (c2 / (cols * 6)) * W;
          var sy2 = surfaceY(x2, y2);
          if (c2 === 0) ctx.moveTo(x2, sy2); else ctx.lineTo(x2, sy2);
        }
        ctx.stroke();
      }
      // 井底质量
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(CX, CY + dip, 26 + dip * 0.16, 0, 6.2832);
      ctx.fill();
      ctx.globalAlpha = 0.8;
      CV.glow(ctx, CX, CY + dip, 90 + dip * 0.2, 'rgba(120,170,255,0.28)', 'rgba(0,0,0,0)');
      // 测试星沿井壁滚入
      if (st.roll > 0) {
        var p = CV.smooth(st.roll);
        var orbitR = 620 * (1 - p) + 34;
        var oa = -0.6 + p * 7.2;
        var sx = CX + Math.cos(oa) * orbitR;
        var sy3 = surfaceY(CX + Math.cos(oa) * orbitR, CY + Math.sin(oa) * orbitR * 0.62);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffd27f';
        CV.glow(ctx, sx, sy3, 26, 'rgba(255,210,127,0.95)', 'rgba(0,0,0,0)');
        ctx.fillStyle = '#fff4dc';
        ctx.beginPath();
        ctx.arc(sx, sy3, 6, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.42);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s04 燃料耗尽：脉动红巨星闪烁熄灭→核心急速内缩（"核燃料烧尽，坍缩开始"）
  Programs.s04 = {
    state: function () {
      return { pulse: 0, fade: 0, collapse: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { pulse: 1, duration: 9, ease: 'sine.inOut' }, 1);
      tl.to(st, { fade: 1, duration: 6, ease: 'sine.inOut' }, 9);
      tl.to(st, { collapse: 1, duration: 2.6, ease: 'power3.in' }, 16.5);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { alpha: 0.8 });
      var beat = Math.sin(t * 2.4) * 0.5 + 0.5;
      var R = (300 - st.fade * 70) * (1 + beat * 0.035 * (1 - st.collapse)) * (1 - CV.smooth(st.collapse) * 0.985);
      var flicker = 1 - st.fade * (0.55 + 0.2 * Math.sin(t * 9));
      // 红巨星本体
      if (R > 8) {
        ctx.globalAlpha = 1;
        CV.glow(ctx, CX, CY, R * 2.1, 'rgba(255,90,60,' + 0.22 * flicker + ')', 'rgba(0,0,0,0)');
        var g = ctx.createRadialGradient(CX - R * 0.25, CY - R * 0.25, R * 0.1, CX, CY, R);
        g.addColorStop(0, 'rgba(255,220,180,' + 0.95 * flicker + ')');
        g.addColorStop(0.55, 'rgba(255,120,80,' + 0.85 * flicker + ')');
        g.addColorStop(1, 'rgba(160,40,30,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(CX, CY, R, 0, 6.2832);
        ctx.fill();
        // 表面对流斑（缓慢移动的暗斑）
        var rnd = CV.mulberry32(4);
        for (var i = 0; i < 9; i++) {
          var a = rnd() * 6.28 + t * 0.05;
          var rr = R * (0.35 + rnd() * 0.5);
          ctx.globalAlpha = 0.12 * flicker;
          CV.glow(ctx, CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, R * 0.16, 'rgba(120,20,15,0.9)', 'rgba(0,0,0,0)');
        }
      }
      // 核心亮点（坍缩时收缩成刺目白点）
      if (st.collapse > 0) {
        var k = CV.smooth(st.collapse);
        ctx.globalAlpha = k;
        CV.glow(ctx, CX, CY, 30 + (1 - k) * 60, 'rgba(255,255,255,' + 0.9 * k + ')', 'rgba(0,0,0,0)');
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.48);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s05 坍缩与超新星冲击波：内爆→激波环扩散，中心留下黑点
  Programs.s05 = {
    state: function () {
      return { implode: 0, blast: 0, settle: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { implode: 1, duration: 2.2, ease: 'power3.in' }, 1.5);
      tl.to(st, { blast: 1, duration: 9, ease: 'sine.out' }, 3.7);
      tl.to(st, { settle: 1, duration: 8, ease: 'sine.inOut' }, 8);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { alpha: 0.75 });
      // 内爆吸入流
      if (st.implode > 0 && st.implode < 1) {
        var rnd = CV.mulberry32(9);
        for (var i = 0; i < 70; i++) {
          var p = CV.clamp01(st.implode * (1.15 - rnd() * 0.3));
          var a = rnd() * 6.2832;
          var r0 = 260 + rnd() * 380;
          var r = r0 * (1 - p);
          if (r < 6) continue;
          ctx.globalAlpha = 0.8 * (1 - p * 0.4);
          ctx.fillStyle = i % 3 ? '#ffd9a8' : '#a8d4ff';
          ctx.beginPath();
          ctx.arc(CX + Math.cos(a) * r, CY + Math.sin(a) * r * 0.9, 1.4, 0, 6.2832);
          ctx.fill();
        }
      }
      // 爆发闪光
      if (st.blast > 0) {
        var b = st.blast;
        ctx.globalAlpha = Math.max(0, 1 - b * 5);
        CV.glow(ctx, CX, CY, 420, 'rgba(255,244,214,0.95)', 'rgba(0,0,0,0)');
        // 激波环（双环：内亮外淡）
        var rr1 = 60 + CV.easeOutCubic(b) * 780;
        ctx.globalAlpha = Math.max(0, 0.85 - b * 0.8);
        ctx.strokeStyle = 'rgba(255,214,160,0.9)';
        ctx.lineWidth = 10 * (1 - b * 0.7);
        ctx.beginPath();
        ctx.arc(CX, CY, rr1, 0, 6.2832);
        ctx.stroke();
        var rr2 = 40 + CV.easeOutCubic(Math.max(0, b - 0.12)) * 560;
        ctx.globalAlpha = Math.max(0, 0.5 - b * 0.5);
        ctx.strokeStyle = 'rgba(150,190,255,0.7)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(CX, CY, rr2, 0, 6.2832);
        ctx.stroke();
        // 抛射物
        var rnd2 = CV.mulberry32(15);
        for (var j = 0; j < 110; j++) {
          var a2 = rnd2() * 6.2832;
          var v = 240 + rnd2() * 620;
          var d2 = CV.easeOutCubic(b) * v;
          ctx.globalAlpha = Math.max(0, 0.9 - b * 0.75);
          ctx.fillStyle = rnd2() > 0.5 ? '#ffd9a8' : '#ffb37a';
          ctx.beginPath();
          ctx.arc(CX + Math.cos(a2) * d2, CY + Math.sin(a2) * d2 * 0.92, 1.2 + rnd2() * 1.6, 0, 6.2832);
          ctx.fill();
        }
      }
      // 中心残留黑点（settle 后黑洞成形）
      var hole = CV.smooth(st.settle);
      if (hole > 0.05) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(CX, CY, 10 + hole * 50, 0, 6.2832);
        ctx.fill();
        ctx.globalAlpha = hole * 0.7;
        ctx.strokeStyle = 'rgba(255,220,170,0.8)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(CX, CY, (10 + hole * 50) * 1.08, 0, 6.2832);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.5);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s06 双星系统：蓝巨星与不可见伴星互绕，物质流被扯向伴星（天鹅座 X-1）
  Programs.s06 = {
    state: function () {
      return { appear: 0, orbit: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { appear: 1, duration: 4, ease: 'sine.out' }, 1);
      tl.to(st, { orbit: 1, duration: 15, ease: 'none' }, 4);
    },
    draw: function (ctx, st, opts, t) {
      backdrop(ctx, opts.stars, t, { alpha: 0.85 });
      var a = CV.smooth(st.appear);
      var ang = st.orbit * Math.PI * 2 * 1.6;
      var sx = CX - 260 + Math.cos(ang) * 230;
      var sy = CY + Math.sin(ang) * 84;
      var bx = CX + 300 + Math.cos(ang + Math.PI) * 120;
      var by = CY + Math.sin(ang + Math.PI) * 44;
      ctx.globalAlpha = a;
      // 蓝巨星
      CV.glow(ctx, sx, sy, 120, 'rgba(150,200,255,0.5)', 'rgba(0,0,0,0)');
      var g = ctx.createRadialGradient(sx, sy, 4, sx, sy, 44);
      g.addColorStop(0, 'rgba(240,250,255,1)');
      g.addColorStop(0.6, 'rgba(140,190,255,0.95)');
      g.addColorStop(1, 'rgba(60,110,220,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, 44, 0, 6.2832);
      ctx.fill();
      // 不可见伴星：只有扭曲的物质流和吸积热点暴露它的位置
      CV.glow(ctx, bx, by, 60, 'rgba(255,190,120,0.35)', 'rgba(0,0,0,0)');
      // 物质流：从巨星拉向伴星的粒子桥
      var rnd = CV.mulberry32(31);
      for (var i = 0; i < 80; i++) {
        var p = (st.orbit * 2.2 + rnd()) % 1;
        var mx = lerpEx(sx, bx, p) + Math.sin(p * 6.28 + i) * 14;
        var my = lerpEx(sy, by, p) - Math.cos(p * 6.28 + i) * 10;
        ctx.globalAlpha = a * Math.sin(p * 3.14) * 0.85;
        ctx.fillStyle = p > 0.75 ? '#ffcf9a' : '#bcd9ff';
        ctx.beginPath();
        ctx.arc(mx, my, 1.1 + rnd() * 1.3, 0, 6.2832);
        ctx.fill();
      }
      // 吸积盘热点闪烁
      ctx.globalAlpha = a * (0.5 + 0.4 * Math.sin(t * 5.2));
      CV.glow(ctx, bx, by, 26, 'rgba(255,230,190,0.9)', 'rgba(0,0,0,0)');
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.48);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s07 M87 吸积盘：EHT 同款金色盘面绕黑影，多普勒左亮右暗
  Programs.s07 = {
    state: function () {
      return { emerge: 0, spin: 0, zoom: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { emerge: 1, duration: 5, ease: 'sine.out' }, 1);
      tl.to(st, { spin: 1, duration: 16, ease: 'none' }, 2);
      tl.to(st, { zoom: 1, duration: 18, ease: 'sine.inOut' }, 3);
    },
    draw: function (ctx, st, opts, t) {
      var z = 1 + CV.smooth(st.zoom) * 0.22;
      ctx.save();
      ctx.translate(CX, CY);
      ctx.scale(z, z);
      ctx.translate(-CX, -CY);
      ctx.fillStyle = BG;
      ctx.fillRect(-100, -100, W + 200, H + 200);
      CV.drawStars(ctx, opts.stars, t, { alpha: 0.8, cx: CX, cy: CY, zoom: z });
      var e = CV.smooth(st.emerge);
      // 盘面辉光（椭圆晕）
      ctx.globalAlpha = e;
      CV.glow(ctx, CX, CY, 500, 'rgba(255,150,60,0.16)', 'rgba(0,0,0,0)');
      // 吸积盘粒子
      CV.drawDisk(ctx, opts.disk, st.spin * 26, { cx: CX, cy: CY, r0: 150, r1: 430, speed: 0.09 });
      // 前景盘弧（盘面下缘从黑影前方经过——引力透镜成像特征）
      ctx.globalAlpha = e * 0.9;
      ctx.strokeStyle = 'rgba(255,196,120,0.55)';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.ellipse(CX, CY, 165, 52, 0, 0.35, Math.PI - 0.35);
      ctx.stroke();
      // 黑影（最后盖上，切出剪影）
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(CX, CY, 138, 0, 6.2832);
      ctx.fill();
      // 光子环
      ctx.globalAlpha = e * (0.8 + 0.2 * Math.sin(t * 2));
      ctx.strokeStyle = 'rgba(255,232,190,0.85)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(CX, CY, 142, 0, 6.2832);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.52);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  // s08 终幕：黑洞剪影缓慢拉远，星场重归宁静
  Programs.s08 = {
    state: function () {
      return { calm: 0, out: 0 };
    },
    tweens: function (tl, st) {
      tl.to(st, { calm: 1, duration: 5, ease: 'sine.inOut' }, 1);
      tl.to(st, { out: 1, duration: 17, ease: 'sine.inOut' }, 2.5);
    },
    draw: function (ctx, st, opts, t) {
      var z = 1 + CV.smooth(st.out) * 0.6;
      backdrop(ctx, opts.stars, t, { alpha: 0.9, cx: CX, cy: CY, zoom: z, lens: 230, horizon: 96 });
      var hole = 96;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(CX, CY, hole, 0, 6.2832);
      ctx.fill();
      ctx.globalAlpha = 0.75 * (1 - CV.smooth(st.out) * 0.5);
      ctx.strokeStyle = 'rgba(255,226,180,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(CX, CY, hole * 1.05, 0, 6.2832);
      ctx.stroke();
      // 环绕的残余星尘（缓慢）
      var rnd = CV.mulberry32(88);
      for (var i = 0; i < 40; i++) {
        var a0 = rnd() * 6.2832;
        var rr = hole * 1.5 + rnd() * 160;
        var a = a0 + t * 0.1 * (0.5 + rnd());
        ctx.globalAlpha = 0.35 + 0.3 * Math.sin(t + i);
        ctx.fillStyle = '#d8e6ff';
        ctx.beginPath();
        ctx.arc(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr * 0.3, 0.8 + rnd(), 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      CV.vignette(ctx, W, H, 0.5);
      CV.letterbox(ctx, W, H, 0.055);
    },
  };

  function lerpEx(a, b, t) { return a + (b - a) * t; }

  // 时间轴缩放代理：把程序的 20s 编排等比压缩到镜头实际时长（节拍密度不降，V-RHY-006）
  global.scaleCinemaTl = function (tl, K) {
    function sargs(a) {
      a = Array.prototype.slice.call(a);
      if (a[1] && typeof a[1] === 'object') {
        var v = Object.assign({}, a[1]);
        if (typeof v.duration === 'number') v.duration = v.duration * K;
        if (typeof v.repeat === 'number' && v.yoyo) v.repeat = Math.max(1, Math.round(v.repeat));
        a[1] = v;
      }
      if (typeof a[2] === 'number') a[2] = a[2] * K;
      return a;
    }
    return {
      to: function () { return tl.to.apply(tl, sargs(arguments)); },
      from: function () { return tl.from.apply(tl, sargs(arguments)); },
      fromTo: function () { return tl.fromTo.apply(tl, sargs(arguments)); },
      set: function () { return tl.set.apply(tl, sargs(arguments)); },
    };
  };

  global.CinemaPrograms = Programs;
})(window);
