import { describe, expect, it } from 'vitest';

import { normalizeGraph } from '../graph/normalize';
import type { ProductionGraph } from '../types/production-graph';
import type { RequiredPlan } from './demand';
import { calculateConstraints } from './constraints';

function graph(overrides: Partial<ProductionGraph> & Pick<ProductionGraph, 'nodes'>): ProductionGraph {
  return {
    schemaVersion: 2,
    edges: [],
    ...overrides,
  };
}

describe('calculateConstraints', () => {
  it('keeps a fully supplied chain at scale 1', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 120 },
        { kind: 'recipe', id: 'smelter', recipeId: 'ingot' },
      ],
      edges: [{ id: 'ore', sourceId: 'source', targetId: 'smelter', itemId: 'ore' }],
    });
    const required: RequiredPlan = {
      source: { nodeId: 'source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 120 } },
      smelter: { nodeId: 'smelter', requiredMachines: 4, requiredInputs: { ore: 120 }, requiredOutputs: { ingot: 120 } },
    };

    const result = calculateConstraints(normalizeGraph(g), required);

    expect(result.globalScale).toBe(1);
    expect(result.plan.source?.scale).toBe(1);
    expect(result.plan.smelter?.scale).toBe(1);
  });

  it('uses source availability over required output as the bottleneck ratio', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'ingot' },
      ],
      edges: [{ id: 'ore', sourceId: 'source', targetId: 'smelter', itemId: 'ore' }],
    });
    const required: RequiredPlan = {
      source: { nodeId: 'source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 120 } },
      smelter: { nodeId: 'smelter', requiredMachines: 4, requiredInputs: { ore: 120 }, requiredOutputs: { ingot: 120 } },
    };

    const result = calculateConstraints(normalizeGraph(g), required);

    expect(result.globalScale).toBeCloseTo(0.5, 5);
    expect(result.plan.source?.sourceRatio).toBeCloseTo(0.5, 5);
    expect(result.plan.smelter?.scale).toBeCloseTo(0.5, 5);
  });

  it('uses the minimum ratio across multiple finite sources in a component', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 90 },
        { kind: 'source', id: 'coal-source', itemId: 'coal', sourceType: 'manual-input', maxRatePerMin: 30 },
        { kind: 'recipe', id: 'foundry', recipeId: 'steel' },
      ],
      edges: [
        { id: 'ore', sourceId: 'ore-source', targetId: 'foundry', itemId: 'ore' },
        { id: 'coal', sourceId: 'coal-source', targetId: 'foundry', itemId: 'coal' },
      ],
    });
    const required: RequiredPlan = {
      'ore-source': { nodeId: 'ore-source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 120 } },
      'coal-source': { nodeId: 'coal-source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { coal: 120 } },
      foundry: { nodeId: 'foundry', requiredMachines: 4, requiredInputs: { ore: 120, coal: 120 }, requiredOutputs: { steel: 120 } },
    };

    const result = calculateConstraints(normalizeGraph(g), required);

    expect(result.globalScale).toBeCloseTo(0.25, 5);
    expect(result.plan.foundry?.scale).toBeCloseTo(0.25, 5);
  });

  it('marks override nodes and their upstream suppliers immune while a sibling chain scales', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'override-source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 10 },
        { kind: 'recipe', id: 'override-recipe', recipeId: 'ingot', machineCountOverride: 4 },
        { kind: 'source', id: 'sibling-source', itemId: 'copper-ore', sourceType: 'manual-input', maxRatePerMin: 30 },
        { kind: 'recipe', id: 'sibling-recipe', recipeId: 'copper-ingot' },
      ],
      edges: [
        { id: 'override-ore', sourceId: 'override-source', targetId: 'override-recipe', itemId: 'ore' },
        { id: 'sibling-ore', sourceId: 'sibling-source', targetId: 'sibling-recipe', itemId: 'copper-ore' },
      ],
    });
    const required: RequiredPlan = {
      'override-source': { nodeId: 'override-source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 120 } },
      'override-recipe': { nodeId: 'override-recipe', requiredMachines: 4, requiredInputs: { ore: 120 }, requiredOutputs: { ingot: 120 } },
      'sibling-source': { nodeId: 'sibling-source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { 'copper-ore': 120 } },
      'sibling-recipe': { nodeId: 'sibling-recipe', requiredMachines: 4, requiredInputs: { 'copper-ore': 120 }, requiredOutputs: { 'copper-ingot': 120 } },
    };

    const result = calculateConstraints(normalizeGraph(g), required);

    expect(result.plan['override-source']?.immune).toBe(true);
    expect(result.plan['override-recipe']?.immune).toBe(true);
    expect(result.plan['override-source']?.scale).toBe(1);
    expect(result.plan['override-recipe']?.scale).toBe(1);
    expect(result.plan['sibling-recipe']?.scale).toBeCloseTo(0.25, 5);
  });

  it('propagates injected immune node ids to their upstream suppliers', () => {
    const g = graph({
      nodes: [
        { kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'ingot' },
      ],
      edges: [{ id: 'ore', sourceId: 'source', targetId: 'smelter', itemId: 'ore' }],
    });
    const required: RequiredPlan = {
      source: { nodeId: 'source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 120 } },
      smelter: { nodeId: 'smelter', requiredMachines: 4, requiredInputs: { ore: 120 }, requiredOutputs: { ingot: 120 } },
    };

    const scaled = calculateConstraints(normalizeGraph(g), required);
    expect(scaled.plan.smelter?.scale).toBeCloseTo(0.5, 5);

    const result = calculateConstraints(normalizeGraph(g), required, { immuneNodeIds: ['smelter'] });

    expect(result.plan.smelter?.immune).toBe(true);
    expect(result.plan.source?.immune).toBe(true);
    expect(result.plan.smelter?.scale).toBe(1);
    expect(result.plan.source?.scale).toBe(1);
  });

  it('ignores zero-demand sources for scale calculations', () => {
    const g = graph({
      nodes: [{ kind: 'source', id: 'source', itemId: 'ore', sourceType: 'manual-input', maxRatePerMin: 0 }],
    });
    const required: RequiredPlan = {
      source: { nodeId: 'source', requiredMachines: 0, requiredInputs: {}, requiredOutputs: { ore: 0 } },
    };

    const result = calculateConstraints(normalizeGraph(g), required);

    expect(result.globalScale).toBe(1);
    expect(result.plan.source?.scale).toBe(1);
    expect(result.plan.source?.sourceRatio).toBeUndefined();
  });
});
