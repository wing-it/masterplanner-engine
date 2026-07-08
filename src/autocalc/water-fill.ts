export interface WaterFillEntry {
  id: string;
  /** Maximum amount this entry can absorb; may be Number.POSITIVE_INFINITY. */
  cap: number;
}

export interface WaterFillResult {
  allocations: Map<string, number>;
  /** Amount that could not be placed because every entry hit its cap. */
  remaining: number;
}

/**
 * Distributes `total` across entries with equal shares, capping each entry at
 * its capacity and redistributing the excess among the rest — the same
 * behavior as an in-game belt merger pulling evenly until a branch starves.
 */
export function waterFill(
  entries: readonly WaterFillEntry[],
  total: number,
  epsilon: number
): WaterFillResult {
  const allocations = new Map<string, number>();
  for (const entry of entries) allocations.set(entry.id, 0);

  let remaining = Math.max(0, total);
  let active = entries.map((entry) => ({ id: entry.id, cap: entry.cap }));

  while (active.length > 0 && remaining > epsilon) {
    const equalShare = remaining / active.length;
    const capped = active.filter((entry) => entry.cap < equalShare - epsilon);

    if (capped.length === 0) {
      for (const { id } of active) allocations.set(id, equalShare);
      remaining = 0;
      break;
    }

    const cappedIds = new Set(capped.map((entry) => entry.id));
    for (const { id, cap } of capped) {
      const allocated = Math.max(0, cap);
      allocations.set(id, allocated);
      remaining -= allocated;
    }
    active = active.filter((entry) => !cappedIds.has(entry.id));
  }

  return { allocations, remaining: Math.max(0, remaining) };
}
