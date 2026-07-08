import { describe, expect, it } from 'vitest';

import type { EngineRecipeDefinition } from '../types/game-data';
import {
  isByproduct,
  machinesForInput,
  machinesForOutput,
  ratePerMachine,
  ratesForMachines,
} from './recipe-math';

function item(id: string) {
  return { entityType: 'item' as const, id, name: id, item_kind: 'solid' };
}

function recipe(opts: {
  id?: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
  product?: string | null;
}): EngineRecipeDefinition {
  const toRate = (row: { itemId: string; amount: number }) => ({
    itemId: row.itemId,
    item: item(row.itemId),
    itemName: row.itemId,
    amount: row.amount,
    itemsPerMinute: row.amount * (60 / opts.durationSeconds),
    portVariant: 'solid' as const,
  });

  return {
    id: opts.id ?? 'recipe',
    name: opts.id ?? 'recipe',
    slug: opts.id ?? 'recipe',
    durationSeconds: opts.durationSeconds,
    isAlternate: false,
    product: opts.product === undefined ? (opts.outputs[0] ? item(opts.outputs[0].itemId) : null) : opts.product ? item(opts.product) : null,
    inputs: opts.inputs.map(toRate),
    outputs: opts.outputs.map(toRate),
    machine: null,
  };
}

describe('ratePerMachine / machinesForOutput', () => {
  it('Iron Ingot: 2s duration, amount 1 -> 30/min/machine', () => {
    const ironIngot = recipe({ durationSeconds: 2, inputs: [{ itemId: 'ore', amount: 1 }], outputs: [{ itemId: 'ingot', amount: 1 }] });
    expect(ratePerMachine(ironIngot, 'ingot', true)).toBeCloseTo(30, 5);
  });

  it('120/min required -> 4 machines', () => {
    const ironIngot = recipe({ durationSeconds: 2, inputs: [{ itemId: 'ore', amount: 1 }], outputs: [{ itemId: 'ingot', amount: 1 }] });
    expect(machinesForOutput(ironIngot, 'ingot', 120)).toBeCloseTo(4, 5);
  });
});

describe('ratesForMachines', () => {
  it('scales all inputs proportionally from one machine count (multi-input)', () => {
    const reinforcedPlate = recipe({
      durationSeconds: 12,
      inputs: [
        { itemId: 'plate', amount: 6 },
        { itemId: 'screw', amount: 12 },
      ],
      outputs: [{ itemId: 'reinforced', amount: 1 }],
    });
    const machines = machinesForOutput(reinforcedPlate, 'reinforced', 10);
    const { inputs } = ratesForMachines(reinforcedPlate, machines);
    const plate = inputs.find((i) => i.itemId === 'plate')!;
    const screw = inputs.find((i) => i.itemId === 'screw')!;
    expect(machinesForInput(reinforcedPlate, 'plate', plate.ratePerMin)).toBeCloseTo(machines, 5);
    expect(screw.ratePerMin / plate.ratePerMin).toBeCloseTo(2, 5);
  });

  it('multi-output recipe returns both outputs scaled by the same machine count', () => {
    const refinery = recipe({
      durationSeconds: 6,
      inputs: [{ itemId: 'oil', amount: 3 }],
      outputs: [
        { itemId: 'plastic', amount: 2 },
        { itemId: 'hor', amount: 1 },
      ],
      product: null,
    });
    const { outputs } = ratesForMachines(refinery, 2.5);
    const plastic = outputs.find((o) => o.itemId === 'plastic')!;
    const hor = outputs.find((o) => o.itemId === 'hor')!;
    expect(plastic.ratePerMin).toBeCloseTo(2 * 10 * 2.5, 5);
    expect(hor.ratePerMin).toBeCloseTo(1 * 10 * 2.5, 5);
  });
});

describe('isByproduct', () => {
  it('declared-product recipe: false for the product, true for the other output', () => {
    const r = recipe({
      durationSeconds: 6,
      inputs: [],
      outputs: [
        { itemId: 'product', amount: 1 },
        { itemId: 'waste', amount: 1 },
      ],
      product: 'product',
    });
    expect(isByproduct(r, 'product')).toBe(false);
    expect(isByproduct(r, 'waste')).toBe(true);
  });

  it('no-declared-product recipe: every output is treated as primary (not a byproduct)', () => {
    const r = recipe({
      durationSeconds: 6,
      inputs: [],
      outputs: [
        { itemId: 'plastic', amount: 2 },
        { itemId: 'hor', amount: 1 },
      ],
      product: null,
    });
    expect(isByproduct(r, 'plastic')).toBe(false);
    expect(isByproduct(r, 'hor')).toBe(false);
  });
});
