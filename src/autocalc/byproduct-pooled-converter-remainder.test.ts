import { describe, expect, it } from 'vitest';

import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph } from '../types/production-graph';
import { solveProductionGraph } from './solve';

function recipe(opts: {
  id: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
  machineId?: string;
}): EngineRecipeDefinition {
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds,
    // First output is the primary product; any later output is a byproduct.
    product: opts.outputs[0] ? { id: opts.outputs[0].itemId } : null,
    inputs: opts.inputs,
    outputs: opts.outputs,
    machine: opts.machineId ? { id: opts.machineId } : null,
  };
}

/**
 * Mirrors the owner-reported Ficsonium power plant:
 *  - `ficsonium`   plutonium + residue -> ficsonium   (6s -> x10/min)
 *  - `fuel-rod`    ficsonium -> rod + residue byproduct (24s -> x2.5/min)
 *  - `converter`   sam -> residue                       (6s -> x10/min)
 *
 * `fuel-rod`'s Dark Matter Residue byproduct is wired back into `ficsonium`'s
 * residue input. A dedicated `converter` recipe supplies the remainder. When
 * both feed the single residue input the app builder inserts a `pool` node, so
 * the cyclic byproduct and the converter share a pool INSIDE the ficsonium ->
 * fuel-rod -> pool -> ficsonium cycle.
 */
function gameData(): EngineGameData {
  return {
    recipes: [
      recipe({
        id: 'ficsonium',
        durationSeconds: 6,
        inputs: [
          { itemId: 'plutonium', amount: 1 },
          { itemId: 'residue', amount: 20 },
        ],
        outputs: [{ itemId: 'ficsonium', amount: 1 }],
      }),
      recipe({
        id: 'fuel-rod',
        durationSeconds: 24,
        inputs: [{ itemId: 'ficsonium', amount: 2 }],
        outputs: [
          { itemId: 'rod', amount: 1 },
          { itemId: 'residue', amount: 20 },
        ],
      }),
      recipe({
        id: 'converter',
        durationSeconds: 6,
        inputs: [{ itemId: 'sam', amount: 5 }],
        outputs: [{ itemId: 'residue', amount: 10 }],
      }),
    ],
    generatorRecipes: [],
    buildingPowerById: new Map(),
  };
}

/**
 * Regression for the cyclic-byproduct-through-a-pool collapse (the plain-recipe
 * analogue of `generator-pooled-water-byproduct.test.ts`). The `converter`'s
 * only input (`sam`) is a demand-mode claim that never seeds supply forward, so
 * in the forward supply-seed pass the residue pool carries only the byproduct
 * trickle. Before the fix, `recipeMachinesFromAvailableInputs` treated that
 * partial trickle as ficsonium's entire residue supply and capped it far below
 * its plutonium-bound size; inside the cycle the cap decayed geometrically and
 * zeroed the whole chain. `hasByproductRemainderBackstop` now skips an input
 * fed by a pool that mixes a fixed byproduct with a demand-driven remainder
 * supplier, so the byproduct never caps the consumer.
 */
