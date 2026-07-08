import { describe, expect, it } from 'vitest';

import type { ProductionGraph } from '../types/production-graph';
import { normalizeGraph } from './normalize';

function graph(overrides: Partial<ProductionGraph> & Pick<ProductionGraph, 'nodes'>): ProductionGraph {
  return {
    schemaVersion: 2,
    edges: [],
    ...overrides,
  };
}

describe('normalizeGraph', () => {
  it('indexes a simple A -> B edge in both directions', () => {
    const g = graph({
      nodes: [
        { kind: 'recipe', id: 'A', recipeId: 'r1' },
        { kind: 'recipe', id: 'B', recipeId: 'r2' },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', itemId: 'item' }],
    });

    const normalized = normalizeGraph(g);

    expect(normalized.outgoingEdgesByNode.get('A')).toEqual([g.edges[0]]);
    expect(normalized.incomingEdgesByNode.get('B')).toEqual([g.edges[0]]);
    expect(normalized.incomingEdgesByNode.get('A')).toEqual([]);
    expect(normalized.outgoingEdgesByNode.get('B')).toEqual([]);
  });

  it('gives isolated nodes empty adjacency lists, not undefined', () => {
    const g = graph({ nodes: [{ kind: 'recipe', id: 'A', recipeId: 'r1' }], edges: [] });
    const normalized = normalizeGraph(g);

    expect(normalized.incomingEdgesByNode.get('A')).toEqual([]);
    expect(normalized.outgoingEdgesByNode.get('A')).toEqual([]);
  });

  it('round-trips every node through nodesById', () => {
    const g = graph({
      nodes: [
        { kind: 'recipe', id: 'A', recipeId: 'r1' },
        { kind: 'source', id: 'S', itemId: 'item', sourceType: 'resource-claim', maxRatePerMin: 60 },
      ],
      edges: [],
    });
    const normalized = normalizeGraph(g);

    expect(normalized.nodesById.get('A')).toBe(g.nodes[0]);
    expect(normalized.nodesById.get('S')).toBe(g.nodes[1]);
  });
});
