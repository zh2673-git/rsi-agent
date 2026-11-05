// 案例 C 场景生成器：neon-tech-cinematic（深色底 / 青色数据光 / 琥珀证据点）
// 纪律：这一派靠「数据在流动」给科技感，所以每镜都有一个持续运动的激光/数据层；
// 时序用 2D 纵深（blur/scale/透视线）不用 3D 原语（styleVisual.dimension=2d）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/ 在项目内：projects/<id>/tools → 向上三级才是 skill 根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/scenes-case-c.mjs <project-id>');
  process.exit(1);
}

const S = {
  bg: '#05070d',
  bg2: '#0a1220',
  ink: '#e8f4ff',
  ink2: '#7f95ad',
  cyan: '#22d3ee',
  amber: '#fbbf24',
  grid: '#12324a',
  font: "'Microsoft YaHei','PingFang SC','SF Pro Display',sans-serif",
};

// accent=1 才砸（5 镜最多 1 个，V-MOT-013）
const SHOTS = [
  {
    accent: 0,
    kicker: 'QUERY',
    hero: '更聪明？',
    sub: '所有人都在问同一个问题',
    metric: '',
    motif: 'sweep',
    cam: 'push-in',
    evidence: false,
  },
  {
    accent: 1,
    kicker: 'BOTTLENECK',
    hero: '记忆',
    sub: '卡住它的不是智力',
    metric: '',
    motif: 'pulse',
    cam: 'pan',
    evidence: true,
  },
  {
    accent: 0,
    kicker: 'OVERFLOW',
    hero: '挤出去',
    sub: '上下文被填满之后',
    metric: '',
    motif: 'drain',
    cam: 'push-in',
    evidence: false,
  },
  {
    accent: 0,
    kicker: 'RETRY',
    hero: '第二遍',
    sub: '同一件事，它又问了一次',
    metric: '2',
    motif: 'scan',
    cam: 'pull-out',
    evidence: true,
  },
  {
    accent: 0,
    kicker: 'REAL PROGRESS',
    hero: '记得住',
    sub: '不是参数变大',
    metric: '',
    motif: 'settle',
    cam: 'tilt-up',
    evidence: false,
  },
];

function page(shotId, s) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${shotId}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  [data-scene-id] { position: relative; width: 100%; height: 100%; }
  body { font-family: ${S.font}; background: ${S.bg}; color: ${S.ink}; }
  .stage {
    position: relative; width: 100%; height: 100%;
    display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
    padding: 0 11%; box-sizing: border-box;
    background:
      radial-gradient(ellipse at 20% 24%, rgba(34,211,238,0.16) 0%, transparent 58%),
      radial-gradient(ellipse at 82% 78%, rgba(251,191,36,0.10) 0%, transparent 52%),
      linear-gradient(165deg, ${S.bg} 0%, ${S.bg2} 100%);
  }
  /* 数据网格：透视线收束到左侧消失点，给纵深而不上 3D 原语 */
  .grid-field {
    position: absolute; inset: -8%; pointer-events: none; opacity: 0.40;
    background-image:
      linear-gradient(to right, ${S.grid} 1px, transparent 1px),
      linear-gradient(to bottom, ${S.grid} 1px, transparent 1px);
    background-size: 5.5% 9%;
    transform: perspective(900px) rotateY(14deg) scale(1.08);
    -webkit-mask-image: linear-gradient(to right, #000 0%, transparent 72%);
    mask-image: linear-gradient(to right, #000 0%, transparent 72%);
  }
  /* 扫描光带：整片持续横移，科技感的主来源 */
  .laser {
    position: absolute; left: -30%; top: 0; width: 26%; height: 100%; z-index: 1;
    pointer-events: none; opacity: 0.55;
    background: linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.05) 40%, rgba(34,211,238,0.34) 78%, transparent 100%);
    filter: blur(2px);
  }
  .subject {
    position: relative; z-index: 4;
    font-size: 150px; font-weight: 800; line-height: 1.02;
    letter-spacing: -0.03em; color: ${S.ink}; max-width: 88%;
    text-shadow: 0 0 26px rgba(34,211,238,0.30);
  }
  .subject em {
    font-style: normal; color: ${S.cyan};
    position: relative; display: inline-block; isolation: isolate;
  }
  .subject em .hl {
    position: absolute; left: -0.05em; right: -0.05em; bottom: 0.08em; height: 0.12em;
    background: ${S.cyan}; opacity: 0.45; z-index: -1;
    transform-origin: 0 50%; display: block; border-radius: 2px;
  }
  .kicker {
    position: absolute; left: 11%; top: 12%; z-index: 4;
    font-size: 22px; font-weight: 700; letter-spacing: 0.34em;
    color: ${S.cyan}; opacity: 0.92;
  }
  .hint {
    position: relative; z-index: 4; margin-top: 4vmin;
    font-size: 34px; line-height: 1.5; color: ${S.ink2}; max-width: 62%;
  }
  /* 琥珀证据点：只有 evidence=true 的镜头出现，作为「这里有实测」的视觉标记 */
  .evidence {
    position: absolute; right: 12%; top: 22%; z-index: 4;
    display: flex; align-items: center; gap: 14px;
    font-size: 20px; font-weight: 700; letter-spacing: 0.24em; color: ${S.amber};
  }
  .evidence .dot {
    width: 12px; height: 12px; border-radius: 50%; background: ${S.amber};
    box-shadow: 0 0 16px rgba(251,191,36,0.85);
  }
  .metric {
    position: absolute; right: 12%; bottom: 16%; z-index: 4;
    font-size: 118px; font-weight: 800; color: ${S.amber};
    font-variant-numeric: tabular-nums; letter-spacing: -0.04em;
    opacity: 0.92;
  }
  /* 基线：一条冷光横线，压住画面下缘 */
  .baseline {
    position: absolute; left: 11%; bottom: 14%; width: 34%; height: 2px; z-index: 3;
    background: linear-gradient(90deg, ${S.cyan} 0%, transparent 100%);
    transform-origin: 0 50%; opacity: 0.7;
  }
