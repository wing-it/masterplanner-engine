import { describe, expect, it } from 'vitest';

import type { EngineBuildingPowerProfile, EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { AutocalcResult, ChangeOrigin } from '../types/autocalc';
import type { ProductionGraph, ProductionNode } from '../types/production-graph';
import type { PowerInput } from '../types/power';
import { computePower } from './solve-power';
import { powerLayer } from './power-layer';
import { DEFAULT_POWER_EXPONENT } from './power-math';

function makeRecipeNode(
  id: string,
  recipeId: string,
  overrides: Partial<Omit<ProductionNode, 'kind' | 'id' | 'recipeId'>> = {},
): ProductionNode {
  return {
    kind: 'recipe',
    id,
    recipeId,
    clockPercent: 100,
    somersloopsInstalled: 0,
    ...overrides,
  };
}

function makeSourceNode(id: string, itemId: string): ProductionNode {
  return {
    kind: 'source',
    id,
    itemId,
    sourceType: 'manual-input',
    maxRatePerMin: 60,
  };
}

function makeGraph(nodes: ProductionNode[]): ProductionGraph {
  return {
    schemaVersion: 2,
    nodes,
    edges: [],
  };
}

function makeAutocalc(
  nodes: Record<string, AutocalcResult['nodes'][string]>,
): AutocalcResult {
  return {
    schemaVersion: 1,
    nodes,
    edges: {},
  };
}

function makeRecipe(id: string, machineId: string): EngineRecipeDefinition {
  return {
    id,
    name: id,
    durationSeconds: 1,
    product: { id: 'item' },
    inputs: [],
    outputs: [{ itemId: 'item', amount: 1 }],
    machine: { id: machineId },
  };
}

function makeConsumerProfile(
  buildingId: string,
  basePowerMw: number,
  overrides: Partial<EngineBuildingPowerProfile> = {},
): EngineBuildingPowerProfile {
  return {
    buildingId,
    role: 'consumer',
    basePowerMw,
    powerExponent: DEFAULT_POWER_EXPONENT,
    generatorScalesLinearly: false,
    powerShardSlots: 0,
    somersloopSlots: 0,
    maxClockPercent: 250,
    supportsSomersloop: false,
    ...overrides,
  };
}

function makeGeneratorProfile(
  buildingId: string,
  baseGeneratedMw: number,
): EngineBuildingPowerProfile {
  return {
    buildingId,
    role: 'generator',
    baseGeneratedMw,
    powerExponent: DEFAULT_POWER_EXPONENT,
    generatorScalesLinearly: true,
    powerShardSlots: 0,
    somersloopSlots: 0,
    maxClockPercent: 250,
    supportsSomersloop: false,
  };
}

function makeGameData(
  profiles: EngineBuildingPowerProfile[],
  recipes: EngineRecipeDefinition[],
): EngineGameData {
  return {
    recipes,
    generatorRecipes: [],
    buildingPowerById: new Map(profiles.map((profile) => [profile.buildingId, profile])),
  };
}

function makePowerInput(graph: ProductionGraph, autocalc: AutocalcResult): PowerInput {
  return { graph, autocalc };
}

describe('computePower', () => {
  it('returns an all-zero world for an empty graph', () => {
    const { result, diagnostics } = computePower(
      makePowerInput(makeGraph([]), makeAutocalc({})),
      makeGameData([], []),
    );

    expect(diagnostics).toHaveLength(0);
    expect(result.nodes).toEqual({});
    expect(result.world).toEqual({ drawMw: 0, genMw: 0, netMw: 0 });
  });

  it('computes consumer draw and world net', () => {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('smelt2', 'iron-ingot', { clockPercent: 200 }),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 2, scale: 1, inputs: [], outputs: [] },
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4)],
      [makeRecipe('iron-ingot', 'smelter')],
    );

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toHaveLength(0);
    expect(result.nodes.smelt1).toEqual({ role: 'consumer', drawMw: 8, genMw: 0 });
    expect(result.nodes.smelt2.drawMw).toBeCloseTo(4 * Math.pow(2, DEFAULT_POWER_EXPONENT), 5);
    expect(result.world.drawMw).toBeCloseTo(8 + 4 * Math.pow(2, DEFAULT_POWER_EXPONENT), 5);
    expect(result.world.netMw).toBeCloseTo(-result.world.drawMw, 5);
  });

  it('computes generator generation', () => {
    const graph = makeGraph([makeRecipeNode('gen1', 'coal-power')]);
    const autocalc = makeAutocalc({
      gen1: { machines: 2, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeGeneratorProfile('coal-gen', 75)],
      [makeRecipe('coal-power', 'coal-gen')],
    );

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toHaveLength(0);
    expect(result.nodes.gen1).toEqual({ role: 'generator', drawMw: 0, genMw: 150 });
    expect(result.world.genMw).toBeCloseTo(150, 5);
    expect(result.world.netMw).toBeCloseTo(150, 5);
  });

  it('computes mixed consumer/generator graph', () => {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('gen1', 'coal-power'),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4), makeGeneratorProfile('coal-gen', 75)],
      [makeRecipe('iron-ingot', 'smelter'), makeRecipe('coal-power', 'coal-gen')],
    );

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toHaveLength(0);
    expect(result.nodes.smelt1).toEqual({ role: 'consumer', drawMw: 4, genMw: 0 });
    expect(result.nodes.gen1).toEqual({ role: 'generator', drawMw: 0, genMw: 75 });
    expect(result.world).toEqual({ drawMw: 4, genMw: 75, netMw: 71 });
  });

  it('applies overclock and somersloop amplification', () => {
    const graph = makeGraph([
      makeRecipeNode('n1', 'r1', { clockPercent: 150, somersloopsInstalled: 2 }),
    ]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('b1', 4, { somersloopSlots: 4, supportsSomersloop: true })],
      [makeRecipe('r1', 'b1')],
    );

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toHaveLength(0);
    const expected = 4 * Math.pow(1.5, DEFAULT_POWER_EXPONENT) * Math.pow(1.5, 2);
    expect(result.nodes.n1.drawMw).toBeCloseTo(expected, 5);
  });

  it('ignores source/sink nodes', () => {
    const graph = makeGraph([
      makeSourceNode('src1', 'iron-ore'),
      makeRecipeNode('smelt1', 'iron-ingot'),
    ]);
    const autocalc = makeAutocalc({
      src1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4)],
      [makeRecipe('iron-ingot', 'smelter')],
    );

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toHaveLength(0);
    expect(result.nodes.src1).toBeUndefined();
    expect(result.nodes.smelt1).toEqual({ role: 'consumer', drawMw: 4, genMw: 0 });
  });

  it('emits a diagnostic and contributes 0 for a missing recipe', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'missing-recipe')]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });

    const { result, diagnostics } = computePower(
      makePowerInput(graph, autocalc),
      makeGameData([], []),
    );

    expect(diagnostics).toEqual([
      {
        layerId: 'power',
        severity: 'error',
        code: 'missing-recipe',
        scope: { nodeId: 'n1' },
        message: 'Recipe missing-recipe not found for node n1.',
      },
    ]);
    expect(result.nodes.n1).toBeUndefined();
    expect(result.world).toEqual({ drawMw: 0, genMw: 0, netMw: 0 });
  });

  it('emits a diagnostic and contributes 0 for a missing machine', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'r1')]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData([], [
      {
        id: 'r1',
        name: 'r1',
        durationSeconds: 1,
        product: { id: 'item' },
        inputs: [],
        outputs: [{ itemId: 'item', amount: 1 }],
        machine: null,
      },
    ]);

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toEqual([
      {
        layerId: 'power',
        severity: 'error',
        code: 'missing-machine',
        scope: { nodeId: 'n1' },
        message: 'Recipe r1 has no machine for node n1.',
      },
    ]);
    expect(result.nodes.n1).toBeUndefined();
    expect(result.world).toEqual({ drawMw: 0, genMw: 0, netMw: 0 });
  });

  it('emits a diagnostic and contributes 0 for a missing power profile', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'r1')]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData([], [makeRecipe('r1', 'unknown-building')]);

    const { result, diagnostics } = computePower(makePowerInput(graph, autocalc), gameData);

    expect(diagnostics).toEqual([
      {
        layerId: 'power',
        severity: 'error',
        code: 'no-power-profile',
        scope: { nodeId: 'n1' },
        message: 'No power profile for building unknown-building on node n1.',
      },
    ]);
    expect(result.nodes.n1).toBeUndefined();
    expect(result.world).toEqual({ drawMw: 0, genMw: 0, netMw: 0 });
  });
});

