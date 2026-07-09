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
 * Owner-reported (uranium power factory). Three cell factories pool their cells
 * into a maximized Uranium Fuel Unit recipe (100 cells / 300s = 20 cells/min per
 * machine). One cell factory (NE) also forks a fixed 20-cell tap to a nobelisk
 * recipe (machine-count override). Total production 1680, so 1660 cells are
 * deliverable to the pool.
 *
 * The factory I/O panel correctly reports 1660. But when the fuel recipe's
 * OUTPUT is unsinked, the fork under-reserves the nobelisk tap and leaks the
 * remainder into the pool, seeding the fuel recipe above the 1660 that actually
 * exists. Connecting the output masks it (the constraint pass scales it back).
 * The seed must be 1660 whether or not the output is sinked.
 */
describe('maximizeOutput fork reservation with an unsinked consumer', () => {
  function data() {
    return gameData([
      // 50 uranium -> 25 cells per minute per machine.
      recipe({ id: 'uranium-cell', durationSeconds: 60, inputs: [{ itemId: 'uranium', amount: 50 }], outputs: [{ itemId: 'cell', amount: 25 }] }),
      // Fixed 20-cell tap when overridden to 1 machine.
      recipe({ id: 'nuke', durationSeconds: 60, inputs: [{ itemId: 'cell', amount: 20 }], outputs: [{ itemId: 'nob', amount: 1 }] }),
      // Real Uranium Fuel Unit: 100 cells / 300s = 20 cells/min per machine.
      recipe({ id: 'fuel-unit', durationSeconds: 300, inputs: [{ itemId: 'cell', amount: 100 }], outputs: [{ itemId: 'fuel', amount: 3 }] }),
    ]);
  }

  // Three cell factories at 560 cells/min each (1120 uranium -> 560 cells).
  // NE forks 20 to the nobelisk, leaving 1660 for the pool.
  function graph(sinked: boolean): ProductionGraph {
    const nodes: ProductionGraph['nodes'] = [
      { kind: 'source', id: 'uNW', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
      { kind: 'recipe', id: 'cellsNW', recipeId: 'uranium-cell', maximizeOutput: true },
      { kind: 'source', id: 'uNE', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
      { kind: 'recipe', id: 'cellsNE', recipeId: 'uranium-cell', maximizeOutput: true },
      { kind: 'recipe', id: 'nob', recipeId: 'nuke', machineCountOverride: 1 },
      { kind: 'source', id: 'uC', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
      { kind: 'recipe', id: 'cellsC', recipeId: 'uranium-cell', maximizeOutput: true },
      { kind: 'pool', id: 'pool:ff:cell', itemId: 'cell' },
      { kind: 'recipe', id: 'fuel', recipeId: 'fuel-unit', maximizeOutput: true },
    ];
    const edges: ProductionGraph['edges'] = [
      { id: 'uNWc', sourceId: 'uNW', targetId: 'cellsNW', itemId: 'uranium' },
      { id: 'cNWpool', sourceId: 'cellsNW', targetId: 'pool:ff:cell', itemId: 'cell' },
      { id: 'uNEc', sourceId: 'uNE', targetId: 'cellsNE', itemId: 'uranium' },
      { id: 'cNEpool', sourceId: 'cellsNE', targetId: 'pool:ff:cell', itemId: 'cell' },
      { id: 'cNEnob', sourceId: 'cellsNE', targetId: 'nob', itemId: 'cell' },
      { id: 'uCc', sourceId: 'uC', targetId: 'cellsC', itemId: 'uranium' },
      { id: 'cCpool', sourceId: 'cellsC', targetId: 'pool:ff:cell', itemId: 'cell' },
      { id: 'poolfuel', sourceId: 'pool:ff:cell', targetId: 'fuel', itemId: 'cell' },
    ];
    if (sinked) {
      nodes.push({ kind: 'sink', id: 'plant', itemId: 'fuel', demandPerMin: 100 });
      edges.push({ id: 'fuelout', sourceId: 'fuel', targetId: 'plant', itemId: 'fuel' });
    }
    return { schemaVersion: 2, nodes, edges };
  }

  function fuelCellInput(sinked: boolean): number {
    const { result } = solveProductionGraph(graph(sinked), data());
    const input = result.nodes.fuel?.inputs?.find((entry) => entry.itemId === 'cell');
    return input?.ratePerMin ?? 0;
  }

  it('does not draw more cells than the pool can deliver when the output is unsinked', () => {
    // 1680 produced - 20 nobelisk tap = 1660 deliverable to the pool.
    expect(fuelCellInput(false)).toBeCloseTo(1660, 3);
  });

  it('draws the same 1660 when the output is sinked', () => {
    expect(fuelCellInput(true)).toBeCloseTo(1660, 3);
  });
});

/**
 * Owner-reported (exact repro): a freshly-dragged recipe has NO maximizeOutput
 * flag at all -- it isn't wired to a world factory output and the user never
 * enabled "send extra to sink". Its output is simply unconnected. The engine's
 * self-demand seeding (an unsinked recipe implicitly "demands" whatever its
 * available input supply can produce, so it previews a sane non-zero rate)
 * makes it behave exactly like a maximize node even though the flag is unset.
 * Forks upstream of it must still reserve fixed-demand siblings correctly.
 */
describe('self-demand-seeded recipe (no maximizeOutput flag, output left unconnected)', () => {
  function data() {
    return gameData([
      recipe({ id: 'uranium-cell', durationSeconds: 60, inputs: [{ itemId: 'uranium', amount: 50 }], outputs: [{ itemId: 'cell', amount: 25 }] }),
      recipe({ id: 'nuke', durationSeconds: 60, inputs: [{ itemId: 'cell', amount: 20 }], outputs: [{ itemId: 'nob', amount: 1 }] }),
      recipe({ id: 'fuel-unit', durationSeconds: 300, inputs: [{ itemId: 'cell', amount: 100 }], outputs: [{ itemId: 'fuel', amount: 3 }] }),
    ]);
  }

  function graph(): ProductionGraph {
    return {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'uNW', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cellsNW', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'source', id: 'uNE', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cellsNE', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'recipe', id: 'nob', recipeId: 'nuke', machineCountOverride: 1 },
        { kind: 'source', id: 'uC', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cellsC', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'pool', id: 'pool:ff:cell', itemId: 'cell' },
        // No maximizeOutput flag -- exactly what a freshly-dragged, unwired recipe looks like.
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-unit' },
      ],
      edges: [
        { id: 'uNWc', sourceId: 'uNW', targetId: 'cellsNW', itemId: 'uranium' },
        { id: 'cNWpool', sourceId: 'cellsNW', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'uNEc', sourceId: 'uNE', targetId: 'cellsNE', itemId: 'uranium' },
        { id: 'cNEpool', sourceId: 'cellsNE', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'cNEnob', sourceId: 'cellsNE', targetId: 'nob', itemId: 'cell' },
        { id: 'uCc', sourceId: 'uC', targetId: 'cellsC', itemId: 'uranium' },
        { id: 'cCpool', sourceId: 'cellsC', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'poolfuel', sourceId: 'pool:ff:cell', targetId: 'fuel', itemId: 'cell' },
        // No outgoing edge from `fuel` at all -- output left unconnected.
      ],
    };
  }

  it('does not draw more cells than the pool can deliver', () => {
    const { result } = solveProductionGraph(graph(), data());
    const input = result.nodes.fuel?.inputs?.find((entry) => entry.itemId === 'cell');
    // 1680 produced - 20 nobelisk tap = 1660 deliverable to the pool.
    expect(input?.ratePerMin ?? 0).toBeCloseTo(1660, 3);
  });
});

/**
 * Counterpart guard: "auto-scale to supply" applies only when the output has
 * nowhere to go. A non-override recipe SINKED to a small downstream consumer
 * must still size to that consumer's demand, not balloon to the full available
 * supply. (Confirms the self-demand fix did not turn every plain recipe into a
 * maximize node.)
 */
describe('non-override recipe sinked to a small consumer stays demand-driven', () => {
  function data() {
    return gameData([
      recipe({ id: 'uranium-cell', durationSeconds: 60, inputs: [{ itemId: 'uranium', amount: 50 }], outputs: [{ itemId: 'cell', amount: 25 }] }),
      recipe({ id: 'fuel-unit', durationSeconds: 300, inputs: [{ itemId: 'cell', amount: 100 }], outputs: [{ itemId: 'fuel', amount: 3 }] }),
    ]);
  }

  it('produces only what the downstream sink demands', () => {
    const graph: ProductionGraph = {
      schemaVersion: 2,
      nodes: [
        // Ample supply: 2000 uranium -> 1000 cells available.
        { kind: 'source', id: 'u', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 2000, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cells', recipeId: 'uranium-cell', maximizeOutput: true },
        // No override, no maximize flag: sized purely by the downstream sink.
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-unit' },
        // Small consumer: 3 fuel/min -> needs 100 cells, far below the 1000 available.
        { kind: 'sink', id: 'consumer', itemId: 'fuel', demandPerMin: 3 },
      ],
      edges: [
        { id: 'uc', sourceId: 'u', targetId: 'cells', itemId: 'uranium' },
        { id: 'cf', sourceId: 'cells', targetId: 'fuel', itemId: 'cell' },
        { id: 'fc', sourceId: 'fuel', targetId: 'consumer', itemId: 'fuel' },
      ],
    };
    const { result } = solveProductionGraph(graph, data());
    // 3 fuel/min needs 100 cells/min, NOT the 1000 that are available.
    expect(result.nodes.fuel?.inputs?.find((e) => e.itemId === 'cell')?.ratePerMin ?? 0).toBeCloseTo(100, 3);
    expect(result.nodes.fuel?.outputs?.find((e) => e.itemId === 'fuel')?.ratePerMin ?? 0).toBeCloseTo(3, 3);
  });
});

/**
 * Guard against over-correction: a single fixed tap fed by TWO producers
 * (same-item fan-in 2). Each producer's fork must reserve its share of the tap
 * (tap/fanIn), the shares summing to the full fixed demand, so the pooled
 * maximize recipe sees exactly production minus the whole tap — not more (the
 * bug) and not less (a naive "reserve full demand on every incoming edge").
 */
describe('maximizeOutput fork reservation with a fan-in fixed tap', () => {
  function data() {
    return gameData([
      recipe({ id: 'uranium-cell', durationSeconds: 60, inputs: [{ itemId: 'uranium', amount: 50 }], outputs: [{ itemId: 'cell', amount: 25 }] }),
      // 20 cells/min per machine; overridden to 2 machines -> 40-cell tap, fed by both producers.
      recipe({ id: 'nuke', durationSeconds: 60, inputs: [{ itemId: 'cell', amount: 20 }], outputs: [{ itemId: 'nob', amount: 1 }] }),
      recipe({ id: 'fuel-unit', durationSeconds: 300, inputs: [{ itemId: 'cell', amount: 100 }], outputs: [{ itemId: 'fuel', amount: 3 }] }),
    ]);
  }

  function graph(): ProductionGraph {
    return {
      schemaVersion: 2,
      nodes: [
        { kind: 'source', id: 'uA', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cellsA', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'source', id: 'uB', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1120, machineCountOverride: 1 },
        { kind: 'recipe', id: 'cellsB', recipeId: 'uranium-cell', maximizeOutput: true },
        { kind: 'recipe', id: 'nob', recipeId: 'nuke', machineCountOverride: 2 },
        { kind: 'pool', id: 'pool:ff:cell', itemId: 'cell' },
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-unit', maximizeOutput: true },
      ],
      edges: [
        { id: 'uAc', sourceId: 'uA', targetId: 'cellsA', itemId: 'uranium' },
        { id: 'cApool', sourceId: 'cellsA', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'cAnob', sourceId: 'cellsA', targetId: 'nob', itemId: 'cell' },
        { id: 'uBc', sourceId: 'uB', targetId: 'cellsB', itemId: 'uranium' },
        { id: 'cBpool', sourceId: 'cellsB', targetId: 'pool:ff:cell', itemId: 'cell' },
        { id: 'cBnob', sourceId: 'cellsB', targetId: 'nob', itemId: 'cell' },
        { id: 'poolfuel', sourceId: 'pool:ff:cell', targetId: 'fuel', itemId: 'cell' },
      ],
    };
  }

  it('reserves exactly the whole tap across both suppliers', () => {
    const { result } = solveProductionGraph(graph(), data());
    // 1120 produced - 40 tap = 1080 deliverable to the pool.
    expect(result.nodes.fuel?.inputs?.find((e) => e.itemId === 'cell')?.ratePerMin).toBeCloseTo(1080, 3);
    expect(result.nodes.nob?.inputs?.find((e) => e.itemId === 'cell')?.ratePerMin).toBeCloseTo(40, 3);
  });
});