describe('recipe consumer with residue pooled from a converter and a cyclic byproduct', () => {
  it('(a) baseline: converter alone (no pool) fully supplies the residue input', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'plutonium', itemId: 'plutonium', sourceType: 'manual-input', maxRatePerMin: 10 },
        { kind: 'source', id: 'sam', itemId: 'sam', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'ficsonium', recipeId: 'ficsonium', maximizeOutput: true },
        { kind: 'recipe', id: 'fuel-rod', recipeId: 'fuel-rod' },
        { kind: 'recipe', id: 'converter', recipeId: 'converter' },
      ],
      edges: [
        { id: 'plutonium-ficsonium', sourceId: 'plutonium', targetId: 'ficsonium', itemId: 'plutonium' },
        { id: 'converter-ficsonium', sourceId: 'converter', targetId: 'ficsonium', itemId: 'residue' },
        { id: 'sam-converter', sourceId: 'sam', targetId: 'converter', itemId: 'sam' },
        { id: 'ficsonium-fuelrod', sourceId: 'ficsonium', targetId: 'fuel-rod', itemId: 'ficsonium' },
      ],
    };

    const { result } = solveProductionGraph(graph, gameData());

    // Plutonium (10/min) bounds ficsonium to 1 machine; fuel-rod self-demand
    // seeds from its 10 ficsonium/min -> 2 machines; the converter alone must
    // supply all 200 residue/min -> 2 machines.
    expect(result.nodes.ficsonium?.machines).toBeCloseTo(1, 4);
    expect(result.nodes['fuel-rod']?.machines).toBeCloseTo(2, 4);
    expect(result.nodes.converter?.machines).toBeCloseTo(2, 4);
    expect(result.edges['converter-ficsonium']?.deficitRate ?? 0).toBeCloseTo(0, 4);
  });

  it('(b) THE FIX: cyclic byproduct + converter through a pool no longer collapses', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'plutonium', itemId: 'plutonium', sourceType: 'manual-input', maxRatePerMin: 10 },
        { kind: 'source', id: 'sam', itemId: 'sam', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'pool', id: 'pool:residue', itemId: 'residue' },
        { kind: 'recipe', id: 'ficsonium', recipeId: 'ficsonium', maximizeOutput: true },
        { kind: 'recipe', id: 'fuel-rod', recipeId: 'fuel-rod' },
        { kind: 'recipe', id: 'converter', recipeId: 'converter' },
      ],
      edges: [
        { id: 'plutonium-ficsonium', sourceId: 'plutonium', targetId: 'ficsonium', itemId: 'plutonium' },
        { id: 'converter-pool', sourceId: 'converter', targetId: 'pool:residue', itemId: 'residue' },
        { id: 'fuelrod-pool', sourceId: 'fuel-rod', targetId: 'pool:residue', itemId: 'residue' },
        { id: 'pool-ficsonium', sourceId: 'pool:residue', targetId: 'ficsonium', itemId: 'residue' },
        { id: 'sam-converter', sourceId: 'sam', targetId: 'converter', itemId: 'sam' },
        { id: 'ficsonium-fuelrod', sourceId: 'ficsonium', targetId: 'fuel-rod', itemId: 'ficsonium' },
      ],
    };

    const { result } = solveProductionGraph(graph, gameData());

    // The chain stays sized to the same steady state as (a): the cyclic
    // byproduct sharing the pool must not shrink ficsonium below its
    // plutonium-bound size.
    expect(result.nodes.ficsonium?.machines).toBeCloseTo(1, 4);
    expect(result.nodes.ficsonium?.machines).toBeGreaterThan(0);
    expect(result.nodes['fuel-rod']?.machines).toBeCloseTo(2, 4);
    expect(result.nodes['fuel-rod']?.machines).toBeGreaterThan(0);

    // Residue input is fully supplied with no deficit: byproduct (100/min from
    // 2 fuel-rod machines) + converter remainder (100/min) = the full 200/min.
    expect(result.edges['pool-ficsonium']?.suppliedRate).toBeCloseTo(200, 3);
    expect(result.edges['pool-ficsonium']?.deficitRate ?? 0).toBeCloseTo(0, 3);

    // The byproduct genuinely contributes (the cycle isn't just ignored) and
    // the converter is sized to cover only the remainder, not the whole input.
    const byproductSupplied = result.edges['fuelrod-pool']?.suppliedRate ?? 0;
    const converterSupplied = result.edges['converter-pool']?.suppliedRate ?? 0;
    expect(byproductSupplied).toBeGreaterThan(0);
    expect(byproductSupplied).toBeCloseTo(100, 1);
    expect(converterSupplied).toBeCloseTo(100, 1);
    expect(result.nodes.converter?.machines).toBeGreaterThan(0);
    expect(result.nodes.converter?.machines).toBeCloseTo(1, 3);
  });
});