</style>
</head>
<body data-scene-id="${shotId}">
<div data-scene-id="${shotId}" data-beats="5" data-accent="${s.accent}">
  <div class="stage">
    <div class="grid-field" data-grid></div>
    <div class="laser" data-laser></div>
    <div class="kicker" data-rank="tertiary">${s.kicker}</div>
    <div class="subject" data-rank="primary"><em>${s.hero}<span class="hl"></span></em></div>
    <div class="hint" data-rank="secondary">${s.sub}</div>
    ${s.metric ? `<div class="metric">${s.metric}</div>` : ''}
    ${s.evidence ? '<div class="evidence"><span class="dot"></span>MEASURED</div>' : ''}
    <div class="baseline" data-baseline></div>
  </div>
</div>
<script src="../motion/gsap.min.js"></script>
<script src="../motion/motion-lib.js"></script>
<script>
(function () {
  function boot() {
    MV.use('scene-${shotId}');
    if (!MV.timeline()) return;
    var accentEl = document.querySelector('[data-accent]');
    var accent = accentEl ? accentEl.getAttribute('data-accent') === '1' : false;

    if (accent) {
      MV.slam('.subject', { delay: 40 });
      MV.highlight('.subject em .hl', { delay: 300 });
    } else {
      MV.enter('.subject', { easing: 'power3.out', duration: 600, from: { opacity: 0, y: 48 } });
      MV.highlight('.subject em .hl', { delay: 400 });
    }
    MV.staggeredIn('.kicker, .hint', { delay: 80, secondary: 380, tertiary: 180 });
    ${s.metric ? "MV.counter('.metric', { from: 0, to: 2, decimals: 0, suffix: '', delay: 420 });" : ''}
    MV.maskReveal('.baseline', { dir: 'right', duration: 520, delay: 240 });
    // 数据流：网格缓慢漂移 + 扫描光带横穿，两种节奏叠出「机器在工作」
    MV.motifLoop('[data-grid]', { kind: '${s.motif}', amp: 0.26, span: 18 });
    MV.motifLoop('[data-laser]', { kind: 'rotate', amp: 0.9, span: 11 });
    ${s.evidence ? "MV.motifLoop('.evidence .dot', { kind: 'pulse', amp: 0.6, span: 22 });" : ''}
    MV.camera('.stage', { move: '${s.cam}', zoom: 1.07 });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
</body>
</html>
`;
}

const sceneDir = path.join(ROOT, 'projects', id, 'scenes');
await fs.mkdir(sceneDir, { recursive: true });
for (let i = 0; i < SHOTS.length; i += 1) {
  const shotId = `s${String(i + 1).padStart(2, '0')}`;
  await fs.writeFile(path.join(sceneDir, `Scene_${shotId}.html`), page(shotId, SHOTS[i]), 'utf8');
}
console.log(`写入 ${SHOTS.length} 个场景 → ${sceneDir}`);
