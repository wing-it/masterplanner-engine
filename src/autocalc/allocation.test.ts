import { describe, expect, it } from 'vitest';

import { normalizeGraph } from '../graph/normalize';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph, ProductionNode } from '../types/production-graph';
import type { ActualPlan } from './actual';
import { allocateActualFlows, deriveRoutingCoverage, forkBranchesLeadToDifferentSinks } from './allocation';
import type { RequiredPlan } from './demand';

function recipe(opts: {
  id: string;
  durationSeconds?: number;
  inputs?: Array<{ itemId: string; amount: number }>;
  outputs?: Array<{ itemId: string; amount: number }>;
  product?: string | null;
}): EngineRecipeDefinition {
  const outputs = opts.outputs ?? [];
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds ?? 60,
    product: opts.product === undefined
      ? outputs[0] ? { id: outputs[0].itemId } : null
      : opts.product ? { id: opts.product } : null,
    inputs: opts.inputs ?? [],
    outputs,
    machine: null,
  };
}

function gameData(recipes: EngineRecipeDefinition[] = []): EngineGameData {
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

function requiredNode(
  nodeId: string,
  requiredInputs: Record<string, number>,
  requiredOutputs: Record<string, number> = {}
): RequiredPlan[string] {
  return {
    nodeId,
    requiredMachines: 0,
    requiredInputs,
    requiredOutputs,
  };
}

function actualNode(
  nodeId: string,
  actualOutputs: Record<string, number>,
  actualInputs: Record<string, number> = {}
): ActualPlan[string] {
  return {
    nodeId,
    requiredMachines: 0,
    actualMachines: 0,
    scale: 1,
    requiredInputs: actualInputs,
    actualInputs,
    requiredOutputs: actualOutputs,
    actualOutputs,
  };
}

describe('allocateActualFlows', () => {
  it('splits reconverging recipe forks proportionally by branch demand', () => {
    const g = graph({
      nodes: [
        { kind: 'recipe', id: 'screw', recipeId: 'screw' },
        { kind: 'recipe', id: 'a', recipeId: 'consumer-a' },
        { kind: 'recipe', id: 'b', recipeId: 'consumer-b' },
        { kind: 'sink', id: 'sink', itemId: 'part' },
      ],
      edges: [
        { id: 'screw-a', sourceId: 'screw', targetId: 'a', itemId: 'screw' },
        { id: 'screw-b', sourceId: 'screw', targetId: 'b', itemId: 'screw' },
        { id: 'a-sink', sourceId: 'a', targetId: 'sink', itemId: 'part' },
        { id: 'b-sink', sourceId: 'b', targetId: 'sink', itemId: 'part' },
      ],
    });
    const required: RequiredPlan = {
      screw: requiredNode('screw', {}, { screw: 200 }),
      a: requiredNode('a', { screw: 120 }),
      b: requiredNode('b', { screw: 80 }),
      sink: requiredNode('sink', { part: 1 }),
    };
    const actual: ActualPlan = {
      screw: actualNode('screw', { screw: 120 }),
      a: actualNode('a', { part: 1 }),
      b: actualNode('b', { part: 1 }),
      sink: actualNode('sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData([
      recipe({ id: 'screw', outputs: [{ itemId: 'screw', amount: 200 }] }),
    ]));

    expect(result.edges['screw-a']?.allocation).toBeCloseTo(72, 5);
    expect(result.edges['screw-b']?.allocation).toBeCloseTo(48, 5);
    expect(result.edges['screw-a']?.demandedRate).toBeCloseTo(120, 5);
    expect(result.edges['screw-b']?.deficitRate).toBeCloseTo(32, 5);
  });

  it('redistributes unused equal share from capped fixed-source branches', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'sink', id: 'a', itemId: 'ore' },
        { kind: 'sink', id: 'b', itemId: 'ore' },
        { kind: 'sink', id: 'c', itemId: 'ore' },
      ],
      edges: [
        { id: 'source-a', sourceId: 'source', targetId: 'a', itemId: 'ore' },
        { id: 'source-b', sourceId: 'source', targetId: 'b', itemId: 'ore' },
        { id: 'source-c', sourceId: 'source', targetId: 'c', itemId: 'ore' },
      ],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { ore: 120 }),
      a: requiredNode('a', { ore: 30 }),
      b: requiredNode('b', { ore: 90 }),
      c: requiredNode('c', { ore: 90 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { ore: 120 }),
      a: actualNode('a', {}),
      b: actualNode('b', {}),
      c: actualNode('c', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData());

    expect(result.edges['source-a']?.allocation).toBeCloseTo(30, 5);
    expect(result.edges['source-b']?.allocation).toBeCloseTo(45, 5);
    expect(result.edges['source-c']?.allocation).toBeCloseTo(45, 5);
  });

  it('handles the coal boundary-equality fork with saturating redistribution', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'resource-claim', maxRatePerMin: 60 },
        { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'resource-claim', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
        { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
        { kind: 'recipe', id: 'compacted-power', recipeId: 'compacted-generator' },
        { kind: 'sink', id: 'direct-sink', itemId: 'power-a' },
        { kind: 'sink', id: 'compacted-sink', itemId: 'power-b' },
      ],
      edges: [
        { id: 'coal-direct', sourceId: 'coal', targetId: 'direct', itemId: 'coal' },
        { id: 'coal-compacted', sourceId: 'coal', targetId: 'compacted', itemId: 'coal' },
        { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
        { id: 'compacted-power', sourceId: 'compacted', targetId: 'compacted-power', itemId: 'compacted-coal' },
        { id: 'direct-sink', sourceId: 'direct', targetId: 'direct-sink', itemId: 'power-a' },
        { id: 'compacted-sink', sourceId: 'compacted-power', targetId: 'compacted-sink', itemId: 'power-b' },
      ],
    });
    const required: RequiredPlan = {
      coal: requiredNode('coal', {}, { coal: 120 }),
      sulfur: requiredNode('sulfur', {}, { sulfur: 60 }),
      direct: requiredNode('direct', { coal: 60 }),
      compacted: requiredNode('compacted', { coal: 60, sulfur: 60 }, { 'compacted-coal': 60 }),
      'compacted-power': requiredNode('compacted-power', { 'compacted-coal': 60 }),
      'direct-sink': requiredNode('direct-sink', { 'power-a': 1 }),
      'compacted-sink': requiredNode('compacted-sink', { 'power-b': 1 }),
    };
    const actual: ActualPlan = {
      coal: actualNode('coal', { coal: 60 }),
      sulfur: actualNode('sulfur', { sulfur: 60 }),
      direct: actualNode('direct', { 'power-a': 1 }),
      compacted: actualNode('compacted', { 'compacted-coal': 60 }),
      'compacted-power': actualNode('compacted-power', { 'power-b': 1 }),
      'direct-sink': actualNode('direct-sink', {}),
      'compacted-sink': actualNode('compacted-sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData([
      recipe({ id: 'coal-generator', inputs: [{ itemId: 'coal', amount: 60 }], outputs: [{ itemId: 'power-a', amount: 1 }] }),
      recipe({
        id: 'compacted-coal',
        inputs: [{ itemId: 'coal', amount: 60 }, { itemId: 'sulfur', amount: 60 }],
        outputs: [{ itemId: 'compacted-coal', amount: 60 }],
      }),
      recipe({
        id: 'compacted-generator',
        inputs: [{ itemId: 'compacted-coal', amount: 60 }],
        outputs: [{ itemId: 'power-b', amount: 1 }],
      }),
    ]));

    expect(result.edges['coal-direct']?.allocation).toBeCloseTo(30, 5);
    expect(result.edges['coal-compacted']?.allocation).toBeCloseTo(30, 5);
    expect(result.edges['coal-direct']?.suppliedRate).toBeCloseTo(60, 5);
    expect(result.edges['coal-compacted']?.suppliedRate).toBeCloseTo(60, 5);
  });

  it('splits a divergent source fork evenly by default', () => {
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
    const required: RequiredPlan = {
      coal: requiredNode('coal', {}, { coal: 1200 }),
      sulfur: requiredNode('sulfur', {}, { sulfur: 750 }),
      direct: requiredNode('direct', { coal: 600 }),
      compacted: requiredNode('compacted', { coal: 600, sulfur: 600 }, { 'compacted-coal': 600 }),
    };
    const actual: ActualPlan = {
      coal: actualNode('coal', { coal: 1200 }),
      sulfur: actualNode('sulfur', { sulfur: 750 }),
      direct: actualNode('direct', {}),
      compacted: actualNode('compacted', { 'compacted-coal': 600 }),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData([
      recipe({ id: 'coal-generator', durationSeconds: 4, inputs: [{ itemId: 'coal', amount: 1 }], outputs: [], product: null }),
      recipe({
        id: 'compacted-coal',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }, { itemId: 'sulfur', amount: 1 }],
        outputs: [{ itemId: 'compacted-coal', amount: 1 }],
      }),
    ]));

    expect(result.edges['coal-direct']?.allocation).toBeCloseTo(600, 5);
    expect(result.edges['coal-compacted']?.allocation).toBeCloseTo(600, 5);
  });

  it('fills a prioritized branch up to physical capacity before redistributing the remainder', () => {
    const routing = { portSide: 'output' as const, portId: 'out', priority: ['coal-compacted'] };
    const g = graph({
      nodes: [
        { kind: 'source', id: 'coal', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 1200 },
        { kind: 'source', id: 'sulfur', itemId: 'sulfur', sourceType: 'manual-input', maxRatePerMin: 750 },
        { kind: 'recipe', id: 'direct', recipeId: 'coal-generator' },
        { kind: 'recipe', id: 'compacted', recipeId: 'compacted-coal' },
      ],
      edges: [
        { id: 'coal-direct', sourceId: 'coal', targetId: 'direct', itemId: 'coal', routing },
        { id: 'coal-compacted', sourceId: 'coal', targetId: 'compacted', itemId: 'coal', routing },
        { id: 'sulfur-compacted', sourceId: 'sulfur', targetId: 'compacted', itemId: 'sulfur' },
      ],
    });
    const required: RequiredPlan = {
      coal: requiredNode('coal', {}, { coal: 1200 }),
      sulfur: requiredNode('sulfur', {}, { sulfur: 750 }),
      direct: requiredNode('direct', { coal: 450 }),
      compacted: requiredNode('compacted', { coal: 750, sulfur: 750 }, { 'compacted-coal': 750 }),
    };
    const actual: ActualPlan = {
      coal: actualNode('coal', { coal: 1200 }),
      sulfur: actualNode('sulfur', { sulfur: 750 }),
      direct: actualNode('direct', {}),
      compacted: actualNode('compacted', { 'compacted-coal': 750 }),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData([
      recipe({ id: 'coal-generator', durationSeconds: 4, inputs: [{ itemId: 'coal', amount: 1 }], outputs: [], product: null }),
      recipe({
        id: 'compacted-coal',
        durationSeconds: 4,
        inputs: [{ itemId: 'coal', amount: 1 }, { itemId: 'sulfur', amount: 1 }],
        outputs: [{ itemId: 'compacted-coal', amount: 1 }],
      }),
    ]));

    expect(result.edges['coal-compacted']?.allocation).toBeCloseTo(750, 5);
    expect(result.edges['coal-direct']?.allocation).toBeCloseTo(450, 5);
  });

  it('fills ranked peers first and redistributes the remainder in hybrid mode', () => {
    const routing = { portSide: 'output' as const, portId: 'out', priority: ['a'] };
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'item', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'sink', id: 'a', itemId: 'item' },
        { kind: 'sink', id: 'b', itemId: 'item' },
        { kind: 'sink', id: 'c', itemId: 'item' },
      ],
      edges: [
        { id: 'source-a', sourceId: 'source', targetId: 'a', itemId: 'item', routing },
        { id: 'source-b', sourceId: 'source', targetId: 'b', itemId: 'item', routing },
        { id: 'source-c', sourceId: 'source', targetId: 'c', itemId: 'item', routing },
      ],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { item: 120 }),
      a: requiredNode('a', { item: 90 }),
      b: requiredNode('b', { item: 60 }),
      c: requiredNode('c', { item: 60 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { item: 120 }),
      a: actualNode('a', {}),
      b: actualNode('b', {}),
      c: actualNode('c', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData());

    expect(deriveRoutingCoverage(g.edges)).toBe('partial');
    expect(result.edges['source-a']?.allocation).toBeCloseTo(90, 5);
    expect(result.edges['source-b']?.allocation).toBeCloseTo(15, 5);
    expect(result.edges['source-c']?.allocation).toBeCloseTo(15, 5);
  });

  it('uses pure priority ordering when every peer is ranked', () => {
    const routing = { portSide: 'output' as const, portId: 'out', priority: ['a', 'b', 'c'] };
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'item', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'sink', id: 'a', itemId: 'item' },
        { kind: 'sink', id: 'b', itemId: 'item' },
        { kind: 'sink', id: 'c', itemId: 'item' },
      ],
      edges: [
        { id: 'source-a', sourceId: 'source', targetId: 'a', itemId: 'item', routing },
        { id: 'source-b', sourceId: 'source', targetId: 'b', itemId: 'item', routing },
        { id: 'source-c', sourceId: 'source', targetId: 'c', itemId: 'item', routing },
      ],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { item: 120 }),
      a: requiredNode('a', { item: 90 }),
      b: requiredNode('b', { item: 60 }),
      c: requiredNode('c', { item: 60 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { item: 120 }),
      a: actualNode('a', {}),
      b: actualNode('b', {}),
      c: actualNode('c', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData());

    expect(deriveRoutingCoverage(g.edges)).toBe('full');
    expect(result.edges['source-a']?.allocation).toBeCloseTo(90, 5);
    expect(result.edges['source-b']?.allocation).toBeCloseTo(30, 5);
    expect(result.edges['source-c']?.allocation).toBeCloseTo(0, 5);
  });

  it('ranks a consumer whose engine endpoint was rewritten, via its authored alias', () => {
    // The app ranks the AUTHORED boundary port id; flattening rewrote the edge
    // target to a `sink:` node, so only the alias can match.
    const routing = { portSide: 'output' as const, portId: 'out', priority: ['out-port', 'packager'] };
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'item', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'sink', id: 'sink:factory-1:out-port', itemId: 'item' },
        { kind: 'sink', id: 'packager', itemId: 'item' },
      ],
      edges: [
        {
          id: 'source-export',
          sourceId: 'source',
          targetId: 'sink:factory-1:out-port',
          itemId: 'item',
          authoredTargetId: 'out-port',
          routing,
        },
        { id: 'source-packager', sourceId: 'source', targetId: 'packager', itemId: 'item', routing },
      ],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { item: 120 }),
      'sink:factory-1:out-port': requiredNode('sink:factory-1:out-port', { item: 90 }),
      packager: requiredNode('packager', { item: 90 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { item: 120 }),
      'sink:factory-1:out-port': actualNode('sink:factory-1:out-port', {}),
      packager: actualNode('packager', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData());

    expect(deriveRoutingCoverage(g.edges)).toBe('full');
    expect(result.edges['source-export']?.allocation).toBeCloseTo(90, 5);
    expect(result.edges['source-packager']?.allocation).toBeCloseTo(30, 5);
  });

  it('serves every branch demand in full before splitting a divergent fork surplus', () => {
    // Aluminum-ingot fan-out, 2026-07-22: an over-producing exporter split
    // between a large and a tiny consumer must not equal-share the output —
    // the big branch read 1665 of its 2060 (phantom shortage) while the small
    // branch drowned in 1665 against a 61.5 demand.
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ingot', sourceType: 'manual-input', maxRatePerMin: 3780 },
        { kind: 'recipe', id: 'big', recipeId: 'big-consumer' },
        { kind: 'recipe', id: 'small', recipeId: 'small-consumer' },
      ],
      edges: [
        { id: 'to-big', sourceId: 'source', targetId: 'big', itemId: 'ingot' },
        { id: 'to-small', sourceId: 'source', targetId: 'small', itemId: 'ingot' },
      ],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { ingot: 3780 }),
      big: requiredNode('big', { ingot: 2060 }, { ficsite: 2060 }),
      small: requiredNode('small', { ingot: 61.5 }, { packaged: 61.5 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { ingot: 3780 }),
      big: actualNode('big', { ficsite: 2060 }),
      small: actualNode('small', { packaged: 61.5 }),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData([
      recipe({ id: 'big-consumer', durationSeconds: 4, inputs: [{ itemId: 'ingot', amount: 1 }], outputs: [{ itemId: 'ficsite', amount: 1 }] }),
      recipe({ id: 'small-consumer', durationSeconds: 4, inputs: [{ itemId: 'ingot', amount: 1 }], outputs: [{ itemId: 'packaged', amount: 1 }] }),
    ]));

    expect(result.edges['to-big']?.allocation).toBeGreaterThanOrEqual(2060 - 1e-5);
    expect(result.edges['to-small']?.allocation).toBeGreaterThanOrEqual(61.5 - 1e-5);
  });

  it('divides demand across same-item fan-in so a target is not double-counted', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source-a', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'source', id: 'source-b', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'sink', id: 'sink', itemId: 'ore' },
      ],
      edges: [
        { id: 'a-sink', sourceId: 'source-a', targetId: 'sink', itemId: 'ore' },
        { id: 'b-sink', sourceId: 'source-b', targetId: 'sink', itemId: 'ore' },
      ],
    });
    const required: RequiredPlan = {
      'source-a': requiredNode('source-a', {}, { ore: 60 }),
      'source-b': requiredNode('source-b', {}, { ore: 60 }),
      sink: requiredNode('sink', { ore: 120 }),
    };
    const actual: ActualPlan = {
      'source-a': actualNode('source-a', { ore: 60 }),
      'source-b': actualNode('source-b', { ore: 60 }),
      sink: actualNode('sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData());

    expect(result.edges['a-sink']?.demandedRate).toBeCloseTo(60, 5);
    expect(result.edges['b-sink']?.demandedRate).toBeCloseTo(60, 5);
    expect(result.edges['a-sink']?.allocation).toBeCloseTo(60, 5);
    expect(result.edges['b-sink']?.allocation).toBeCloseTo(60, 5);
  });

  it('reports touched edge ids against a previous allocation result', () => {
    const source: ProductionNode = {
      kind: 'source',
      id: 'source',
      itemId: 'ore',
      sourceType: 'manual-input',
      maxRatePerMin: 60,
    };
    const g = graph({
      nodes: [source, { kind: 'sink', id: 'sink', itemId: 'ore' }],
      edges: [{ id: 'edge', sourceId: 'source', targetId: 'sink', itemId: 'ore' }],
    });
    const required: RequiredPlan = {
      source: requiredNode('source', {}, { ore: 60 }),
      sink: requiredNode('sink', { ore: 60 }),
    };
    const actual: ActualPlan = {
      source: actualNode('source', { ore: 60 }),
      sink: actualNode('sink', {}),
    };
    const previous = allocateActualFlows(normalizeGraph(g), required, actual, gameData()).edges;

    const result = allocateActualFlows(normalizeGraph(g), required, actual, gameData(), { previous });

    expect(result.touchedEdgeIds).toEqual([]);
  });
});

