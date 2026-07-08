import { describe, expect, it } from 'vitest';

import { normalizeGraph } from '../graph/normalize';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph } from '../types/production-graph';
import { solveProductionGraph } from './solve';

function recipe(opts: {
  id: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
  product?: string | null;
}): EngineRecipeDefinition {
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds,
    product:
      opts.product === undefined
        ? opts.outputs[0]
          ? { id: opts.outputs[0].itemId }
          : null
        : opts.product
        ? { id: opts.product }
        : null,
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

function coalForkRecipes(): EngineRecipeDefinition[] {
  return [
    recipe({
      id: 'coal-generator',
      durationSeconds: 4,
      inputs: [{ itemId: 'coal', amount: 1 }, { itemId: 'water', amount: 3 }],
      outputs: [],
      product: null,
    }),
    recipe({
      id: 'compacted-coal',
      durationSeconds: 4,
      inputs: [
        { itemId: 'coal', amount: 1 },
        { itemId: 'sulfur', amount: 1 },
      ],
      outputs: [{ itemId: 'compacted-coal', amount: 1 }],
    }),
  ];
}

function coalForkGraph(priority: string[] = []): ProductionGraph {
  const routing = priority.length > 0
    ? { portSide: 'output' as const, portId: 'out', priority }
    : undefined;

  return graph({
    nodes: [
      { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1200 },
      { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 720 },
      { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
      { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
    ],
    edges: [
      { id: 'coal-direct', sourceId: 'coal', targetId: 'direct', itemId: 'coal', ...(routing ? { routing } : {}) },
      { id: 'coal-compacted', sourceId: 'coal', targetId: 'compacted', itemId: 'coal', ...(routing ? { routing } : {}) },
      { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
    ],
  });
}

function coalForkGraphWithOverrides(params: {
  priority?: string[];
  directMachines?: number;
  compactedMachines?: number;
}): ProductionGraph {
  const base = coalForkGraph(params.priority ?? []);
  return {
    ...base,
    nodes: base.nodes.map((node) => {
      if (node.id === 'direct' && params.directMachines !== undefined) {
        return { ...node, machineCountOverride: params.directMachines };
      }
      if (node.id === 'compacted' && params.compactedMachines !== undefined) {
        return { ...node, machineCountOverride: params.compactedMachines };
      }
      return node;
    }),
  };
}

function coalForkGraphWithWater(params: {
  priority?: string[];
  waterMachines?: number;
} = {}): ProductionGraph {
  const base = coalForkGraph(params.priority ?? []);
  const waterNode = {
    kind: 'source' as const,
    id: 'water',
    itemId: 'water',
    sourceType: 'water' as const,
    maxRatePerMin: params.waterMachines == null ? 1_000_000_000 : params.waterMachines * 120,
    perExtractorRatePerMin: 120,
    ...(params.waterMachines == null ? {} : { machineCountOverride: params.waterMachines }),
  };

  return {
    ...base,
    nodes: [...base.nodes, waterNode],
    edges: [
      ...base.edges,
      { id: 'water-direct', sourceId: 'water', targetId: 'direct', itemId: 'water' },
    ],
  };
}

describe('solveProductionGraph', () => {
  it('keeps an isolated undriven recipe at zero machines with blank rates', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [{ kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' }],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.smelter).toEqual({
      machines: 0,
      scale: 1,
      inputs: [],
      outputs: [],
    });
  });

  it('keeps an undriven recipe at zero when connected only to a null-machine resource claim', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
      ],
      edges: [{ id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' }],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['ore-source']?.machines).toBe(0);
    expect(result.nodes['ore-source']?.outputs).toEqual([]);
    expect(result.nodes.smelter).toEqual({
      machines: 0,
      scale: 1,
      inputs: [],
      outputs: [],
    });
  });

  it('supply-drives a single-input recipe from a finite connected source when there is no downstream demand', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 60, machineCountOverride: 1 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
      ],
      edges: [{ id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' }],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.smelter?.machines).toBeCloseTo(2, 5);
    expect(result.nodes.smelter?.inputs).toContainEqual({ itemId: 'iron-ore', ratePerMin: 60 });
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 60 });
  });

  it('sums unequal fixed resource-claim fan-in into one recipe input', () => {
    const data = gameData([
      recipe({
        id: 'uranium-processing',
        durationSeconds: 1,
        inputs: [{ itemId: 'uranium', amount: 1 }],
        outputs: [{ itemId: 'processed-uranium', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'uranium-normal', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 600, machineCountOverride: 1 },
        { kind: 'source', id: 'uranium-impure', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 300, machineCountOverride: 1 },
        { kind: 'recipe', id: 'processor', recipeId: 'uranium-processing' },
      ],
      edges: [
        { id: 'normal-to-processor', sourceId: 'uranium-normal', targetId: 'processor', itemId: 'uranium' },
        { id: 'impure-to-processor', sourceId: 'uranium-impure', targetId: 'processor', itemId: 'uranium' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.processor?.inputs).toContainEqual({ itemId: 'uranium', ratePerMin: 900 });
    expect(result.nodes.processor?.machines).toBeCloseTo(15, 5);
    expect(result.edges['normal-to-processor']?.allocation).toBeCloseTo(600, 5);
    expect(result.edges['impure-to-processor']?.allocation).toBeCloseTo(300, 5);
  });

  it('scales oversized downstream demand down to unequal fixed resource-claim fan-in capacity', () => {
    const data = gameData([
      recipe({
        id: 'uranium-processing',
        durationSeconds: 1,
        inputs: [{ itemId: 'uranium', amount: 1 }],
        outputs: [{ itemId: 'processed-uranium', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'uranium-normal', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 600, machineCountOverride: 1 },
        { kind: 'source', id: 'uranium-impure', itemId: 'uranium', sourceType: 'resource-claim', maxRatePerMin: 300, machineCountOverride: 1 },
        { kind: 'recipe', id: 'processor', recipeId: 'uranium-processing' },
        { kind: 'sink', id: 'sink', itemId: 'processed-uranium', demandPerMin: 26033.33 },
      ],
      edges: [
        { id: 'normal-to-processor', sourceId: 'uranium-normal', targetId: 'processor', itemId: 'uranium' },
        { id: 'impure-to-processor', sourceId: 'uranium-impure', targetId: 'processor', itemId: 'uranium' },
        { id: 'processor-to-sink', sourceId: 'processor', targetId: 'sink', itemId: 'processed-uranium' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.processor?.inputs).toContainEqual({ itemId: 'uranium', ratePerMin: 900 });
    expect(result.nodes.processor?.outputs).toContainEqual({ itemId: 'processed-uranium', ratePerMin: 900 });
    expect(result.edges['normal-to-processor']?.allocation).toBeCloseTo(600, 5);
    expect(result.edges['impure-to-processor']?.allocation).toBeCloseTo(300, 5);
  });

  it('supply-drives a chain through to the terminal leaf recipe', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
      recipe({
        id: 'iron-plate',
        durationSeconds: 6,
        inputs: [{ itemId: 'iron-ingot', amount: 3 }],
        outputs: [{ itemId: 'iron-plate', amount: 2 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 60, machineCountOverride: 1 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
        { kind: 'recipe', id: 'constructor', recipeId: 'iron-plate' },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'ingot-constructor', sourceId: 'smelter', targetId: 'constructor', itemId: 'iron-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.smelter?.machines).toBeCloseTo(2, 5);
    expect(result.nodes['constructor']?.machines).toBeCloseTo(2, 5);
    expect(result.nodes['constructor']?.outputs).toContainEqual({ itemId: 'iron-plate', ratePerMin: 40 });
  });

  it('supply-drives a reconverging diamond to full ore throughput', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
      recipe({
        id: 'iron-plate',
        durationSeconds: 6,
        inputs: [{ itemId: 'iron-ingot', amount: 3 }],
        outputs: [{ itemId: 'iron-plate', amount: 2 }],
      }),
      recipe({
        id: 'cast-screws',
        durationSeconds: 24,
        inputs: [{ itemId: 'iron-ingot', amount: 5 }],
        outputs: [{ itemId: 'screw', amount: 20 }],
      }),
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [
          { itemId: 'iron-plate', amount: 6 },
          { itemId: 'screw', amount: 12 },
        ],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 120, machineCountOverride: 2 },
        { kind: 'recipe', id: 'ingot', recipeId: 'iron-ingot' },
        { kind: 'recipe', id: 'plate', recipeId: 'iron-plate' },
        { kind: 'recipe', id: 'screws', recipeId: 'cast-screws' },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
      ],
      edges: [
        { id: 'ore-ingot', sourceId: 'ore-source', targetId: 'ingot', itemId: 'iron-ore' },
        { id: 'ingot-plate', sourceId: 'ingot', targetId: 'plate', itemId: 'iron-ingot' },
        { id: 'ingot-screws', sourceId: 'ingot', targetId: 'screws', itemId: 'iron-ingot' },
        { id: 'plate-rip', sourceId: 'plate', targetId: 'rip', itemId: 'iron-plate' },
        { id: 'screws-rip', sourceId: 'screws', targetId: 'rip', itemId: 'screw' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.ingot?.machines).toBeCloseTo(4, 5);
    expect(result.nodes.ingot?.inputs).toContainEqual({ itemId: 'iron-ore', ratePerMin: 120 });
    expect(result.nodes.rip?.machines).toBeCloseTo(2, 5);
    expect(result.nodes.rip?.outputs).toContainEqual({ itemId: 'reinforced-plate', ratePerMin: 10 });
    expect(result.edges['ingot-plate']?.allocation).toBeCloseTo(90, 5);
    expect(result.edges['ingot-screws']?.allocation).toBeCloseTo(30, 5);
  });

  it('supply-drives a multi-input recipe when one required input is missing', () => {
    const data = gameData([
      recipe({
        id: 'steel-ingot',
        durationSeconds: 4,
        inputs: [
          { itemId: 'iron-ore', amount: 3 },
          { itemId: 'coal', amount: 3 },
        ],
        outputs: [{ itemId: 'steel-ingot', amount: 3 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 60, machineCountOverride: 1 },
        { kind: 'recipe', id: 'foundry', recipeId: 'steel-ingot' },
      ],
      edges: [{ id: 'ore-foundry', sourceId: 'ore-source', targetId: 'foundry', itemId: 'iron-ore' }],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.foundry?.machines).toBeCloseTo(1.333333, 5);
    expect(result.nodes.foundry?.inputs).toContainEqual({ itemId: 'iron-ore', ratePerMin: 60 });
    expect(result.nodes.foundry?.inputs).toContainEqual({ itemId: 'coal', ratePerMin: 60 });
    expect(result.nodes.foundry?.outputs).toContainEqual({ itemId: 'steel-ingot', ratePerMin: 60 });
  });

  it('keeps a multi-input recipe at zero when none of its inputs are supplied', () => {
    const data = gameData([
      recipe({
        id: 'steel-ingot',
        durationSeconds: 4,
        inputs: [
          { itemId: 'iron-ore', amount: 3 },
          { itemId: 'coal', amount: 3 },
        ],
        outputs: [{ itemId: 'steel-ingot', amount: 3 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'recipe', id: 'foundry', recipeId: 'steel-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.foundry).toEqual({
      machines: 0,
      scale: 1,
      inputs: [],
      outputs: [],
    });
  });

  it('supply-drives reinforced plates from connected plates and reports missing screws', () => {
    const data = gameData([
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [
          { itemId: 'iron-plate', amount: 6 },
          { itemId: 'screw', amount: 12 },
        ],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'plate-source', itemId: 'iron-plate', sourceType: 'manual-input', maxRatePerMin: 800 },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
      ],
      edges: [{ id: 'plate-rip', sourceId: 'plate-source', targetId: 'rip', itemId: 'iron-plate' }],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.rip?.machines).toBeCloseTo(26.666666, 5);
    expect(result.nodes.rip?.inputs).toContainEqual({ itemId: 'iron-plate', ratePerMin: 800 });
    expect(result.nodes.rip?.inputs).toContainEqual({ itemId: 'screw', ratePerMin: 1600 });
    expect(result.nodes.rip?.outputs.find((output) => output.itemId === 'reinforced-plate')?.ratePerMin).toBeCloseTo(133.333333, 5);
  });

  it('uses the limiting supplied input for multi-input supply-driven recipes', () => {
    const data = gameData([
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [
          { itemId: 'iron-plate', amount: 6 },
          { itemId: 'screw', amount: 12 },
        ],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'plate-source', itemId: 'iron-plate', sourceType: 'manual-input', maxRatePerMin: 800 },
        { kind: 'source', id: 'screw-source', itemId: 'screw', sourceType: 'manual-input', maxRatePerMin: 600 },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
      ],
      edges: [
        { id: 'plate-rip', sourceId: 'plate-source', targetId: 'rip', itemId: 'iron-plate' },
        { id: 'screw-rip', sourceId: 'screw-source', targetId: 'rip', itemId: 'screw' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.rip?.machines).toBeCloseTo(10, 5);
    expect(result.nodes.rip?.inputs).toContainEqual({ itemId: 'iron-plate', ratePerMin: 300 });
    expect(result.nodes.rip?.inputs).toContainEqual({ itemId: 'screw', ratePerMin: 600 });
    expect(result.nodes.rip?.outputs).toContainEqual({ itemId: 'reinforced-plate', ratePerMin: 50 });
  });

  it('uses an input-rate driver as a supply seed', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'recipe',
          id: 'smelter',
          recipeId: 'iron-ingot',
          inputRateOverride: { itemId: 'iron-ore', ratePerMin: 45 },
        },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.smelter?.machines).toBeCloseTo(1.5, 5);
    expect(result.nodes.smelter?.inputs).toContainEqual({ itemId: 'iron-ore', ratePerMin: 45 });
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 45 });
  });

  it('computes world-wide rollups across all nodes', () => {
    const data = gameData([
      recipe({
        id: 'modular-frame',
        durationSeconds: 60,
        inputs: [
          { itemId: 'reinforced-plate', amount: 3 },
          { itemId: 'iron-rod', amount: 12 },
        ],
        outputs: [{ itemId: 'modular-frame', amount: 2 }],
      }),
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [
          { itemId: 'iron-plate', amount: 6 },
          { itemId: 'screw', amount: 12 },
        ],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
    ]);

    const g = graph({
      nodes: [
        { kind: 'source', id: 'plate-source', itemId: 'iron-plate', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'source', id: 'rod-source', itemId: 'iron-rod', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'source', id: 'screw-source', itemId: 'screw', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
        { kind: 'recipe', id: 'mf', recipeId: 'modular-frame' },
        { kind: 'sink', id: 'sink', itemId: 'modular-frame', demandPerMin: 10 },
      ],
      edges: [
        { id: 'plate-rip', sourceId: 'plate-source', targetId: 'rip', itemId: 'iron-plate' },
        { id: 'screw-rip', sourceId: 'screw-source', targetId: 'rip', itemId: 'screw' },
        { id: 'rip-mf', sourceId: 'rip', targetId: 'mf', itemId: 'reinforced-plate' },
        { id: 'rod-mf', sourceId: 'rod-source', targetId: 'mf', itemId: 'iron-rod' },
        { id: 'mf-sink', sourceId: 'mf', targetId: 'sink', itemId: 'modular-frame' },
      ],
    });

    const { result, diagnostics } = solveProductionGraph(g, data);

    expect(diagnostics).toHaveLength(0);

    // Verify assembler and constructor counts
    expect(result.nodes.mf?.machines).toBeCloseTo(5, 5);
    expect(result.nodes.rip?.machines).toBeCloseTo(3, 5);

    // Verify world rollup aggregates all nodes (recipes + sources)
    expect(result.rollups).toBeDefined();
    expect(result.rollups!.world.machines).toBeCloseTo(8, 5); // 5 (mf) + 3 (rip) + 0 (sources)
  });

  it('supports incremental recalculation and change-gating', () => {
    const data = gameData([
      recipe({
        id: 'iron-plate',
        durationSeconds: 6,
        inputs: [{ itemId: 'iron-ore', amount: 3 }],
        outputs: [{ itemId: 'iron-plate', amount: 2 }],
      }),
      recipe({
        id: 'iron-rod',
        durationSeconds: 4,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-rod', amount: 1 }],
      }),
    ]);

    // Build two unconnected chains:
    // Chain A: ore-source-a -> plate-recipe -> plate-sink
    // Chain B: ore-source-b -> rod-recipe -> rod-sink
    const g1 = graph({
      nodes: [
        { kind: 'source', id: 'ore-source-a', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'plate-recipe', recipeId: 'iron-plate', productionRateOverride: 20 },
        { kind: 'sink', id: 'plate-sink', itemId: 'iron-plate', demandPerMin: 999 },

        { kind: 'source', id: 'ore-source-b', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'rod-recipe', recipeId: 'iron-rod', productionRateOverride: 15 },
        { kind: 'sink', id: 'rod-sink', itemId: 'iron-rod', demandPerMin: 999 },
      ],
      edges: [
        { id: 'a-edge1', sourceId: 'ore-source-a', targetId: 'plate-recipe', itemId: 'iron-ore' },
        { id: 'a-edge2', sourceId: 'plate-recipe', targetId: 'plate-sink', itemId: 'iron-plate' },

        { id: 'b-edge1', sourceId: 'ore-source-b', targetId: 'rod-recipe', itemId: 'iron-ore' },
        { id: 'b-edge2', sourceId: 'rod-recipe', targetId: 'rod-sink', itemId: 'iron-rod' },
      ],
    });

    // 1. Initial full solve
    const solve1 = solveProductionGraph(g1, data);
    expect(solve1.touchedNodeIds).toHaveLength(6); // All nodes touched

    // 2. Edit plate-recipe override to 40
    const g2 = {
      ...g1,
      nodes: g1.nodes.map((n) =>
        n.id === 'plate-recipe' ? { ...n, productionRateOverride: 40 } : n
      ),
    };

    const solve2 = solveProductionGraph(g2, data, {
      previous: solve1.result,
      origin: { type: 'recipe-node', nodeId: 'plate-recipe' },
    });

    // Verifications for Chain A edited:
    // - Touched nodes should be from Chain A (plate-recipe, ore-source-a)
    expect(solve2.touchedNodeIds).toContain('plate-recipe');
    expect(solve2.touchedNodeIds).toContain('ore-source-a');
    expect(solve2.touchedNodeIds).not.toContain('plate-sink');

    // - Touched edges should be from Chain A (a-edge1, a-edge2)
    expect(solve2.touchedEdgeIds).toContain('a-edge1');
    expect(solve2.touchedEdgeIds).toContain('a-edge2');

    // - Touched nodes/edges should NOT contain anything from Chain B
    expect(solve2.touchedNodeIds).not.toContain('ore-source-b');
    expect(solve2.touchedNodeIds).not.toContain('rod-recipe');
    expect(solve2.touchedNodeIds).not.toContain('rod-sink');
    expect(solve2.touchedEdgeIds).not.toContain('b-edge1');
    expect(solve2.touchedEdgeIds).not.toContain('b-edge2');

    // - Chain B nodes should be reference-equal to solve1 results
    expect(solve2.result.nodes['ore-source-b']).toBe(solve1.result.nodes['ore-source-b']);
    expect(solve2.result.nodes['rod-recipe']).toBe(solve1.result.nodes['rod-recipe']);
    expect(solve2.result.nodes['rod-sink']).toBe(solve1.result.nodes['rod-sink']);

    // - Chain B edge allocations should be reference-equal
    expect(solve2.result.edges['b-edge1']).toBe(solve1.result.edges['b-edge1']);
    expect(solve2.result.edges['b-edge2']).toBe(solve1.result.edges['b-edge2']);

    // 3. No-op edit (set plate-recipe override to 40 again, without actual changes)
    const solve3 = solveProductionGraph(g2, data, {
      previous: solve2.result,
      origin: { type: 'recipe-node', nodeId: 'plate-recipe' },
    });

    // Verification for no-op edit:
    // - Since no rates or parameters changed, no nodes are reported as touched.
    expect(solve3.touchedNodeIds).toEqual([]);
    expect(solve3.result.nodes['ore-source-a']).toBe(solve2.result.nodes['ore-source-a']);
    expect(solve3.result.nodes['plate-sink']).toBe(solve2.result.nodes['plate-sink']);

    // 4. Compare full vs incremental: they must produce identical values
    const solveFull = solveProductionGraph(g2, data);
    expect(solve2.result.nodes['plate-recipe']).toEqual(solveFull.result.nodes['plate-recipe']);
    expect(solve2.result.nodes['ore-source-a']).toEqual(solveFull.result.nodes['ore-source-a']);
    expect(solve2.result.nodes['plate-sink']).toEqual(solveFull.result.nodes['plate-sink']);
    expect(solve2.result.edges['a-edge1']).toEqual(solveFull.result.edges['a-edge1']);
    expect(solve2.result.edges['a-edge2']).toEqual(solveFull.result.edges['a-edge2']);
  });

  it('incrementally propagates a new upstream override into an undriven downstream chain', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
      recipe({
        id: 'iron-rod',
        durationSeconds: 4,
        inputs: [{ itemId: 'iron-ingot', amount: 1 }],
        outputs: [{ itemId: 'iron-rod', amount: 1 }],
      }),
      recipe({
        id: 'screw',
        durationSeconds: 6,
        inputs: [{ itemId: 'iron-rod', amount: 1 }],
        outputs: [{ itemId: 'screw', amount: 4 }],
      }),
    ]);
    const baseGraph = graph({
      nodes: [
        { kind: 'recipe', id: 'ingots', recipeId: 'iron-ingot' },
        { kind: 'recipe', id: 'rods', recipeId: 'iron-rod' },
        { kind: 'recipe', id: 'screws', recipeId: 'screw' },
      ],
      edges: [
        { id: 'ingots-rods', sourceId: 'ingots', targetId: 'rods', itemId: 'iron-ingot' },
        { id: 'rods-screws', sourceId: 'rods', targetId: 'screws', itemId: 'iron-rod' },
      ],
    });
    const initial = solveProductionGraph(baseGraph, data);
    expect(initial.result.nodes.rods?.machines).toBe(0);
    expect(initial.result.nodes.screws?.machines).toBe(0);

    const editedGraph = {
      ...baseGraph,
      nodes: baseGraph.nodes.map((node) =>
        node.id === 'ingots' ? { ...node, machineCountOverride: 2 } : node
      ),
    };

    const incremental = solveProductionGraph(editedGraph, data, {
      previous: initial.result,
      origin: { type: 'recipe-node', nodeId: 'ingots' },
    });
    const full = solveProductionGraph(editedGraph, data);

    expect(incremental.result.nodes.ingots).toEqual(full.result.nodes.ingots);
    expect(incremental.result.nodes.rods).toEqual(full.result.nodes.rods);
    expect(incremental.result.nodes.screws).toEqual(full.result.nodes.screws);
    expect(incremental.result.nodes.rods?.machines).toBeCloseTo(4, 5);
    expect(incremental.result.nodes.screws?.machines).toBeCloseTo(6, 5);

    const removedOverride = solveProductionGraph(baseGraph, data, {
      previous: incremental.result,
      origin: { type: 'recipe-node', nodeId: 'ingots' },
    });
    const fullRemovedOverride = solveProductionGraph(baseGraph, data);

    expect(removedOverride.result.nodes.ingots).toEqual(fullRemovedOverride.result.nodes.ingots);
    expect(removedOverride.result.nodes.rods).toEqual(fullRemovedOverride.result.nodes.rods);
    expect(removedOverride.result.nodes.screws).toEqual(fullRemovedOverride.result.nodes.screws);
    expect(removedOverride.result.nodes.ingots?.machines).toBe(0);
    expect(removedOverride.result.nodes.rods?.machines).toBe(0);
    expect(removedOverride.result.nodes.screws?.machines).toBe(0);
  });

  it('incrementally supply-drives a multi-input recipe after connecting one input', () => {
    const data = gameData([
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [
          { itemId: 'iron-plate', amount: 6 },
          { itemId: 'screw', amount: 12 },
        ],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
    ]);
    const baseGraph = graph({
      nodes: [
        { kind: 'source', id: 'plate-source', itemId: 'iron-plate', sourceType: 'manual-input', maxRatePerMin: 800 },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
      ],
    });
    const initial = solveProductionGraph(baseGraph, data);
    expect(initial.result.nodes.rip?.machines).toBe(0);

    const connectedGraph = {
      ...baseGraph,
      edges: [{ id: 'plate-rip', sourceId: 'plate-source', targetId: 'rip', itemId: 'iron-plate' }],
    };

    const incremental = solveProductionGraph(connectedGraph, data, {
      previous: initial.result,
      origin: { type: 'edge', edgeId: 'plate-rip' },
    });
    const full = solveProductionGraph(connectedGraph, data);

    expect(incremental.result.nodes.rip).toEqual(full.result.nodes.rip);
    expect(incremental.result.nodes.rip?.machines).toBeCloseTo(26.666666, 5);
    expect(incremental.result.nodes.rip?.inputs).toContainEqual({ itemId: 'iron-plate', ratePerMin: 800 });
    expect(incremental.result.nodes.rip?.inputs).toContainEqual({ itemId: 'screw', ratePerMin: 1600 });
  });

  it('recalculates a divergent fork priority change to match a fresh full solve', () => {
    const data = gameData(coalForkRecipes());
    const initial = solveProductionGraph(coalForkGraph(), data);
    expect(initial.result.edges['coal-direct']?.allocation).toBeCloseTo(600, 5);
    expect(initial.result.edges['coal-compacted']?.allocation).toBeCloseTo(600, 5);

    const prioritizedGraph = coalForkGraph(['coal-compacted']);
    const incremental = solveProductionGraph(prioritizedGraph, data, {
      previous: initial.result,
      origin: { type: 'routing', nodeId: 'coal', portId: 'out' },
    });
    const full = solveProductionGraph(prioritizedGraph, data);

    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(720, 5);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(480, 5);

    const balancedIncremental = solveProductionGraph(coalForkGraph(), data, {
      previous: incremental.result,
      origin: { type: 'routing', nodeId: 'coal', portId: 'out' },
    });
    const balancedFull = solveProductionGraph(coalForkGraph(), data);

    expect(balancedIncremental.result.nodes.compacted).toEqual(balancedFull.result.nodes.compacted);
    expect(balancedIncremental.result.nodes.direct).toEqual(balancedFull.result.nodes.direct);
    expect(balancedIncremental.result.edges['coal-compacted']).toEqual(balancedFull.result.edges['coal-compacted']);
    expect(balancedIncremental.result.edges['coal-direct']).toEqual(balancedFull.result.edges['coal-direct']);
    expect(balancedIncremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(600, 5);
    expect(balancedIncremental.result.edges['coal-direct']?.allocation).toBeCloseTo(600, 5);
  });

  it('fills a prioritized coal generator branch before compacted coal in the full solve result', () => {
    const data = gameData(coalForkRecipes());
    const initial = solveProductionGraph(coalForkGraph(), data);
    const prioritizedGraph = coalForkGraph(['coal-direct']);

    const incremental = solveProductionGraph(prioritizedGraph, data, {
      previous: initial.result,
      origin: { type: 'routing', nodeId: 'coal', portId: 'out' },
    });
    const full = solveProductionGraph(prioritizedGraph, data);

    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.nodes.direct?.machines).toBeCloseTo(80, 5);
    expect(incremental.result.nodes.compacted?.machines).toBeCloseTo(0, 5);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(1200, 5);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(0, 5);
  });

  it('keeps coal fork routing unchanged when auto water is connected to the generator branch', () => {
    const data = gameData(coalForkRecipes());
    const withoutWater = solveProductionGraph(coalForkGraph(), data);
    const withWater = solveProductionGraph(coalForkGraphWithWater(), data);

    expect(withWater.result.edges['coal-direct']).toEqual(withoutWater.result.edges['coal-direct']);
    expect(withWater.result.edges['coal-compacted']).toEqual(withoutWater.result.edges['coal-compacted']);
    expect(withWater.result.nodes.direct?.machines).toBeCloseTo(withoutWater.result.nodes.direct?.machines ?? 0, 5);
    expect(withWater.result.nodes.water?.machines).toBeCloseTo(15, 5);
    expect(withWater.result.nodes.water?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 1800 });
  });

  it('keeps prioritized coal fork routing unchanged when auto water is connected', () => {
    const data = gameData(coalForkRecipes());

    for (const priority of [['coal-compacted'], ['coal-direct']]) {
      const withoutWater = solveProductionGraph(coalForkGraph(priority), data);
      const withWater = solveProductionGraph(coalForkGraphWithWater({ priority }), data);

      expect(withWater.result.edges['coal-direct']).toEqual(withoutWater.result.edges['coal-direct']);
      expect(withWater.result.edges['coal-compacted']).toEqual(withoutWater.result.edges['coal-compacted']);
    }
  });

  it('lets fixed water cap a coal generator branch when water has a machine override', () => {
    const data = gameData(coalForkRecipes());
    const result = solveProductionGraph(coalForkGraphWithWater({ priority: ['coal-direct'], waterMachines: 1 }), data).result;

    expect(result.nodes.water?.machines).toBeCloseTo(1, 5);
    expect(result.edges['coal-direct']?.allocation).toBeCloseTo(40, 5);
    expect(result.edges['coal-compacted']?.allocation).toBeCloseTo(720, 5);
    expect(result.edges['water-direct']?.allocation).toBeCloseTo(120, 5);
  });

  it('recalculates sibling fork branches when a balanced branch override caps compacted coal', () => {
    const data = gameData(coalForkRecipes());
    const initial = solveProductionGraph(coalForkGraph(), data);
    expect(initial.result.edges['coal-direct']?.allocation).toBeCloseTo(600, 5);
    expect(initial.result.edges['coal-compacted']?.allocation).toBeCloseTo(600, 5);

    const editedGraph = coalForkGraphWithOverrides({ compactedMachines: 1 });
    const incremental = solveProductionGraph(editedGraph, data, {
      previous: initial.result,
      origin: { type: 'recipe-node', nodeId: 'compacted' },
    });
    const full = solveProductionGraph(editedGraph, data);

    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).not.toBe(initial.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).not.toBe(initial.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(15, 5);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(1185, 5);
  });

  it('recalculates sibling fork branches when a balanced branch override caps coal generators', () => {
    const data = gameData(coalForkRecipes());
    const initial = solveProductionGraph(coalForkGraph(), data);

    const editedGraph = coalForkGraphWithOverrides({ directMachines: 1 });
    const incremental = solveProductionGraph(editedGraph, data, {
      previous: initial.result,
      origin: { type: 'recipe-node', nodeId: 'direct' },
    });
    const full = solveProductionGraph(editedGraph, data);

    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).not.toBe(initial.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).not.toBe(initial.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(15, 5);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(720, 5);
  });

  it('recalculates unranked siblings when a prioritized compacted branch is capped', () => {
    const data = gameData(coalForkRecipes());
    const prioritized = solveProductionGraph(coalForkGraph(['coal-compacted']), data);
    expect(prioritized.result.edges['coal-compacted']?.allocation).toBeCloseTo(720, 5);
    expect(prioritized.result.edges['coal-direct']?.allocation).toBeCloseTo(480, 5);

    const editedGraph = coalForkGraphWithOverrides({
      priority: ['coal-compacted'],
      compactedMachines: 1,
    });
    const incremental = solveProductionGraph(editedGraph, data, {
      previous: prioritized.result,
      origin: { type: 'recipe-node', nodeId: 'compacted' },
    });
    const full = solveProductionGraph(editedGraph, data);

    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).not.toBe(prioritized.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).not.toBe(prioritized.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(15, 5);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(1185, 5);
  });

  it('recalculates unranked siblings when a prioritized generator branch is capped', () => {
    const data = gameData(coalForkRecipes());
    const prioritized = solveProductionGraph(coalForkGraph(['coal-direct']), data);
    expect(prioritized.result.edges['coal-direct']?.allocation).toBeCloseTo(1200, 5);
    expect(prioritized.result.edges['coal-compacted']?.allocation).toBeCloseTo(0, 5);

    const editedGraph = coalForkGraphWithOverrides({
      priority: ['coal-direct'],
      directMachines: 1,
    });
    const incremental = solveProductionGraph(editedGraph, data, {
      previous: prioritized.result,
      origin: { type: 'recipe-node', nodeId: 'direct' },
    });
    const full = solveProductionGraph(editedGraph, data);

    expect(incremental.result.nodes.direct).toEqual(full.result.nodes.direct);
    expect(incremental.result.nodes.compacted).toEqual(full.result.nodes.compacted);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).not.toBe(prioritized.result.edges['coal-direct']);
    expect(incremental.result.edges['coal-compacted']).not.toBe(prioritized.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']?.allocation).toBeCloseTo(15, 5);
    expect(incremental.result.edges['coal-compacted']?.allocation).toBeCloseTo(720, 5);
  });

  it('treats routing changes for non-engine visual nodes as a full dirty solve', () => {
    const data = gameData(coalForkRecipes());
    const initial = solveProductionGraph(coalForkGraph(), data);
    const prioritizedGraph = coalForkGraph(['coal-compacted']);

    const incremental = solveProductionGraph(prioritizedGraph, data, {
      previous: initial.result,
      origin: { type: 'routing', nodeId: 'junction:coal:output:out', portId: 'out' },
    });
    const full = solveProductionGraph(prioritizedGraph, data);

    expect(incremental.result.edges['coal-compacted']).toEqual(full.result.edges['coal-compacted']);
    expect(incremental.result.edges['coal-direct']).toEqual(full.result.edges['coal-direct']);
  });

  it('back-calculates fractional extractor count for a demand-mode source', () => {
    const data = gameData([]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'water-source',
          itemId: 'Desc_Water_C',
          sourceType: 'water',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 120,
        },
        { kind: 'sink', id: 'water-sink', itemId: 'Desc_Water_C', demandPerMin: 300 },
      ],
      edges: [
        { id: 'water-edge', sourceId: 'water-source', targetId: 'water-sink', itemId: 'Desc_Water_C' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['water-source']?.machines).toBeCloseTo(2.5, 5);
    expect(result.nodes['water-source']?.outputs).toContainEqual({
      itemId: 'Desc_Water_C',
      ratePerMin: 300,
    });
  });

  describe('byproduct recycling integration', () => {
    it('full pipeline: byproduct water reduces resource-claim demand and adjusts edge allocations', () => {
      const data = gameData([
        recipe({
          id: 'water-producer',
          durationSeconds: 6,
          inputs: [{ itemId: 'ore', amount: 1 }],
          outputs: [
            { itemId: 'ingot', amount: 1 },
            { itemId: 'water', amount: 20 },
          ],
        }),
        recipe({
          id: 'reactor',
          durationSeconds: 6,
          inputs: [{ itemId: 'water', amount: 10 }],
          outputs: [{ itemId: 'product', amount: 1 }],
        }),
      ]);

      // wp produces 10 ingot/min + 200 water/min (1 machine)
      // reactor needs 1000 water/min (10 machines)
      // Byproduct covers 200 → water source supplies 800
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 1 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 10 },
          { kind: 'sink', id: 'product-sink', itemId: 'product', demandPerMin: 100 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
          { id: 'product-sink', sourceId: 'reactor', targetId: 'product-sink', itemId: 'product' },
        ],
      });

      const { result, diagnostics } = solveProductionGraph(g, data);

      expect(diagnostics).toHaveLength(0);

      expect(result.nodes.wp?.machines).toBeCloseTo(1, 5);
      expect(result.nodes.wp?.outputs).toContainEqual({ itemId: 'ingot', ratePerMin: 10 });
      expect(result.nodes.wp?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 200 });

      expect(result.nodes.reactor?.machines).toBeCloseTo(10, 5);
      expect(result.nodes.reactor?.inputs).toContainEqual({ itemId: 'water', ratePerMin: 1000 });
      expect(result.nodes.reactor?.outputs).toContainEqual({ itemId: 'product', ratePerMin: 100 });

      expect(result.nodes['water-source']?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 800 });

      expect(result.edges['ww-reactor']?.allocation).toBeCloseTo(200, 5);
      expect(result.edges['ww-reactor']?.demandedRate).toBeCloseTo(200, 5);

      expect(result.edges['water-reactor']?.allocation).toBeCloseTo(800, 5);
      expect(result.edges['water-reactor']?.demandedRate).toBeCloseTo(800, 5);
    });

    it('full pipeline: direct aluminum scrap water cycle reduces only external water', () => {
      const data = gameData([
        recipe({
          id: 'alumina',
          durationSeconds: 6,
          inputs: [
            { itemId: 'bauxite', amount: 12 },
            { itemId: 'water', amount: 18 },
          ],
          outputs: [
            { itemId: 'alumina-solution', amount: 12 },
            { itemId: 'silica', amount: 5 },
          ],
        }),
        recipe({
          id: 'scrap',
          durationSeconds: 6,
          inputs: [
            { itemId: 'alumina-solution', amount: 24 },
            { itemId: 'coal', amount: 12 },
          ],
          outputs: [
            { itemId: 'aluminum-scrap', amount: 36 },
            { itemId: 'water', amount: 12 },
          ],
        }),
        recipe({
          id: 'ingot',
          durationSeconds: 4,
          inputs: [
            { itemId: 'aluminum-scrap', amount: 6 },
            { itemId: 'silica', amount: 5 },
          ],
          outputs: [{ itemId: 'aluminum-ingot', amount: 4 }],
        }),
      ]);
      const nodes: ProductionGraph['nodes'] = [
        { kind: 'source', id: 'bauxite', itemId: 'bauxite', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 1200 },
        { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 120 },
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
        { kind: 'source', id: 'quartz-silica', itemId: 'silica', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'alumina', recipeId: 'alumina' },
        { kind: 'recipe', id: 'scrap', recipeId: 'scrap' },
        { kind: 'recipe', id: 'ingot', recipeId: 'ingot' },
        { kind: 'sink', id: 'sink', itemId: 'aluminum-ingot', demandPerMin: 240 },
      ];
      const edges: ProductionGraph['edges'] = [
        { id: 'bauxite-alumina', sourceId: 'bauxite', targetId: 'alumina', itemId: 'bauxite' },
        { id: 'water-alumina', sourceId: 'water-source', targetId: 'alumina', itemId: 'water' },
        { id: 'alumina-scrap', sourceId: 'alumina', targetId: 'scrap', itemId: 'alumina-solution' },
        { id: 'coal-scrap', sourceId: 'coal', targetId: 'scrap', itemId: 'coal' },
        { id: 'scrap-ingot', sourceId: 'scrap', targetId: 'ingot', itemId: 'aluminum-scrap' },
        { id: 'silica-ingot-main', sourceId: 'alumina', targetId: 'ingot', itemId: 'silica' },
        { id: 'silica-ingot-extra', sourceId: 'quartz-silica', targetId: 'ingot', itemId: 'silica' },
        { id: 'scrap-water-alumina', sourceId: 'scrap', targetId: 'alumina', itemId: 'water' },
        { id: 'ingot-sink', sourceId: 'ingot', targetId: 'sink', itemId: 'aluminum-ingot' },
      ];

      const { result, diagnostics } = solveProductionGraph(graph({ nodes, edges }), data);

      expect(diagnostics).toHaveLength(0);
      expect(result.nodes.alumina?.machines).toBeCloseTo(2, 5);
      expect(result.nodes.scrap?.machines).toBeCloseTo(1, 5);
      expect(result.nodes.ingot?.machines).toBeCloseTo(4, 5);
      expect(result.nodes['water-source']?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 240 });
      expect(result.edges['scrap-water-alumina']?.demandedRate).toBeCloseTo(120, 5);
      expect(result.edges['scrap-water-alumina']?.allocation).toBeCloseTo(120, 5);
      expect(result.edges['water-alumina']?.demandedRate).toBeCloseTo(240, 5);
      expect(result.edges['water-alumina']?.allocation).toBeCloseTo(240, 5);
    });

    it('full pipeline: same-recipe byproduct self-loop reduces only external water', () => {
      const data = gameData([
        recipe({
          id: 'water-loop-product',
          durationSeconds: 6,
          inputs: [
            { itemId: 'ore', amount: 1 },
            { itemId: 'water', amount: 10 },
          ],
          outputs: [
            { itemId: 'product', amount: 1 },
            { itemId: 'water', amount: 4 },
          ],
        }),
      ]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 120 },
          { kind: 'recipe', id: 'loop', recipeId: 'water-loop-product' },
          { kind: 'sink', id: 'sink', itemId: 'product', demandPerMin: 100 },
        ],
        edges: [
          { id: 'ore-loop', sourceId: 'ore', targetId: 'loop', itemId: 'ore' },
          { id: 'water-loop', sourceId: 'water-source', targetId: 'loop', itemId: 'water' },
          { id: 'self-water-loop', sourceId: 'loop', targetId: 'loop', itemId: 'water' },
          { id: 'product-sink', sourceId: 'loop', targetId: 'sink', itemId: 'product' },
        ],
      });

      const { result, diagnostics } = solveProductionGraph(g, data);

      expect(diagnostics).toHaveLength(0);
      expect(result.nodes.loop?.machines).toBeCloseTo(10, 5);
      expect(result.nodes.loop?.inputs).toContainEqual({ itemId: 'water', ratePerMin: 1000 });
      expect(result.nodes.loop?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 400 });
      expect(result.nodes['water-source']?.outputs).toContainEqual({ itemId: 'water', ratePerMin: 600 });
      expect(result.edges['self-water-loop']?.allocation).toBeCloseTo(400, 5);
      expect(result.edges['water-loop']?.allocation).toBeCloseTo(600, 5);
    });
  });

  it('uses a fixed machine-count override on a source and bottlenecks downstream', () => {
    const data = gameData([]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'water-source',
          itemId: 'Desc_Water_C',
          sourceType: 'water',
          maxRatePerMin: 240,
          perExtractorRatePerMin: 120,
          machineCountOverride: 2,
        },
        { kind: 'sink', id: 'water-sink', itemId: 'Desc_Water_C', demandPerMin: 300 },
      ],
      edges: [
        { id: 'water-edge', sourceId: 'water-source', targetId: 'water-sink', itemId: 'Desc_Water_C' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['water-source']?.machines).toBeCloseTo(2, 5);
    expect(result.nodes['water-source']?.outputs).toContainEqual({
      itemId: 'Desc_Water_C',
      ratePerMin: 240,
    });
    expect(result.edges['water-edge']?.deficitRate).toBeCloseTo(60, 5);
  });

  it('scales a demand-mode source down when a fixed sibling source bottlenecks the component', () => {
    const data = gameData([
      recipe({
        id: 'steel-ingot',
        durationSeconds: 4,
        inputs: [
          { itemId: 'iron-ore', amount: 1 },
          { itemId: 'coal', amount: 1 },
        ],
        outputs: [{ itemId: 'steel-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'ore-source',
          itemId: 'iron-ore',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 60,
        },
        {
          kind: 'source',
          id: 'coal-source',
          itemId: 'coal',
          sourceType: 'resource-claim',
          maxRatePerMin: 60,
          perExtractorRatePerMin: 60,
          machineCountOverride: 1,
        },
        { kind: 'recipe', id: 'foundry', recipeId: 'steel-ingot' },
        { kind: 'sink', id: 'steel-sink', itemId: 'steel-ingot', demandPerMin: 120 },
      ],
      edges: [
        { id: 'ore-foundry', sourceId: 'ore-source', targetId: 'foundry', itemId: 'iron-ore' },
        { id: 'coal-foundry', sourceId: 'coal-source', targetId: 'foundry', itemId: 'coal' },
        { id: 'steel-edge', sourceId: 'foundry', targetId: 'steel-sink', itemId: 'steel-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // Fixed coal caps the component at 60/min, so the demand-mode ore source
    // only delivers 60/min and reports one extractor.
    expect(result.nodes['coal-source']?.machines).toBeCloseTo(1, 5);
    expect(result.nodes['ore-source']?.machines).toBeCloseTo(1, 5);
    expect(result.nodes['ore-source']?.outputs).toContainEqual({
      itemId: 'iron-ore',
      ratePerMin: 60,
    });
  });

  describe('Phase 4: byproduct-first priority, routing override priority, overflow, and diagnostics', () => {
    it('uses byproduct-first merge policy by default', () => {
      const data = gameData([
        recipe({
          id: 'byproduct-maker',
          durationSeconds: 6,
          inputs: [{ itemId: 'ore', amount: 1 }],
          outputs: [{ itemId: 'ingot', amount: 1 }, { itemId: 'water', amount: 4 }],
        }),
        recipe({
          id: 'water-consumer',
          durationSeconds: 6,
          inputs: [{ itemId: 'water', amount: 10 }],
          outputs: [{ itemId: 'product', amount: 1 }],
        }),
      ]);

      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 100 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 100 },
          { kind: 'recipe', id: 'maker', recipeId: 'byproduct-maker', machineCountOverride: 1 },
          { kind: 'recipe', id: 'consumer', recipeId: 'water-consumer', machineCountOverride: 1 },
          { kind: 'sink', id: 'product-sink', itemId: 'product', demandPerMin: 10 },
        ],
        edges: [
          { id: 'ore-edge', sourceId: 'ore-source', targetId: 'maker', itemId: 'ore' },
          { id: 'byproduct-edge', sourceId: 'maker', targetId: 'consumer', itemId: 'water' },
          { id: 'fresh-edge', sourceId: 'water-source', targetId: 'consumer', itemId: 'water' },
          { id: 'product-edge', sourceId: 'consumer', targetId: 'product-sink', itemId: 'product' },
        ],
      });

      const { result } = solveProductionGraph(g, data);

      // maker outputs 10 ingot/min + 40 water/min
      // consumer needs 100 water/min
      // By default, byproduct-first priority satisfies 40 from maker, 60 from water-source
      expect(result.edges['byproduct-edge']?.allocation).toBeCloseTo(40, 5);
      expect(result.edges['fresh-edge']?.allocation).toBeCloseTo(60, 5);
      expect(result.nodes['water-source']?.outputs[0]?.ratePerMin).toBeCloseTo(60, 5);
    });

    it('allows routing priority override to interleave byproduct and fresh', () => {
      const data = gameData([
        recipe({
          id: 'byproduct-maker',
          durationSeconds: 6,
          inputs: [{ itemId: 'ore', amount: 1 }],
          outputs: [{ itemId: 'ingot', amount: 1 }, { itemId: 'water', amount: 4 }],
        }),
        recipe({
          id: 'water-consumer',
          durationSeconds: 6,
          inputs: [{ itemId: 'water', amount: 10 }],
          outputs: [{ itemId: 'product', amount: 1 }],
        }),
      ]);

      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 100 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 100 },
          { kind: 'recipe', id: 'maker', recipeId: 'byproduct-maker', machineCountOverride: 1 },
          { kind: 'recipe', id: 'consumer', recipeId: 'water-consumer', machineCountOverride: 1 },
          { kind: 'sink', id: 'product-sink', itemId: 'product', demandPerMin: 10 },
        ],
        edges: [
          { id: 'ore-edge', sourceId: 'ore-source', targetId: 'maker', itemId: 'ore' },
          {
            id: 'byproduct-edge',
            sourceId: 'maker',
            targetId: 'consumer',
            itemId: 'water',
            routing: { portSide: 'input', portId: 'water-in', priority: ['fresh-edge', 'byproduct-edge'] },
          },
          {
            id: 'fresh-edge',
            sourceId: 'water-source',
            targetId: 'consumer',
            itemId: 'water',
            routing: { portSide: 'input', portId: 'water-in', priority: ['fresh-edge', 'byproduct-edge'] },
          },
          { id: 'product-edge', sourceId: 'consumer', targetId: 'product-sink', itemId: 'product' },
        ],
      });

      const { result } = solveProductionGraph(g, data);

      // fresh-edge is higher priority than byproduct-edge, so fresh-edge supplies full 100/min first.
      expect(result.edges['fresh-edge']?.allocation).toBeCloseTo(100, 5);
      expect(result.edges['byproduct-edge']?.allocation).toBeCloseTo(0, 5);
    });

    it('routes excess supply to overflow edge last', () => {
      const data = gameData([
        recipe({
          id: 'water-producer',
          durationSeconds: 6,
          inputs: [{ itemId: 'ore', amount: 1 }],
          outputs: [{ itemId: 'water', amount: 10 }],
        }),
        recipe({
          id: 'water-consumer',
          durationSeconds: 6,
          inputs: [{ itemId: 'water', amount: 4 }],
          outputs: [{ itemId: 'product', amount: 1 }],
        }),
      ]);

      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 10 },
          { kind: 'recipe', id: 'maker', recipeId: 'water-producer', machineCountOverride: 1 },
          { kind: 'recipe', id: 'consumer', recipeId: 'water-consumer', machineCountOverride: 1 },
          { kind: 'sink', id: 'product-sink', itemId: 'product', demandPerMin: 10 },
          { kind: 'sink', id: 'overflow-sink', itemId: 'water' },
        ],
        edges: [
          { id: 'ore-edge', sourceId: 'ore-source', targetId: 'maker', itemId: 'ore' },
          { id: 'regular-edge', sourceId: 'maker', targetId: 'consumer', itemId: 'water' },
          { id: 'overflow-edge', sourceId: 'maker', targetId: 'overflow-sink', itemId: 'water', routing: { portSide: 'output', portId: 'water-out', priority: [], overflow: true } },
          { id: 'product-edge', sourceId: 'consumer', targetId: 'product-sink', itemId: 'product' },
        ],
      });

      const { result } = solveProductionGraph(g, data);

      // maker outputs 100 water/min.
      // consumer takes 40 water/min.
      // remaining 60 water/min is absorbed by the overflow-edge.
      expect(result.edges['regular-edge']?.allocation).toBeCloseTo(40, 5);
      expect(result.edges['overflow-edge']?.allocation).toBeCloseTo(60, 5);
    });

    it('emits unconnected-input and unresolved-byproduct diagnostics', () => {
      const data = gameData([
        recipe({
          id: 'problematic-recipe',
          durationSeconds: 6,
          inputs: [{ itemId: 'required-input', amount: 1 }],
          outputs: [{ itemId: 'product', amount: 1 }, { itemId: 'byproduct', amount: 1 }],
        }),
      ]);

      const g = graph({
        nodes: [
          { kind: 'recipe', id: 'recipe-node', recipeId: 'problematic-recipe', machineCountOverride: 1 },
          { kind: 'sink', id: 'product-sink', itemId: 'product', demandPerMin: 10 },
        ],
        edges: [
          { id: 'product-edge', sourceId: 'recipe-node', targetId: 'product-sink', itemId: 'product' },
        ],
      });

      const { diagnostics } = solveProductionGraph(g, data);

      expect(diagnostics).toContainEqual(expect.objectContaining({
        code: 'unconnected-input',
        severity: 'warning',
        scope: expect.objectContaining({ nodeId: 'recipe-node', itemId: 'required-input' }),
      }));

      expect(diagnostics).toContainEqual(expect.objectContaining({
        code: 'unresolved-byproduct',
        severity: 'warning',
        scope: expect.objectContaining({ nodeId: 'recipe-node', itemId: 'byproduct' }),
      }));
    });
  });
});

