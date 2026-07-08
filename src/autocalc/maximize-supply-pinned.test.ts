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
 * Owner-specified semantics: maximizeOutput pins the recipe's production at
 * its (visible) supply bound. Downstream consumers divide that fixed output —
 * the divergent-branch rule fulfils a small fixed tap first and the large
 * branch absorbs the shortfall — instead of demand inflating the node past
 * what its inputs can physically deliver.
 */
describe('maximizeOutput pinned to a visible supply bound', () => {
  function cellsData() {
    return gameData([
      recipe({
        id: 'sulfuric-acid',
        durationSeconds: 60,
        inputs: [{ itemId: 'sulfur', amount: 60 }],
        outputs: [{ itemId: 'acid', amount: 60 }],
      }),
      recipe({
        id: 'uranium-cell',
        durationSeconds: 60,
        inputs: [
          { itemId: 'uranium', amount: 50 },
          { itemId: 'acid', amount: 15 },
        ],
        outputs: [{ itemId: 'cell', amount: 25 }],
      }),
      recipe({
        id: 'nuke-nobelisk',
        durationSeconds: 60,
        inputs: [{ itemId: 'cell', amount: 10 }],
        outputs: [{ itemId: 'nobelisk', amount: 3 }],
      }),
    ]);
  }

  function cellsGraph(opts: { withNobelisk: boolean }): ProductionGraph {
    const nodes: ProductionGraph['nodes'] = [
      { kind: 'source', id: 'sulfur-src', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 3000 },
      { kind: 'recipe', id: 'acid-plant', recipeId: 'sulfuric-acid' },
      // Seedable, bounded: exactly 150 cells' worth of uranium.
      { kind: 'source', id: 'uranium-claim', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 300, machineCountOverride: 1 },
      { kind: 'recipe', id: 'cells', recipeId: 'uranium-cell', maximizeOutput: true },
      { kind: 'sink', id: 'power-plant', itemId: 'cell', demandPerMin: 150 },
    ];
    const edges: ProductionGraph['edges'] = [
      { id: 'sulfur-to-acid', sourceId: 'sulfur-src', targetId: 'acid-plant', itemId: 'sulfur' },
      { id: 'acid-to-cells', sourceId: 'acid-plant', targetId: 'cells', itemId: 'acid' },
      { id: 'uranium-to-cells', sourceId: 'uranium-claim', targetId: 'cells', itemId: 'uranium' },
      { id: 'cells-to-plant', sourceId: 'cells', targetId: 'power-plant', itemId: 'cell' },
    ];
    if (opts.withNobelisk) {
      nodes.push({ kind: 'recipe', id: 'nobelisk', recipeId: 'nuke-nobelisk', machineCountOverride: 1 });
      edges.push({ id: 'cells-to-nobelisk', sourceId: 'cells', targetId: 'nobelisk', itemId: 'cell' });
    }
    return graph({ nodes, edges });
  }

  it('produces at the supply bound when demand matches it', () => {
    const { result } = solveProductionGraph(cellsGraph({ withNobelisk: false }), cellsData());

    expect(result.nodes.cells?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 150 });
    expect(result.edges['cells-to-plant']?.allocation).toBeCloseTo(150, 4);
  });

  it('a new fixed tap divides the pinned output instead of inflating it', () => {
    const { result } = solveProductionGraph(cellsGraph({ withNobelisk: true }), cellsData());

    // Production stays at the bound; the nobelisk's 10 is fulfilled first
    // (divergent-branch even split), the export absorbs the shortfall.
    expect(result.nodes.cells?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 150 });
    expect(result.edges['cells-to-nobelisk']?.allocation).toBeCloseTo(10, 4);
    expect(result.edges['cells-to-nobelisk']?.deficitRate).toBeLessThan(1e-4);
    expect(result.edges['cells-to-plant']?.allocation).toBeCloseTo(140, 4);
    expect(result.edges['cells-to-plant']?.deficitRate).toBeCloseTo(10, 4);
  });
});
