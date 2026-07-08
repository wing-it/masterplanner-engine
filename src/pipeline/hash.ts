function normalizeForHash(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry, seen));
  }

  if (value instanceof Map) {
    return {
      __type: 'Map',
      entries: [...value.entries()]
        .map(([key, entryValue]) => [normalizeForHash(key, seen), normalizeForHash(entryValue, seen)])
        .sort(([left], [right]) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    };
  }

  if (value instanceof Set) {
    return {
      __type: 'Set',
      values: [...value.values()]
        .map((entry) => normalizeForHash(entry, seen))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry !== 'function' && entry !== undefined) {
      normalized[key] = normalizeForHash(entry, seen);
    }
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

export function stableValueHash(value: unknown): string {
  const input = stableStringify(value);
  // Two FNV-1a passes with different offset bases, concatenated to 64 bits of
  // key. Cache lookups trust the key without verifying the full input, so a
  // 32-bit key space makes silent collisions plausible once a persistent
  // backend accumulates a few thousand entries (~0.1% at 2 600, ~10% at 30 000).
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x01000193);
  }

  return `fnv1a64:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