describe('maximizeOutput', () => {
  function ingotData() {
    return gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
  }

  it('keeps a maximized recipe at full supply when downstream demand is lower', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot', maximizeOutput: true },
        { kind: 'sink', id: 'sink', itemId: 'iron-ingot', demandPerMin: 20 },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'smelter-sink', sourceId: 'smelter', targetId: 'sink', itemId: 'iron-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, ingotData());

    expect(result.nodes.smelter?.machines).toBeCloseTo(2, 5);
    expect(result.nodes.smelter?.scale).toBe(1);
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 60 });
    expect(result.nodes.smelter?.inputs).toContainEqual({ itemId: 'iron-ore', ratePerMin: 60 });
  });

  it('scales the same recipe down to demand without the flag (control)', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
        { kind: 'sink', id: 'sink', itemId: 'iron-ingot', demandPerMin: 20 },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'smelter-sink', sourceId: 'smelter', targetId: 'sink', itemId: 'iron-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, ingotData());

    expect(result.nodes.smelter?.machines).toBeCloseTo(2 / 3, 5);
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 20 });
  });

  it('sizes intermediate recipes upstream of a maximized node to full supply', () => {
    const data = gameData([
      recipe({
        id: 'iron-ingot',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
      recipe({
        id: 'iron-rod',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ingot', amount: 1 }],
        outputs: [{ itemId: 'iron-rod', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
        { kind: 'recipe', id: 'rod-maker', recipeId: 'iron-rod', maximizeOutput: true },
        { kind: 'sink', id: 'sink', itemId: 'iron-rod', demandPerMin: 10 },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'smelter-rods', sourceId: 'smelter', targetId: 'rod-maker', itemId: 'iron-ingot' },
        { id: 'rods-sink', sourceId: 'rod-maker', targetId: 'sink', itemId: 'iron-rod' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['rod-maker']?.machines).toBeCloseTo(2, 5);
    expect(result.nodes['rod-maker']?.outputs).toContainEqual({ itemId: 'iron-rod', ratePerMin: 60 });
    expect(result.nodes.smelter?.machines).toBeCloseTo(2, 5);
    expect(result.nodes.smelter?.scale).toBe(1);
  });

  it('sizes a single-input downstream recipe from aggregate maximized fan-in supply', () => {
    const data = gameData([
      recipe({
        id: 'cell-maker',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'cell', amount: 20 }],
      }),
      recipe({
        id: 'fuel-rod',
        durationSeconds: 60,
        inputs: [
          { itemId: 'cell', amount: 20 },
          { itemId: 'control', amount: 1 },
        ],
        outputs: [{ itemId: 'rod', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-a', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 15 },
        { kind: 'source', id: 'ore-b', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 22.5 },
        { kind: 'recipe', id: 'cell-a', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'cell-b', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-rod' },
      ],
      edges: [
        { id: 'ore-a-cell-a', sourceId: 'ore-a', targetId: 'cell-a', itemId: 'ore' },
        { id: 'ore-b-cell-b', sourceId: 'ore-b', targetId: 'cell-b', itemId: 'ore' },
        { id: 'link-a', sourceId: 'cell-a', targetId: 'fuel', itemId: 'cell' },
        { id: 'link-b', sourceId: 'cell-b', targetId: 'fuel', itemId: 'cell' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['cell-a']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 300 });
    expect(result.nodes['cell-b']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 450 });
    expect(result.nodes.fuel?.machines).toBeCloseTo(37.5, 5);
    expect(result.nodes.fuel?.scale).toBe(1);
    expect(result.nodes.fuel?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 750 });
    expect(result.edges['link-a']?.demandedRate).toBeCloseTo(300, 5);
    expect(result.edges['link-a']?.allocation).toBeCloseTo(300, 5);
    expect(result.edges['link-b']?.demandedRate).toBeCloseTo(450, 5);
    expect(result.edges['link-b']?.allocation).toBeCloseTo(450, 5);
  });

  it('still lets another connected input bottleneck aggregate fan-in supply', () => {
    const data = gameData([
      recipe({
        id: 'cell-maker',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'cell', amount: 20 }],
      }),
      recipe({
        id: 'fuel-rod',
        durationSeconds: 60,
        inputs: [
          { itemId: 'cell', amount: 20 },
          { itemId: 'control', amount: 1 },
        ],
        outputs: [{ itemId: 'rod', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-a', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 15 },
        { kind: 'source', id: 'ore-b', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 22.5 },
        { kind: 'source', id: 'control-source', itemId: 'control', sourceType: 'manual-input', maxRatePerMin: 10 },
        { kind: 'recipe', id: 'cell-a', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'cell-b', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-rod' },
      ],
      edges: [
        { id: 'ore-a-cell-a', sourceId: 'ore-a', targetId: 'cell-a', itemId: 'ore' },
        { id: 'ore-b-cell-b', sourceId: 'ore-b', targetId: 'cell-b', itemId: 'ore' },
        { id: 'link-a', sourceId: 'cell-a', targetId: 'fuel', itemId: 'cell' },
        { id: 'link-b', sourceId: 'cell-b', targetId: 'fuel', itemId: 'cell' },
        { id: 'control-fuel', sourceId: 'control-source', targetId: 'fuel', itemId: 'control' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes.fuel?.machines).toBeCloseTo(10, 5);
    expect(result.nodes.fuel?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 200 });
    expect(result.nodes.fuel?.inputs).toContainEqual({ itemId: 'control', ratePerMin: 10 });
    expect(result.nodes['cell-a']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 300 });
    expect(result.nodes['cell-b']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 450 });
  });

  function uraniumChainData() {
    return gameData([
      recipe({
        id: 'cell-maker',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'cell', amount: 20 }],
      }),
      recipe({
        id: 'fuel-rod',
        durationSeconds: 60,
        inputs: [{ itemId: 'cell', amount: 20 }],
        outputs: [{ itemId: 'rod', amount: 1 }],
      }),
      recipe({
        id: 'uranium-plant',
        durationSeconds: 60,
        inputs: [{ itemId: 'rod', amount: 1 }],
        outputs: [],
        product: null,
      }),
    ]);
  }

  function uraniumFanInGraph(
    oreRates: [number, number, number, number],
    opts: { rodMachineOverride?: number; demandModeClaims?: string[] } = {}
  ): ProductionGraph {
    const suffixes = ['a', 'b', 'c', 'd'] as const;
    const nodes: ProductionGraph['nodes'] = [];
    const edges: NonNullable<ProductionGraph['edges']>[number][] = [];

    suffixes.forEach((suffix, index) => {
      const oreId = `ore-${suffix}`;
      if (opts.demandModeClaims?.includes(oreId)) {
        nodes.push({
          kind: 'source',
          id: oreId,
          itemId: 'ore',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 60,
        });
      } else {
        nodes.push({
          kind: 'source',
          id: oreId,
          itemId: 'ore',
          sourceType: 'manual-input',
          maxRatePerMin: oreRates[index]!,
        });
      }
      nodes.push({ kind: 'recipe', id: `cell-${suffix}`, recipeId: 'cell-maker', maximizeOutput: true });
      edges.push({ id: `ore-${suffix}-cell`, sourceId: oreId, targetId: `cell-${suffix}`, itemId: 'ore' });
      edges.push({ id: `link-${suffix}`, sourceId: `cell-${suffix}`, targetId: 'rod', itemId: 'cell' });
    });

    nodes.push({
      kind: 'recipe',
      id: 'rod',
      recipeId: 'fuel-rod',
      ...(opts.rodMachineOverride != null ? { machineCountOverride: opts.rodMachineOverride } : {}),
    });
    nodes.push({ kind: 'recipe', id: 'gen', recipeId: 'uranium-plant' });
    edges.push({ id: 'rod-gen', sourceId: 'rod', targetId: 'gen', itemId: 'rod' });

    return graph({ nodes, edges });
  }

  it('drains four asymmetric maximized suppliers fully through an intermediate into a generator', () => {
    const g = uraniumFanInGraph([7.5, 7.5, 10, 10]);

    const { result } = solveProductionGraph(g, uraniumChainData());

    expect(result.nodes.rod?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 700 });
    expect(result.nodes.rod?.machines).toBeCloseTo(35, 5);
    expect(result.nodes.rod?.scale).toBe(1);
    expect(result.nodes.gen?.machines).toBeCloseTo(35, 5);
    expect(result.edges['link-a']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-b']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-c']?.allocation).toBeCloseTo(200, 5);
    expect(result.edges['link-d']?.allocation).toBeCloseTo(200, 5);
    expect(result.edges['link-c']?.demandedRate).toBeCloseTo(200, 5);
    expect(result.edges['link-d']?.demandedRate).toBeCloseTo(200, 5);
  });

  it('re-drains a strengthened supplier on an incremental re-solve instead of sticking at the old split', () => {
    const data = uraniumChainData();
    const first = solveProductionGraph(uraniumFanInGraph([7.5, 7.5, 7.5, 7.5]), data);
    expect(first.result.nodes.rod?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 600 });

    const bumped = uraniumFanInGraph([7.5, 7.5, 10, 7.5]);
    const { result } = solveProductionGraph(bumped, data, {
      previous: first.result,
      origin: { type: 'source', nodeId: 'ore-c' },
    });

    expect(result.nodes.rod?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 650 });
    expect(result.edges['link-a']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-b']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-c']?.allocation).toBeCloseTo(200, 5);
    expect(result.edges['link-d']?.allocation).toBeCloseTo(150, 5);
  });

  it('honors known supplier ceilings when one fan-in branch cannot seed', () => {
    const g = uraniumFanInGraph([7.5, 7.5, 10, 0], { demandModeClaims: ['ore-d'] });

    const { result } = solveProductionGraph(g, uraniumChainData());

    expect(result.nodes.rod?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 500 });
    expect(result.edges['link-a']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-b']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-c']?.allocation).toBeCloseTo(200, 5);
    expect(result.edges['link-d']?.allocation ?? 0).toBeCloseTo(0, 5);
    expect(result.nodes['cell-d']?.machines ?? 0).toBeCloseTo(0, 5);
  });

  it('keeps maximized suppliers at full output when the consumer is capped, exposing per-supplier surplus', () => {
    const g = uraniumFanInGraph([7.5, 7.5, 10, 10], { rodMachineOverride: 30 });

    const { result } = solveProductionGraph(g, uraniumChainData());

    expect(result.nodes.rod?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 600 });
    expect(result.edges['link-a']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-b']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-c']?.allocation).toBeCloseTo(150, 5);
    expect(result.edges['link-d']?.allocation).toBeCloseTo(150, 5);
    expect(result.nodes['cell-c']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 200 });
    expect(result.nodes['cell-d']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 200 });
  });

  it('seeds through a second input fed by an elastic demand-mode claim', () => {
    const data = gameData([
      recipe({
        id: 'acid-cell',
        durationSeconds: 60,
        inputs: [
          { itemId: 'ore', amount: 1 },
          { itemId: 'acid', amount: 2 },
        ],
        outputs: [{ itemId: 'cell', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        {
          kind: 'source',
          id: 'acid-claim',
          itemId: 'acid',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 60,
        },
        { kind: 'recipe', id: 'maker', recipeId: 'acid-cell', maximizeOutput: true },
      ],
      edges: [
        { id: 'ore-maker', sourceId: 'ore-source', targetId: 'maker', itemId: 'ore' },
        { id: 'acid-maker', sourceId: 'acid-claim', targetId: 'maker', itemId: 'acid' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // The elastic claim sizes to demand, so the ore supply drives sizing.
    expect(result.nodes.maker?.machines).toBeCloseTo(60, 5);
    expect(result.nodes.maker?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 60 });
    expect(result.nodes.maker?.inputs).toContainEqual({ itemId: 'acid', ratePerMin: 120 });
  });

  it('treats a seedable-but-empty second input as a genuine bottleneck', () => {
    const data = gameData([
      recipe({
        id: 'acid-cell',
        durationSeconds: 60,
        inputs: [
          { itemId: 'ore', amount: 1 },
          { itemId: 'acid', amount: 2 },
        ],
        outputs: [{ itemId: 'cell', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'source', id: 'acid-source', itemId: 'acid', sourceType: 'manual-input', maxRatePerMin: 0 },
        { kind: 'recipe', id: 'maker', recipeId: 'acid-cell', maximizeOutput: true },
      ],
      edges: [
        { id: 'ore-maker', sourceId: 'ore-source', targetId: 'maker', itemId: 'ore' },
        { id: 'acid-maker', sourceId: 'acid-source', targetId: 'maker', itemId: 'acid' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // A fixed supply of zero on a connected input must zero the seeded chain,
    // not let the ore branch size the node as if acid were available.
    expect(result.nodes.maker?.machines ?? 0).toBeCloseTo(0, 5);
  });

  it('falls back to demand-driven sizing when upstream supply cannot seed', () => {
    // Demand-mode resource claims (no machine override) never seed supply, so
    // the flag must not change behavior: the node sizes to demand, not zero.
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-claim', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 600 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot', maximizeOutput: true },
        { kind: 'sink', id: 'sink', itemId: 'iron-ingot', demandPerMin: 20 },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-claim', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'smelter-sink', sourceId: 'smelter', targetId: 'sink', itemId: 'iron-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, ingotData());

    expect(result.nodes.smelter?.machines).toBeCloseTo(2 / 3, 5);
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 20 });
  });

  it('lets an explicit machineCountOverride win over maximizeOutput', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'iron-ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot', maximizeOutput: true, machineCountOverride: 1 },
        { kind: 'sink', id: 'sink', itemId: 'iron-ingot', demandPerMin: 20 },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'iron-ore' },
        { id: 'smelter-sink', sourceId: 'smelter', targetId: 'sink', itemId: 'iron-ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, ingotData());

    expect(result.nodes.smelter?.machines).toBeCloseTo(1, 5);
    expect(result.nodes.smelter?.outputs).toContainEqual({ itemId: 'iron-ingot', ratePerMin: 30 });
  });

  it('keeps a supply-bound maximized chain immune while a starved sibling in the same component scales', () => {
    const data = gameData([
      recipe({
        id: 'x-maker',
        durationSeconds: 2,
        inputs: [{ itemId: 'ore-a', amount: 1 }],
        outputs: [{ itemId: 'item-x', amount: 1 }],
      }),
      recipe({
        id: 'y-maker',
        durationSeconds: 2,
        inputs: [
          { itemId: 'item-x', amount: 1 },
          { itemId: 'ore-b', amount: 1 },
        ],
        outputs: [{ itemId: 'item-y', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'src-a', itemId: 'ore-a', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'source', id: 'src-b', itemId: 'ore-b', sourceType: 'manual-input', maxRatePerMin: 30 },
        { kind: 'recipe', id: 'maximized', recipeId: 'x-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'starved', recipeId: 'y-maker' },
        { kind: 'sink', id: 'sink', itemId: 'item-y', demandPerMin: 60 },
      ],
      edges: [
        { id: 'a-max', sourceId: 'src-a', targetId: 'maximized', itemId: 'ore-a' },
        { id: 'x-starved', sourceId: 'maximized', targetId: 'starved', itemId: 'item-x' },
        { id: 'b-starved', sourceId: 'src-b', targetId: 'starved', itemId: 'ore-b' },
        { id: 'y-sink', sourceId: 'starved', targetId: 'sink', itemId: 'item-y' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // ore-b limits the sibling to half its demand, but the maximized chain
    // keeps producing everything ore-a supplies.
    expect(result.nodes.starved?.scale).toBeCloseTo(0.5, 5);
    expect(result.nodes.starved?.machines).toBeCloseTo(1, 5);
    expect(result.nodes.maximized?.scale).toBe(1);
    expect(result.nodes.maximized?.machines).toBeCloseTo(2, 5);
  });
});

describe('autoPrioritizeContestedForks', () => {
  function contestedForkData() {
    return gameData([
      recipe({
        id: 'make-shallow',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'shallow-item', amount: 1 }],
      }),
      recipe({
        id: 'make-mid',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'mid-item', amount: 1 }],
      }),
      recipe({
        id: 'make-deep',
        durationSeconds: 60,
        inputs: [{ itemId: 'mid-item', amount: 1 }],
        outputs: [{ itemId: 'deep-item', amount: 1 }],
      }),
    ]);
  }

  function contestedForkGraph(priority: string[] = []): ProductionGraph {
    const routing = priority.length > 0
      ? { portSide: 'output' as const, portId: 'out', priority }
      : undefined;
    return graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'shallow', recipeId: 'make-shallow' },
        { kind: 'recipe', id: 'mid', recipeId: 'make-mid' },
        { kind: 'recipe', id: 'deep', recipeId: 'make-deep' },
      ],
      edges: [
        { id: 'ore-shallow', sourceId: 'ore-source', targetId: 'shallow', itemId: 'ore', ...(routing ? { routing } : {}) },
        { id: 'ore-mid', sourceId: 'ore-source', targetId: 'mid', itemId: 'ore', ...(routing ? { routing } : {}) },
        { id: 'mid-deep', sourceId: 'mid', targetId: 'deep', itemId: 'mid-item' },
      ],
    });
  }

  it('splits a contested fork evenly by default (flag off)', () => {
    const { result } = solveProductionGraph(contestedForkGraph(), contestedForkData());

    expect(result.nodes.shallow?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 30 });
    expect(result.nodes.deep?.inputs).toContainEqual({ itemId: 'mid-item', ratePerMin: 30 });
  });

  it('gives the deeper product chain the contested input when enabled', () => {
    const { result } = solveProductionGraph(contestedForkGraph(), contestedForkData(), {
      autoPrioritizeContestedForks: true,
    });

    expect(result.nodes.mid?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 60 });
    expect(result.nodes.deep?.inputs).toContainEqual({ itemId: 'mid-item', ratePerMin: 60 });
    expect(result.nodes.shallow?.machines ?? 0).toBeCloseTo(0, 5);
    expect(result.edges['ore-mid']?.allocation).toBeCloseTo(60, 5);
    expect(result.edges['ore-shallow']?.allocation ?? 0).toBeCloseTo(0, 5);
  });

  it('lets a manual routing priority override the automatic ranking', () => {
    const { result } = solveProductionGraph(contestedForkGraph(['ore-shallow', 'ore-mid']), contestedForkData(), {
      autoPrioritizeContestedForks: true,
    });

    expect(result.nodes.shallow?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 60 });
    expect(result.nodes.mid?.machines ?? 0).toBeCloseTo(0, 5);
  });
});

