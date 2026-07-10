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

function graph(overrides: Partial<ProductionGraph> & Pick<ProductionGraph, 'nodes'>): ProductionGraph {
  return { schemaVersion: 2, edges: [], ...overrides };
}

const WATER_SOURCE_RATE = 1_000_000_000;

/**
 * Owner-reported bug: a freshly placed recipe reads 0 (no demand, no supply),
 * but dragging one of its inputs onto the factory I/O panel to mint a NEW,
 * map-unconnected input port made it scale up to ~1e9. That input is backed by
 * the implicit `manual-input` free-import placeholder (sentinel rate,
 * `unbounded: true`). An unbounded/elastic source must only ever supply what is
 * actually pulled — it must never seed an unsinked (self-demand) or maximized
 * consumer forward on its own.
 */
describe('unbounded manual-input never seeds production forward', () => {
  function pelletData(): EngineGameData {
    // 25 waste -> 30 pellet (an unsinked byproduct-style recipe).
    return gameData([
      recipe({
        id: 'plutonium',
        durationSeconds: 60,
        inputs: [{ itemId: 'waste', amount: 25 }],
        outputs: [{ itemId: 'pellet', amount: 30 }],
      }),
    ]);
  }

  it('leaves an unsinked recipe at 0 when its only input is an unbounded manual import', () => {
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'source:manual-input:waste-port',
          itemId: 'waste',
          sourceType: 'manual-input',
          maxRatePerMin: WATER_SOURCE_RATE,
          unbounded: true,
        },
        { kind: 'recipe', id: 'pellets', recipeId: 'plutonium' },
      ],
      edges: [{ id: 'waste-in', sourceId: 'source:manual-input:waste-port', targetId: 'pellets', itemId: 'waste' }],
    });

    const { result } = solveProductionGraph(g, pelletData());

    // No demand and no seedable supply -> the recipe stays at 0 machines (no
    // output rows emitted), exactly as it read before the input was minted.
    const pelletRate = result.nodes.pellets?.outputs.find((o) => o.itemId === 'pellet')?.ratePerMin ?? 0;
    expect(pelletRate).toBeCloseTo(0, 6);
    expect(result.nodes.pellets?.requiredMachines ?? 0).toBeCloseTo(0, 6);
  });

  it('still supplies an unbounded manual import when a real downstream sink pulls it', () => {
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'source:manual-input:waste-port',
          itemId: 'waste',
          sourceType: 'manual-input',
          maxRatePerMin: WATER_SOURCE_RATE,
          unbounded: true,
        },
        { kind: 'recipe', id: 'pellets', recipeId: 'plutonium' },
        { kind: 'sink', id: 'pellet-sink', itemId: 'pellet', demandPerMin: 30 },
      ],
      edges: [
        { id: 'waste-in', sourceId: 'source:manual-input:waste-port', targetId: 'pellets', itemId: 'waste' },
        { id: 'pellet-out', sourceId: 'pellets', targetId: 'pellet-sink', itemId: 'pellet' },
      ],
    });

    const { result } = solveProductionGraph(g, pelletData());

    // The sink pulls 30 pellet -> 1 machine -> 25 waste imported. Elastic import
    // meets the real demand but does not overshoot to the sentinel.
    expect(result.nodes.pellets?.outputs).toContainEqual({ itemId: 'pellet', ratePerMin: 30 });
    expect(result.edges['waste-in']?.allocation ?? 0).toBeCloseTo(25, 4);
  });

  it('a finite (bounded) manual import still seeds a maximized consumer', () => {
    const g = graph({
      nodes: [
        // No `unbounded` flag: a real, bounded import that SHOULD seed.
        { kind: 'source', id: 'waste-src', itemId: 'waste', sourceType: 'manual-input', maxRatePerMin: 250 },
        { kind: 'recipe', id: 'pellets', recipeId: 'plutonium', maximizeOutput: true },
      ],
      edges: [{ id: 'waste-in', sourceId: 'waste-src', targetId: 'pellets', itemId: 'waste' }],
    });

    const { result } = solveProductionGraph(g, pelletData());

    // 250 waste / 25 -> 10 machines -> 300 pellet.
    expect(result.nodes.pellets?.outputs).toContainEqual({ itemId: 'pellet', ratePerMin: 300 });
  });
});
