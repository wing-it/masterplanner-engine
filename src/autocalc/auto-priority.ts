import type { NormalizedGraph } from '../graph/normalize';
import type { ProductionEdge } from '../types/production-graph';

/**
 * Ranks the branches of a contested fork by downstream recipe-chain depth:
 * branches feeding deeper (more processed) products come first, so a shared
 * intermediate is not burned on simple items at the expense of complex ones.
 *
 * Returns null when every branch ties, leaving the caller's default
 * distribution in place. Callers consult this only when no manual routing
 * priority exists, so manual ranking always wins.
 */
export function autoRankContestedFork(
  itemEdges: readonly ProductionEdge[],
  normalized: NormalizedGraph
): ProductionEdge[] | null {
  if (itemEdges.length <= 1) return null;

  const cache = new Map<string, number>();
  const depths = itemEdges.map((edge) => branchDepth(edge.targetId, normalized, cache, new Set()));
  if (Math.max(...depths) === Math.min(...depths)) return null;

  return itemEdges
    .map((edge, index) => ({ edge, depth: depths[index]!, index }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map((entry) => entry.edge);
}

/** Longest count of recipe nodes from `nodeId` (inclusive) to any terminal. */
function branchDepth(
  nodeId: string,
  normalized: NormalizedGraph,
  cache: Map<string, number>,
  visiting: Set<string>
): number {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  if (visiting.has(nodeId)) return 0;

  const node = normalized.nodesById.get(nodeId);
  if (!node) return 0;

  const self = node.kind === 'recipe' ? 1 : 0;
  const outgoing = normalized.outgoingEdgesByNode.get(nodeId) ?? [];
  const nextVisiting = new Set(visiting);
  nextVisiting.add(nodeId);

  let deepest = 0;
  for (const edge of outgoing) {
    deepest = Math.max(deepest, branchDepth(edge.targetId, normalized, cache, nextVisiting));
  }

  const depth = self + deepest;
  cache.set(nodeId, depth);
  return depth;
}
