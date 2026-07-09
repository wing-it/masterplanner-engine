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
 * Owner-reported (ECM / Supply factory). Steel Ingot forks to a fixed branch
 * (Steel Beam, pinned by a downstream Encased Industrial Beam machine override)
 * and a maximize branch (Steel Pipe -> ... -> EM Rod). With 6300 steel ingot
 * available, the fixed branch needs exactly 3600 and the maximize branch should
 * absorb the remaining 2700.
 *
 * The bug: after the fork reserves the fixed 3600 floor, the leftover 2700 is
 * split evenly between the two branches (both treated as unbounded), so the
 * fixed branch is over-allocated 4950 (1350 it cannot even consume) and the
 * maximize branch is starved to 1350. The fixed ceiling must drain first and
 * the elastic branch must absorb the leftover.
 */
describe('divergent fork: a fixed branch drains to its ceiling before the elastic branch', () => {
  function data() {
    return gameData([
      // 1 steel -> 1 beam per second = 60/min per machine (auto; no override).
      recipe({ id: 'beam', durationSeconds: 1, inputs: [{ itemId: 'steel', amount: 1 }], outputs: [{ itemId: 'beam', amount: 1 }] }),
      // 1 beam -> 1 eib per second = 60/min per machine; the machine override
      // lives here (downstream), fixing the whole beam branch at 3600 steel.
      recipe({ id: 'eib', durationSeconds: 1, inputs: [{ itemId: 'beam', amount: 1 }], outputs: [{ itemId: 'eib', amount: 1 }] }),
      // 1 steel -> 1 pipe per second (auto); the maximize flag sits downstream
      // on rod, exactly like Steel Pipe -> Stator -> EM Rod.
      recipe({ id: 'pipe', durationSeconds: 1, inputs: [{ itemId: 'steel', amount: 1 }], outputs: [{ itemId: 'pipe', amount: 1 }] }),
      recipe({ id: 'rod', durationSeconds: 1, inputs: [{ itemId: 'pipe', amount: 1 }], outputs: [{ itemId: 'rod', amount: 1 }] }),
    ]);
  }

  function graph(): ProductionGraph {
    return {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'steel', itemId: 'steel', sourceType: 'resource-claim', maxRatePerMin: 6300, machineCountOverride: 1 },
        // Auto recipe -- its steel demand is fixed only transitively, by the
        // downstream eib override, exactly like Steel Beam -> Encased Beam.
        { kind: 'recipe', id: 'beam', recipeId: 'beam' },
        // 60 machines * 60/min = 3600 beam demand => beam needs 3600 steel.
        { kind: 'recipe', id: 'eib', recipeId: 'eib', machineCountOverride: 60 },
        // Auto recipe feeding the maximize terminal (rod).
        { kind: 'recipe', id: 'pipe', recipeId: 'pipe' },
        { kind: 'recipe', id: 'rod', recipeId: 'rod', maximizeOutput: true },
        { kind: 'sink', id: 'eibSink', itemId: 'eib', demandPerMin: 1_000_000 },
        // Maximize terminal with NO fixed downstream demand, like a world output
        // port -- so the pipe branch has a zero fixed floor.
        { kind: 'sink', id: 'rodSink', itemId: 'rod', demandPerMin: 0 },
      ],
      edges: [
        { id: 'steel-beam', sourceId: 'steel', targetId: 'beam', itemId: 'steel' },
        { id: 'beam-eib', sourceId: 'beam', targetId: 'eib', itemId: 'beam' },
        { id: 'eib-out', sourceId: 'eib', targetId: 'eibSink', itemId: 'eib' },
        { id: 'steel-pipe', sourceId: 'steel', targetId: 'pipe', itemId: 'steel' },
        { id: 'pipe-rod', sourceId: 'pipe', targetId: 'rod', itemId: 'pipe' },
        { id: 'rod-out', sourceId: 'rod', targetId: 'rodSink', itemId: 'rod' },
      ],
    };
  }

  it('gives the fixed branch exactly its demand and the maximize branch the remainder', () => {
    const { result } = solveProductionGraph(graph(), data());
    expect(result.edges['steel-beam']?.allocation).toBeCloseTo(3600, 3);
    expect(result.edges['steel-pipe']?.allocation).toBeCloseTo(2700, 3);
  });

  it('does not over-allocate the fixed branch beyond what it can consume', () => {
    const { result } = solveProductionGraph(graph(), data());
    // The fixed beam branch consumes 3600; it must not be handed more.
    expect(result.nodes.beam?.inputs?.find((i) => i.itemId === 'steel')?.ratePerMin ?? 0).toBeCloseTo(3600, 3);
    expect(result.edges['steel-beam']?.allocation ?? 0).toBeLessThanOrEqual(3600 + 1e-3);
  });
});
