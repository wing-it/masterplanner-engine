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
