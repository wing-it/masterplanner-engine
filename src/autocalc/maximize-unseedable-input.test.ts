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
  return {
    recipes,
    generatorRecipes: [],
    buildingPowerById: new Map(),
  };
}

function graph(overrides: Partial<ProductionGraph> & Pick<ProductionGraph, 'nodes'>): ProductionGraph {
  return {
    schemaVersion: 2,
    edges: [],
    ...overrides,
  };
}

/**
 * Owner-reported bug: a maximized recipe with one input fed through a
 * demand-mode resource-claim chain (which cannot seed supply) gets sized from
 * its other, seedable input alone. The unseedable input's real capacity is
 * ignored at seed time, the node is marked supply-bound (scale-down immune),
 * and the solve reports a shortage instead of settling at the feasible rate —
 * the same rate the identical graph produces when the output is unconnected
 * (maximize inactive).
 */
describe('maximizeOutput with an unseedable (demand-only) input chain', () => {
  function heatSinkData() {
    return gameData([
      recipe({
        id: 'copper-sheet',
        durationSeconds: 60,
        inputs: [{ itemId: 'copper-ore', amount: 60 }],
        outputs: [{ itemId: 'sheet', amount: 60 }],
      }),
      recipe({
        id: 'heat-sink',
        durationSeconds: 60,
        inputs: [
          { itemId: 'casing', amount: 10 },
          { itemId: 'sheet', amount: 10 },
        ],
        outputs: [{ itemId: 'heat-sink', amount: 10 }],
      }),
    ]);
  }

  function heatSinkGraph(opts: { maximize: boolean; connected: boolean }): ProductionGraph {
    const nodes: ProductionGraph['nodes'] = [
      { kind: 'source', id: 'casing-src', itemId: 'casing', sourceType: 'manual-input', maxRatePerMin: 200 },
      // Demand-mode claim (no machineCountOverride): elastic up to 100/min.
      { kind: 'source', id: 'ore-claim', itemId: 'copper-ore', sourceType: 'resource-claim', maxRatePerMin: 100 },
      { kind: 'recipe', id: 'sheets', recipeId: 'copper-sheet' },
      {
        kind: 'recipe',
        id: 'sinks',
        recipeId: 'heat-sink',
        ...(opts.maximize ? { maximizeOutput: true } : {}),
      },
    ];
    const edges: ProductionGraph['edges'] = [
      { id: 'ore-to-sheets', sourceId: 'ore-claim', targetId: 'sheets', itemId: 'copper-ore' },
      { id: 'sheets-to-sinks', sourceId: 'sheets', targetId: 'sinks', itemId: 'sheet' },
      { id: 'casing-to-sinks', sourceId: 'casing-src', targetId: 'sinks', itemId: 'casing' },
    ];
    if (opts.connected) {
      nodes.push({ kind: 'sink', id: 'export', itemId: 'heat-sink' });
      edges.push({ id: 'sinks-to-export', sourceId: 'sinks', targetId: 'export', itemId: 'heat-sink' });
    }
    return graph({ nodes, edges });
  }

  it('control: unconnected output settles at the constrained input capacity', () => {
    const { result } = solveProductionGraph(heatSinkGraph({ maximize: false, connected: false }), heatSinkData());

    expect(result.nodes.sinks?.outputs).toContainEqual({ itemId: 'heat-sink', ratePerMin: 100 });
    expect(result.nodes.sinks?.inputs).toContainEqual({ itemId: 'sheet', ratePerMin: 100 });
    expect(result.nodes.sinks?.inputs).toContainEqual({ itemId: 'casing', ratePerMin: 100 });
  });

  it('connecting the output to an export sink must not change the solved rate', () => {
    const { result } = solveProductionGraph(heatSinkGraph({ maximize: true, connected: true }), heatSinkData());

    expect(result.nodes.sinks?.outputs).toContainEqual({ itemId: 'heat-sink', ratePerMin: 100 });
    expect(result.nodes.sinks?.inputs).toContainEqual({ itemId: 'sheet', ratePerMin: 100 });
    expect(result.nodes.sinks?.inputs).toContainEqual({ itemId: 'casing', ratePerMin: 100 });
  });
});
