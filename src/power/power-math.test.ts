import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POWER_EXPONENT,
  calculateClockFactor,
  calculatePowerShardUsage,
  consumerDrawMw,
  generatorGenMw,
  normalizeSomersloopCount,
} from './power-math';
import type { EngineBuildingPowerProfile } from '../types/game-data';

function makeProfile(overrides: Partial<EngineBuildingPowerProfile> = {}): EngineBuildingPowerProfile {
  return {
    buildingId: 'test',
    role: 'consumer',
    basePowerMw: 4,
    powerExponent: DEFAULT_POWER_EXPONENT,
    generatorScalesLinearly: false,
    powerShardSlots: 0,
    somersloopSlots: 4,
    maxClockPercent: 250,
    supportsSomersloop: true,
    ...overrides,
  };
}

describe('consumerDrawMw', () => {
  it('0 machines returns 0 MW', () => {
    const profile = makeProfile({ basePowerMw: 4 });
    expect(consumerDrawMw(profile, 0, 100, 0)).toBe(0);
  });

  it('Iron Ingot smelter at 100% clock -> basePowerMw * machines', () => {
    const profile = makeProfile({ basePowerMw: 4 });
    expect(consumerDrawMw(profile, 1, 100, 0)).toBeCloseTo(4, 5);
    expect(consumerDrawMw(profile, 5, 100, 0)).toBeCloseTo(20, 5);
  });

  it('250% overclock uses exponent (not linear)', () => {
    const profile = makeProfile({ basePowerMw: 4, powerExponent: DEFAULT_POWER_EXPONENT });
    const at100 = consumerDrawMw(profile, 1, 100, 0);
    const at250 = consumerDrawMw(profile, 1, 250, 0);
    expect(at250).toBeCloseTo(at100 * Math.pow(2.5, DEFAULT_POWER_EXPONENT), 5);
    expect(at250 / at100).toBeGreaterThan(2.5);
  });

  it('2 somersloops in a 4-slot machine -> power * (1.5)^2', () => {
    const profile = makeProfile({ basePowerMw: 4, somersloopSlots: 4 });
    const noSomersloop = consumerDrawMw(profile, 1, 100, 0);
    const twoSomersloops = consumerDrawMw(profile, 1, 100, 2);
    expect(twoSomersloops).toBeCloseTo(noSomersloop * Math.pow(1.5, 2), 5);
  });

  it('somersloopSlots === 0 -> amplification factor 1', () => {
    const profile = makeProfile({ basePowerMw: 4, somersloopSlots: 0, supportsSomersloop: false });
    const noSomersloop = consumerDrawMw(profile, 1, 100, 0);
    const withSomersloops = consumerDrawMw(profile, 1, 100, 4);
    expect(withSomersloops).toBeCloseTo(noSomersloop, 5);
  });

  it('defaults clockPercent to 100 when not provided', () => {
    const profile = makeProfile({ basePowerMw: 4 });
    expect(consumerDrawMw(profile, 1, 100 as any, 0)).toBeCloseTo(4, 5);
  });

  it('defaults somersloopsInstalled to 0 when not provided', () => {
    const profile = makeProfile({ basePowerMw: 4 });
    expect(consumerDrawMw(profile, 1, 100, 0 as any)).toBeCloseTo(4, 5);
  });

  it('basePowerMw === 0 returns 0', () => {
    const profile = makeProfile({ basePowerMw: 0 });
    expect(consumerDrawMw(profile, 1, 100, 0)).toBe(0);
  });
});

function makeGeneratorProfile(overrides: Partial<EngineBuildingPowerProfile> = {}): EngineBuildingPowerProfile {
  return {
    buildingId: 'test-gen',
    role: 'generator',
    baseGeneratedMw: 75,
    powerExponent: DEFAULT_POWER_EXPONENT,
    generatorScalesLinearly: true,
    powerShardSlots: 0,
    somersloopSlots: 0,
    maxClockPercent: 250,
    supportsSomersloop: false,
    ...overrides,
  };
}