describe('byproduct-aware allocation', () => {
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
        inputs: [
          { itemId: 'residue', amount: 1 },
          { itemId: 'water', amount: 10 },
        ],
        outputs: [{ itemId: 'product', amount: 1 }],
      }),
    ];
  }

  it('allocates byproduct edge first and resource-claim edge gets remainder', () => {
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

    const required: RequiredPlan = {
      oil: requiredNode('oil', {}, { 'crude-oil': 999 }),
      'water-source': requiredNode('water-source', {}, { water: 10000 }),
      refinery: requiredNode('refinery', { 'crude-oil': 300 }, { plastic: 200, residue: 400 }),
      reactor: requiredNode('reactor', { residue: 100, water: 1000 }, { product: 100 }),
      'plastic-sink': requiredNode('plastic-sink', { plastic: 200 }),
    };
    const actual: ActualPlan = {
      oil: actualNode('oil', { 'crude-oil': 300 }),
      'water-source': actualNode('water-source', { water: 1000 }),
      refinery: actualNode('refinery', { plastic: 200, residue: 400 }),
      reactor: actualNode('reactor', { product: 100 }),
      'plastic-sink': actualNode('plastic-sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, data);

    expect(result.edges['residue-reactor']?.allocation).toBeCloseTo(100, 5);
    expect(result.edges['water-reactor']?.allocation).toBeCloseTo(1000, 5);
    expect(result.edges['residue-reactor']?.demandedRate).toBeCloseTo(100, 5);
    expect(result.edges['water-reactor']?.demandedRate).toBeCloseTo(1000, 5);
  });

  it('allocates same-item byproduct first and reduces resource-claim allocation', () => {
    const data = gameData(byproductRecipes());
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
        { id: 'ww-reactor', sourceId: 'wp', targetId: 'reactor', itemId: 'water' },
        { id: 'water-reactor', sourceId: 'water-source', targetId: 'reactor', itemId: 'water' },
        { id: 'ingot-sink', sourceId: 'wp', targetId: 'ingot-sink', itemId: 'ingot' },
      ],
    });

    const required: RequiredPlan = {
      ore: requiredNode('ore', {}, { ore: 999 }),
      'water-source': requiredNode('water-source', {}, { water: 10000 }),
      wp: requiredNode('wp', { ore: 25 }, { ingot: 50, water: 500 }),
      reactor: requiredNode('reactor', { water: 1000 }, { product: 100 }),
      'ingot-sink': requiredNode('ingot-sink', { ingot: 50 }),
    };
    const actual: ActualPlan = {
      ore: actualNode('ore', { ore: 25 }),
      'water-source': actualNode('water-source', { water: 500 }),
      wp: actualNode('wp', { ingot: 50, water: 500 }),
      reactor: actualNode('reactor', { product: 100 }),
      'ingot-sink': actualNode('ingot-sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, data);

    expect(result.edges['ww-reactor']?.allocation).toBeCloseTo(500, 5);
    expect(result.edges['water-reactor']?.allocation).toBeCloseTo(500, 5);
  });

  it('caps byproduct allocation at demand when supply exceeds need', () => {
    const data = gameData(byproductRecipes());
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

    const required: RequiredPlan = {
      ore: requiredNode('ore', {}, { ore: 999 }),
      'water-source': requiredNode('water-source', {}, { water: 10000 }),
      wp: requiredNode('wp', { ore: 250 }, { ingot: 500, water: 5000 }),
      reactor: requiredNode('reactor', { water: 100 }, { product: 10 }),
      'ingot-sink': requiredNode('ingot-sink', { ingot: 500 }),
    };
    const actual: ActualPlan = {
      ore: actualNode('ore', { ore: 250 }),
      'water-source': actualNode('water-source', { water: 0 }),
      wp: actualNode('wp', { ingot: 500, water: 5000 }),
      reactor: actualNode('reactor', { product: 10 }),
      'ingot-sink': actualNode('ingot-sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, data);

    expect(result.edges['ww-reactor']?.allocation).toBeCloseTo(100, 5);
    expect(result.edges['water-reactor']?.allocation).toBeCloseTo(0, 5);
  });

  it('splits byproduct equally between two consumers', () => {
    const data = gameData(byproductRecipes());
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 999 },
        { kind: 'source', id: 'water-1', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
        { kind: 'source', id: 'water-2', itemId: 'water', sourceType: 'resource-claim', maxRatePerMin: 10000, perExtractorRatePerMin: 10000 },
        { kind: 'recipe', id: 'wp', recipeId: 'wastewater-producer', machineCountOverride: 2.5 },
        { kind: 'recipe', id: 'reactor-1', recipeId: 'reactor', machineCountOverride: 10 },
        { kind: 'recipe', id: 'reactor-2', recipeId: 'reactor', machineCountOverride: 10 },
        { kind: 'sink', id: 'ingot-sink', itemId: 'ingot', demandPerMin: 25 },
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

    const required: RequiredPlan = {
      ore: requiredNode('ore', {}, { ore: 999 }),
      'water-1': requiredNode('water-1', {}, { water: 10000 }),
      'water-2': requiredNode('water-2', {}, { water: 10000 }),
      wp: requiredNode('wp', { ore: 12.5 }, { ingot: 25, 'waste-water': 2000 }),
      'reactor-1': requiredNode('reactor-1', { 'waste-water': 1000, water: 1000 }, { product: 100 }),
      'reactor-2': requiredNode('reactor-2', { 'waste-water': 1000, water: 1000 }, { product: 100 }),
      'ingot-sink': requiredNode('ingot-sink', { ingot: 25 }),
    };
    const actual: ActualPlan = {
      ore: actualNode('ore', { ore: 12.5 }),
      'water-1': actualNode('water-1', { water: 1000 }),
      'water-2': actualNode('water-2', { water: 1000 }),
      wp: actualNode('wp', { ingot: 25, 'waste-water': 2000 }),
      'reactor-1': actualNode('reactor-1', { product: 100 }),
      'reactor-2': actualNode('reactor-2', { product: 100 }),
      'ingot-sink': actualNode('ingot-sink', {}),
    };

    const result = allocateActualFlows(normalizeGraph(g), required, actual, data);

    expect(result.edges['ww-r1']?.allocation).toBeCloseTo(1000, 5);
    expect(result.edges['ww-r2']?.allocation).toBeCloseTo(1000, 5);
    expect(result.edges['water-r1']?.allocation).toBeCloseTo(1000, 5);
    expect(result.edges['water-r2']?.allocation).toBeCloseTo(1000, 5);
  });
});

describe('forkBranchesLeadToDifferentSinks with cycles', () => {
  it('does not treat a fork as divergent when branches share a sink only through a cycle node', () => {
    // F forks to A and B. N sits in a cycle with A (A→N→A) and is also fed by
    // B; every terminal N reaches goes through A. With a shared per-call cache,
    // computing branch A first used to cache N's terminals as the truncated
    // empty set, so branch B appeared to reach only its own sink and the fork
    // was misclassified as divergent.
    const g = graph({
      nodes: [
        { kind: 'source', id: 'F', itemId: 'shared', sourceType: 'manual-input', maxRatePerMin: 100 },
        { kind: 'recipe', id: 'A', recipeId: 'ra' },
        { kind: 'recipe', id: 'B', recipeId: 'rb' },
        { kind: 'recipe', id: 'N', recipeId: 'rn' },
        { kind: 'sink', id: 'S1', itemId: 'p1', demandPerMin: 10 },
        { kind: 'sink', id: 'S2', itemId: 'p2', demandPerMin: 10 },
      ],
      edges: [
        { id: 'f-a', sourceId: 'F', targetId: 'A', itemId: 'shared' },
        { id: 'f-b', sourceId: 'F', targetId: 'B', itemId: 'shared' },
        { id: 'a-n', sourceId: 'A', targetId: 'N', itemId: 'x' },
        { id: 'n-a', sourceId: 'N', targetId: 'A', itemId: 'y' },
        { id: 'a-s1', sourceId: 'A', targetId: 'S1', itemId: 'p1' },
        { id: 'b-n', sourceId: 'B', targetId: 'N', itemId: 'x' },
        { id: 'b-s2', sourceId: 'B', targetId: 'S2', itemId: 'p2' },
      ],
    });
    const normalized = normalizeGraph(g);
    const forkEdges = (normalized.outgoingEdgesByNode.get('F') ?? []).filter((e) => e.itemId === 'shared');

    expect(forkBranchesLeadToDifferentSinks(forkEdges, normalized, new Map())).toBe(false);
  });

  it('caches complete terminal sets normally on acyclic graphs', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'F', itemId: 'shared', sourceType: 'manual-input', maxRatePerMin: 100 },
        { kind: 'recipe', id: 'A', recipeId: 'ra' },
        { kind: 'recipe', id: 'B', recipeId: 'rb' },
        { kind: 'sink', id: 'S1', itemId: 'p1', demandPerMin: 10 },
        { kind: 'sink', id: 'S2', itemId: 'p2', demandPerMin: 10 },
      ],
      edges: [
        { id: 'f-a', sourceId: 'F', targetId: 'A', itemId: 'shared' },
        { id: 'f-b', sourceId: 'F', targetId: 'B', itemId: 'shared' },
        { id: 'a-s1', sourceId: 'A', targetId: 'S1', itemId: 'p1' },
        { id: 'b-s2', sourceId: 'B', targetId: 'S2', itemId: 'p2' },
      ],
    });
    const normalized = normalizeGraph(g);
    const forkEdges = (normalized.outgoingEdgesByNode.get('F') ?? []).filter((e) => e.itemId === 'shared');
    const cache = new Map<string, Set<string>>();

    expect(forkBranchesLeadToDifferentSinks(forkEdges, normalized, cache)).toBe(true);
    expect(cache.get('A')).toEqual(new Set(['S1']));
    expect(cache.get('B')).toEqual(new Set(['S2']));
  });
});
