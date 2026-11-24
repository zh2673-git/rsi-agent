import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSceneSystemPrompt,
  buildScriptSystemPrompt,
} from '../src/infrastructure/llm-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('视觉丰富性注入三处系统提示词', () => {
  it('编剧提示词要求为可视化写具体动作', () => {
    const prompt = buildScriptSystemPrompt();
    expect(prompt).toContain('为可视化写动作');
    expect(prompt).toContain('谁是主体');
  });

  it('导演批注提示词要求画面丰富且区分丰富与乱动', () => {
    // 导演批注提示词无单独导出，读源码文本断言锁定注入，避免随重构静默丢失
    const src = readFileSync(path.join(REPO_ROOT, 'src/infrastructure/llm-client.ts'), 'utf8');
    expect(src).toContain('这一镜怎么"画面丰富"');
    expect(src).toContain('动作准确与丰富纪律');
    expect(src).toContain('动作由语义决定');
    expect(src).toContain('元素动优先于镜头动');
    expect(src).toContain('丰富不等于堆砌');
  });

  it('场景画师提示词把视觉丰富列为创作目标且禁止乱动', () => {
    const prompt = buildSceneSystemPrompt();
    expect(prompt).toContain('视觉丰富');
    expect(prompt).toContain('乱动');
    expect(prompt).toContain('镜头推拉摇移不替代元素自身的运动');
  });
});