describe('machineCountOverride priority over maximizeOutput', () => {
  // ingot fork: beam chain (overridden) competes with pipe chain feeding a
  // maximized frame recipe. All recipes run 30 items/min per machine.
  function frameData() {
    return gameData([
      recipe({
        id: 'beam',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'beam', amount: 1 }],
      }),
      recipe({
        id: 'pipe',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'pipe', amount: 1 }],
      }),
      recipe({
        id: 'frame',
        durationSeconds: 2,
        inputs: [
          { itemId: 'beam', amount: 1 },
          { itemId: 'pipe', amount: 1 },
        ],
        outputs: [{ itemId: 'frame', amount: 1 }],
      }),
      recipe({
        id: 'rod',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'rod', amount: 1 }],
      }),
      recipe({
        id: 'beam-from-rod',
        durationSeconds: 2,
        inputs: [{ itemId: 'rod', amount: 1 }],
        outputs: [{ itemId: 'beam', amount: 1 }],
      }),
    ]);
  }

  function expectNoDeficits(result: { edges: Record<string, { deficitRate: number }> }) {
    for (const [edgeId, edge] of Object.entries(result.edges)) {
      expect(edge.deficitRate, `edge ${edgeId} should have no deficit`).toBeLessThan(1e-4);
    }
  }

  it('reserves shared supply for the override before sizing the maximized node', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam', machineCountOverride: 3 },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe' },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame', maximizeOutput: true },
        { kind: 'sink', id: 'frame-sink', itemId: 'frame' },
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-frame', sourceId: 'beam-maker', targetId: 'frame-maker', itemId: 'beam' },
        { id: 'pipe-frame', sourceId: 'pipe-maker', targetId: 'frame-maker', itemId: 'pipe' },
        { id: 'frame-sink-edge', sourceId: 'frame-maker', targetId: 'frame-sink', itemId: 'frame' },
      ],
    });

    const { result } = solveProductionGraph(g, frameData());

    // Override chain runs at exactly the requested size with full inputs.
    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(3, 5);
    expect(result.nodes['beam-maker']?.scale).toBe(1);
    expect(result.nodes['beam-maker']?.inputs).toContainEqual({ itemId: 'ingot', ratePerMin: 90 });
    expect(result.edges['ingot-beam']?.allocation).toBeCloseTo(90, 4);

    // The maximized frame chain absorbs the shortfall: only 30 ingots remain
    // for pipes, so the frame recipe sizes to 1 machine instead of over-demanding.
    expect(result.nodes['pipe-maker']?.machines).toBeCloseTo(1, 4);
    expect(result.nodes['frame-maker']?.machines).toBeCloseTo(1, 4);
    expect(result.nodes['frame-maker']?.scale).toBe(1);

    expectNoDeficits(result);
  });

  it('reserves through multi-hop chains between the fork and the override', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'rod-maker', recipeId: 'rod' },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam-from-rod', machineCountOverride: 3 },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe' },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame', maximizeOutput: true },
        { kind: 'sink', id: 'frame-sink', itemId: 'frame' },
      ],
      edges: [
        { id: 'ingot-rod', sourceId: 'ingot-source', targetId: 'rod-maker', itemId: 'ingot' },
        { id: 'rod-beam', sourceId: 'rod-maker', targetId: 'beam-maker', itemId: 'rod' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-frame', sourceId: 'beam-maker', targetId: 'frame-maker', itemId: 'beam' },
        { id: 'pipe-frame', sourceId: 'pipe-maker', targetId: 'frame-maker', itemId: 'pipe' },
        { id: 'frame-sink-edge', sourceId: 'frame-maker', targetId: 'frame-sink', itemId: 'frame' },
      ],
    });

    const { result } = solveProductionGraph(g, frameData());

    // The fixed plan propagates the override's rod demand up to the ingot fork.
    expect(result.nodes['rod-maker']?.machines).toBeCloseTo(3, 4);
    expect(result.edges['ingot-rod']?.allocation).toBeCloseTo(90, 4);
    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(3, 5);
    expect(result.nodes['pipe-maker']?.machines).toBeCloseTo(1, 4);
    expect(result.nodes['frame-maker']?.machines).toBeCloseTo(1, 4);

    expectNoDeficits(result);
  });

  it('shares the remainder between multiple maximized consumers without deficits', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam', machineCountOverride: 2 },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe', maximizeOutput: true },
        { kind: 'recipe', id: 'rod-maker', recipeId: 'rod', maximizeOutput: true },
        { kind: 'sink', id: 'pipe-sink', itemId: 'pipe' },
        { kind: 'sink', id: 'rod-sink', itemId: 'rod' },
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'ingot-rod', sourceId: 'ingot-source', targetId: 'rod-maker', itemId: 'ingot' },
        { id: 'pipe-sink-edge', sourceId: 'pipe-maker', targetId: 'pipe-sink', itemId: 'pipe' },
        { id: 'rod-sink-edge', sourceId: 'rod-maker', targetId: 'rod-sink', itemId: 'rod' },
      ],
    });

    const { result } = solveProductionGraph(g, frameData());

    // Override gets its 60 ingots; the two maximized consumers share the rest.
    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(2, 5);
    expect(result.edges['ingot-beam']?.allocation).toBeCloseTo(60, 4);

    const pipeIngots = result.edges['ingot-pipe']?.allocation ?? 0;
    const rodIngots = result.edges['ingot-rod']?.allocation ?? 0;
    expect(pipeIngots).toBeGreaterThan(1e-4);
    expect(rodIngots).toBeGreaterThan(1e-4);
    expect(pipeIngots + rodIngots).toBeCloseTo(60, 4);

    expectNoDeficits(result);
  });

  it('fully feeds the override branch on a divergent fork to different sinks', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam', machineCountOverride: 3 },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe', maximizeOutput: true },
        { kind: 'sink', id: 'beam-sink', itemId: 'beam' },
        { kind: 'sink', id: 'pipe-sink', itemId: 'pipe' },
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-sink-edge', sourceId: 'beam-maker', targetId: 'beam-sink', itemId: 'beam' },
        { id: 'pipe-sink-edge', sourceId: 'pipe-maker', targetId: 'pipe-sink', itemId: 'pipe' },
      ],
    });

    const { result } = solveProductionGraph(g, frameData());

    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(3, 5);
    expect(result.edges['ingot-beam']?.allocation).toBeCloseTo(90, 4);
    expect(result.edges['ingot-pipe']?.allocation).toBeCloseTo(30, 4);
    expect(result.nodes['pipe-maker']?.machines).toBeCloseTo(1, 4);

    expectNoDeficits(result);
  });

  it('reserves a depot sink demand so a downstream maximize consumer compensates down', () => {
    // HMF-shaped: claim-bounded ingots fork into an EIB-like chain and a pipe
    // chain; both feed a maximized frame recipe. An authored depot sink (+X)
    // on the EIB output is fixed demand: it must be satisfied exactly and the
    // maximize consumer must shrink instead of absorbing the extra beams.
    const buildGraph = (depotRate: number | null) => graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam' },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe' },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame', maximizeOutput: true },
        { kind: 'sink', id: 'frame-sink', itemId: 'frame' },
        ...(depotRate != null
          ? [{ kind: 'sink' as const, id: 'depot-sink:beam-maker:beam', itemId: 'beam', demandPerMin: depotRate }]
          : []),
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-frame', sourceId: 'beam-maker', targetId: 'frame-maker', itemId: 'beam' },
        { id: 'pipe-frame', sourceId: 'pipe-maker', targetId: 'frame-maker', itemId: 'pipe' },
        { id: 'frame-sink-edge', sourceId: 'frame-maker', targetId: 'frame-sink', itemId: 'frame' },
        ...(depotRate != null
          ? [{ id: 'depot-edge:beam-maker:beam', sourceId: 'beam-maker', targetId: 'depot-sink:beam-maker:beam', itemId: 'beam' }]
          : []),
      ],
    });

    const baseline = solveProductionGraph(buildGraph(null), frameData()).result;
    const baselineFrames = baseline.nodes['frame-maker']?.machines ?? 0;
    expect(baselineFrames).toBeGreaterThan(0);

    const depotRate = 12;
    const { result } = solveProductionGraph(buildGraph(depotRate), frameData());

    // Depot demand satisfied exactly; the frame chain shrank to pay for it.
    expect(result.edges['depot-edge:beam-maker:beam']?.allocation).toBeCloseTo(depotRate, 4);
    expect(result.nodes['frame-maker']?.machines).toBeLessThan(baselineFrames - 1e-4);
    expect(result.nodes['frame-maker']?.machines).toBeGreaterThan(0);

    expectNoDeficits(result);
  });

  it('rounds a demand-bound producer up to a whole machine and sinks the remainder', () => {
    // frame-sink demands 25 frames/min → frame-maker wants 25/30 machines.
    // A round-up sink rounds it to 1 machine and diverts the 5/min remainder.
    const data = gameData([
      recipe({
        id: 'frame-only',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'frame', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame-only' },
        { kind: 'sink', id: 'demand-sink', itemId: 'frame', demandPerMin: 25 },
        { kind: 'sink', id: 'depot-sink:frame-maker:frame', itemId: 'frame', roundUp: true },
      ],
      edges: [
        { id: 'ingot-frame', sourceId: 'ingot-source', targetId: 'frame-maker', itemId: 'ingot' },
        { id: 'frame-demand', sourceId: 'frame-maker', targetId: 'demand-sink', itemId: 'frame' },
        { id: 'depot-edge:frame-maker:frame', sourceId: 'frame-maker', targetId: 'depot-sink:frame-maker:frame', itemId: 'frame' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // 25/30 machines rounds up to 1 whole machine (30 frames/min).
    expect(result.nodes['frame-maker']?.machines).toBeCloseTo(1, 4);
    // The 5/min remainder is diverted to the round-up sink.
    expect(result.edges['depot-edge:frame-maker:frame']?.allocation).toBeCloseTo(5, 4);
    expect(result.edges['frame-demand']?.allocation).toBeCloseTo(25, 4);
    expectNoDeficits(result);
  });

  it('rounds up to exactly the next whole machine when the consumer is maximized', () => {
    // The user-reported bug: with a maximize consumer downstream, adding the
    // depot demand shifts upstream elastic splits toward the producer's
    // branch, so a one-shot resolution overshoots (9.52 → 11.11 instead of
    // 10). The resolution must converge on the actual machine count.
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 115 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam' },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe' },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame', maximizeOutput: true },
        { kind: 'sink', id: 'frame-sink', itemId: 'frame' },
        { kind: 'sink', id: 'depot-sink:beam-maker:beam', itemId: 'beam', roundUp: true },
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-frame', sourceId: 'beam-maker', targetId: 'frame-maker', itemId: 'beam' },
        { id: 'pipe-frame', sourceId: 'pipe-maker', targetId: 'frame-maker', itemId: 'pipe' },
        { id: 'frame-sink-edge', sourceId: 'frame-maker', targetId: 'frame-sink', itemId: 'frame' },
        { id: 'depot-edge:beam-maker:beam', sourceId: 'beam-maker', targetId: 'depot-sink:beam-maker:beam', itemId: 'beam' },
      ],
    });

    const { result } = solveProductionGraph(g, frameData());

    // Without the depot, 115 ingots split ~57.5/57.5 → beam-maker ≈ 1.92
    // machines. Round-up must land on exactly 2 whole machines.
    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(2, 3);
    // The depot receives the true remainder: beam output minus the frame pull.
    const beamOut = result.nodes['beam-maker']!.machines * 30;
    const framePull = result.edges['beam-frame']?.allocation ?? 0;
    expect(result.edges['depot-edge:beam-maker:beam']?.allocation).toBeCloseTo(beamOut - framePull, 3);
    expectNoDeficits(result);
  });

  it('rounds a large maximized producer up without increasing total source use', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 570 },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam' },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe' },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame', maximizeOutput: true },
        { kind: 'sink', id: 'frame-sink', itemId: 'frame' },
        { kind: 'sink', id: 'depot-sink:beam-maker:beam', itemId: 'beam', roundUp: true },
      ],
      edges: [
        { id: 'ingot-beam', sourceId: 'ingot-source', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'ingot-source', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-frame', sourceId: 'beam-maker', targetId: 'frame-maker', itemId: 'beam' },
        { id: 'pipe-frame', sourceId: 'pipe-maker', targetId: 'frame-maker', itemId: 'pipe' },
        { id: 'frame-sink-edge', sourceId: 'frame-maker', targetId: 'frame-sink', itemId: 'frame' },
        { id: 'depot-edge:beam-maker:beam', sourceId: 'beam-maker', targetId: 'depot-sink:beam-maker:beam', itemId: 'beam' },
      ],
    });

    const baseline = solveProductionGraph({
      ...g,
      nodes: g.nodes.filter((node) => node.id !== 'depot-sink:beam-maker:beam'),
      edges: g.edges.filter((edge) => edge.id !== 'depot-edge:beam-maker:beam'),
    }, frameData()).result;
    expect(baseline.nodes['beam-maker']?.machines).toBeCloseTo(9.5, 4);

    const { result } = solveProductionGraph(g, frameData());

    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(10, 4);
    expect(result.nodes['pipe-maker']?.machines).toBeCloseTo(9, 4);
    expect(result.nodes['frame-maker']?.machines).toBeCloseTo(9, 4);
    expect(result.edges['depot-edge:beam-maker:beam']?.allocation).toBeCloseTo(30, 4);
    expect(result.edges['beam-frame']?.allocation).toBeCloseTo(270, 4);
    expect(result.nodes['ingot-source']?.outputs[0]?.ratePerMin).toBeCloseTo(570, 4);
    expectNoDeficits(result);
  });

  it('adds one more machine when an already-whole producer is rounded up', () => {
    const data = gameData([
      recipe({
        id: 'frame-only',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'frame', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'frame-maker', recipeId: 'frame-only' },
        { kind: 'sink', id: 'demand-sink', itemId: 'frame', demandPerMin: 60 },
        { kind: 'sink', id: 'depot-sink:frame-maker:frame', itemId: 'frame', roundUp: true },
      ],
      edges: [
        { id: 'ingot-frame', sourceId: 'ingot-source', targetId: 'frame-maker', itemId: 'ingot' },
        { id: 'frame-demand', sourceId: 'frame-maker', targetId: 'demand-sink', itemId: 'frame' },
        { id: 'depot-edge:frame-maker:frame', sourceId: 'frame-maker', targetId: 'depot-sink:frame-maker:frame', itemId: 'frame' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    // 60/30 = exactly 2 machines; round-up mode intentionally adds one more.
    expect(result.nodes['frame-maker']?.machines).toBeCloseTo(3, 4);
    expect(result.edges['depot-edge:frame-maker:frame']?.allocation ?? 0).toBeCloseTo(30, 4);
  });

  it('reserves at a fork downstream of the shared producer for an overridden consumer', () => {
    // The fork sits on a recipe output (ingots) rather than on the source.
    const data = gameData([
      recipe({
        id: 'smelt',
        durationSeconds: 2,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'ingot', amount: 1 }],
      }),
      recipe({
        id: 'beam',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'beam', amount: 1 }],
      }),
      recipe({
        id: 'pipe',
        durationSeconds: 2,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'pipe', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'smelter', recipeId: 'smelt' },
        { kind: 'recipe', id: 'beam-maker', recipeId: 'beam', machineCountOverride: 3 },
        { kind: 'recipe', id: 'pipe-maker', recipeId: 'pipe', maximizeOutput: true },
        { kind: 'sink', id: 'beam-sink', itemId: 'beam' },
        { kind: 'sink', id: 'pipe-sink', itemId: 'pipe' },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'ore' },
        { id: 'ingot-beam', sourceId: 'smelter', targetId: 'beam-maker', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'smelter', targetId: 'pipe-maker', itemId: 'ingot' },
        { id: 'beam-sink-edge', sourceId: 'beam-maker', targetId: 'beam-sink', itemId: 'beam' },
        { id: 'pipe-sink-edge', sourceId: 'pipe-maker', targetId: 'pipe-sink', itemId: 'pipe' },
      ],
    });

    const { result } = solveProductionGraph(g, data);

    expect(result.nodes['beam-maker']?.machines).toBeCloseTo(3, 5);
    expect(result.edges['ingot-beam']?.allocation).toBeCloseTo(90, 4);
    expect(result.nodes['pipe-maker']?.machines).toBeCloseTo(1, 4);

    expectNoDeficits(result);
  });
});

