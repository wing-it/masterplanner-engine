import type { ProductionEdge } from '../types/production-graph';

/**
 * Every id a routing `priority` entry may legally name for this edge.
 *
 * The app authors priorities against PLANNER ids, but flattening rewrites
 * endpoints (a world output port becomes a `sink:` node, a factory link's
 * target becomes the remote recipe, a subfactory port becomes the inner
 * recipe). The builder records what it rewrote in `authoredSourceId` /
 * `authoredTargetId`, so matching must consider those too — otherwise a
 * ranked boundary consumer is permanently unrankable and the split falls back
 * to an even share.
 */
export function edgeIdentifiers(edge: ProductionEdge): string[] {
  const identifiers = [edge.id, edge.sourceId, edge.targetId];
  if (edge.authoredSourceId) identifiers.push(edge.authoredSourceId);
  if (edge.authoredTargetId) identifiers.push(edge.authoredTargetId);
  return identifiers;
}

export function matchesIdentifier(edge: ProductionEdge, identifier: string): boolean {
  return (
    edge.id === identifier ||
    edge.sourceId === identifier ||
    edge.targetId === identifier ||
    edge.authoredSourceId === identifier ||
    edge.authoredTargetId === identifier
  );
}
