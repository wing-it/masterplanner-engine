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
 * Owner-reported bug (uranium cell factory): a maximized recipe with one
 * bounded-but-unseedable input (demand-mode resource claim, builder sentinel
 * maxRatePerMin=1e9) and one seedable input chain was floor-sized from the
 * seedable chain alone. Adding a small override consumer took a 150/min
 * factory to ~5000/min, because the acid chain's seeded capacity — not
 * demand — set the machine count, and the claim's sentinel capacity meant
 * constraint scaling could never pull it back.
 *
 * Expected: the supply-seeded floor only applies when every connected input
 * actually seeded (inputs fed purely by elastic water sources are exempt);
 * otherwise the node stays demand-driven.
 */
describe('maximizeOutput floor with partially seedable inputs', () => {
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
      // Seedable: a big fixed sulfur supply.
      { kind: 'source', id: 'sulfur-src', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 3000 },
      { kind: 'recipe', id: 'acid-plant', recipeId: 'sulfuric-acid' },
      // Demand-mode claim: unseedable, sentinel "unbounded" capacity.
      { kind: 'source', id: 'uranium-claim', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
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

  it('keeps a maximized recipe demand-driven when a bounded input cannot seed', () => {
    const { result } = solveProductionGraph(cellsGraph({ withNobelisk: false }), cellsData());

    expect(result.nodes.cells?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 150 });
  });

  it('adding a small override consumer grows output by exactly its demand', () => {
    const { result } = solveProductionGraph(cellsGraph({ withNobelisk: true }), cellsData());

    // 150 export (maximize keeps the advertised port rate) + 10 for the nobelisk.
    expect(result.nodes.cells?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 160 });
    expect(result.edges['cells-to-plant']?.allocation).toBeCloseTo(150, 4);
    expect(result.edges['cells-to-nobelisk']?.allocation).toBeCloseTo(10, 4);
  });

  it('still floor-sizes from seeded supply when the only unseeded input is elastic water', () => {
    const data = gameData([
      recipe({
        id: 'diluted-fuel',
        durationSeconds: 60,
        inputs: [
          { itemId: 'heavy-oil', amount: 30 },
          { itemId: 'water', amount: 60 },
        ],
        outputs: [{ itemId: 'fuel', amount: 60 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'oil-src', itemId: 'heavy-oil', sourceType: 'manual-input', maxRatePerMin: 90 },
        { kind: 'source', id: 'water-src', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'refinery', recipeId: 'diluted-fuel', maximizeOutput: true },
        { kind: 'sink', id: 'fuel-sink', itemId: 'fuel', demandPerMin: 30 },
      ],
      edges: [
        { id: 'oil-in', sourceId: 'oil-src', targetId: 'refinery', itemId: 'heavy-oil' },
        { id: 'water-in', sourceId: 'water-src', targetId: 'refinery', itemId: 'water' },
        { id: 'fuel-out', sourceId: 'refinery', targetId: 'fuel-sink', itemId: 'fuel' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // Oil seeds 3 machines' worth; water is elastic and must not block the floor.
    expect(result.nodes.refinery?.outputs).toContainEqual({ itemId: 'fuel', ratePerMin: 180 });
  });
});
