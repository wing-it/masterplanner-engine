import { describe, expect, it } from 'vitest';

import {
  createLayerCache,
  createMemoryPersistentLayerCacheBackend,
  type LayerCachePersistentBackend,
} from './layer-cache';

function persistentSpyBackend(): LayerCachePersistentBackend & {
  values: Map<string, unknown>;
  sets: string[];
} {
  const values = new Map<string, unknown>();
  const sets: string[] = [];

  return {
    values,
    sets,

    async get(hash) {
      return values.get(hash) ?? null;
    },

    async set(hash, value) {
      sets.push(hash);
      values.set(hash, value);
    },

    async delete(hash) {
      values.delete(hash);
    },

    async clear() {
      values.clear();
    },
  };
}

describe('LayerCache', () => {
  it('stores small payloads in memory and retrieves them by hash', async () => {
    const cache = createLayerCache({
      persistentBackend: persistentSpyBackend(),
      persistenceThresholdBytes: 64,
    });

    await cache.set('small', { value: 1 });

    await expect(cache.get('small')).resolves.toEqual({ value: 1 });
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 0,
      memoryEntries: 1,
      memorySets: 1,
      persistentSets: 0,
      lastBackend: 'memory',
    });
  });

  it('stores large payloads in the persistent backend when one is injected', async () => {
    const backend = persistentSpyBackend();
    const cache = createLayerCache({
      persistentBackend: backend,
      persistenceThresholdBytes: 16,
    });

    await cache.set('large', { value: 'this payload is intentionally bigger than sixteen bytes' });

    expect(backend.sets).toEqual(['large']);
    expect(cache.stats()).toMatchObject({
      memoryEntries: 0,
      persistentSets: 1,
      lastBackend: 'persistent',
    });
    await expect(cache.get('large')).resolves.toEqual({
      value: 'this payload is intentionally bigger than sixteen bytes',
    });
    expect(cache.stats().lastBackend).toBe('persistent');
  });

  it('returns null for misses', async () => {
    const cache = createLayerCache({ persistentBackend: createMemoryPersistentLayerCacheBackend() });

    await expect(cache.get('missing')).resolves.toBeNull();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, lastBackend: null });
  });

  it('evicts the oldest memory entry when the LRU limit is exceeded', async () => {
    const cache = createLayerCache({
      memoryLimit: 2,
      persistentBackend: null,
      persistenceThresholdBytes: 1000,
    });

    await cache.set('a', { value: 'a' });
    await cache.set('b', { value: 'b' });
    await cache.get('a');
    await cache.set('c', { value: 'c' });

    await expect(cache.get('a')).resolves.toEqual({ value: 'a' });
    await expect(cache.get('b')).resolves.toBeNull();
    await expect(cache.get('c')).resolves.toEqual({ value: 'c' });
  });

  it('clones values on write and read', async () => {
    const cache = createLayerCache({ persistentBackend: null });
    const original = { nested: { value: 1 } };

    await cache.set('hash', original);
    original.nested.value = 2;

    const first = await cache.get<typeof original>('hash');
    expect(first).toEqual({ nested: { value: 1 } });
    first!.nested.value = 3;

    await expect(cache.get('hash')).resolves.toEqual({ nested: { value: 1 } });
  });

  it('defaults to memory-only with no persistent backend', async () => {
    const cache = createLayerCache({ persistenceThresholdBytes: 10 });

    const largeValue = { data: 'some large text that would exceed the persistence threshold' };
    await cache.set('big-key', largeValue);

    expect(cache.stats()).toMatchObject({
      memorySets: 1,
      persistentSets: 0,
      lastBackend: 'memory',
    });
    await expect(cache.get('big-key')).resolves.toEqual(largeValue);
  });

  it('survives simulated reload via a shared persistent backend', async () => {
    const backend = createMemoryPersistentLayerCacheBackend();
    const cache1 = createLayerCache({
      persistentBackend: backend,
      persistenceThresholdBytes: 10, // Force persistence
    });

    const largeValue = { data: 'some large text to force persistence' };
    await cache1.set('db-key', largeValue);

    // Re-create the cache (simulating page reload) over the same backend
    const cache2 = createLayerCache({
      persistentBackend: backend,
      persistenceThresholdBytes: 10,
    });

    await expect(cache2.get('db-key')).resolves.toEqual(largeValue);
    expect(cache2.stats().lastBackend).toBe('persistent');
  });
});
