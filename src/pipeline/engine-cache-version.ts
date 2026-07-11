/**
 * Version prefix for persisted layer-cache keys. Bump whenever solver/layer
 * semantics change so cached (IndexedDB) results from older engine code are
 * invalidated — the cache key is otherwise purely content-based (graph +
 * gameData hash) and would keep serving stale results.
 */
export const ENGINE_CACHE_VERSION = 18;
