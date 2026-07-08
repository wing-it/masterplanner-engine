import type { NormalizedGraph } from '../graph/normalize';
import { itemsMatch } from '../graph/recipe-math';
import type { NodeId, ProductionNode } from '../types/production-graph';
import type { RequiredPlan } from './demand';

const DEFAULT_SCALE = 1;

export interface ConstraintPlanNode {
  nodeId: NodeId;
  scale: number;
  immune: boolean;
  componentId: number;
  sourceRatio?: number;
}

export type ConstraintPlan = Record<NodeId, ConstraintPlanNode>;

export interface ConstraintResult {
  plan: ConstraintPlan;
  globalScale: number;
  componentScales: Record<number, number>;
  immuneNodeIds: NodeId[];
}

export interface ConstraintOptions {
  /**
   * Extra scaling-immune nodes (e.g. supply-bound maximized recipes from the
   * demand pass). Immunity propagates upstream from these, same as for nodes
   * with explicit output overrides.
   */
  immuneNodeIds?: Iterable<NodeId>;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCALE;
  return Math.max(0, Math.min(1, value));
}

function hasOutputOverride(node: ProductionNode): boolean {
  return node.kind === 'recipe' && (
    node.machineCountOverride != null ||
    node.productionRateOverride != null
  );
}

function getRequiredOutput(requiredPlan: RequiredPlan, nodeId: NodeId, itemId: string): number {
  const outputs = requiredPlan[nodeId]?.requiredOutputs ?? {};
  if (outputs[itemId] !== undefined) return outputs[itemId]!;

  for (const [key, value] of Object.entries(outputs)) {
    if (itemsMatch(key, itemId)) return value;
  }

  return 0;
}

function buildUpstreamOfOverrideSet(
  normalized: NormalizedGraph,
  extraImmuneNodeIds: Iterable<NodeId>
): Set<NodeId> {
  const immune = new Set<NodeId>();
  const queue: NodeId[] = [];

  for (const node of normalized.nodes) {
    if (!hasOutputOverride(node)) continue;
    immune.add(node.id);
    queue.push(node.id);
  }

  for (const nodeId of extraImmuneNodeIds) {
    if (immune.has(nodeId) || !normalized.nodesById.has(nodeId)) continue;
    immune.add(nodeId);
    queue.push(nodeId);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
      if (immune.has(edge.sourceId)) continue;
      immune.add(edge.sourceId);
      queue.push(edge.sourceId);
    }
  }

  return immune;
}

function calculateComponents(normalized: NormalizedGraph): Map<NodeId, number> {
  const components = new Map<NodeId, number>();
  let nextComponentId = 0;

  for (const node of normalized.nodes) {
    if (components.has(node.id)) continue;

    const componentId = nextComponentId;
    nextComponentId += 1;
    const queue = [node.id];
    components.set(node.id, componentId);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const edges = [
        ...(normalized.incomingEdgesByNode.get(nodeId) ?? []),
        ...(normalized.outgoingEdgesByNode.get(nodeId) ?? []),
      ];

      for (const edge of edges) {
        for (const neighborId of [edge.sourceId, edge.targetId]) {
          if (components.has(neighborId) || !normalized.nodesById.has(neighborId)) continue;
          components.set(neighborId, componentId);
          queue.push(neighborId);
        }
      }
    }
  }

  return components;
}

export function calculateConstraints(
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  options: ConstraintOptions = {}
): ConstraintResult {
  const immune = buildUpstreamOfOverrideSet(normalized, options.immuneNodeIds ?? []);

  const components = calculateComponents(normalized);
  const componentScales = new Map<number, number>();
  let globalScale = DEFAULT_SCALE;

  for (const node of normalized.nodes) {
    const componentId = components.get(node.id) ?? 0;
    componentScales.set(componentId, componentScales.get(componentId) ?? DEFAULT_SCALE);
  }

  const sourceRatios = new Map<NodeId, number>();
  for (const node of normalized.nodes) {
    if (node.kind !== 'source') continue;

    const requiredRate = getRequiredOutput(requiredPlan, node.id, node.itemId);
    if (requiredRate <= 0) continue;

    const ratio = clampScale(node.maxRatePerMin / requiredRate);
    sourceRatios.set(node.id, ratio);

    if (immune.has(node.id)) continue;
    const componentId = components.get(node.id) ?? 0;
    const nextComponentScale = Math.min(componentScales.get(componentId) ?? DEFAULT_SCALE, ratio);
    componentScales.set(componentId, nextComponentScale);
    globalScale = Math.min(globalScale, ratio);
  }

  const plan: ConstraintPlan = {};
  for (const node of normalized.nodes) {
    const componentId = components.get(node.id) ?? 0;
    const nodeIsImmune = immune.has(node.id);
    plan[node.id] = {
      nodeId: node.id,
      scale: nodeIsImmune ? DEFAULT_SCALE : componentScales.get(componentId) ?? DEFAULT_SCALE,
      immune: nodeIsImmune,
      componentId,
      sourceRatio: sourceRatios.get(node.id),
    };
  }

  return {
    plan,
    globalScale,
    componentScales: Object.fromEntries(componentScales.entries()),
    immuneNodeIds: [...immune],
  };
}
