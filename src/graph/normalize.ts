import type { NodeId, ProductionEdge, ProductionGraph, ProductionNode } from '../types/production-graph';

export interface NormalizedGraph {
  nodes: ProductionNode[];
  edges: ProductionEdge[];
  nodesById: Map<NodeId, ProductionNode>;
  incomingEdgesByNode: Map<NodeId, ProductionEdge[]>;
  outgoingEdgesByNode: Map<NodeId, ProductionEdge[]>;
}

/**
 * Builds O(1) adjacency indices over a flat production graph. The graph is
 * flat by construction (v2 schema has no grouping), so this is pure
 * index-building.
 */
export function normalizeGraph(graph: ProductionGraph): NormalizedGraph {
  const nodesById = new Map<NodeId, ProductionNode>();
  const incomingEdgesByNode = new Map<NodeId, ProductionEdge[]>();
  const outgoingEdgesByNode = new Map<NodeId, ProductionEdge[]>();

  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
    incomingEdgesByNode.set(node.id, []);
    outgoingEdgesByNode.set(node.id, []);
  }

  for (const edge of graph.edges) {
    outgoingEdgesByNode.get(edge.sourceId)?.push(edge);
    incomingEdgesByNode.get(edge.targetId)?.push(edge);
  }

  return {
    nodes: graph.nodes,
    edges: graph.edges,
    nodesById,
    incomingEdgesByNode,
    outgoingEdgesByNode,
  };
}
