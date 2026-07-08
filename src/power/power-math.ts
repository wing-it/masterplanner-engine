import type { EngineBuildingPowerProfile } from '../types/game-data';
import {
  DEFAULT_MAX_CLOCK_PERCENT,
  DEFAULT_POWER_EXPONENT,
  DEFAULT_POWER_SHARD_SLOTS,
} from './power-constants';

export {
  DEFAULT_MAX_CLOCK_PERCENT,
  DEFAULT_POWER_EXPONENT,
  DEFAULT_POWER_SHARD_SLOTS,
} from './power-constants';

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}

export function calculateClockFactor(
  clockPercent: number,
  maxClockPercent?: number,
): number {
  assertNonNegativeFinite(clockPercent, 'clockPercent');

  if (maxClockPercent === undefined) {
    return clockPercent / 100;
  }

  assertNonNegativeFinite(maxClockPercent, 'maxClockPercent');
  return Math.min(clockPercent, maxClockPercent) / 100;
}

export function calculatePowerShardUsage(
  clockPercent: number,
  maxPowerShardSlots = DEFAULT_POWER_SHARD_SLOTS,
): number {
  assertNonNegativeFinite(clockPercent, 'clockPercent');
  assertNonNegativeFinite(maxPowerShardSlots, 'maxPowerShardSlots');

  if (clockPercent <= 100 || maxPowerShardSlots === 0) {
    return 0;
  }

  const requiredShards = Math.ceil((clockPercent - 100) / 50);
  return Math.min(requiredShards, Math.floor(maxPowerShardSlots));
}

export function normalizeSomersloopCount(value: number, maxSomersloopSlots: number): number {
  assertNonNegativeFinite(maxSomersloopSlots, 'maxSomersloopSlots');
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.floor(maxSomersloopSlots), Math.max(0, Math.floor(value)));
}

export function consumerDrawMw(
  profile: EngineBuildingPowerProfile,
  machines: number,
  clockPercent: number,
  somersloopsInstalled: number,
): number {
  if (machines === 0) return 0;

  const basePowerMw = profile.basePowerMw ?? 0;
  if (basePowerMw === 0) return 0;

  const clockFactor = (clockPercent ?? 100) / 100;
  const powerExponent = profile.powerExponent ?? DEFAULT_POWER_EXPONENT;

  let somersloopFactor = 1;
  const somersloopSlots = profile.somersloopSlots ?? 0;
  if (somersloopSlots > 0) {
    somersloopFactor = Math.pow(1 + (somersloopsInstalled ?? 0) / somersloopSlots, 2);
  }

  return machines * basePowerMw * Math.pow(clockFactor, powerExponent) * somersloopFactor;
}

export function generatorGenMw(
  profile: EngineBuildingPowerProfile,
  count: number,
  clockPercent: number,
): number {
  if (count === 0) return 0;

  const baseGeneratedMw = profile.baseGeneratedMw ?? 0;
  if (baseGeneratedMw === 0) return 0;

  const clockFactor = (clockPercent ?? 100) / 100;
  return baseGeneratedMw * count * clockFactor;
}