describe('pool nodes', () => {
  function poolData() {
    return gameData([
      recipe({
        id: 'consume-ore',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'widget', amount: 1 }],
      }),
      recipe({
        id: 'consume-ore-b',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'gadget', amount: 1 }],
      }),
    ]);
  }

  it('pools two sources and water-fills one consumer', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'c1', recipeId: 'consume-ore' },
        { kind: 'sink', id: 'sink1', itemId: 'widget', demandPerMin: 1800 },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-c1', sourceId: 'pool', targetId: 'c1', itemId: 'ore' },
        { id: 'c1-sink', sourceId: 'c1', targetId: 'sink1', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, poolData());

    expect(result.nodes.c1?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 1800 });
    expect(result.nodes.c1?.machines).toBeCloseTo(1800, 4);
    expect(result.edges['pool-c1']?.allocation).toBeCloseTo(1800, 4);
    expect(result.edges['s1-pool']?.allocation).toBeCloseTo(900, 4);
    expect(result.edges['s2-pool']?.allocation).toBeCloseTo(900, 4);
    expect(result.edges['pool-c1']?.deficitRate).toBeCloseTo(0, 4);
  });

  it('pools asymmetric sources so neither consumer starves', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 400 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'cA', recipeId: 'consume-ore' },
        { kind: 'recipe', id: 'cB', recipeId: 'consume-ore' },
        { kind: 'sink', id: 'sinkA', itemId: 'widget', demandPerMin: 800 },
        { kind: 'sink', id: 'sinkB', itemId: 'widget', demandPerMin: 800 },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-cA', sourceId: 'pool', targetId: 'cA', itemId: 'ore' },
        { id: 'pool-cB', sourceId: 'pool', targetId: 'cB', itemId: 'ore' },
        { id: 'cA-sink', sourceId: 'cA', targetId: 'sinkA', itemId: 'widget' },
        { id: 'cB-sink', sourceId: 'cB', targetId: 'sinkB', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, poolData());

    expect(result.nodes.cA?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 800 });
    expect(result.nodes.cB?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 800 });
    expect(result.edges['s1-pool']?.allocation).toBeCloseTo(1200, 4);
    expect(result.edges['s2-pool']?.allocation).toBeCloseTo(400, 4);
    expect(result.edges['pool-cA']?.deficitRate).toBeCloseTo(0, 4);
    expect(result.edges['pool-cB']?.deficitRate).toBeCloseTo(0, 4);
  });

  it('CONTROL: direct asymmetric sources starve a consumer without a pool', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 400 },
        { kind: 'recipe', id: 'cA', recipeId: 'consume-ore' },
        { kind: 'recipe', id: 'cB', recipeId: 'consume-ore' },
        { kind: 'sink', id: 'sinkA', itemId: 'widget', demandPerMin: 800 },
        { kind: 'sink', id: 'sinkB', itemId: 'widget', demandPerMin: 800 },
      ],
      edges: [
        { id: 's1-cA', sourceId: 's1', targetId: 'cA', itemId: 'ore' },
        { id: 's1-cB', sourceId: 's1', targetId: 'cB', itemId: 'ore' },
        { id: 's2-cA', sourceId: 's2', targetId: 'cA', itemId: 'ore' },
        { id: 's2-cB', sourceId: 's2', targetId: 'cB', itemId: 'ore' },
        { id: 'cA-sink', sourceId: 'cA', targetId: 'sinkA', itemId: 'widget' },
        { id: 'cB-sink', sourceId: 'cB', targetId: 'sinkB', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, poolData());

    const oreA = result.nodes.cA?.inputs.find((i) => i.itemId === 'ore')?.ratePerMin ?? 0;
    const oreB = result.nodes.cB?.inputs.find((i) => i.itemId === 'ore')?.ratePerMin ?? 0;
    // Total supply (1600) meets total demand (1600), yet independent per-source
    // splitting strands supply and starves the consumers -- the bug the pool fixes.
    expect(oreA + oreB).toBeLessThan(1600 - 1);
  });

  it('honors tiered reservation through a pool (fixed demand before maximize)', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'fixed', recipeId: 'consume-ore' },
        { kind: 'recipe', id: 'maxc', recipeId: 'consume-ore-b', maximizeOutput: true },
        { kind: 'sink', id: 'fixed-sink', itemId: 'widget', demandPerMin: 600 },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-fixed', sourceId: 'pool', targetId: 'fixed', itemId: 'ore' },
        { id: 'pool-maxc', sourceId: 'pool', targetId: 'maxc', itemId: 'ore' },
        { id: 'fixed-sink-edge', sourceId: 'fixed', targetId: 'fixed-sink', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, poolData());

    expect(result.nodes.fixed?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 600 });
    expect(result.nodes.maxc?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 1800 });
    expect(result.edges['pool-fixed']?.allocation).toBeCloseTo(600, 4);
    expect(result.edges['pool-maxc']?.allocation).toBeCloseTo(1800, 4);
  });

  it('excludes pool throughput from the world rollup', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'c1', recipeId: 'consume-ore' },
        { kind: 'sink', id: 'sink1', itemId: 'widget', demandPerMin: 1800 },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-c1', sourceId: 'pool', targetId: 'c1', itemId: 'ore' },
        { id: 'c1-sink', sourceId: 'c1', targetId: 'sink1', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, poolData());

    const oreOut = result.rollups?.world.outputs.find((o) => o.itemId === 'ore')?.ratePerMin ?? 0;
    const oreIn = result.rollups?.world.inputs.find((i) => i.itemId === 'ore')?.ratePerMin ?? 0;
    // Sources output 1800 ore and the consumer draws 1800 ore. If the pool
    // passthrough leaked into the rollup these would double to 3600.
    expect(oreOut).toBeCloseTo(1800, 4);
    expect(oreIn).toBeCloseTo(1800, 4);
  });
});

