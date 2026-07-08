import { describe, expect, it } from 'vitest';

import type { EngineBuildingPowerProfile, EngineGameData, EngineRecipeDefinition } from '../types/game-data';
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
    product: opts.outputs[0] ? { id: opts.outputs[0].itemId } : null,
    inputs: opts.inputs,
    outputs: opts.outputs,
    machine: opts.machineId ? { id: opts.machineId } : null,
  };
}

const generatorProfile: EngineBuildingPowerProfile = {
  buildingId: 'nuke-plant',
  role: 'generator',
  baseGeneratedMw: 2500,
  powerExponent: 1.321928,
  generatorScalesLinearly: true,
  powerShardSlots: 3,
  maxClockPercent: 250,
  supportsSomersloop: false,
  somersloopSlots: 0,
};

function gameData(): EngineGameData {
  return {
    recipes: [
      recipe({
        id: 'ficsonium',
        durationSeconds: 6,
        inputs: [
          { itemId: 'waste', amount: 1 },
          { itemId: 'scell', amount: 1 },
          { itemId: 'dark', amount: 20000 },
        ],
        outputs: [{ itemId: 'fics', amount: 1 }],
      }),
    ],
    generatorRecipes: [
      // Nuclear plant: burns fuel + water, emits waste as a byproduct output.
      // outputs.length > 0, but the building role is 'generator'.
      recipe({
        id: 'nuke',
        durationSeconds: 60,
        inputs: [
          { itemId: 'fuel', amount: 1 },
          { itemId: 'water', amount: 10 },
        ],
        outputs: [{ itemId: 'waste', amount: 10 }],
        machineId: 'nuke-plant',
      }),
    ],
    buildingPowerById: new Map([['nuke-plant', generatorProfile]]),
  };
}

/**
 * Owner-reported (plutonium waste -> Ficsonium): a nuclear power plant is a
 * generator that *emits* waste, so its recipe has an item output — which used
 * to defeat `isGeneratorRecipe` (outputs.length === 0). Misclassified, a
 * power-target plant was sized by a bogus waste-item demand equal to its MW
 * target and scaled without bound, and a downstream maximized Ficsonium recipe
 * inflated to hundreds of machines instead of pinning to the ~waste supply.
 */
describe('power-target generator emitting a waste byproduct', () => {
  function graph(): ProductionGraph {
    return {
      schemaVersion: 2,
      nodes: [
        // Fuel is unbounded so only the power target can cap the plant.
        { kind: 'source', id: 'fuel', itemId: 'fuel', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'source', id: 'water', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'plant', recipeId: 'nuke', powerTargetMw: 15000 },
        { kind: 'source', id: 'scell', itemId: 'scell', sourceType: 'manual-input', maxRatePerMin: 100000 },
        { kind: 'source', id: 'dark', itemId: 'dark', sourceType: 'manual-input', maxRatePerMin: 100_000_000 },
        { kind: 'recipe', id: 'fics', recipeId: 'ficsonium', maximizeOutput: true },
        { kind: 'sink', id: 'fics-out', itemId: 'fics' },
      ],
      edges: [
        { id: 'fuel-plant', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' },
        { id: 'water-plant', sourceId: 'water', targetId: 'plant', itemId: 'water' },
        { id: 'plant-fics', sourceId: 'plant', targetId: 'fics', itemId: 'waste' },
        { id: 'scell-fics', sourceId: 'scell', targetId: 'fics', itemId: 'scell' },
        { id: 'dark-fics', sourceId: 'dark', targetId: 'fics', itemId: 'dark' },
        { id: 'fics-sink', sourceId: 'fics', targetId: 'fics-out', itemId: 'fics' },
      ],
    };
  }

  it('sizes the plant by its power target, not by waste-output demand', () => {
    const { result } = solveProductionGraph(graph(), gameData());

    // 15000 MW / 2500 MW per machine = 6 machines -> 60 waste/min.
    expect(result.nodes.plant?.machines).toBeCloseTo(6, 4);
    expect(result.nodes.plant?.outputs).toContainEqual({ itemId: 'waste', ratePerMin: 60 });
  });

  it('pins the maximized Ficsonium recipe to the waste supply', () => {
    const { result } = solveProductionGraph(graph(), gameData());

    // 60 waste / 10 per machine = 6 Ficsonium machines. The bug produced
    // hundreds (driven by the plentiful singularity-cell / dark-energy inputs).
    expect(result.nodes.fics?.machines).toBeCloseTo(6, 4);
    expect(result.nodes.fics?.inputs).toContainEqual({ itemId: 'waste', ratePerMin: 60 });
  });
});
