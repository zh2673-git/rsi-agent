// 案例 A 逐镜场景生成器（kinetic-type 语法族：字是演员）
//
// 为什么是生成器而不是手写 7 个 HTML 文件：
//   场景之间有共享的结构（舞台/色带/环境母题），但每一镜的**主语词、数字、
//   动作谱**都不同；生成器把这些差异外显成数据表，一镜一改，且能重跑。
//
// 铁律遵守（SKILL.md 工作规则 8 + docs/10）：
//   - 画面不复述旁白原文（V-SCENE-005）：上屏的是抽象名词与数字，不是句子；
//   - 主语唯一（V-COMP-001）；辅助元素 opacity ≤0.7（V-MOT-004）；
//   - 时长只用 profile 档位；缓动只用白名单；
//   - 重音由 data-accent 决定（本镜砸不砸），不是每镜都砸（V-MOT-013）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/ 在项目内：projects/<id>/tools → 向上三级才是 skill 根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/scenes-case-a.mjs <project-id>');
  process.exit(1);
}

const STYLE = {
  primary: '#0f7b96',
  accent: '#e8a33d',
  ink: '#1f1b16',
  ink2: '#5b5245',
  ink3: '#8d8272',
  paper: '#f6f1e6',
  paper2: '#e9e1d1',
  font: "'Microsoft YaHei','PingFang SC',sans-serif",
};

// 每镜的设计（主语词是抽象名词，不是旁白句子）
const SHOTS = [
  {
    accent: 1,
    kicker: 'MOTION GRAMMAR',
    hero: '对上',
    sub: '不是给每句话配一张图',
    figure: '01',
    figureTo: 1,
    figureDec: 0,
    figureSuffix: '',
    motif: 'shimmer',
    camera: 'push-in',
  },
  {
    accent: 0,
    kicker: 'STEP 01 · 动作谱',
    hero: '六件事',
    sub: '准备 / 主动作 / 刹停 / 让位 / 相机 / 声音',
    figure: '',
    figureTo: 0,
    motif: 'float',
    camera: 'pan',
  },
  {
    accent: 0,
    kicker: 'BUDGET',
    hero: '稀缺',
    sub: '重音不是每句都给的',
    figure: '33%',
    figureTo: 33,
    figureDec: 0,
    figureSuffix: '%',
    motif: 'shimmer',
    camera: 'static',
  },
  {
    accent: 0,
    kicker: 'ANTI-PATTERN',
    hero: '都加粗',
    sub: '等于没有重点',
    figure: '',
    figureTo: 0,
    motif: 'pulse',
    camera: 'punch-in',
  },
  {
    accent: 0,
    kicker: 'STEP 03 · 母题',
    hero: '活的',
    sub: '一个主动作 + 两个环境循环',
    figure: '2',
    figureTo: 2,
    figureDec: 0,
    figureSuffix: ' 个',
    motif: 'float',
    camera: 'pan',
  },
  {
    accent: 0,
    kicker: 'FOCUS',
    hero: '单焦点',
    sub: '字在动，光也在动',
    figure: '',
    figureTo: 0,
    motif: 'shimmer',
    camera: 'drift',
  },
  {
    accent: 1,
    kicker: 'CONCLUSION',
    hero: '落在词上',
    sub: '丰富 ≠ 更多动效',
    figure: '',
    figureTo: 0,
    motif: 'pulse',
    camera: 'pull-out',
  },
];