describe('pool nodes with maximize and overrides', () => {
  function poolMaximizeData() {
    return gameData([
      recipe({
        id: 'cell-maker',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'cell', amount: 20 }],
      }),
      recipe({
        id: 'fuel-rod',
        durationSeconds: 60,
        inputs: [{ itemId: 'cell', amount: 20 }],
        outputs: [{ itemId: 'rod', amount: 1 }],
      }),
      recipe({
        id: 'consume-ore',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'widget', amount: 1 }],
      }),
      recipe({
        id: 'consume-ore-b',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'gadget', amount: 1 }],
      }),
    ]);
  }

  function maximizedFanInThroughPool(oreA: number, oreB: number): ProductionGraph {
    return graph({
      nodes: [
        { kind: 'source', id: 'ore-a', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: oreA },
        { kind: 'source', id: 'ore-b', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: oreB },
        { kind: 'recipe', id: 'cell-a', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'recipe', id: 'cell-b', recipeId: 'cell-maker', maximizeOutput: true },
        { kind: 'pool', id: 'pool', itemId: 'cell' },
        { kind: 'recipe', id: 'fuel', recipeId: 'fuel-rod' },
      ],
      edges: [
        { id: 'ore-a-cell', sourceId: 'ore-a', targetId: 'cell-a', itemId: 'ore' },
        { id: 'ore-b-cell', sourceId: 'ore-b', targetId: 'cell-b', itemId: 'ore' },
        { id: 'cell-a-pool', sourceId: 'cell-a', targetId: 'pool', itemId: 'cell' },
        { id: 'cell-b-pool', sourceId: 'cell-b', targetId: 'pool', itemId: 'cell' },
        { id: 'pool-fuel', sourceId: 'pool', targetId: 'fuel', itemId: 'cell' },
      ],
    });
  }

  it('sizes an unconstrained consumer from asymmetric maximized suppliers through a pool', () => {
    const { result } = solveProductionGraph(maximizedFanInThroughPool(15, 22.5), poolMaximizeData());

    expect(result.nodes.fuel?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 750 });
    expect(result.nodes['cell-a']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 300 });
    expect(result.nodes['cell-b']?.outputs).toContainEqual({ itemId: 'cell', ratePerMin: 450 });
    expect(result.edges['cell-a-pool']?.allocation).toBeCloseTo(300, 4);
    expect(result.edges['cell-b-pool']?.allocation).toBeCloseTo(450, 4);
    expect(result.edges['pool-fuel']?.allocation).toBeCloseTo(750, 4);
  });

  it('re-drains a strengthened supplier through a pool on an incremental re-solve', () => {
    const data = poolMaximizeData();
    const first = solveProductionGraph(maximizedFanInThroughPool(15, 15), data);
    expect(first.result.nodes.fuel?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 600 });

    const { result } = solveProductionGraph(maximizedFanInThroughPool(15, 22.5), data, {
      previous: first.result,
      origin: { type: 'source', nodeId: 'ore-b' },
    });

    expect(result.nodes.fuel?.inputs).toContainEqual({ itemId: 'cell', ratePerMin: 750 });
    expect(result.edges['cell-b-pool']?.allocation).toBeCloseTo(450, 4);
  });

  it('reserves an overridden consumer through a pool before a maximize sibling', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'ov', recipeId: 'consume-ore', machineCountOverride: 1000 },
        { kind: 'recipe', id: 'maxc', recipeId: 'consume-ore-b', maximizeOutput: true },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-ov', sourceId: 'pool', targetId: 'ov', itemId: 'ore' },
        { id: 'pool-maxc', sourceId: 'pool', targetId: 'maxc', itemId: 'ore' },
      ],
    });

    const { result } = solveProductionGraph(g, poolMaximizeData());

    expect(result.nodes.ov?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 1000 });
    expect(result.nodes.maxc?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 1400 });
    expect(result.edges['pool-ov']?.allocation).toBeCloseTo(1000, 4);
    expect(result.edges['pool-maxc']?.allocation).toBeCloseTo(1400, 4);
  });
});

