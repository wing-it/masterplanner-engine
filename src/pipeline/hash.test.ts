import { describe, expect, it } from 'vitest';

import { stableValueHash } from './hash';

describe('stableValueHash', () => {
  it('is stable across key order and equivalent structures', () => {
    expect(stableValueHash({ a: 1, b: 2 })).toBe(stableValueHash({ b: 2, a: 1 }));
    expect(stableValueHash([1, 2, 3])).not.toBe(stableValueHash([3, 2, 1]));
  });

  it('separates values that collide under a single 32-bit FNV-1a pass', () => {
    // These two strings hash identically under FNV-1a/32 over their JSON form
    // (found by brute force). The cache trusts keys without verifying inputs,
    // so the key must carry more than 32 bits.
    expect(stableValueHash('k4pwu')).not.toBe(stableValueHash('kf5fa'));
  });

  it('emits the widened 64-bit key format', () => {
    expect(stableValueHash({ any: 'value' })).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });
});
