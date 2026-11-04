import { describe, expect, it } from 'vitest';
import { assertShotTransition } from '../src/runtime/state-engine.js';
import { MvError } from '../src/core/errors.js';

describe('镜头状态机', () => {
  it('合法迁移通过', () => {
    expect(() => assertShotTransition('pending', 'sourcing')).not.toThrow();
    expect(() => assertShotTransition('sourcing', 'sourced')).not.toThrow();
    expect(() => assertShotTransition('sourced', 'voicing')).not.toThrow();
    expect(() => assertShotTransition('voicing', 'voiced')).not.toThrow();
    expect(() => assertShotTransition('voiced', 'ready')).not.toThrow();
    expect(() => assertShotTransition('failed', 'pending')).not.toThrow();
  });

  it('非法迁移抛 ERR_ILLEGAL_TRANSITION', () => {
    expect(() => assertShotTransition('pending', 'ready')).toThrow(MvError);
    expect(() => assertShotTransition('ready', 'pending')).toThrow(MvError);
    expect(() => assertShotTransition('sourced', 'ready')).toThrow(MvError);
    try {
      assertShotTransition('pending', 'ready');
    } catch (e) {
      expect((e as MvError).code).toBe('ERR_ILLEGAL_TRANSITION');
    }
  });
});