describe('override pinning and shortage exposure', () => {
  function pinningData() {
    return gameData([
      recipe({
        id: 'consume-ore',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'widget', amount: 1 }],
      }),
      recipe({
        id: 'smelt',
        durationSeconds: 60,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [{ itemId: 'ingot', amount: 1 }],
      }),
      recipe({
        id: 'beam',
        durationSeconds: 60,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'beam', amount: 1 }],
      }),
      recipe({
        id: 'pipe',
        durationSeconds: 60,
        inputs: [{ itemId: 'ingot', amount: 1 }],
        outputs: [{ itemId: 'pipe', amount: 1 }],
      }),
      recipe({
        id: 'use-widget',
        durationSeconds: 60,
        inputs: [{ itemId: 'widget', amount: 1 }],
        outputs: [{ itemId: 'gizmo', amount: 1 }],
      }),
    ]);
  }

  it('pins an overridden node exactly; a downstream maximize consumer sizes to its output, not raw supply', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-src', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 240 },
        { kind: 'recipe', id: 'ov', recipeId: 'consume-ore', machineCountOverride: 100 },
        { kind: 'recipe', id: 'maxc', recipeId: 'use-widget', maximizeOutput: true },
      ],
      edges: [
        { id: 'ore-ov', sourceId: 'ore-src', targetId: 'ov', itemId: 'ore' },
        { id: 'ov-maxc', sourceId: 'ov', targetId: 'maxc', itemId: 'widget' },
      ],
    });

    const { result } = solveProductionGraph(g, pinningData());

    // Override is absolute: 100 machines, 100 ore in, 100 widgets out.
    expect(result.nodes.ov?.machines).toBeCloseTo(100, 4);
    expect(result.nodes.ov?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 100 });
    // The maximize consumer sizes to the override's actual output, not the 240 raw ore.
    expect(result.nodes.maxc?.inputs).toContainEqual({ itemId: 'widget', ratePerMin: 100 });
    expect(result.nodes.ov?.scale).toBe(1);
  });

  it('reserves a parallel override before a maximize sibling on a tight pool', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 600 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'ov', recipeId: 'consume-ore', machineCountOverride: 1000 },
        { kind: 'recipe', id: 'maxc', recipeId: 'smelt', maximizeOutput: true },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-ov', sourceId: 'pool', targetId: 'ov', itemId: 'ore' },
        { id: 'pool-maxc', sourceId: 'pool', targetId: 'maxc', itemId: 'ore' },
      ],
    });

    const { result } = solveProductionGraph(g, pinningData());

    expect(result.nodes.ov?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 1000 });
    expect(result.edges['pool-ov']?.allocation).toBeCloseTo(1000, 4);
    expect(result.nodes.maxc?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 800 });
    expect(result.edges['pool-maxc']?.allocation).toBeCloseTo(800, 4);
    expect(result.nodes.ov?.scale).toBe(1);
  });

  it('keeps the full override demand visible when supply falls short (3000 vs 2400)', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 's1', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 's2', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'pool', id: 'pool', itemId: 'ore' },
        { kind: 'recipe', id: 'ov', recipeId: 'consume-ore', machineCountOverride: 3000 },
      ],
      edges: [
        { id: 's1-pool', sourceId: 's1', targetId: 'pool', itemId: 'ore' },
        { id: 's2-pool', sourceId: 's2', targetId: 'pool', itemId: 'ore' },
        { id: 'pool-ov', sourceId: 'pool', targetId: 'ov', itemId: 'ore' },
      ],
    });

    const { result } = solveProductionGraph(g, pinningData());

    // Requested stays 3000 — never rescaled away — so the UI can show 3000/2400.
    expect(result.nodes.ov?.machines).toBeCloseTo(3000, 4);
    expect(result.nodes.ov?.scale).toBe(1);
    expect(result.nodes.ov?.inputs).toContainEqual({ itemId: 'ore', ratePerMin: 3000 });
    // Only 2400 actually arrives; the gap is a visible edge deficit.
    expect(result.edges['pool-ov']?.allocation).toBeCloseTo(2400, 4);
    expect(result.edges['pool-ov']?.deficitRate).toBeCloseTo(600, 4);
    // Sources deliver their full capacity toward the override.
    expect(result.edges['s1-pool']?.allocation).toBeCloseTo(1200, 4);
    expect(result.edges['s2-pool']?.allocation).toBeCloseTo(1200, 4);
  });

  it('sizes a shared intermediate to cover the override first, maximize takes the remainder', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-src', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 500 },
        { kind: 'recipe', id: 'smelter', recipeId: 'smelt' },
        { kind: 'recipe', id: 'beam-ov', recipeId: 'beam', machineCountOverride: 300 },
        { kind: 'recipe', id: 'pipe-max', recipeId: 'pipe', maximizeOutput: true },
      ],
      edges: [
        { id: 'ore-smelter', sourceId: 'ore-src', targetId: 'smelter', itemId: 'ore' },
        { id: 'ingot-beam', sourceId: 'smelter', targetId: 'beam-ov', itemId: 'ingot' },
        { id: 'ingot-pipe', sourceId: 'smelter', targetId: 'pipe-max', itemId: 'ingot' },
      ],
    });

    const { result } = solveProductionGraph(g, pinningData());

    // The shared smelter covers the override's 300 and everything else feeds maximize.
    expect(result.nodes['beam-ov']?.inputs).toContainEqual({ itemId: 'ingot', ratePerMin: 300 });
    expect(result.edges['ingot-beam']?.allocation).toBeCloseTo(300, 4);
    expect(result.edges['ingot-beam']?.deficitRate).toBeCloseTo(0, 4);
    expect(result.nodes['pipe-max']?.inputs).toContainEqual({ itemId: 'ingot', ratePerMin: 200 });
    expect(result.nodes.smelter?.machines).toBeCloseTo(500, 4);
    expect(result.nodes.smelter?.scale).toBe(1);
  });
});