describe('generatorGenMw', () => {
  it('0 generators returns 0 MW', () => {
    const profile = makeGeneratorProfile({ baseGeneratedMw: 75 });
    expect(generatorGenMw(profile, 0, 100)).toBe(0);
  });

  it('coal generator at 100% clock -> baseGeneratedMw * count', () => {
    const profile = makeGeneratorProfile({ baseGeneratedMw: 75 });
    expect(generatorGenMw(profile, 1, 100)).toBeCloseTo(75, 5);
    expect(generatorGenMw(profile, 4, 100)).toBeCloseTo(300, 5);
  });

  it('250% clock -> 2.5x rated (linear, no exponent)', () => {
    const profile = makeGeneratorProfile({ baseGeneratedMw: 75 });
    const at100 = generatorGenMw(profile, 1, 100);
    const at250 = generatorGenMw(profile, 1, 250);
    expect(at250).toBeCloseTo(at100 * 2.5, 5);
  });

  it('count scales proportionally', () => {
    const profile = makeGeneratorProfile({ baseGeneratedMw: 75 });
    expect(generatorGenMw(profile, 2, 100)).toBeCloseTo(150, 5);
    expect(generatorGenMw(profile, 2, 200)).toBeCloseTo(300, 5);
  });

  it('baseGeneratedMw === 0 returns 0', () => {
    const profile = makeGeneratorProfile({ baseGeneratedMw: 0 });
    expect(generatorGenMw(profile, 1, 100)).toBe(0);
  });
});

describe('calculateClockFactor', () => {
  it('converts clock percent to factor', () => {
    expect(calculateClockFactor(100)).toBe(1);
    expect(calculateClockFactor(250)).toBe(2.5);
    expect(calculateClockFactor(50)).toBe(0.5);
  });

  it('clamps to maxClockPercent when provided', () => {
    expect(calculateClockFactor(250, 250)).toBe(2.5);
    expect(calculateClockFactor(300, 250)).toBe(2.5);
    expect(calculateClockFactor(150, 100)).toBe(1);
  });

  it('throws on invalid clockPercent', () => {
    expect(() => calculateClockFactor(-10)).toThrow(RangeError);
    expect(() => calculateClockFactor(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => calculateClockFactor(Number.NaN)).toThrow(RangeError);
  });
});

describe('calculatePowerShardUsage', () => {
  it('returns 0 at or below 100% clock', () => {
    expect(calculatePowerShardUsage(100)).toBe(0);
    expect(calculatePowerShardUsage(50)).toBe(0);
  });

  it('returns 1 shard per 50% overclock', () => {
    expect(calculatePowerShardUsage(150)).toBe(1);
    expect(calculatePowerShardUsage(200)).toBe(2);
    expect(calculatePowerShardUsage(250)).toBe(3);
  });

  it('caps at maxPowerShardSlots', () => {
    expect(calculatePowerShardUsage(250, 2)).toBe(2);
    expect(calculatePowerShardUsage(150, 0)).toBe(0);
  });

  it('throws on invalid inputs', () => {
    expect(() => calculatePowerShardUsage(-10)).toThrow(RangeError);
    expect(() => calculatePowerShardUsage(150, -1)).toThrow(RangeError);
  });
});

describe('normalizeSomersloopCount', () => {
  it('clamps value to [0, maxSomersloopSlots]', () => {
    expect(normalizeSomersloopCount(2, 4)).toBe(2);
    expect(normalizeSomersloopCount(5, 4)).toBe(4);
    expect(normalizeSomersloopCount(-1, 4)).toBe(0);
  });

  it('floors fractional values', () => {
    expect(normalizeSomersloopCount(2.9, 4)).toBe(2);
    expect(normalizeSomersloopCount(0.1, 4)).toBe(0);
  });

  it('returns 0 for non-finite value', () => {
    expect(normalizeSomersloopCount(Number.NaN, 4)).toBe(0);
    expect(normalizeSomersloopCount(Number.POSITIVE_INFINITY, 4)).toBe(0);
  });

  it('throws on negative maxSomersloopSlots', () => {
    expect(() => normalizeSomersloopCount(0, -1)).toThrow(RangeError);
  });
});