describe('computePower incremental', () => {
  it('recomputes only the edited node and preserves reference equality for untouched nodes', () => {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('smelt2', 'iron-ingot', { clockPercent: 200 }),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4)],
      [makeRecipe('iron-ingot', 'smelter')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);

    const editedGraph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot', { clockPercent: 150 }),
      makeRecipeNode('smelt2', 'iron-ingot', { clockPercent: 200 }),
    ]);
    const incremental = computePower(
      {
        graph: editedGraph,
        autocalc,
        previous: base.result,
        origin: { type: 'recipe-node', nodeId: 'smelt1' },
        autocalcTouched: [],
      },
      gameData,
    );

    expect(incremental.result.nodes.smelt2).toBe(base.result.nodes.smelt2);
    expect(incremental.result.nodes.smelt1).not.toBe(base.result.nodes.smelt1);
    expect(incremental.result.nodes.smelt1.drawMw).toBeCloseTo(
      4 * Math.pow(1.5, DEFAULT_POWER_EXPONENT),
      5,
    );

    const expected = computePower(makePowerInput(editedGraph, autocalc), gameData).result;
    expect(incremental.result.world.drawMw).toBeCloseTo(expected.world.drawMw, 5);
    expect(incremental.result.world.genMw).toBeCloseTo(expected.world.genMw, 5);
    expect(incremental.result.world.netMw).toBeCloseTo(expected.world.netMw, 5);
    expect(incremental.touchedNodeIds).toEqual(['smelt1']);
  });

  it('touches zero nodes on a no-op value edit', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'r1', { clockPercent: 150 })]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('b1', 4)],
      [makeRecipe('r1', 'b1')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);
    const incremental = computePower(
      {
        graph,
        autocalc,
        previous: base.result,
        origin: { type: 'recipe-node', nodeId: 'n1' },
        autocalcTouched: [],
      },
      gameData,
    );

    expect(incremental.touchedNodeIds).toEqual([]);
    expect(incremental.result.nodes.n1).not.toBe(base.result.nodes.n1);
    expect(incremental.result.nodes.n1).toEqual(base.result.nodes.n1);
    expect(incremental.result.world.drawMw).toBeCloseTo(base.result.world.drawMw, 5);
    expect(incremental.result.world.genMw).toBeCloseTo(base.result.world.genMw, 5);
  });

  it('subtracts a removed node from the world rollup', () => {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('smelt2', 'iron-ingot'),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4)],
      [makeRecipe('iron-ingot', 'smelter')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);

    const editedGraph = makeGraph([makeRecipeNode('smelt2', 'iron-ingot')]);
    const editedAutocalc = makeAutocalc({
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const incremental = computePower(
      {
        graph: editedGraph,
        autocalc: editedAutocalc,
        previous: base.result,
        origin: { type: 'recipe-node', nodeId: 'smelt1' },
        autocalcTouched: [],
      },
      gameData,
    );

    const expected = computePower(makePowerInput(editedGraph, editedAutocalc), gameData).result;
    expect(incremental.result.nodes.smelt1).toBeUndefined();
    expect(incremental.result.nodes.smelt2).toBe(base.result.nodes.smelt2);
    expect(incremental.result.world.drawMw).toBeCloseTo(expected.world.drawMw, 5);
    expect(incremental.result.world.netMw).toBeCloseTo(expected.world.netMw, 5);
    expect(incremental.touchedNodeIds).toContain('smelt1');
    expect(incremental.touchedNodeIds).not.toContain('smelt2');
  });

  it('adds a new node to the world rollup', () => {
    const graph = makeGraph([makeRecipeNode('smelt1', 'iron-ingot')]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4)],
      [makeRecipe('iron-ingot', 'smelter')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);

    const editedGraph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('smelt2', 'iron-ingot'),
    ]);
    const editedAutocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const incremental = computePower(
      {
        graph: editedGraph,
        autocalc: editedAutocalc,
        previous: base.result,
        origin: { type: 'recipe-node', nodeId: 'smelt2' },
        autocalcTouched: ['smelt2'],
      },
      gameData,
    );

    const expected = computePower(makePowerInput(editedGraph, editedAutocalc), gameData).result;
    expect(incremental.result.nodes.smelt1).toBe(base.result.nodes.smelt1);
    expect(incremental.result.nodes.smelt2).not.toBe(base.result.nodes.smelt2);
    expect(incremental.result.world.drawMw).toBeCloseTo(expected.world.drawMw, 5);
    expect(incremental.touchedNodeIds).toContain('smelt2');
  });

  it('deep-equals a full recompute across a fixture set', () => {
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4), makeGeneratorProfile('coal-gen', 75)],
      [makeRecipe('iron-ingot', 'smelter'), makeRecipe('coal-power', 'coal-gen')],
    );

    const fixtures: {
      name: string;
      base: PowerInput;
      edited: PowerInput;
      origin: ChangeOrigin;
      autocalcTouched: string[];
    }[] = [
      {
        name: 'clock change on consumer',
        base: makePowerInput(
          makeGraph([
            makeRecipeNode('smelt1', 'iron-ingot'),
            makeRecipeNode('gen1', 'coal-power'),
          ]),
          makeAutocalc({
            smelt1: { machines: 2, scale: 1, inputs: [], outputs: [] },
            gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        edited: makePowerInput(
          makeGraph([
            makeRecipeNode('smelt1', 'iron-ingot', { clockPercent: 150 }),
            makeRecipeNode('gen1', 'coal-power'),
          ]),
          makeAutocalc({
            smelt1: { machines: 2, scale: 1, inputs: [], outputs: [] },
            gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        origin: { type: 'recipe-node', nodeId: 'smelt1' },
        autocalcTouched: [],
      },
      {
        name: 'machine count change on consumer and generator',
        base: makePowerInput(
          makeGraph([
            makeRecipeNode('smelt1', 'iron-ingot'),
            makeRecipeNode('gen1', 'coal-power'),
          ]),
          makeAutocalc({
            smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
            gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        edited: makePowerInput(
          makeGraph([
            makeRecipeNode('smelt1', 'iron-ingot'),
            makeRecipeNode('gen1', 'coal-power'),
          ]),
          makeAutocalc({
            smelt1: { machines: 3, scale: 1, inputs: [], outputs: [] },
            gen1: { machines: 2, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        origin: { type: 'recipe-node', nodeId: 'smelt1' },
        autocalcTouched: ['smelt1', 'gen1'],
      },
      {
        name: 'add generator node',
        base: makePowerInput(
          makeGraph([makeRecipeNode('smelt1', 'iron-ingot')]),
          makeAutocalc({
            smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        edited: makePowerInput(
          makeGraph([
            makeRecipeNode('smelt1', 'iron-ingot'),
            makeRecipeNode('gen1', 'coal-power'),
          ]),
          makeAutocalc({
            smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
            gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
          }),
        ),
        origin: { type: 'recipe-node', nodeId: 'gen1' },
        autocalcTouched: ['gen1'],
      },
    ];

    for (const fixture of fixtures) {
      const baseResult = computePower(fixture.base, gameData).result;
      const expected = computePower(fixture.edited, gameData).result;
      const incremental = computePower(
        {
          ...fixture.edited,
          previous: baseResult,
          origin: fixture.origin,
          autocalcTouched: fixture.autocalcTouched,
        },
        gameData,
      );

      expect(incremental.result.nodes, fixture.name).toEqual(expected.nodes);
      expect(incremental.result.world.drawMw, fixture.name).toBeCloseTo(
        expected.world.drawMw,
        5,
      );
      expect(incremental.result.world.genMw, fixture.name).toBeCloseTo(
        expected.world.genMw,
        5,
      );
      expect(incremental.result.world.netMw, fixture.name).toBeCloseTo(
        expected.world.netMw,
        5,
      );
    }
  });

  it('treats edge changes without machine changes as no-op', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'r1')]);
    const autocalc = makeAutocalc({
      n1: { machines: 2, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('b1', 4)],
      [makeRecipe('r1', 'b1')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);

    const incremental = computePower(
      {
        graph,
        autocalc,
        previous: base.result,
        origin: { type: 'edge', edgeId: 'e1' },
        autocalcTouched: [],
      },
      gameData,
    );

    expect(incremental.touchedNodeIds).toEqual([]);
    expect(incremental.result.nodes.n1).toBe(base.result.nodes.n1);
    expect(incremental.result.world.drawMw).toBeCloseTo(base.result.world.drawMw, 5);
    expect(incremental.result.world.genMw).toBeCloseTo(base.result.world.genMw, 5);
  });

  it('does a full recompute when origin type is full', () => {
    const graph = makeGraph([makeRecipeNode('n1', 'r1')]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('b1', 4)],
      [makeRecipe('r1', 'b1')],
    );

    const base = computePower(makePowerInput(graph, autocalc), gameData);
    const result = computePower(
      {
        graph,
        autocalc,
        previous: base.result,
        origin: { type: 'full' },
        autocalcTouched: [],
      },
      gameData,
    );

    expect(result.touchedNodeIds).toEqual(['n1']);
    expect(result.result.nodes.n1).not.toBe(base.result.nodes.n1);
    expect(result.result.nodes.n1).toEqual(base.result.nodes.n1);
  });
});

describe('powerLayer', () => {
  function makeInput(): PowerInput {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('gen1', 'coal-power'),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    return makePowerInput(graph, autocalc);
  }

  function makeGameDataForLayer(): EngineGameData {
    return makeGameData(
      [makeConsumerProfile('smelter', 4), makeGeneratorProfile('coal-gen', 75)],
      [makeRecipe('iron-ingot', 'smelter'), makeRecipe('coal-power', 'coal-gen')],
    );
  }

  it('wraps computePower in a LayerResult', async () => {
    const result = await powerLayer.compute(makeInput(), makeGameDataForLayer());

    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.diagnostics).toHaveLength(0);
    expect(result.meta.layerId).toBe('power');
    expect(result.meta.inputHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(result.data!.world).toEqual({ drawMw: 4, genMw: 75, netMw: 71 });
  });

  it('changes the input hash when a node clock changes', () => {
    const gameData = makeGameDataForLayer();
    const input1 = makeInput();
    const input2 = {
      ...input1,
      graph: makeGraph([
        makeRecipeNode('smelt1', 'iron-ingot', { clockPercent: 200 }),
        makeRecipeNode('gen1', 'coal-power'),
      ]),
    };

    const hash1 = powerLayer.inputHash(input1, gameData);
    const hash2 = powerLayer.inputHash(input2, gameData);

    expect(hash1).not.toBe(hash2);
  });

  it('does not change the input hash when only edges change', () => {
    const gameData = makeGameDataForLayer();
    const baseInput = makeInput();

    const input1 = {
      ...baseInput,
      graph: {
        ...baseInput.graph,
        edges: [{ id: 'e1', sourceId: 'smelt1', targetId: 'gen1', itemId: 'iron-ingot' }],
      },
    };
    const input2 = {
      ...baseInput,
      graph: {
        ...baseInput.graph,
        edges: [{ id: 'e2', sourceId: 'gen1', targetId: 'smelt1', itemId: 'coal' }],
      },
    };

    const hash1 = powerLayer.inputHash(input1, gameData);
    const hash2 = powerLayer.inputHash(input2, gameData);

    expect(hash1).toBe(hash2);
  });

  it('forwards diagnostics from computePower', async () => {
    const graph = makeGraph([makeRecipeNode('n1', 'missing-recipe')]);
    const autocalc = makeAutocalc({
      n1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const result = await powerLayer.compute(makePowerInput(graph, autocalc), makeGameData([], []));

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      layerId: 'power',
      severity: 'error',
      code: 'missing-recipe',
      scope: { nodeId: 'n1' },
    });
  });

  it('forwards touchedNodeIds in layer meta', async () => {
    const graph = makeGraph([
      makeRecipeNode('smelt1', 'iron-ingot'),
      makeRecipeNode('gen1', 'coal-power'),
    ]);
    const autocalc = makeAutocalc({
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      gen1: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const gameData = makeGameData(
      [makeConsumerProfile('smelter', 4), makeGeneratorProfile('coal-gen', 75)],
      [makeRecipe('iron-ingot', 'smelter'), makeRecipe('coal-power', 'coal-gen')],
    );
    const input: PowerInput = { graph, autocalc };
    const base = await powerLayer.compute(input, gameData);

    const editedInput: PowerInput = {
      graph: makeGraph([
        makeRecipeNode('smelt1', 'iron-ingot', { clockPercent: 200 }),
        makeRecipeNode('gen1', 'coal-power'),
      ]),
      autocalc,
      previous: base.data!,
      origin: { type: 'recipe-node', nodeId: 'smelt1' },
      autocalcTouched: [],
    };
    const result = await powerLayer.compute(editedInput, gameData);

    expect(result.meta.touchedNodeIds).toEqual(['smelt1']);
  });
});