describe('overproduceFromSurplus (spare-capacity mode)', () => {
  function spareData() {
    return gameData([
      recipe({
        id: 'motor',
        durationSeconds: 60,
        inputs: [
          { itemId: 'steel', amount: 2 },
          { itemId: 'copper', amount: 2 },
        ],
        outputs: [{ itemId: 'motor', amount: 1 }],
      }),
      recipe({
        id: 'wire',
        durationSeconds: 60,
        inputs: [{ itemId: 'copper', amount: 1 }],
        outputs: [{ itemId: 'wire', amount: 2 }],
      }),
      recipe({
        id: 'use-wire',
        durationSeconds: 60,
        inputs: [{ itemId: 'wire', amount: 1 }],
        outputs: [{ itemId: 'cable', amount: 1 }],
      }),
      recipe({
        id: 'consume-copper',
        durationSeconds: 60,
        inputs: [{ itemId: 'copper', amount: 1 }],
        outputs: [{ itemId: 'widget', amount: 1 }],
      }),
    ]);
  }

  const overflowRouting = { portSide: 'output' as const, portId: 'out', priority: [], overflow: true };

  /**
   * With `spare` off this mirrors what the app builds when the ticket is off:
   * no depot sink and no overflow edge — the wire recipe is undriven. (A bare
   * sink alone would already absorb seeded supply via the auto-sink path.)
   */
  function motorWireGraph(opts: { spare: boolean; copperRate?: number }): ProductionGraph {
    return graph({
      nodes: [
        { kind: 'source', id: 'steel-src', itemId: 'steel', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'manual-input', maxRatePerMin: opts.copperRate ?? 200 },
        { kind: 'recipe', id: 'motors', recipeId: 'motor', maximizeOutput: true },
        { kind: 'recipe', id: 'wires', recipeId: 'wire', ...(opts.spare ? { overproduceFromSurplus: true } : {}) },
        ...(opts.spare ? [{ kind: 'sink', id: 'depot', itemId: 'wire' } as ProductionGraph['nodes'][number]] : []),
      ],
      edges: [
        { id: 'steel-motors', sourceId: 'steel-src', targetId: 'motors', itemId: 'steel' },
        { id: 'copper-motors', sourceId: 'copper-src', targetId: 'motors', itemId: 'copper' },
        { id: 'copper-wires', sourceId: 'copper-src', targetId: 'wires', itemId: 'copper' },
        ...(opts.spare
          ? [{ id: 'wires-depot', sourceId: 'wires', targetId: 'depot', itemId: 'wire', routing: overflowRouting }]
          : []),
      ],
    });
  }

  it('overproduces exactly the leftover copper without touching the steel-limited motor chain', () => {
    const data = spareData();
    const baseline = solveProductionGraph(motorWireGraph({ spare: false }), data).result;
    const { result } = solveProductionGraph(motorWireGraph({ spare: true }), data);

    // Motors are steel-bottlenecked at 30 machines: 60 steel + 60 copper.
    expect(result.nodes.motors?.machines).toBeCloseTo(30, 4);
    expect(result.nodes.motors?.inputs).toContainEqual({ itemId: 'steel', ratePerMin: 60 });
    expect(result.nodes.motors?.inputs).toContainEqual({ itemId: 'copper', ratePerMin: 60 });

    // The wire recipe absorbs the remaining 140 copper into the depot.
    expect(result.nodes.wires?.machines).toBeCloseTo(140, 4);
    expect(result.nodes.wires?.outputs).toContainEqual({ itemId: 'wire', ratePerMin: 280 });
    expect(result.edges['wires-depot']?.allocation).toBeCloseTo(280, 4);

    // Source draw never exceeds the claim: 60 + 140 = 200.
    expect(result.edges['copper-motors']?.allocation).toBeCloseTo(60, 4);
    expect(result.edges['copper-wires']?.allocation).toBeCloseTo(140, 4);

    // Guard: enabling the flag changes NOTHING for the non-spare nodes.
    // (The baseline wire node still auto-sizes as an undriven terminal recipe
    // — pre-existing engine semantics — but the motor chain must be identical.)
    expect(result.nodes.motors?.machines).toBeCloseTo(baseline.nodes.motors?.machines ?? -1, 4);
    for (const input of result.nodes.motors?.inputs ?? []) {
      const baselineRate = baseline.nodes.motors?.inputs.find((i) => i.itemId === input.itemId)?.ratePerMin;
      expect(input.ratePerMin).toBeCloseTo(baselineRate ?? -1, 4);
    }
    const baselineCopperOut = baseline.nodes['copper-src']?.outputs.find((o) => o.itemId === 'copper')?.ratePerMin;
    const copperOut = result.nodes['copper-src']?.outputs.find((o) => o.itemId === 'copper')?.ratePerMin;
    expect(copperOut).toBeCloseTo(baselineCopperOut ?? -1, 4);
  });

  it('is a no-op when there is no leftover input supply', () => {
    const { result } = solveProductionGraph(motorWireGraph({ spare: true, copperRate: 60 }), spareData());

    expect(result.nodes.motors?.machines).toBeCloseTo(30, 4);
    expect(result.nodes.wires?.machines ?? 0).toBeCloseTo(0, 4);
    expect(result.edges['wires-depot']?.allocation ?? 0).toBeCloseTo(0, 4);
  });

  it('serves a real downstream consumer first and sinks only the remainder', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'steel-src', itemId: 'steel', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'manual-input', maxRatePerMin: 200 },
        { kind: 'recipe', id: 'motors', recipeId: 'motor', maximizeOutput: true },
        { kind: 'recipe', id: 'wires', recipeId: 'wire', overproduceFromSurplus: true },
        { kind: 'recipe', id: 'cables', recipeId: 'use-wire' },
        { kind: 'sink', id: 'cable-sink', itemId: 'cable', demandPerMin: 50 },
        { kind: 'sink', id: 'depot', itemId: 'wire' },
      ],
      edges: [
        { id: 'steel-motors', sourceId: 'steel-src', targetId: 'motors', itemId: 'steel' },
        { id: 'copper-motors', sourceId: 'copper-src', targetId: 'motors', itemId: 'copper' },
        { id: 'copper-wires', sourceId: 'copper-src', targetId: 'wires', itemId: 'copper' },
        { id: 'wires-cables', sourceId: 'wires', targetId: 'cables', itemId: 'wire' },
        { id: 'cables-sink', sourceId: 'cables', targetId: 'cable-sink', itemId: 'cable' },
        { id: 'wires-depot', sourceId: 'wires', targetId: 'depot', itemId: 'wire', routing: overflowRouting },
      ],
    });

    const { result } = solveProductionGraph(g, spareData());

    // The fixed 50-cable chain is fully served...
    expect(result.nodes.cables?.inputs).toContainEqual({ itemId: 'wire', ratePerMin: 50 });
    expect(result.edges['wires-cables']?.allocation).toBeCloseTo(50, 4);
    expect(result.edges['wires-cables']?.deficitRate).toBeCloseTo(0, 4);
    // ...motors keep their 60 copper, and the wire recipe still uses ALL leftover.
    expect(result.nodes.motors?.inputs).toContainEqual({ itemId: 'copper', ratePerMin: 60 });
    expect(result.nodes.wires?.machines).toBeCloseTo(140, 4);
    // 280 wire produced, 50 consumed, 230 overflows into the depot.
    expect(result.edges['wires-depot']?.allocation).toBeCloseTo(230, 4);
  });

  it('yields to a maximize sibling: an unbounded maximize chain takes all leftover', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'manual-input', maxRatePerMin: 200 },
        { kind: 'recipe', id: 'widgets', recipeId: 'consume-copper', maximizeOutput: true },
        { kind: 'recipe', id: 'wires', recipeId: 'wire', overproduceFromSurplus: true },
        { kind: 'sink', id: 'depot', itemId: 'wire' },
      ],
      edges: [
        { id: 'copper-widgets', sourceId: 'copper-src', targetId: 'widgets', itemId: 'copper' },
        { id: 'copper-wires', sourceId: 'copper-src', targetId: 'wires', itemId: 'copper' },
        { id: 'wires-depot', sourceId: 'wires', targetId: 'depot', itemId: 'wire', routing: overflowRouting },
      ],
    });

    const { result } = solveProductionGraph(g, spareData());

    expect(result.nodes.widgets?.inputs).toContainEqual({ itemId: 'copper', ratePerMin: 200 });
    expect(result.nodes.wires?.machines ?? 0).toBeCloseTo(0, 4);
  });
});
