const DEFAULT_MEMORY_LIMIT = 100;
export const DEFAULT_PERSISTENCE_THRESHOLD_BYTES = 64 * 1024;

export interface LayerCachePersistentBackend {
  get(hash: string): Promise<unknown | null>;
  set(hash: string, value: unknown, sizeBytes: number): Promise<void>;
  delete(hash: string): Promise<void>;
  clear(): Promise<void>;
}

export interface LayerCacheStats {
  hits: number;
  misses: number;
  memoryEntries: number;
  memorySets: number;
  persistentSets: number;
  lastBackend: 'memory' | 'persistent' | null;
}

export interface LayerCacheOptions {
  memoryLimit?: number;
  persistenceThresholdBytes?: number;
  persistentBackend?: LayerCachePersistentBackend | null;
}

export interface LayerCache {
  get<T>(hash: string): Promise<T | null>;
  set<T>(hash: string, value: T): Promise<void>;
  delete(hash: string): Promise<void>;
  clear(): Promise<void>;
  stats(): LayerCacheStats;
}

function cloneValue<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function serializedSizeBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
}

export function createMemoryPersistentLayerCacheBackend(): LayerCachePersistentBackend {
  const entries = new Map<string, unknown>();

  return {
    async get(hash) {
      const value = entries.get(hash);
      return value === undefined ? null : cloneValue(value);
    },

    async set(hash, value) {
      entries.set(hash, cloneValue(value));
    },

    async delete(hash) {
      entries.delete(hash);
    },

    async clear() {
      entries.clear();
    },
  };
}

export function createMemoryOnlyLayerCache(
  options: Omit<LayerCacheOptions, 'persistentBackend'> = {}
): LayerCache {
  return createLayerCache({ ...options, persistentBackend: null });
}

export function createLayerCache(options: LayerCacheOptions = {}): LayerCache {
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const persistenceThresholdBytes = options.persistenceThresholdBytes ?? DEFAULT_PERSISTENCE_THRESHOLD_BYTES;
  const persistentBackend = options.persistentBackend ?? null;
  const memory = new Map<string, unknown>();
  const cacheStats: LayerCacheStats = {
    hits: 0,
    misses: 0,
    memoryEntries: 0,
    memorySets: 0,
    persistentSets: 0,
    lastBackend: null,
  };

  function touchMemoryEntry(hash: string, value: unknown): void {
    memory.delete(hash);
    memory.set(hash, value);
    while (memory.size > memoryLimit) {
      const oldestHash = memory.keys().next().value as string | undefined;
      if (!oldestHash) break;
      memory.delete(oldestHash);
    }
    cacheStats.memoryEntries = memory.size;
  }

  return {
    async get<T>(hash: string) {
      if (memory.has(hash)) {
        const value = memory.get(hash);
        touchMemoryEntry(hash, value);
        cacheStats.hits += 1;
        cacheStats.lastBackend = 'memory';
        return cloneValue(value) as T;
      }

      if (persistentBackend) {
        const value = await persistentBackend.get(hash);
        if (value !== null) {
          cacheStats.hits += 1;
          cacheStats.lastBackend = 'persistent';
          return cloneValue(value) as T;
        }
      }

      cacheStats.misses += 1;
      cacheStats.lastBackend = null;
      return null;
    },

    async set<T>(hash: string, value: T) {
      const cloned = cloneValue(value);
      const sizeBytes = serializedSizeBytes(cloned);
      if (sizeBytes <= persistenceThresholdBytes || !persistentBackend) {
        touchMemoryEntry(hash, cloned);
        cacheStats.memorySets += 1;
        cacheStats.lastBackend = 'memory';
        return;
      }

      await persistentBackend.set(hash, cloned, sizeBytes);
      memory.delete(hash);
      cacheStats.memoryEntries = memory.size;
      cacheStats.persistentSets += 1;
      cacheStats.lastBackend = 'persistent';
    },

    async delete(hash: string) {
      memory.delete(hash);
      cacheStats.memoryEntries = memory.size;
      if (persistentBackend) {
        await persistentBackend.delete(hash);
      }
    },

    async clear() {
      memory.clear();
      cacheStats.memoryEntries = 0;
      if (persistentBackend) {
        await persistentBackend.clear();
      }
    },

    stats() {
      return { ...cacheStats, memoryEntries: memory.size };
    },
  };
}
