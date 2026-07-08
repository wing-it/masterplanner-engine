import { describe, expect, it } from 'vitest';

import type { EngineGameData, EngineRecipeDefinition } from './game-data';
import {
  productionGraphSchema,
  productionGraphSchemaV1,
  migrateProductionGraph,
  validateProductionGraph,
  type ProductionGraph,
} from './production-graph';

function rate(itemId: string) {
  return {
    itemId,
    item: null,
    itemName: itemId,
    amount: 1,
    itemsPerMinute: 60,
    portVariant: 'solid' as const,
  };
}

function recipe(id: string, inputs: string[], outputs: string[]): EngineRecipeDefinition {
  return {
    id,
    name: id,
    slug: id,
    durationSeconds: 1,
    product: null,
    inputs: inputs.map(rate),
    outputs: outputs.map(rate),
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

const validGraph: ProductionGraph = {
  schemaVersion: 2,
  nodes: [
    { kind: 'source', id: 'ore-source', itemId: 'Desc_OreIron_C', sourceType: 'resource-claim', maxRatePerMin: 60 },
    { kind: 'recipe', id: 'smelter', recipeId: 'Recipe_IngotIron_C' },
  ],
  edges: [
    { id: 'ore-to-smelter', sourceId: 'ore-source', targetId: 'smelter', itemId: 'Desc_OreIron_C' },
  ],
};

describe('productionGraphSchema', () => {
  it('parses a valid graph', () => {
    expect(productionGraphSchema.parse(validGraph)).toEqual(validGraph);
  });

  it('round-trips through JSON serialization', () => {
    const parsed = productionGraphSchema.parse(JSON.parse(JSON.stringify(validGraph)));
    expect(parsed).toEqual(validGraph);
  });

  it('round-trips a source node with perExtractorRatePerMin', () => {
    const graph: ProductionGraph = {
      ...validGraph,
      nodes: [
        { kind: 'source', id: 'water-source', itemId: 'Desc_Water_C', sourceType: 'water', maxRatePerMin: 1_000_000_000, perExtractorRatePerMin: 120 },
        { kind: 'recipe', id: 'smelter', recipeId: 'Recipe_IngotIron_C' },
      ],
    };
    const parsed = productionGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
    expect(parsed).toEqual(graph);
  });

  it('round-trips a source node without perExtractorRatePerMin (backward-compat)', () => {
    const parsed = productionGraphSchema.parse(JSON.parse(JSON.stringify(validGraph)));
    expect(parsed).toEqual(validGraph);
  });

  it('round-trips a recipe node with maximizeOutput', () => {
    const graph: ProductionGraph = {
      ...validGraph,
      nodes: [
        { kind: 'source', id: 'ore-source', itemId: 'Desc_OreIron_C', sourceType: 'resource-claim', maxRatePerMin: 60 },
        { kind: 'recipe', id: 'smelter', recipeId: 'Recipe_IngotIron_C', maximizeOutput: true },
      ],
    };
    const parsed = productionGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
    expect(parsed).toEqual(graph);
  });
});

describe('migrateProductionGraph', () => {
  it('migrates v1 graph with grouping to v2 (drops grouping)', () => {
    const v1Graph = {
      schemaVersion: 1,
      nodes: validGraph.nodes,
      edges: validGraph.edges,
      grouping: [
        { nodeId: 'ore-source', factoryId: 'factory-a' },
        { nodeId: 'smelter', factoryId: 'factory-a' },
      ],
    };

    const result = migrateProductionGraph(v1Graph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(1);
      expect(result.graph.schemaVersion).toBe(2);
      expect(result.graph.nodes).toEqual(validGraph.nodes);
      expect(result.graph.edges).toEqual(validGraph.edges);
      expect((result.graph as unknown as Record<string, unknown>)['grouping']).toBeUndefined();
    }
  });

  it('passes v2 graphs through unchanged', () => {
    const result = migrateProductionGraph(validGraph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBeNull();
      expect(result.graph).toEqual(validGraph);
    }
  });

  it('rejects invalid documents', () => {
    const result = migrateProductionGraph({ schemaVersion: 99, bad: true });
    expect(result.ok).toBe(false);
  });
});

describe('validateProductionGraph', () => {
  it('rejects edges that reference missing nodes', () => {
    const result = validateProductionGraph({
      ...validGraph,
      edges: [{ ...validGraph.edges[0]!, targetId: 'missing' }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'missing-node', scope: { edgeId: 'ore-to-smelter', nodeId: 'missing' } }));
  });

  it('accepts and migrates v1 graphs with deprecated-schema warning', () => {
    const v1Graph = {
      schemaVersion: 1,
      nodes: validGraph.nodes,
      edges: validGraph.edges,
      grouping: [
        { nodeId: 'ore-source', factoryId: 'factory-a' },
      ],
    };
    const result = validateProductionGraph(v1Graph);

    expect(result.ok).toBe(true);
    expect(result.graph?.schemaVersion).toBe(2);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'deprecated-schema' }));
  });

  it('warns for edge item mismatches without failing validation', () => {
    const result = validateProductionGraph(
      {
        ...validGraph,
        edges: [{ ...validGraph.edges[0]!, itemId: 'Desc_CopperOre_C' }],
      },
      gameData([recipe('Recipe_IngotIron_C', ['Desc_OreIron_C'], ['Desc_IronIngot_C'])])
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'item-mismatch', scope: { edgeId: 'ore-to-smelter' } }));
  });
});