function page(shotId, s) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  [data-scene-id] { position: relative; width: 100%; height: 100%; }
  body { font-family: ${STYLE.font}; background: ${STYLE.paper}; color: ${STYLE.ink}; }
  .stage {
    position: relative; width: 100%; height: 100%;
    display: flex; flex-direction: column; justify-content: center;
    padding: 9% 10%; box-sizing: border-box;
    background:
      radial-gradient(ellipse at 78% 16%, ${STYLE.accent}1f 0%, transparent 58%),
      linear-gradient(168deg, ${STYLE.paper} 0%, ${STYLE.paper2} 100%);
  }
  .grain-field {
    position: absolute; inset: -6%; opacity: 0.45; pointer-events: none;
    background-image:
      repeating-linear-gradient(0deg, ${STYLE.ink3}16 0 1px, transparent 1px 4.2vmin),
      repeating-linear-gradient(90deg, ${STYLE.ink3}16 0 1px, transparent 1px 4.2vmin);
  }
  .subject {
    position: relative; z-index: 3;
    font-size: 128px; font-weight: 800; line-height: 1.06;
    letter-spacing: -0.03em; color: ${STYLE.ink}; max-width: 92%;
  }
  .subject em {
    font-style: normal; color: ${STYLE.primary};
    position: relative; display: inline-block; isolation: isolate;
  }
  .subject em .hl {
    position: absolute; left: -0.06em; right: -0.06em; bottom: 0.06em; height: 0.34em;
    background: ${STYLE.accent}; opacity: 0.4; z-index: -1;
    transform-origin: 0 50%; display: block; border-radius: 2px;
  }
  .figure {
    position: absolute; right: 10%; bottom: 15%; z-index: 3;
    font-size: 92px; font-weight: 800; color: ${STYLE.primary};
    font-variant-numeric: tabular-nums; letter-spacing: -0.04em;
  }
  .kicker {
    position: relative; z-index: 3; font-size: 30px; font-weight: 600;
    letter-spacing: 0.26em; text-transform: uppercase;
    color: ${STYLE.ink2}; margin-bottom: 2.2vmin;
  }
  .hint {
    position: relative; z-index: 3; margin-top: 3.4vmin;
    font-size: 34px; line-height: 1.6; color: ${STYLE.ink2};
    max-width: 78%; opacity: 0.68;
  }
  .rule-line {
    position: absolute; left: 10%; top: 21%; width: 3px; height: 23%; z-index: 2;
    background: linear-gradient(180deg, ${STYLE.primary}, transparent);
    transform-origin: 50% 0;
  }
  .band { position: absolute; left: 0; right: 0; height: 33.4%; opacity: 0; pointer-events: none; }
  .band.b1 { top: 0; background: ${STYLE.primary}; }
  .band.b2 { top: 33.3%; background: ${STYLE.accent}; }
  .band.b3 { top: 66.6%; background: ${STYLE.primary}; }
  .grain { position: absolute; inset: 0; pointer-events: none; opacity: 0.05; mix-blend-mode: multiply;
    background-image: repeating-radial-gradient(circle at 30% 40%, rgba(90,74,50,0.14) 0 0.5px, transparent 0.6px 2.2px);
    background-size: 3px 3px; }
  .vignette { position: absolute; inset: 0; pointer-events: none; opacity: 0.2;
    background: radial-gradient(ellipse at center, transparent 54%, rgba(58,44,24,0.4) 132%); }
</style>
</head>
<body data-scene-id="${shotId}">
<div data-scene-id="${shotId}" data-beats="5" data-accent="${s.accent}">
  <div class="stage">
    <div class="grain-field" data-motif></div>
    <div class="rule-line" data-rule></div>
    <div class="kicker" data-rank="tertiary">${s.kicker}</div>
    <div class="subject" data-rank="primary"><em>${s.hero}<span class="hl"></span></em></div>
    <div class="figure">${s.figure}</div>
    <div class="hint" data-rank="secondary">${s.sub}</div>
    <div class="band b1"></div><div class="band b2"></div><div class="band b3"></div>
  </div>
  <div class="grain"></div>
  <div class="vignette"></div>
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
      MV.slam('.subject', { delay: 60 });
      MV.highlight('.subject em .hl', { delay: 300 });
    } else {
      MV.enter('.subject', { easing: 'power3.out', duration: 600, from: { opacity: 0, y: 52 } });
      MV.highlight('.subject em .hl', { delay: 360 });
    }
    MV.staggeredIn('.kicker, .hint', { delay: 120, secondary: 180, tertiary: 320 });
    ${s.figure ? `MV.counter('.figure', { from: 0, to: ${s.figureTo}, decimals: ${s.figureDec}, suffix: '${s.figureSuffix ?? ''}', delay: 420 });` : ''}
    MV.maskReveal('.rule-line', { dir: 'down', duration: 500, delay: 200 });
    MV.motifLoop('.grain-field', { kind: '${s.motif}', amp: 0.3, span: 14 });
    MV.enter('.figure', { easing: 'power2.out', duration: 600, delay: 300, from: { opacity: 0 } });
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
