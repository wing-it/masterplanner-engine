import { describe, expect, it } from 'vitest';

import { normalizeGraph } from '../graph/normalize';
import type { EngineBuildingPowerProfile, EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph } from '../types/production-graph';
import { calculateRequiredPlan } from './demand';

function recipe(opts: {
  id: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
  product?: string | null;
  machine?: { id: string };
}): EngineRecipeDefinition {
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds,
    product: opts.product === undefined
      ? opts.outputs[0] ? { id: opts.outputs[0].itemId } : null
      : opts.product ? { id: opts.product } : null,
    inputs: opts.inputs,
    outputs: opts.outputs,
    machine: opts.machine ?? null,
  };
}

function gameData(
  recipes: EngineRecipeDefinition[],
  profiles: EngineBuildingPowerProfile[] = []
): EngineGameData {
  return {
    recipes,
    generatorRecipes: [],
    buildingPowerById: new Map(profiles.map((profile) => [profile.buildingId, profile])),
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

function coalForkGraph(sulfurRate: number, priority: string[] = []): ProductionGraph {
  const routing = priority.length > 0
    ? { portSide: 'output' as const, portId: 'out', priority }
    : undefined;

  return graph({
    nodes: [
      { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1200 },
      { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: sulfurRate },
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

describe('calculateRequiredPlan', () => {
  it('calculates 10 Modular Frames/min demand and upstream rates', () => {
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

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.mf?.requiredMachines).toBeCloseTo(5, 5);
    expect(result.plan.mf?.requiredInputs['reinforced-plate']).toBeCloseTo(15, 5);
    expect(result.plan.mf?.requiredInputs['iron-rod']).toBeCloseTo(60, 5);
    expect(result.plan.rip?.requiredMachines).toBeCloseTo(3, 5);
    expect(result.plan.rip?.requiredInputs['iron-plate']).toBeCloseTo(90, 5);
    expect(result.plan.rip?.requiredInputs.screw).toBeCloseTo(180, 5);
  });

  it('sums shared screw demand from two consumers', () => {
    const data = gameData([
      recipe({
        id: 'screw',
        durationSeconds: 6,
        inputs: [{ itemId: 'iron-rod', amount: 1 }],
        outputs: [{ itemId: 'screw', amount: 4 }],
      }),
      recipe({
        id: 'reinforced-plate',
        durationSeconds: 12,
        inputs: [{ itemId: 'screw', amount: 12 }],
        outputs: [{ itemId: 'reinforced-plate', amount: 1 }],
      }),
      recipe({
        id: 'rotor',
        durationSeconds: 15,
        inputs: [{ itemId: 'screw', amount: 25 }],
        outputs: [{ itemId: 'rotor', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'rod-source', itemId: 'iron-rod', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'screw', recipeId: 'screw' },
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
        { kind: 'recipe', id: 'rotor', recipeId: 'rotor' },
        { kind: 'sink', id: 'rip-sink', itemId: 'reinforced-plate', demandPerMin: 20 },
        { kind: 'sink', id: 'rotor-sink', itemId: 'rotor', demandPerMin: 8 },
      ],
      edges: [
        { id: 'rod-screw', sourceId: 'rod-source', targetId: 'screw', itemId: 'iron-rod' },
        { id: 'screw-rip', sourceId: 'screw', targetId: 'rip', itemId: 'screw' },
        { id: 'screw-rotor', sourceId: 'screw', targetId: 'rotor', itemId: 'screw' },
        { id: 'rip-sink', sourceId: 'rip', targetId: 'rip-sink', itemId: 'reinforced-plate' },
        { id: 'rotor-sink', sourceId: 'rotor', targetId: 'rotor-sink', itemId: 'rotor' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.rip?.requiredInputs.screw).toBeCloseTo(240, 5);
    expect(result.plan.rotor?.requiredInputs.screw).toBeCloseTo(200, 5);
    expect(result.plan.screw?.requiredOutputs.screw).toBeCloseTo(440, 5);
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

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.ingot?.requiredInputs['iron-ore']).toBeCloseTo(120, 5);
    expect(result.plan.ingot?.requiredOutputs['iron-ingot']).toBeCloseTo(120, 5);
    expect(result.plan.rip?.requiredMachines).toBeCloseTo(2, 5);
    expect(result.plan.rip?.requiredOutputs['reinforced-plate']).toBeCloseTo(10, 5);
    expect(result.plan.plate?.requiredInputs['iron-ingot']).toBeCloseTo(90, 5);
    expect(result.plan.screws?.requiredInputs['iron-ingot']).toBeCloseTo(30, 5);
  });

  it('uses the max output rule for multi-output recipes', () => {
    const data = gameData([
      recipe({
        id: 'refinery',
        durationSeconds: 6,
        inputs: [{ itemId: 'oil', amount: 3 }],
        outputs: [
          { itemId: 'plastic', amount: 2 },
          { itemId: 'residue', amount: 1 },
        ],
        product: null,
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'oil-source', itemId: 'oil', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'refinery', recipeId: 'refinery' },
        { kind: 'sink', id: 'plastic-sink', itemId: 'plastic', demandPerMin: 50 },
        { kind: 'sink', id: 'residue-sink', itemId: 'residue', demandPerMin: 15 },
      ],
      edges: [
        { id: 'oil-refinery', sourceId: 'oil-source', targetId: 'refinery', itemId: 'oil' },
        { id: 'plastic', sourceId: 'refinery', targetId: 'plastic-sink', itemId: 'plastic' },
        { id: 'residue', sourceId: 'refinery', targetId: 'residue-sink', itemId: 'residue' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.refinery?.requiredMachines).toBeCloseTo(2.5, 5);
    expect(result.plan.refinery?.requiredOutputs.plastic).toBeCloseTo(50, 5);
    expect(result.plan.refinery?.requiredOutputs.residue).toBeCloseTo(25, 5);
  });

  it('represents source and sink rates with zero machines', () => {
    const data = gameData([]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'sink', id: 'sink', itemId: 'ore', demandPerMin: 45 },
      ],
      edges: [{ id: 'ore', sourceId: 'source', targetId: 'sink', itemId: 'ore' }],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.source).toMatchObject({
      requiredMachines: 0,
      requiredInputs: {},
      requiredOutputs: { ore: 45 },
    });
    expect(result.plan.sink).toMatchObject({
      requiredMachines: 0,
      requiredInputs: { ore: 45 },
      requiredOutputs: {},
    });
  });

  it('emits a cycle diagnostic when fixed-point iteration does not converge before the cap', () => {
    const data = gameData([
      recipe({
        id: 'a',
        durationSeconds: 1,
        inputs: [{ itemId: 'b-item', amount: 2 }],
        outputs: [{ itemId: 'a-item', amount: 1 }],
      }),
      recipe({
        id: 'b',
        durationSeconds: 1,
        inputs: [{ itemId: 'a-item', amount: 2 }],
        outputs: [{ itemId: 'b-item', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'recipe', id: 'a', recipeId: 'a', machineCountOverride: 1 },
        { kind: 'recipe', id: 'b', recipeId: 'b' },
      ],
      edges: [
        { id: 'a-b', sourceId: 'a', targetId: 'b', itemId: 'a-item' },
        { id: 'b-a', sourceId: 'b', targetId: 'a', itemId: 'b-item' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data, { maxIterations: 1 });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'cycle' }));
  });

  it('fixed source uses maxRatePerMin already scaled by machineCountOverride', () => {
    const data = gameData([
      recipe({
        id: 'smelter',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'iron-ore',
          itemId: 'iron-ore',
          sourceType: 'resource-claim',
          maxRatePerMin: 120,
          machineCountOverride: 2,
        },
        { kind: 'recipe', id: 'smelter', recipeId: 'smelter' },
      ],
      edges: [
        { id: 'e1', sourceId: 'iron-ore', targetId: 'smelter', itemId: 'iron-ore' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    const smelterPlan = result.plan['smelter'];
    expect(smelterPlan.requiredInputs['iron-ore']).toBeCloseTo(120, 5);
    expect(result.plan['iron-ore']?.requiredOutputs['iron-ore']).toBeCloseTo(120, 5);
  });

  it('does not supply-drive an undriven recipe from a null-machine resource claim', () => {
    const data = gameData([
      recipe({
        id: 'smelter',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'iron-ore',
          itemId: 'iron-ore',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
        },
        { kind: 'recipe', id: 'smelter', recipeId: 'smelter' },
      ],
      edges: [
        { id: 'e1', sourceId: 'iron-ore', targetId: 'smelter', itemId: 'iron-ore' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan['iron-ore']?.requiredOutputs['iron-ore']).toBe(0);
    expect(result.plan.smelter?.requiredMachines).toBe(0);
    expect(result.plan.smelter?.requiredInputs).toEqual({});
    expect(result.plan.smelter?.requiredOutputs).toEqual({});
  });

  it('supply-drives a multi-input recipe from connected inputs and reports unconnected input demand', () => {
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
      edges: [
        { id: 'plate-rip', sourceId: 'plate-source', targetId: 'rip', itemId: 'iron-plate' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.rip?.requiredMachines).toBeCloseTo(26.666666, 5);
    expect(result.plan.rip?.requiredInputs['iron-plate']).toBeCloseTo(800, 5);
    expect(result.plan.rip?.requiredInputs.screw).toBeCloseTo(1600, 5);
    expect(result.plan.rip?.requiredOutputs['reinforced-plate']).toBeCloseTo(133.333333, 5);
  });

  it('supply-drives a multi-input recipe from a connected source when another input is connected to an unsupplied recipe', () => {
    const data = gameData([
      recipe({
        id: 'aluminum-ingot',
        durationSeconds: 6,
        inputs: [
          { itemId: 'scrap', amount: 6 },
          { itemId: 'silica', amount: 5 },
        ],
        outputs: [{ itemId: 'aluminum-ingot', amount: 1 }],
      }),
      recipe({
        id: 'silica',
        durationSeconds: 8,
        inputs: [{ itemId: 'quartz', amount: 3 }],
        outputs: [{ itemId: 'silica', amount: 5 }],
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'scrap-source', itemId: 'scrap', sourceType: 'manual-input', maxRatePerMin: 1800 },
        { kind: 'recipe', id: 'silica-recipe', recipeId: 'silica' },
        { kind: 'recipe', id: 'aluminum', recipeId: 'aluminum-ingot' },
      ],
      edges: [
        { id: 'scrap-aluminum', sourceId: 'scrap-source', targetId: 'aluminum', itemId: 'scrap' },
        { id: 'silica-aluminum', sourceId: 'silica-recipe', targetId: 'aluminum', itemId: 'silica' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    // Aluminum sizes from scrap supply: 1800 / (6/6*60) = 30 machines
    expect(result.plan.aluminum?.requiredMachines).toBeCloseTo(30, 5);
    expect(result.plan.aluminum?.requiredInputs.scrap).toBeCloseTo(1800, 5);
    expect(result.plan.aluminum?.requiredInputs.silica).toBeCloseTo(1500, 5);
    // Silica recipe sizes from demand: 1500 / (5/8*60) = 40 machines
    expect(result.plan['silica-recipe']?.requiredMachines).toBeCloseTo(40, 5);
    expect(result.plan['silica-recipe']?.requiredInputs.quartz).toBeCloseTo(900, 5);
    expect(result.plan['silica-recipe']?.requiredOutputs.silica).toBeCloseTo(1500, 5);
  });

  it('keeps a multi-input recipe at zero when no inputs are supplied', () => {
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
        { kind: 'recipe', id: 'rip', recipeId: 'reinforced-plate' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.rip).toEqual({
      nodeId: 'rip',
      requiredMachines: 0,
      requiredInputs: {},
      requiredOutputs: {},
    });
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

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.rip?.requiredMachines).toBeCloseTo(10, 5);
    expect(result.plan.rip?.requiredInputs['iron-plate']).toBeCloseTo(300, 5);
    expect(result.plan.rip?.requiredInputs.screw).toBeCloseTo(600, 5);
    expect(result.plan.rip?.requiredOutputs['reinforced-plate']).toBeCloseTo(50, 5);
  });

  it('upstream machineCountOverride drives downstream recipe demand', () => {
    const data = gameData([
      recipe({
        id: 'smelter',
        durationSeconds: 2,
        inputs: [{ itemId: 'iron-ore', amount: 1 }],
        outputs: [{ itemId: 'iron-ingot', amount: 1 }],
      }),
      recipe({
        id: 'plate',
        durationSeconds: 3,
        inputs: [{ itemId: 'iron-ingot', amount: 2 }],
        outputs: [{ itemId: 'iron-plate', amount: 1 }],
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'iron-ore',
          itemId: 'iron-ore',
          sourceType: 'resource-claim',
          maxRatePerMin: 60,
        },
        {
          kind: 'recipe',
          id: 'upstream',
          recipeId: 'smelter',
          machineCountOverride: 2,
        },
        { kind: 'recipe', id: 'downstream', recipeId: 'plate' },
        { kind: 'sink', id: 'sink', itemId: 'iron-plate', demandPerMin: 30 },
      ],
      edges: [
        { id: 'e1', sourceId: 'iron-ore', targetId: 'upstream', itemId: 'iron-ore' },
        { id: 'e2', sourceId: 'upstream', targetId: 'downstream', itemId: 'iron-ingot' },
        { id: 'e3', sourceId: 'downstream', targetId: 'sink', itemId: 'iron-plate' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.upstream?.requiredMachines).toBeCloseTo(2, 5);
    expect(result.plan.downstream?.requiredMachines).toBeGreaterThan(0);
    expect(result.plan.downstream?.requiredInputs['iron-ingot']).toBeGreaterThan(0);
  });

  it('uses an upstream override as fixed supply for an undriven rod and screw chain', () => {
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
    const g = graph({
      nodes: [
        { kind: 'source', id: 'iron-ore', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'ingots', recipeId: 'iron-ingot', machineCountOverride: 2 },
        { kind: 'recipe', id: 'rods', recipeId: 'iron-rod' },
        { kind: 'recipe', id: 'screws', recipeId: 'screw' },
      ],
      edges: [
        { id: 'ore-ingots', sourceId: 'iron-ore', targetId: 'ingots', itemId: 'iron-ore' },
        { id: 'ingots-rods', sourceId: 'ingots', targetId: 'rods', itemId: 'iron-ingot' },
        { id: 'rods-screws', sourceId: 'rods', targetId: 'screws', itemId: 'iron-rod' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.ingots?.requiredMachines).toBeCloseTo(2, 5);
    expect(result.plan.ingots?.requiredInputs['iron-ore']).toBeCloseTo(60, 5);
    expect(result.plan.ingots?.requiredOutputs['iron-ingot']).toBeCloseTo(60, 5);
    expect(result.plan.rods?.requiredMachines).toBeCloseTo(4, 5);
    expect(result.plan.rods?.requiredInputs['iron-ingot']).toBeCloseTo(60, 5);
    expect(result.plan.rods?.requiredOutputs['iron-rod']).toBeCloseTo(60, 5);
    expect(result.plan.screws?.requiredMachines).toBeCloseTo(6, 5);
    expect(result.plan.screws?.requiredInputs['iron-rod']).toBeCloseTo(60, 5);
    expect(result.plan.screws?.requiredOutputs.screw).toBeCloseTo(240, 5);
  });

  it('does not double-count upstream fixed supply when downstream has its own override', () => {
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
    const g = graph({
      nodes: [
        { kind: 'source', id: 'iron-ore', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 999 },
        { kind: 'recipe', id: 'ingots', recipeId: 'iron-ingot', machineCountOverride: 2 },
        { kind: 'recipe', id: 'rods', recipeId: 'iron-rod' },
        { kind: 'recipe', id: 'screws', recipeId: 'screw', machineCountOverride: 3 },
      ],
      edges: [
        { id: 'ore-ingots', sourceId: 'iron-ore', targetId: 'ingots', itemId: 'iron-ore' },
        { id: 'ingots-rods', sourceId: 'ingots', targetId: 'rods', itemId: 'iron-ingot' },
        { id: 'rods-screws', sourceId: 'rods', targetId: 'screws', itemId: 'iron-rod' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.ingots?.requiredMachines).toBeCloseTo(2, 5);
    expect(result.plan.rods?.requiredMachines).toBeCloseTo(2, 5);
    expect(result.plan.rods?.requiredInputs['iron-ingot']).toBeCloseTo(30, 5);
    expect(result.plan.rods?.requiredOutputs['iron-rod']).toBeCloseTo(30, 5);
    expect(result.plan.screws?.requiredMachines).toBeCloseTo(3, 5);
    expect(result.plan.screws?.requiredInputs['iron-rod']).toBeCloseTo(30, 5);
    expect(result.plan.screws?.requiredOutputs.screw).toBeCloseTo(120, 5);
  });

  it('scales a generator to consume fuel from a fixed manual source', () => {
    const data = gameData([
      recipe({
        id: 'coal-power',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
        outputs: [],
        product: null,
      }),
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'gen', recipeId: 'coal-power' },
      ],
      edges: [{ id: 'coal-gen', sourceId: 'coal', targetId: 'gen', itemId: 'coal' }],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.gen?.requiredMachines).toBeCloseTo(8, 5);
    expect(result.plan.gen?.requiredInputs.coal).toBeCloseTo(120, 5);
    expect(result.plan.coal?.requiredOutputs.coal).toBeCloseTo(120, 5);
  });

  it('does not size a generator from a null-machine resource claim', () => {
    const data = gameData([
      recipe({
        id: 'coal-power',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
        outputs: [],
        product: null,
      }),
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'coal',
          itemId: 'coal',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 60,
        },
        { kind: 'recipe', id: 'gen', recipeId: 'coal-power' },
      ],
      edges: [{ id: 'coal-gen', sourceId: 'coal', targetId: 'gen', itemId: 'coal' }],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.gen?.requiredMachines).toBe(0);
    expect(result.plan.gen?.requiredInputs.coal ?? 0).toBe(0);
    expect(result.plan.coal?.requiredOutputs.coal ?? 0).toBe(0);
  });

  it('uses a power target to size a generator and scales the source to match', () => {
    const data = gameData(
      [
        recipe({
          id: 'coal-power',
          durationSeconds: 4,
          inputs: [{ itemId: 'coal', amount: 1 }],
          outputs: [],
          product: null,
          machine: { id: 'coal-generator' },
        }),
      ],
      [
        {
          buildingId: 'coal-generator',
          role: 'generator',
          baseGeneratedMw: 75,
          powerExponent: 1,
          generatorScalesLinearly: true,
          powerShardSlots: 0,
          maxClockPercent: 250,
          supportsSomersloop: false,
          somersloopSlots: 0,
        },
      ]
    );
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'coal',
          itemId: 'coal',
          sourceType: 'resource-claim',
          maxRatePerMin: 1_000_000_000,
          perExtractorRatePerMin: 60,
        },
        { kind: 'recipe', id: 'gen', recipeId: 'coal-power', powerTargetMw: 300 },
      ],
      edges: [{ id: 'coal-gen', sourceId: 'coal', targetId: 'gen', itemId: 'coal' }],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.gen?.requiredMachines).toBeCloseTo(4, 5);
    expect(result.plan.gen?.requiredInputs.coal).toBeCloseTo(60, 5);
  });

  it('leaves a generator at 0 when no fuel is connected', () => {
    const data = gameData([
      recipe({
        id: 'coal-power',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
        outputs: [],
        product: null,
      }),
    ]);
    const g = graph({
      nodes: [{ kind: 'recipe', id: 'gen', recipeId: 'coal-power' }],
      edges: [],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.gen?.requiredMachines).toBeCloseTo(0, 5);
  });

  it('evenly splits a divergent source fork between a generator and a sulfur-limited recipe', () => {
    const data = gameData([
      recipe({
        id: 'coal-generator',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
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
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 750 },
        { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
        { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
      ],
      edges: [
        { id: 'coal-direct', sourceId: 'coal', targetId: 'direct', itemId: 'coal' },
        { id: 'coal-compacted', sourceId: 'coal', targetId: 'compacted', itemId: 'coal' },
        { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.direct?.requiredInputs.coal).toBeCloseTo(600, 5);
    expect(result.plan.direct?.requiredMachines).toBeCloseTo(40, 5);
    expect(result.plan.compacted?.requiredInputs.coal).toBeCloseTo(600, 5);
    expect(result.plan.compacted?.requiredInputs.sulfur).toBeCloseTo(600, 5);
    expect(result.plan.compacted?.requiredMachines).toBeCloseTo(40, 5);
    expect(result.plan.coal?.requiredOutputs.coal).toBeCloseTo(1200, 5);
    expect(result.plan.sulfur?.requiredOutputs.sulfur).toBeCloseTo(600, 5);
  });

  it('evenly splits a fixed resource-claim fork between a generator and a sulfur-limited recipe', () => {
    const data = gameData([
      recipe({
        id: 'coal-generator',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
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
    ]);
    const g = graph({
      nodes: [
        {
          kind: 'source',
          id: 'coal',
          itemId: 'coal',
          sourceType: 'resource-claim',
          maxRatePerMin: 1200,
          perExtractorRatePerMin: 60,
          machineCountOverride: 20,
        },
        {
          kind: 'source',
          id: 'sulfur',
          itemId: 'sulfur',
          sourceType: 'resource-claim',
          maxRatePerMin: 750,
          perExtractorRatePerMin: 60,
          machineCountOverride: 12.5,
        },
        { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
        { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
      ],
      edges: [
        { id: 'coal-direct', sourceId: 'coal', targetId: 'direct', itemId: 'coal' },
        { id: 'coal-compacted', sourceId: 'coal', targetId: 'compacted', itemId: 'coal' },
        { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.direct?.requiredInputs.coal).toBeCloseTo(600, 5);
    expect(result.plan.direct?.requiredMachines).toBeCloseTo(40, 5);
    expect(result.plan.compacted?.requiredInputs.coal).toBeCloseTo(600, 5);
    expect(result.plan.compacted?.requiredInputs.sulfur).toBeCloseTo(600, 5);
    expect(result.plan.compacted?.requiredMachines).toBeCloseTo(40, 5);
    expect(result.plan.coal?.requiredOutputs.coal).toBeCloseTo(1200, 5);
    expect(result.plan.sulfur?.requiredOutputs.sulfur).toBeCloseTo(600, 5);
  });

  it('fills a prioritized branch up to its physical limit in a divergent source fork', () => {
    const data = gameData([
      recipe({
        id: 'coal-generator',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }],
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
    ]);
    const g = graph({
      nodes: [
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 750 },
        { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
        { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
      ],
      edges: [
        {
          id: 'coal-direct',
          sourceId: 'coal',
          targetId: 'direct',
          itemId: 'coal',
          routing: { portSide: 'output', portId: 'out', priority: ['coal-compacted'] },
        },
        {
          id: 'coal-compacted',
          sourceId: 'coal',
          targetId: 'compacted',
          itemId: 'coal',
          routing: { portSide: 'output', portId: 'out', priority: ['coal-compacted'] },
        },
        { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
      ],
    });

    const result = calculateRequiredPlan(normalizeGraph(g), data);

    expect(result.plan.compacted?.requiredInputs.coal).toBeCloseTo(750, 5);
    expect(result.plan.compacted?.requiredInputs.sulfur).toBeCloseTo(750, 5);
    expect(result.plan.compacted?.requiredMachines).toBeCloseTo(50, 5);
    expect(result.plan.direct?.requiredInputs.coal).toBeCloseTo(450, 5);
    expect(result.plan.direct?.requiredMachines).toBeCloseTo(30, 5);
    expect(result.plan.coal?.requiredOutputs.coal).toBeCloseTo(1200, 5);
  });

  it('fills compacted coal to a 720 sulfur physical limit when prioritized after an even split', () => {
    const data = gameData(coalForkRecipes());
    const base = calculateRequiredPlan(normalizeGraph(coalForkGraph(720)), data);
    expect(base.plan.direct?.requiredInputs.coal).toBeCloseTo(600, 5);
    expect(base.plan.compacted?.requiredInputs.coal).toBeCloseTo(600, 5);

    const prioritized = calculateRequiredPlan(
      normalizeGraph(coalForkGraph(720, ['coal-compacted'])),
      data,
      {
        previous: base.plan,
        dirtyNodeIds: ['coal'],
      }
    );

    expect(prioritized.plan.compacted?.requiredInputs.coal).toBeCloseTo(720, 5);
    expect(prioritized.plan.compacted?.requiredInputs.sulfur).toBeCloseTo(720, 5);
    expect(prioritized.plan.direct?.requiredInputs.coal).toBeCloseTo(480, 5);
    expect(prioritized.plan.coal?.requiredOutputs.coal).toBeCloseTo(1200, 5);
  });

  it('gives a prioritized single-input coal generator all coal before the compacted branch', () => {
    const data = gameData(coalForkRecipes());
    const base = calculateRequiredPlan(normalizeGraph(coalForkGraph(720)), data);

    const prioritized = calculateRequiredPlan(
      normalizeGraph(coalForkGraph(720, ['coal-direct'])),
      data,
      {
        previous: base.plan,
        dirtyNodeIds: ['coal'],
      }
    );

    expect(prioritized.plan.direct?.requiredInputs.coal).toBeCloseTo(1200, 5);
    expect(prioritized.plan.compacted?.requiredInputs.coal ?? 0).toBeCloseTo(0, 5);
    expect(prioritized.plan.compacted?.requiredInputs.sulfur ?? 0).toBeCloseTo(0, 5);
  });

  it('fills compacted coal to a 750 sulfur physical limit when prioritized', () => {
    const data = gameData(coalForkRecipes());
    const result = calculateRequiredPlan(
      normalizeGraph(coalForkGraph(750, ['coal-compacted'])),
      data
    );

    expect(result.plan.compacted?.requiredInputs.coal).toBeCloseTo(750, 5);
    expect(result.plan.compacted?.requiredInputs.sulfur).toBeCloseTo(750, 5);
    expect(result.plan.direct?.requiredInputs.coal).toBeCloseTo(450, 5);
  });

  describe('byproduct recycling', () => {
    function byproductRecipes() {
      return [
        recipe({
          id: 'refinery',
          durationSeconds: 6,
          inputs: [{ itemId: 'crude-oil', amount: 3 }],
          outputs: [
            { itemId: 'plastic', amount: 2 },
            { itemId: 'residue', amount: 4 },
          ],
        }),
        recipe({
          id: 'wastewater-producer',
          durationSeconds: 3,
          inputs: [{ itemId: 'ore', amount: 1 }],
          outputs: [
            { itemId: 'ingot', amount: 1 },
            { itemId: 'waste-water', amount: 40 },
          ],
        }),
        recipe({
          id: 'reactor',
          durationSeconds: 6,
          inputs: [
            { itemId: 'residue', amount: 1 },
            { itemId: 'water', amount: 10 },
          ],
          outputs: [{ itemId: 'product', amount: 1 }],
        }),
      ];
    }

    it('routes byproduct first and reduces resource-claim demand', () => {
      const data = gameData(byproductRecipes());
      const g = graph({
        nodes: [
          { kind: 'source', id: 'oil', itemId: 'crude-oil', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'refinery', recipeId: 'refinery', machineCountOverride: 10 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'plastic-sink', itemId: 'plastic', demandPerMin: 200 },
        ],
        edges: [
          { id: 'oil-refinery', sourceId: 'oil', targetId: 'refinery', itemId: 'crude-oil' },
          { id: 'residue-reactor', sourceId: 'refinery', targetId: 'reactor', itemId: 'residue' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'plastic-sink', sourceId: 'refinery', targetId: 'plastic-sink', itemId: 'plastic' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan.reactor?.requiredInputs.residue).toBeCloseTo(100, 5);
      expect(result.plan.refinery?.requiredOutputs.residue).toBeCloseTo(400, 5);
    });

    it('caps byproduct at demand when supply exceeds need', () => {
      const data = gameData(byproductRecipes());
      const g = graph({
        nodes: [
          { kind: 'source', id: 'oil', itemId: 'crude-oil', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'refinery', recipeId: 'refinery', machineCountOverride: 10 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 1 },
          { kind: 'sink', id: 'plastic-sink', itemId: 'plastic', demandPerMin: 200 },
        ],
        edges: [
          { id: 'oil-refinery', sourceId: 'oil', targetId: 'refinery', itemId: 'crude-oil' },
          { id: 'residue-reactor', sourceId: 'refinery', targetId: 'reactor', itemId: 'residue' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'plastic-sink', sourceId: 'refinery', targetId: 'plastic-sink', itemId: 'plastic' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(100, 5);
      expect(result.plan.reactor?.requiredInputs.residue).toBeCloseTo(10, 5);
    });

    it('splits byproduct equally between two consumers', () => {
      const data = gameData(byproductRecipes());
      const g = graph({
        nodes: [
          { kind: 'source', id: 'oil', itemId: 'crude-oil', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-1', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'source', id: 'water-2', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'wastewater-producer', machineCountOverride: 2.5 },
          { kind: 'recipe', id: 'reactor-1', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'recipe', id: 'reactor-2', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 50 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-r1', sourceId: 'wp', targetId: 'reactor-1', itemId: 'waste-water' },
          { id: 'ww-r2', sourceId: 'wp', targetId: 'reactor-2', itemId: 'waste-water' },
          { id: 'water-r1', sourceId: 'water-1', targetId: 'reactor-1', itemId: 'water' },
          { id: 'water-r2', sourceId: 'water-2', targetId: 'reactor-2', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan['reactor-1']?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['reactor-2']?.requiredInputs.water).toBeCloseTo(1000, 5);
    });

    it('deducts byproduct from resource-claim demand when connected', () => {
      const data = gameData(byproductRecipes());
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'wastewater-producer', machineCountOverride: 5 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 100 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'waste-water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan.wp?.requiredOutputs['waste-water']).toBeCloseTo(4000, 5);
    });

    it('reduces resource-claim demand when a same-item byproduct is wired', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 20 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 2.5 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 25 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['water-source']?.requiredOutputs.water).toBeCloseTo(500, 5);
    });

    it('caps same-item byproduct at demand when supply exceeds need', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 20 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 50 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 1 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 500 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(100, 5);
      expect(result.plan['water-source']?.requiredOutputs.water).toBeCloseTo(0, 5);
    });

    it('splits same-item byproduct equally between two consumers', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 20 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-1', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'source', id: 'water-2', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 5 },
          { kind: 'recipe', id: 'reactor-1', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'recipe', id: 'reactor-2', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 50 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-r1', sourceId: 'wp', targetId: 'reactor-1', itemId: 'water' },
          { id: 'ww-r2', sourceId: 'wp', targetId: 'reactor-2', itemId: 'water' },
          { id: 'water-r1', sourceId: 'water-1', targetId: 'reactor-1', itemId: 'water' },
          { id: 'water-r2', sourceId: 'water-2', targetId: 'reactor-2', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan['reactor-1']?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['reactor-2']?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['water-1']?.requiredOutputs.water).toBeCloseTo(500, 5);
      expect(result.plan['water-2']?.requiredOutputs.water).toBeCloseTo(500, 5);
    });

    it('partially reduces resource-claim when byproduct is insufficient', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 5 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 10 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 100 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['water-source']?.requiredOutputs.water).toBeCloseTo(500, 5);
    });

    it('restores resource-claim demand when byproduct edge is absent', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 20 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 5 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 50 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.plan.reactor?.requiredInputs.water).toBeCloseTo(1000, 5);
      expect(result.plan['water-source']?.requiredOutputs.water).toBeCloseTo(1000, 5);
    });

    it('keeps a direct aluminum byproduct cycle sized while recycled water reduces only external water', () => {
      const alumina = recipe({
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
      });
      const scrap = recipe({
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
      });
      const ingot = recipe({
        id: 'ingot',
        durationSeconds: 4,
        inputs: [
          { itemId: 'aluminum-scrap', amount: 6 },
          { itemId: 'silica', amount: 5 },
        ],
        outputs: [{ itemId: 'aluminum-ingot', amount: 4 }],
      });
      const data = gameData([alumina, scrap, ingot]);
      const baseNodes: ProductionGraph['nodes'] = [
        { kind: 'source', id: 'bauxite', itemId: 'bauxite', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 1200 },
        { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'water', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 120 },
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
        { kind: 'source', id: 'quartz-silica', itemId: 'silica', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'alumina', recipeId: 'alumina' },
        { kind: 'recipe', id: 'scrap', recipeId: 'scrap' },
        { kind: 'recipe', id: 'ingot', recipeId: 'ingot' },
        { kind: 'sink', id: 'sink', itemId: 'aluminum-ingot', demandPerMin: 240 },
      ];
      const baseEdges: ProductionGraph['edges'] = [
        { id: 'bauxite-alumina', sourceId: 'bauxite', targetId: 'alumina', itemId: 'bauxite' },
        { id: 'water-alumina', sourceId: 'water-source', targetId: 'alumina', itemId: 'water' },
        { id: 'alumina-scrap', sourceId: 'alumina', targetId: 'scrap', itemId: 'alumina-solution' },
        { id: 'coal-scrap', sourceId: 'coal', targetId: 'scrap', itemId: 'coal' },
        { id: 'scrap-ingot', sourceId: 'scrap', targetId: 'ingot', itemId: 'aluminum-scrap' },
        { id: 'silica-ingot-main', sourceId: 'alumina', targetId: 'ingot', itemId: 'silica' },
        { id: 'silica-ingot-extra', sourceId: 'quartz-silica', targetId: 'ingot', itemId: 'silica' },
        { id: 'ingot-sink', sourceId: 'ingot', targetId: 'sink', itemId: 'aluminum-ingot' },
      ];

      const withoutRecycle = calculateRequiredPlan(normalizeGraph(graph({ nodes: baseNodes, edges: baseEdges })), data);
      const withRecycle = calculateRequiredPlan(normalizeGraph(graph({
        nodes: baseNodes,
        edges: [
          ...baseEdges,
          { id: 'scrap-water-alumina', sourceId: 'scrap', targetId: 'alumina', itemId: 'water' },
        ],
      })), data);

      expect(withoutRecycle.plan.alumina?.requiredMachines).toBeCloseTo(2, 5);
      expect(withoutRecycle.plan.scrap?.requiredMachines).toBeCloseTo(1, 5);
      expect(withoutRecycle.plan['water-source']?.requiredOutputs.water).toBeCloseTo(360, 5);

      expect(withRecycle.diagnostics.filter((d) => d.code === 'cycle')).toHaveLength(0);
      expect(withRecycle.plan.alumina?.requiredMachines).toBeCloseTo(2, 5);
      expect(withRecycle.plan.scrap?.requiredMachines).toBeCloseTo(1, 5);
      expect(withRecycle.plan.alumina?.requiredInputs.water).toBeCloseTo(360, 5);
      expect(withRecycle.plan.scrap?.requiredOutputs.water).toBeCloseTo(120, 5);
      expect(withRecycle.plan['water-source']?.requiredOutputs.water).toBeCloseTo(240, 5);
    });

    it('A↔B byproduct loop converges without cycle diagnostic', () => {
      const recipeA = recipe({
        id: 'recipe-a',
        durationSeconds: 6,
        inputs: [
          { itemId: 'input-a', amount: 1 },
          { itemId: 'shared', amount: 5 },
        ],
        outputs: [
          { itemId: 'output-a', amount: 1 },
          { itemId: 'waste-a', amount: 2 },
        ],
      });
      const recipeB = recipe({
        id: 'recipe-b',
        durationSeconds: 6,
        inputs: [
          { itemId: 'input-b', amount: 1 },
          { itemId: 'waste-a', amount: 3 },
        ],
        outputs: [
          { itemId: 'output-b', amount: 1 },
          { itemId: 'shared', amount: 4 },
        ],
      });
      const data = gameData([recipeA, recipeB]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'input-a', itemId: 'input-a', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'input-b', itemId: 'input-b', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'shared-source', itemId: 'shared', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'a', recipeId: 'recipe-a', machineCountOverride: 10 },
          { kind: 'recipe', id: 'b', recipeId: 'recipe-b', machineCountOverride: 5 },
          { kind: 'sink', id: 'sink-a', itemId: 'output-a', demandPerMin: 10 },
          { kind: 'sink', id: 'sink-b', itemId: 'output-b', demandPerMin: 5 },
        ],
        edges: [
          { id: 'ia-a', sourceId: 'input-a', targetId: 'a', itemId: 'input-a' },
          { id: 'ib-b', sourceId: 'input-b', targetId: 'b', itemId: 'input-b' },
          { id: 'shared-b', sourceId: 'shared-source', targetId: 'b', itemId: 'shared' },
          { id: 'waste-a-b', sourceId: 'a', targetId: 'b', itemId: 'waste-a' },
          { id: 'shared-a', sourceId: 'b', targetId: 'a', itemId: 'shared' },
          { id: 'out-a-sink', sourceId: 'a', targetId: 'sink-a', itemId: 'output-a' },
          { id: 'out-b-sink', sourceId: 'b', targetId: 'sink-b', itemId: 'output-b' },
        ],
      });

      const result = calculateRequiredPlan(normalizeGraph(g), data);

      expect(result.diagnostics.filter((d) => d.code === 'cycle')).toHaveLength(0);
      expect(result.plan.a?.requiredMachines).toBeGreaterThan(0);
      expect(result.plan.b?.requiredMachines).toBeGreaterThan(0);
      expect(Number.isFinite(result.plan.a?.requiredMachines)).toBe(true);
      expect(Number.isFinite(result.plan.b?.requiredMachines)).toBe(true);
    });

    it('incremental recompute updates downstream consumer when byproduct source changes', () => {
      const waterProducer = recipe({
        id: 'water-producer',
        durationSeconds: 6,
        inputs: [{ itemId: 'ore', amount: 1 }],
        outputs: [
          { itemId: 'ingot', amount: 1 },
          { itemId: 'water', amount: 20 },
        ],
      });
      const reactorRecipe = recipe({
        id: 'reactor',
        durationSeconds: 6,
        inputs: [{ itemId: 'water', amount: 10 }],
        outputs: [{ itemId: 'product', amount: 1 }],
      });
      const data = gameData([waterProducer, reactorRecipe]);
      const g = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 2.5 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 25 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const normalized = normalizeGraph(g);
      const first = calculateRequiredPlan(normalized, data);
      expect(first.plan['water-source']?.requiredOutputs.water).toBeCloseTo(500, 5);

      const g2 = graph({
        nodes: [
          { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
          { kind: 'source', id: 'water-source', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
          { kind: 'recipe', id: 'wp', recipeId: 'water-producer', machineCountOverride: 5 },
          { kind: 'recipe', id: 'reactor', recipeId: 'reactor', machineCountOverride: 10 },
          { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 50 },
        ],
        edges: [
          { id: 'ore-wp', sourceId: 'ore', targetId: 'wp', itemId: 'ore' },
          { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
          { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
          { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
        ],
      });

      const normalized2 = normalizeGraph(g2);
      const second = calculateRequiredPlan(normalized2, data, {
        previous: first.plan,
        dirtyNodeIds: ['wp'],
      });

      expect(second.plan['water-source']?.requiredOutputs.water).toBeCloseTo(0, 5);
    });
  });

  describe('tiered supply seeding (override priority over maximizeOutput)', () => {
    function tierData() {
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
      ]);
    }

    function tierGraph(overrides: { beamOverride?: number; pipeMaximize?: boolean; pipeOverride?: number }) {
      return graph({
        nodes: [
          { kind: 'source', id: 'ingot-source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 120 },
          {
            kind: 'recipe',
            id: 'beam-maker',
            recipeId: 'beam',
            ...(overrides.beamOverride != null ? { machineCountOverride: overrides.beamOverride } : {}),
          },
          {
            kind: 'recipe',
            id: 'pipe-maker',
            recipeId: 'pipe',
            ...(overrides.pipeMaximize ? { maximizeOutput: true } : {}),
            ...(overrides.pipeOverride != null ? { machineCountOverride: overrides.pipeOverride } : {}),
          },
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
    }

    it('sizes the maximized node to the remainder and keeps it supply-bound', () => {
      const normalized = normalizeGraph(tierGraph({ beamOverride: 3, pipeMaximize: true }));
      const result = calculateRequiredPlan(normalized, tierData());

      expect(result.diagnostics.filter((d) => d.code === 'cycle')).toHaveLength(0);
      expect(result.plan['beam-maker']?.requiredMachines).toBeCloseTo(3, 5);
      // 120 ingots minus the override's 90 leaves 30/min → 1 machine.
      expect(result.plan['pipe-maker']?.requiredMachines).toBeCloseTo(1, 4);
      expect(result.supplyBoundMaximizedNodeIds).toContain('pipe-maker');
      expect(result.fixedRequiredPlan?.['beam-maker']?.requiredMachines).toBeCloseTo(3, 5);
    });

    it('treats a maximize flag as inert when the same node has an override', () => {
      // The only maximize node is overridden, so tiered seeding must not run
      // and the plan matches the plain-override plan.
      const withInertMaximize = calculateRequiredPlan(
        normalizeGraph(tierGraph({ beamOverride: 2, pipeMaximize: true, pipeOverride: 1 })),
        tierData()
      );
      const withoutMaximize = calculateRequiredPlan(
        normalizeGraph(tierGraph({ beamOverride: 2, pipeOverride: 1 })),
        tierData()
      );

      expect(withInertMaximize.fixedRequiredPlan).toBeUndefined();
      expect(withInertMaximize.plan).toEqual(withoutMaximize.plan);
    });
  });
});
