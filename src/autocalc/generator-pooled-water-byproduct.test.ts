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

/**
 * A nuclear-plant-shaped generator (fuel + water in, waste out) plus a
 * reprocessing recipe that turns the plant's own waste byproduct into a
 * small trickle of water -- mirrors the owner-reported Uranium Fuel Rod
 * plant / Non-Fissile Uranium cycle.
 */
function gameData(): EngineGameData {
  return {
    recipes: [
      recipe({
        id: 'reprocess',
        durationSeconds: 60,
        inputs: [{ itemId: 'waste', amount: 10 }],
        outputs: [{ itemId: 'water', amount: 4.5 }],
      }),
    ],
    generatorRecipes: [
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
 * Owner-reported (Uranium Fuel Rod Nuclear Power Plant): a generator's water
 * input fed by BOTH a demand-mode water pump claim (`sourceType:'water'`,
 * unbounded, no `machineCountOverride` -> elastic/demand-only) AND a cyclic
 * waste-reprocessing byproduct collapsed the whole factory to zero the
 * moment both suppliers were connected -- connecting a second supplier makes
 * the builder insert a `pool` node between the suppliers and the consumer,
 * and the water-input exemption that lets a lone demand-mode source size the
 * generator from fuel alone did not see through that pool.
 *
 * `hasUnsuppliedConnectedInput` (demand.ts) now recurses one level through a
 * `pool` node when deciding whether an unsupplied input has an exempt
 * feeder (`isExemptFeeder`). A second, narrower gap surfaced while verifying
 * this fixture: even once the pool no longer forces the recipe to zero, a
 * small nonzero amount arriving from the finite co-supplier (the byproduct)
 * was still treated as the input's *entire* available supply, wrongly
 * capping the generator far below its true fuel-bound size (and, if the
 * byproduct total is a fraction of demand, collapsing further each pass as
 * the trickle it produces shrinks along with the artificially-capped
 * generator). `recipeMachinesFromAvailableInputs` and
 * `seedGeneratorInputDemand` now also skip an input entirely (never let it
 * cap or seed demand) whenever it is backed, directly or through one pool
 * hop, by a genuinely elastic source (`hasElasticBackstop`) -- the elastic
 * source is trusted to cover whatever the finite co-supplier does not.
 */
describe('generator with water pooled from a demand-mode source and a cyclic byproduct', () => {
  it('(a) baseline: demand-mode water source alone (no pool) sizes the plant from fuel', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'fuel', itemId: 'fuel', sourceType: 'manual-input', maxRatePerMin: 558 },
        { kind: 'source', id: 'pump', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'plant', recipeId: 'nuke' },
      ],
      edges: [
        { id: 'fuel-plant', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' },
        { id: 'pump-plant', sourceId: 'pump', targetId: 'plant', itemId: 'water' },
      ],
    };

    const { result } = solveProductionGraph(graph, gameData());

    expect(result.nodes.plant?.machines).toBeCloseTo(558, 4);
    expect(result.nodes.plant?.inputs).toContainEqual({ itemId: 'water', ratePerMin: 5580 });
    expect(result.edges['pump-plant']?.deficitRate ?? 0).toBeCloseTo(0, 4);
  });

  it('(b) baseline: manual-input water source + cyclic byproduct through a pool still sizes correctly', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'fuel', itemId: 'fuel', sourceType: 'manual-input', maxRatePerMin: 558 },
        { kind: 'source', id: 'manual-water', itemId: 'water', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
        { kind: 'pool', id: 'pool:water', itemId: 'water' },
        { kind: 'recipe', id: 'plant', recipeId: 'nuke' },
        { kind: 'recipe', id: 'reprocess', recipeId: 'reprocess' },
      ],
      edges: [
        { id: 'fuel-plant', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' },
        { id: 'manual-water-pool', sourceId: 'manual-water', targetId: 'pool:water', itemId: 'water' },
        { id: 'reprocess-pool', sourceId: 'reprocess', targetId: 'pool:water', itemId: 'water' },
        { id: 'pool-plant', sourceId: 'pool:water', targetId: 'plant', itemId: 'water' },
        { id: 'plant-reprocess', sourceId: 'plant', targetId: 'reprocess', itemId: 'waste' },
      ],
    };

    const { result } = solveProductionGraph(graph, gameData());

    expect(result.nodes.plant?.machines).toBeCloseTo(558, 4);
    expect(result.nodes.plant?.inputs).toContainEqual({ itemId: 'water', ratePerMin: 5580 });
    expect(result.edges['pool-plant']?.deficitRate ?? 0).toBeCloseTo(0, 4);
  });

  it('(c) THE FIX: demand-mode water source + cyclic byproduct through a pool no longer collapses', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'fuel', itemId: 'fuel', sourceType: 'manual-input', maxRatePerMin: 558 },
        { kind: 'source', id: 'pump', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000 },
        { kind: 'pool', id: 'pool:water', itemId: 'water' },
        { kind: 'recipe', id: 'plant', recipeId: 'nuke' },
        { kind: 'recipe', id: 'reprocess', recipeId: 'reprocess' },
      ],
      edges: [
        { id: 'fuel-plant', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' },
        { id: 'pump-pool', sourceId: 'pump', targetId: 'pool:water', itemId: 'water' },
        { id: 'reprocess-pool', sourceId: 'reprocess', targetId: 'pool:water', itemId: 'water' },
        { id: 'pool-plant', sourceId: 'pool:water', targetId: 'plant', itemId: 'water' },
        { id: 'plant-reprocess', sourceId: 'plant', targetId: 'reprocess', itemId: 'waste' },
      ],
    };

    const { result } = solveProductionGraph(graph, gameData());

    // Fully fuel-bound: 558 fuel/min at 1/machine -> 558 machines, matching
    // states (a) and (b) exactly -- the pooled demand-mode water source must
    // not shrink the plant just because a finite byproduct also shares the
    // pool.
    expect(result.nodes.plant?.machines).toBeCloseTo(558, 4);
    expect(result.nodes.plant?.machines).toBeGreaterThan(0);

    // Water demand is the full recipe requirement (558 * 10/min) and is
    // fully supplied (no deficit): the pool's inflow from the pump plus the
    // byproduct trickle together cover it.
    expect(result.nodes.plant?.inputs).toContainEqual({ itemId: 'water', ratePerMin: 5580 });
    expect(result.edges['pool-plant']?.suppliedRate).toBeCloseTo(5580, 4);
    expect(result.edges['pool-plant']?.deficitRate ?? 0).toBeCloseTo(0, 4);

    // The byproduct genuinely contributes (the cycle isn't just being
    // ignored) and the pump makes up the rest.
    const pumpSupplied = result.edges['pump-pool']?.suppliedRate ?? 0;
    const byproductSupplied = result.edges['reprocess-pool']?.suppliedRate ?? 0;
    expect(byproductSupplied).toBeGreaterThan(0);
    expect(pumpSupplied + byproductSupplied).toBeCloseTo(5580, 1);
  });
});
