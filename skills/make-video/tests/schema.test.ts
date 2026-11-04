import { describe, expect, it } from 'vitest';
import {
  ProjectSchema,
  StylePackSchema,
  RecipeSchema,
  ShotStateSchema,
} from '../src/core/schema.js';

const stylePack = {
  id: 'test-pack',
  name: '测试包',
  grade: 'A',
  status: 'registered',
  userFacing: { name: '测试', aliases: ['t'], vibe: 'v', bestFor: ['science-explainer'] },
  anatomy: {
    script: 's',
    directing: 'd',
    art: 'a',
    camera: 'c',
    performance: 'p',
    sourcing: 'so',
    sound: 'sd',
    editing: 'e',
  },
  palette: {
    primary: '#111111',
    accent: '#222222',
    neutral: ['#1', '#2', '#3', '#4', '#5'],
    colorArc: 'x→y',
  },
  type: { families: ['sans'], scale: { title: 0.1, body: 0.03 }, tracking: {} },
  layout: { density: 0.3, maxElementsPerShot: 3, whitespace: 0.4 },
  motion: { easing: 'power3.out', intensity: 0.5, staggerMs: 80, spring: { stiffness: 180, damping: 20 } },
  pacing: { curve: 'three-act', shotLenMs: [1500, 3000], breathEvery: 5 },
  effects: { grain: 0.1, vignette: 0.2 },
  transitions: ['dissolve'],
  shotScaleBias: ['MS'],
  provenance: { source: 'manual', from: 'test', version: '1.0' },
};

describe('schema', () => {
  it('风格包 round-trip', () => {
    const parsed = StylePackSchema.parse(stylePack);
    expect(parsed.id).toBe('test-pack');
  });

  it('拒绝缺 neutral 的风格包', () => {
    const bad = { ...stylePack, palette: { ...stylePack.palette, neutral: ['#1'] } };
    expect(StylePackSchema.safeParse(bad).success).toBe(false);
  });

  it('镜头状态枚举', () => {
    expect(ShotStateSchema.parse('voiced')).toBe('voiced');
    expect(ShotStateSchema.safeParse('weird').success).toBe(false);
  });

  it('项目 IR 合法构造', () => {
    const project = {
      schemaVersion: 1,
      meta: {
        id: 'p1',
        title: 't',
        topic: 'topic',
        aspect: '16:9',
        durationTier: '0-5',
        fps: 30,
        genre: 'science-explainer',
        assetPolicy: 'auto',
      },
      stage: 'init',
      directorNotes: [],
      shots: [],
      materialDecisions: {},
      confirmed: false,
    };
    expect(ProjectSchema.parse(project).meta.id).toBe('p1');
  });
});
