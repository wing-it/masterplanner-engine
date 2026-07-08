import { describe, expect, it } from 'vitest';

import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph } from '../types/production-graph';
import { solveProductionGraph } from './solve';

function recipe(opts: {
  id: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
}): EngineRecipeDefinition {
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds,
    product: opts.outputs[0] ? { id: opts.outputs[0].itemId } : null,
    inputs: opts.inputs,
    outputs: opts.outputs,
    machine: null,
  };
}

function gameData(recipes: EngineRecipeDefinition[]): EngineGameData {
  return { recipes, generatorRecipes: [], buildingPowerById: new Map() };
}

/**
 * Owner-reported (uranium fuel factory): several bounded cell factories pool
 * their cells into a maximized fuel-unit recipe that also consumes an unseeded
 * intermediate (beams). One cell factory has a small fixed tap (nobelisk). A
 * high downstream fuel demand used to inflate the fuel recipe to that demand —
 * the cell-supply ceiling was discarded because the beam input was unseeded —
 * producing a large phantom shortage. The fuel recipe must instead stay pinned
 * near the deliverable pooled cell supply.
 */
describe('maximizeOutput pinned through a pool with an unseeded intermediate input', () => {
  function data() {
    return gameData([
      recipe({ id: 'uranium-cell', durationSeconds: 60, inputs: [{ itemId: 'uranium', amount: 50 }], outputs: [{ itemId: 'cell', amount: 25 }] }),
      recipe({ id: 'nuke', durationSeconds: 60, inputs: [{ itemId: 'cell', amount: 10 }], outputs: [{ itemId: 'nob', amount: 3 }] }),
      recipe({ id: 'beam-mk', durationSeconds: 60, inputs: [{ itemId: 'steel', amount: 4 }], outputs: [{ itemId: 'beam', amount: 4 }] }),
      recipe({ id: 'fuel-unit', durationSeconds: 60, inputs: [{ itemId: 'cell', amount: 10 }, { itemId: 'beam', amount: 2 }], outputs: [{ itemId: 'fuel', amount: 1 }] }),
    ]);
  }

  function graph(): ProductionGraph {
    return {
      schemaVersion: 2,
      nodes: [
        // Two bounded cell factories: 600 uranium each -> 300 cells each.
        { kind: 'source', id: 'u1', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 600, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cells1', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'recipe', id: 'nob', recipeId: 'nuke', machineCountOverride: 1 },
        { kind: 'source', id: 'u2', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 600, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cells2', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'pool', id: 'pool:ff:cell', itemId: 'cell' },
        // Beam supply through a demand-mode (sentinel) steel claim: unseeded.
        { kind: 'source', id: 'steel', itemId: 'steel', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'beam1', recipeId: 'beam-mk' },
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-unit', maximizeOutput: true },
        // Power plant demanding far more fuel than the cells can supply.
        { kind: 'sink', id: 'plant', itemId: 'fuel', demandPerMin: 200 },
      ],
      edges: [
        { id: 'u1c1', sourceId: 'u1', targetId: 'cells1', itemId: 'uranium' },
        { id: 'c1pool', sourceId: 'cells1', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'c1nob', sourceId: 'cells1', targetId: 'nob', itemId: 'cell' },
        { id: 'u2c2', sourceId: 'u2', targetId: 'cells2', itemId: 'uranium' },
        { id: 'c2pool', sourceId: 'cells2', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'poolfuel', sourceId: 'pool:ff:cell', targetId: 'fuel', itemId: 'cell' },
        { id: 'steelbeam', sourceId: 'steel', targetId: 'beam1', itemId: 'steel' },
        { id: 'beamfuel', sourceId: 'beam1', targetId: 'fuel', itemId: 'beam' },
        { id: 'fuelout', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' },
      ],
    };
  }

  it('does not inflate the fuel recipe to downstream demand past the cell supply', () => {
    const { result } = solveProductionGraph(graph(), data());

    // Cells stay pinned at their supply bound; one ships 10 to the nobelisk.
    expect(result.nodes.cells1?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 300 });
    expect(result.nodes.cells2?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 300 });

    // Deliverable pooled cells = 300 + 300 - 10 tap = 590 -> ~59 fuel machines.
    // The bug produced 200 machines (2000 cells demanded); pinning keeps it low.
    const fuelMachines = result.nodes.fuel?.machines ?? 0;
    expect(fuelMachines).toBeGreaterThan(58);
    expect(fuelMachines).toBeLessThan(61);
  });
});

/**
 * Owner-reported (iron plate factory): three bounded factories each maximize
 * an iron-ingot recipe and pool their output into a plain (non-maximize)
 * downstream recipe with no further consumer — its machine count is sized
 * purely from whatever supply arrives. With two pooled sources this sizes
 * correctly; adding a third inflates the downstream recipe to more than 2x
 * the pooled supply that actually exists.
 */
describe('plain recipe pooling three unequal maximize sources', () => {
  function data() {
    return gameData([
      recipe({ id: 'ingot-recipe', durationSeconds: 1, inputs: [{ itemId: 'ore', amount: 1 }], outputs: [{ itemId: 'ingot', amount: 1 }] }),
      recipe({ id: 'plate-recipe', durationSeconds: 6, inputs: [{ itemId: 'ingot', amount: 3 }], outputs: [{ itemId: 'plate', amount: 2 }] }),
    ]);
  }

  /**
   * Each ingot factory's ore ceiling comes from its own ore claims. When a
   * factory has multiple claims (mirroring the real Factory 1 = 2 claims,
   * Factory 3 = 3 claims), those claims are pooled internally into the
   * factory's own smelter recipe (same poolFactoryInputs mechanism the app
   * applies to the outer ingot pool) — an inner pool feeding a maximize
   * recipe that itself feeds the outer pool. A single-element claims array
   * (Factory 2) stays a plain direct edge, no inner pool.
   */
  function graph(claimsPerFactory: number[][]): ProductionGraph {
    const nodes: ProductionGraph['nodes'] = [];
    const edges: ProductionGraph['edges'] = [];

    claimsPerFactory.forEach((claims, factoryIndex) => {
      const ingotId = `ingot${factoryIndex + 1}`;
      nodes.push({ kind: 'recipe', id: ingotId, recipeId: 'ingot-recipe', maximizeOutput: true });

      if (claims.length === 1) {
        const oreId = `o${factoryIndex + 1}`;
        nodes.push({ kind: 'source', id: oreId, itemId: 'ore', sourceType: 'resource-claim', maxRatePerMin: claims[0]!, machineCountOverride: 1 });
        edges.push({ id: `${oreId}${ingotId}`, sourceId: oreId, targetId: ingotId, itemId: 'ore' });
      } else {
        const orePoolId = `pool:ore${factoryIndex + 1}`;
        nodes.push({ kind: 'pool', id: orePoolId, itemId: 'ore' });
        claims.forEach((rate, claimIndex) => {
          const oreId = `o${factoryIndex + 1}_${claimIndex + 1}`;
          nodes.push({ kind: 'source', id: oreId, itemId: 'ore', sourceType: 'resource-claim', maxRatePerMin: rate, machineCountOverride: 1 });
          edges.push({ id: `${oreId}pool`, sourceId: oreId, targetId: orePoolId, itemId: 'ore' });
        });
        edges.push({ id: `${orePoolId}${ingotId}`, sourceId: orePoolId, targetId: ingotId, itemId: 'ore' });
      }

      edges.push({ id: `${ingotId}pool`, sourceId: ingotId, targetId: 'pool:ingot', itemId: 'ingot' });
    });

    nodes.push({ kind: 'pool', id: 'pool:ingot', itemId: 'ingot' });
    nodes.push({ kind: 'recipe', id: 'plate', recipeId: 'plate-recipe' });
    edges.push({ id: 'poolplate', sourceId: 'pool:ingot', targetId: 'plate', itemId: 'ingot' });

    return { schemaVersion: 2, nodes, edges };
  }

  it('sizes the downstream recipe from exactly the pooled supply with two sources', () => {
    // Factory 1: 2 pooled ore claims (45 + 45 = 90). Factory 2: 1 direct claim (60).
    const { result } = solveProductionGraph(graph([[45, 45], [60]]), data());

    // 90 + 60 = 150 pooled ingots -> 150 * 2/3 = 100 plate/min.
    expect(result.nodes.plate?.inputs).toContainEqual({ itemId: 'ingot', ratePerMin: 150 });
    expect(result.nodes.plate?.outputs).toContainEqual({ itemId: 'plate', ratePerMin: 100 });
  });

  it('does not inflate the downstream recipe past the pooled supply with three sources', () => {
    // Factory 1: 2 pooled claims (90). Factory 2: 1 direct claim (60).
    // Factory 3: 3 pooled claims (50*3 = 150) -- mirrors the owner's report exactly.
    const { result } = solveProductionGraph(graph([[45, 45], [60], [50, 50, 50]]), data());

    // 90 + 60 + 150 = 300 pooled ingots -> 300 * 2/3 = 200 plate/min.
    // The bug produced ~2.125x this (matching the owner-reported factor).
    expect(result.nodes.plate?.inputs).toContainEqual({ itemId: 'ingot', ratePerMin: 300 });
    expect(result.nodes.plate?.outputs).toContainEqual({ itemId: 'plate', ratePerMin: 200 });
  });
});
