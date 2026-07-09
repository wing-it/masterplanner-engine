import type { NormalizedGraph } from '../graph/normalize';
import { findRecipe, itemsMatch, ratePerMachine } from '../graph/recipe-math';
import { autoRankContestedFork } from './auto-priority';
import { classifyIncomingEdges, isFixedByproductEdge } from './recycling';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { NodeId, ProductionEdge, ProductionNode } from '../types/production-graph';
import type { ActualPlan } from './actual';
import type { RequiredPlan } from './demand';
import { waterFill } from './water-fill';

const DEFAULT_EPSILON = 1e-6;

export interface EdgeAllocation {
  demandedRate: number;
  suppliedRate: number;
  deficitRate: number;
  allocation: number;
}

export interface AllocationResult {
  edges: Record<string, EdgeAllocation>;
  touchedEdgeIds: string[];
}

export interface AllocationOptions {
  previous?: Record<string, EdgeAllocation>;
  dirtyNodeIds?: Iterable<NodeId>;
  epsilon?: number;
  /**
   * Fixed-demand baseline from the demand pass (present when tiered supply
   * seeding ran). Divergent-fork redistribution reserves these rates per
   * branch before equal-share splitting so override/explicit-demand chains
   * cannot be starved by maximize-driven siblings.
   */
  fixedRequiredPlan?: RequiredPlan;
  /**
   * Opt-in: on contested forks without manual routing priority, rank branches
   * by downstream recipe depth so complex products win the shared input.
   */
  autoPrioritizeContestedForks?: boolean;
}

type RoutingCoverage = 'none' | 'partial' | 'full';

function getRecordValue(record: Readonly<Record<string, number>>, itemId: string): number {
  if (record[itemId] !== undefined) return record[itemId]!;
  for (const [key, value] of Object.entries(record)) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function getNodeOutputRate(
  node: ProductionNode,
  actualPlan: ActualPlan,
  itemId: string
): number {
  const actualOutput = getRecordValue(actualPlan[node.id]?.actualOutputs ?? {}, itemId);
  if (node.kind !== 'source') return actualOutput;
  return Math.min(node.maxRatePerMin, actualOutput);
}

function byproductEdgeCap(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData
): number {
  const sourceNode = normalized.nodesById.get(edge.sourceId);
  if (!sourceNode) return 0;

  const supply = getNodeOutputRate(sourceNode, actualPlan, edge.itemId);
  if (supply <= DEFAULT_EPSILON) return 0;

  const siblingEdges = (normalized.outgoingEdgesByNode.get(edge.sourceId) ?? [])
    .filter((candidate) =>
      itemsMatch(candidate.itemId, edge.itemId) &&
      isFixedByproductEdge(candidate, normalized, gameData)
    );
  if (siblingEdges.length <= 1) return supply;

  const weights = siblingEdges.map((candidate) => {
    const targetDemand = getRecordValue(requiredPlan[candidate.targetId]?.requiredInputs ?? {}, candidate.itemId);
    return { edge: candidate, weight: targetDemand };
  });
  const totalWeight = weights.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (totalWeight <= DEFAULT_EPSILON) return supply / siblingEdges.length;

  const ownWeight = weights.find((entry) => entry.edge.id === edge.id)?.weight ?? 0;
  return supply * (Math.max(0, ownWeight) / totalWeight);
}

/**
 * Fixed-plan demand attributed to a single edge, mirroring the demand pass's
 * same-item fan-in split (getBranchDemandFromPlan). Used to net a shared
 * source's reserved outflow out of its advertised capacity below.
 */
function fixedBranchDemand(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  fixedRequiredPlan: RequiredPlan
): number {
  const targetPlan = fixedRequiredPlan[edge.targetId];
  if (!targetPlan) return 0;
  const targetDemand = getRecordValue(targetPlan.requiredInputs, edge.itemId);
  if (targetDemand <= DEFAULT_EPSILON) return 0;
  const fanIn = (normalized.incomingEdgesByNode.get(edge.targetId) ?? []).filter((candidate) =>
    itemsMatch(candidate.itemId, edge.itemId)
  ).length;
  return fanIn > 0 ? targetDemand / fanIn : targetDemand;
}

/**
 * Supply a source can actually deliver along `edge` for the fan's water-fill:
 * its full output minus the demand it must reserve for its OTHER outgoing edges
 * that feed fixed-demand consumers. Without the netting, a source shared
 * between this pool and a fixed sibling (e.g. an override machine count)
 * advertises its whole output here; the share it cannot deliver is then never
 * redistributed to siblings that still have spare capacity, leaving the pool
 * under-filled (each unshared sibling capped at an even split it never needed).
 */
function elasticEdgeCapacity(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  actualPlan: ActualPlan,
  fixedRequiredPlan?: RequiredPlan
): number {
  const source = normalized.nodesById.get(edge.sourceId);
  if (!source || (source.kind !== 'source' && source.kind !== 'recipe')) return 0;
  const total = getNodeOutputRate(source, actualPlan, edge.itemId);
  if (!fixedRequiredPlan) return total;

  const committedElsewhere = (normalized.outgoingEdgesByNode.get(source.id) ?? [])
    .filter((other) => other.id !== edge.id && itemsMatch(other.itemId, edge.itemId))
    .reduce((sum, other) => sum + fixedBranchDemand(other, normalized, fixedRequiredPlan), 0);
  return Math.max(0, total - committedElsewhere);
}

function getEdgeDemand(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData,
  fixedRequiredPlan?: RequiredPlan
): number {
  const targetPlan = requiredPlan[edge.targetId];
  if (!targetPlan) return 0;

  const targetDemand = getRecordValue(targetPlan.requiredInputs, edge.itemId);
  const incoming = normalized.incomingEdgesByNode.get(edge.targetId) ?? [];
  const relevantEdges = incoming.filter((candidate) => itemsMatch(candidate.itemId, edge.itemId));

  if (relevantEdges.length <= 1) return targetDemand;

  const tiers = classifyIncomingEdges(relevantEdges, normalized, gameData);
  let remaining = targetDemand;
  const edgeDemands = new Map<string, number>();

  for (const tier of tiers) {
    const byproductInTier = tier.filter((e) => isFixedByproductEdge(e, normalized, gameData));
    const elasticInTier = tier.filter((e) => !isFixedByproductEdge(e, normalized, gameData) && !e.routing?.overflow);
    const overflowInTier = tier.filter((e) => e.routing?.overflow);

    let byproductAllocated = 0;
    if (byproductInTier.length > 0) {
      const byproductCaps = new Map<string, number>();
      let totalByproductCap = 0;
      for (const bpEdge of byproductInTier) {
        const cap = byproductEdgeCap(bpEdge, normalized, requiredPlan, actualPlan, gameData);
        byproductCaps.set(bpEdge.id, cap);
        totalByproductCap += cap;
      }
      byproductAllocated = Math.min(totalByproductCap, remaining);
      remaining -= byproductAllocated;

      if (totalByproductCap > 0) {
        for (const bpEdge of byproductInTier) {
          const edgeCap = byproductCaps.get(bpEdge.id) ?? 0;
          edgeDemands.set(bpEdge.id, byproductAllocated * (edgeCap / totalByproductCap));
        }
      }
    }

    if (elasticInTier.length > 0) {
      const allocated = remaining;
      remaining = 0;
      const capacities = elasticInTier.map((elEdge) =>
        elasticEdgeCapacity(elEdge, normalized, actualPlan, fixedRequiredPlan)
      );
      const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);

      if (elasticInTier.length > 1 && totalCapacity > DEFAULT_EPSILON) {
        // Mirror the demand-side split: pull evenly, cap each branch at what
        // its source actually produces, redistribute the rest.
        const { allocations: fill } = waterFill(
          elasticInTier.map((elEdge, index) => ({ id: elEdge.id, cap: capacities[index]! })),
          Math.min(allocated, totalCapacity),
          DEFAULT_EPSILON
        );
        for (const elEdge of elasticInTier) {
          edgeDemands.set(elEdge.id, fill.get(elEdge.id) ?? 0);
        }
      } else {
        for (const elEdge of elasticInTier) {
          edgeDemands.set(elEdge.id, allocated / elasticInTier.length);
        }
      }
    }

    if (overflowInTier.length > 0 && remaining > 0) {
      const allocated = remaining;
      remaining = 0;
      const splitRate = allocated / overflowInTier.length;
      for (const ovEdge of overflowInTier) {
        edgeDemands.set(ovEdge.id, splitRate);
      }
    }
  }

  for (const e of relevantEdges) {
    if (!edgeDemands.has(e.id)) {
      edgeDemands.set(e.id, 0);
    }
  }

  return edgeDemands.get(edge.id) ?? 0;
}

function rankForEdge(edge: ProductionEdge, relevantEdges: readonly ProductionEdge[]): number | null {
  const priorities = relevantEdges
    .map((candidate) => candidate.routing?.priority ?? [])
    .find((priority) => priority.length > 0) ?? [];
  if (priorities.length === 0) return null;

  const identifiers = [edge.id, edge.sourceId, edge.targetId];
  for (const identifier of identifiers) {
    const rank = priorities.indexOf(identifier);
    if (rank >= 0) return rank;
  }

  for (const peerId of priorities) {
    const peerIndex = relevantEdges.findIndex((candidate) =>
      candidate.id === peerId || candidate.sourceId === peerId || candidate.targetId === peerId
    );
    if (peerIndex >= 0 && relevantEdges[peerIndex]?.id === edge.id) {
      return priorities.indexOf(peerId);
    }
  }

  return null;
}

export function deriveRoutingCoverage(edges: readonly ProductionEdge[]): RoutingCoverage {
  const rankedCount = edges.filter((edge) => rankForEdge(edge, edges) != null).length;
  if (rankedCount === 0) return 'none';
  return rankedCount === edges.length ? 'full' : 'partial';
}

function sortByRoutingRank(edges: readonly ProductionEdge[]): ProductionEdge[] {
  return edges
    .map((edge, index) => ({ edge, index, rank: rankForEdge(edge, edges) }))
    .sort((left, right) => {
      const leftRank = left.rank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.rank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map((entry) => entry.edge);
}

export function findTerminalSinkIds(
  startNodeId: string,
  normalized: NormalizedGraph,
  cache: Map<string, Set<string>> = new Map(),
  visiting: Set<string> = new Set()
): Set<string> {
  return findTerminalSinkIdsInternal(startNodeId, normalized, cache, visiting).terminals;
}

function findTerminalSinkIdsInternal(
  startNodeId: string,
  normalized: NormalizedGraph,
  cache: Map<string, Set<string>>,
  visiting: Set<string>
): { terminals: Set<string>; truncated: boolean } {
  const cached = cache.get(startNodeId);
  if (cached) return { terminals: cached, truncated: false };
  if (visiting.has(startNodeId)) return { terminals: new Set(), truncated: true };

  const node = normalized.nodesById.get(startNodeId);
  if (!node) return { terminals: new Set([startNodeId]), truncated: false };

  const outgoing = normalized.outgoingEdgesByNode.get(startNodeId) ?? [];
  if (node.kind === 'sink' || outgoing.length === 0) {
    const terminals = new Set([startNodeId]);
    cache.set(startNodeId, terminals);
    return { terminals, truncated: false };
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(startNodeId);
  const terminals = new Set<string>();
  let truncated = false;
  for (const edge of outgoing) {
    const branch = findTerminalSinkIdsInternal(edge.targetId, normalized, cache, nextVisiting);
    truncated ||= branch.truncated;
    for (const sinkId of branch.terminals) {
      terminals.add(sinkId);
    }
  }

  // A traversal cut short by a cycle back-edge is missing the terminals
  // reachable through the node currently on the visiting stack — caching that
  // partial set would poison later lookups from outside the cycle.
  if (!truncated) cache.set(startNodeId, terminals);
  return { terminals, truncated };
}

export function forkBranchesLeadToDifferentSinks(
  itemEdges: readonly ProductionEdge[],
  normalized: NormalizedGraph,
  cache: Map<string, Set<string>> = new Map()
): boolean {
  const branchSinks = itemEdges.map((edge) => findTerminalSinkIds(edge.targetId, normalized, cache));

  for (let left = 0; left < branchSinks.length; left += 1) {
    for (let right = left + 1; right < branchSinks.length; right += 1) {
      const leftSinks = branchSinks[left]!;
      const rightSinks = branchSinks[right]!;
      if (leftSinks.size === 0 || rightSinks.size === 0) continue;
      const overlaps = [...leftSinks].some((sinkId) => rightSinks.has(sinkId));
      if (!overlaps) return true;
    }
  }

  return false;
}

function getTargetInputRates(
  node: ProductionNode | undefined,
  gameData: EngineGameData
): Array<{ itemId: string; ratePerMachine: number }> {
  if (node?.kind !== 'recipe') return [];
  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) return [];

  return recipe.inputs
    .filter((input): input is typeof input & { itemId: string } => Boolean(input.itemId))
    .map((input) => ({
      itemId: input.itemId,
      ratePerMachine: ratePerMachine(recipe, input.itemId, false),
    }))
    .filter((input) => input.ratePerMachine > 0);
}

function getKnownEdgeSupplyRate(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  actualPlan: ActualPlan,
  edgeRates: Readonly<Record<string, number>>,
  visitedEdges: Set<string> = new Set()
): number | undefined {
  if (visitedEdges.has(edge.id)) return undefined;
  if (edgeRates[edge.id] !== undefined) return edgeRates[edge.id]!;

  const sourceNode = normalized.nodesById.get(edge.sourceId);
  if (!sourceNode) return undefined;

  return getNodeOutputRate(sourceNode, actualPlan, edge.itemId);
}

export function computeBranchPull(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData,
  edgeRates: Readonly<Record<string, number>> = {}
): number {
  const targetNode = normalized.nodesById.get(edge.targetId);
  const inputRates = getTargetInputRates(targetNode, gameData);
  const forkBaseRate = inputRates.find((input) => itemsMatch(input.itemId, edge.itemId))?.ratePerMachine ?? 0;
  if (forkBaseRate <= 0) return getEdgeDemand(edge, normalized, requiredPlan, actualPlan, gameData);

  const targetPlan = requiredPlan[edge.targetId];
  const targetHasOverride =
    targetNode?.kind === 'recipe' &&
    (targetNode.machineCountOverride != null || targetNode.productionRateOverride != null);
  const plannedForkInput = targetHasOverride && targetPlan
    ? getRecordValue(targetPlan.requiredInputs, edge.itemId)
    : 0;
  let maxMachineScale = plannedForkInput > 0
    ? plannedForkInput / forkBaseRate
    : Number.POSITIVE_INFINITY;

  const incoming = normalized.incomingEdgesByNode.get(edge.targetId) ?? [];
  for (const input of inputRates.filter((candidate) => !itemsMatch(candidate.itemId, edge.itemId))) {
    const connected = incoming.filter((candidate) => itemsMatch(candidate.itemId, input.itemId));
    if (connected.length === 0) continue;

    let supplied = 0;
    let hasKnownFlow = false;
    for (const connectedEdge of connected) {
      const rate = getKnownEdgeSupplyRate(connectedEdge, normalized, actualPlan, edgeRates);
      if (rate === undefined) continue;
      supplied += rate;
      hasKnownFlow = true;
    }

    if (hasKnownFlow) {
      maxMachineScale = Math.min(maxMachineScale, supplied / input.ratePerMachine);
    }
  }

  if (!Number.isFinite(maxMachineScale)) return Number.POSITIVE_INFINITY;
  return Math.max(0, maxMachineScale * forkBaseRate);
}

function branchDemand(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData
): number {
  return getEdgeDemand(edge, normalized, requiredPlan, actualPlan, gameData);
}

function cappedPull(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData,
  edgeRates: Readonly<Record<string, number>>,
  options: { keepUnknownPullUnbounded?: boolean; capByDemand?: boolean } = {}
): number {
  const capByDemand = options.capByDemand ?? true;
  const physicalPull = computeBranchPull(edge, normalized, requiredPlan, actualPlan, gameData, edgeRates);
  const demand = branchDemand(edge, normalized, requiredPlan, actualPlan, gameData);
  if (!Number.isFinite(physicalPull) && options.keepUnknownPullUnbounded) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(physicalPull)) return demand > 0 ? demand : Number.POSITIVE_INFINITY;
  if (!capByDemand) return physicalPull;
  return demand > 0 ? Math.min(physicalPull, demand) : physicalPull;
}

function allocateRedistribute(params: {
  actualSupply: number;
  itemEdges: ProductionEdge[];
  normalized: NormalizedGraph;
  requiredPlan: RequiredPlan;
  actualPlan: ActualPlan;
  gameData: EngineGameData;
  edgeRates: Readonly<Record<string, number>>;
  fixedRequiredPlan?: RequiredPlan;
}): Record<string, number> {
  const divergentFork = forkBranchesLeadToDifferentSinks(params.itemEdges, params.normalized);

  // Divergent forks split by unbounded equal share, which can starve a branch
  // whose demand is fixed (override/explicit sink) in favor of maximize-driven
  // siblings. Reserve each branch's fixed-plan demand as a floor first.
  const floors = new Map<string, number>();
  if (divergentFork && params.fixedRequiredPlan) {
    let totalFloor = 0;
    for (const edge of params.itemEdges) {
      const fixedDemand = getEdgeDemand(edge, params.normalized, params.fixedRequiredPlan, params.actualPlan, params.gameData);
      const currentDemand = getEdgeDemand(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData);
      const floor = Math.max(0, Math.min(fixedDemand, currentDemand));
      floors.set(edge.id, floor);
      totalFloor += floor;
    }
    if (totalFloor <= DEFAULT_EPSILON) {
      floors.clear();
    } else if (totalFloor > params.actualSupply) {
      // Shortage across the reserved branches: split like an in-game merger —
      // equal shares, small reservations fulfil first and release the rest —
      // instead of pro-rata, so a small fixed tap is fully fed and the large
      // branch absorbs the deficit.
      const { allocations: fill } = waterFill(
        [...floors.keys()].map((edgeId) => ({ id: edgeId, cap: floors.get(edgeId)! })),
        Math.max(0, params.actualSupply),
        DEFAULT_EPSILON
      );
      for (const edgeId of floors.keys()) floors.set(edgeId, fill.get(edgeId) ?? 0);
    }
  }

  const pulls = params.itemEdges.map((edge) => {
    const floor = floors.get(edge.id) ?? 0;
    const pull = cappedPull(
      edge,
      params.normalized,
      params.requiredPlan,
      params.actualPlan,
      params.gameData,
      params.edgeRates,
      { keepUnknownPullUnbounded: divergentFork, capByDemand: !divergentFork }
    );
    return { edge, pull: Number.isFinite(pull) ? Math.max(0, pull - floor) : pull };
  });
  const totalFloors = [...floors.values()].reduce((sum, value) => sum + value, 0);
  const { allocations: fill } = waterFill(
    pulls.map(({ edge, pull }) => ({ id: edge.id, cap: pull })),
    Math.max(0, params.actualSupply - totalFloors),
    DEFAULT_EPSILON
  );

  const allocations: Record<string, number> = {};
  for (const { edge } of pulls) {
    allocations[edge.id] = (fill.get(edge.id) ?? 0) + (floors.get(edge.id) ?? 0);
  }
  return allocations;
}

function allocateProportional(
  actualSupply: number,
  itemEdges: ProductionEdge[],
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData
): Record<string, number> {
  const demands = itemEdges.map((edge) => ({ edge, demand: getEdgeDemand(edge, normalized, requiredPlan, actualPlan, gameData) }));
  const totalDemand = demands.reduce((sum, entry) => sum + entry.demand, 0);
  const allocations: Record<string, number> = {};

  if (totalDemand > 0) {
    for (const { edge, demand } of demands) {
      allocations[edge.id] = Math.max(0, actualSupply) * (demand / totalDemand);
    }
  } else {
    const equalShare = itemEdges.length > 0 ? Math.max(0, actualSupply) / itemEdges.length : 0;
    for (const edge of itemEdges) allocations[edge.id] = equalShare;
  }

  return allocations;
}

function allocatePriority(
  params: {
    actualSupply: number;
    itemEdges: ProductionEdge[];
    normalized: NormalizedGraph;
    requiredPlan: RequiredPlan;
    actualPlan: ActualPlan;
    gameData: EngineGameData;
    edgeRates: Readonly<Record<string, number>>;
  },
  orderOverride?: readonly ProductionEdge[]
): Record<string, number> {
  const allocations: Record<string, number> = {};
  const orderedEdges = orderOverride ?? sortByRoutingRank(params.itemEdges);
  const divergentFork = forkBranchesLeadToDifferentSinks(params.itemEdges, params.normalized);
  let remaining = Math.max(0, params.actualSupply);

  for (const edge of orderedEdges) {
    const pull = cappedPull(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData, params.edgeRates, { capByDemand: !divergentFork });
    const demand = getEdgeDemand(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData);
    const ceiling = Number.isFinite(pull) ? pull : demand;
    const allocated = Math.min(Math.max(0, ceiling), remaining);
    allocations[edge.id] = allocated;
    remaining -= allocated;
  }

  for (const edge of params.itemEdges) allocations[edge.id] ??= 0;
  return allocations;
}

function allocateHybrid(params: {
  actualSupply: number;
  itemEdges: ProductionEdge[];
  normalized: NormalizedGraph;
  requiredPlan: RequiredPlan;
  actualPlan: ActualPlan;
  gameData: EngineGameData;
  edgeRates: Readonly<Record<string, number>>;
}): Record<string, number> {
  const rankedEdges = sortByRoutingRank(params.itemEdges).filter((edge) => rankForEdge(edge, params.itemEdges) != null);
  const rankedIds = new Set(rankedEdges.map((edge) => edge.id));
  const unrankedEdges = params.itemEdges.filter((edge) => !rankedIds.has(edge.id));
  const divergentFork = forkBranchesLeadToDifferentSinks(params.itemEdges, params.normalized);
  const allocations: Record<string, number> = {};
  let remaining = Math.max(0, params.actualSupply);

  for (const edge of rankedEdges) {
    const pull = cappedPull(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData, params.edgeRates, { capByDemand: !divergentFork });
    const demand = getEdgeDemand(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData);
    const ceiling = Number.isFinite(pull) ? pull : demand;
    const allocated = Math.min(Math.max(0, ceiling), remaining);
    allocations[edge.id] = allocated;
    remaining -= allocated;
  }

  if (unrankedEdges.length > 0 && remaining > 0) {
    Object.assign(allocations, allocateRedistribute({ ...params, actualSupply: remaining, itemEdges: unrankedEdges }));
  }

  for (const edge of params.itemEdges) allocations[edge.id] ??= 0;
  return allocations;
}

function usesSaturation(
  sourceNode: ProductionNode,
  itemEdges: ProductionEdge[],
  normalized: NormalizedGraph,
  gameData: EngineGameData
): boolean {
  if (sourceNode.kind === 'source') return true;
  if (sourceNode.kind !== 'recipe') return false;

  const recipe = findRecipe(sourceNode.recipeId, gameData);
  const isPrimaryOutput = recipe ? !isByproductOutput(recipe, itemEdges[0]?.itemId ?? '') : true;
  return isPrimaryOutput && forkBranchesLeadToDifferentSinks(itemEdges, normalized);
}

function isByproductOutput(recipe: EngineRecipeDefinition, itemId: string): boolean {
  if (!recipe.product) return false;
  return !itemsMatch(recipe.product.id, itemId);
}

function allocateOutgoingEdgesInternal(params: {
  sourceNode: ProductionNode;
  itemEdges: ProductionEdge[];
  actualSupply: number;
  normalized: NormalizedGraph;
  requiredPlan: RequiredPlan;
  actualPlan: ActualPlan;
  gameData: EngineGameData;
  edgeRates: Readonly<Record<string, number>>;
  fixedRequiredPlan?: RequiredPlan;
  autoPrioritizeContestedForks?: boolean;
}): Record<string, number> {
  if (params.itemEdges.length === 1) {
    const edge = params.itemEdges[0]!;
    if (edge.routing?.overflow) {
      return { [edge.id]: Math.max(0, params.actualSupply) };
    }
    const demand = getEdgeDemand(edge, params.normalized, params.requiredPlan, params.actualPlan, params.gameData, params.fixedRequiredPlan);
    return { [edge.id]: Math.min(Math.max(0, params.actualSupply), demand) };
  }

  const coverage = deriveRoutingCoverage(params.itemEdges);
  if (coverage === 'full') return allocatePriority(params);
  if (coverage === 'partial') return allocateHybrid(params);

  if (
    params.autoPrioritizeContestedForks &&
    forkBranchesLeadToDifferentSinks(params.itemEdges, params.normalized)
  ) {
    const ordered = autoRankContestedFork(params.itemEdges, params.normalized);
    if (ordered) return allocatePriority(params, ordered);
  }

  if (usesSaturation(params.sourceNode, params.itemEdges, params.normalized, params.gameData)) {
    return allocateRedistribute(params);
  }

  return allocateProportional(params.actualSupply, params.itemEdges, params.normalized, params.requiredPlan, params.actualPlan, params.gameData);
}

export function allocateOutgoingEdges(params: {
  sourceNode: ProductionNode;
  itemEdges: ProductionEdge[];
  actualSupply: number;
  normalized: NormalizedGraph;
  requiredPlan: RequiredPlan;
  actualPlan: ActualPlan;
  gameData: EngineGameData;
  edgeRates: Readonly<Record<string, number>>;
  fixedRequiredPlan?: RequiredPlan;
  autoPrioritizeContestedForks?: boolean;
}): Record<string, number> {
  const nonOverflow = params.itemEdges.filter((edge) => !edge.routing?.overflow);
  const overflow = params.itemEdges.filter((edge) => edge.routing?.overflow);

  const allocations: Record<string, number> = {};

  if (nonOverflow.length > 0) {
    const subAllocations = allocateOutgoingEdgesInternal({
      ...params,
      itemEdges: nonOverflow,
    });
    Object.assign(allocations, subAllocations);
  }

  const totalAllocated = Object.values(allocations).reduce((sum, val) => sum + val, 0);
  const remainingSupply = Math.max(0, params.actualSupply - totalAllocated);

  if (overflow.length > 0) {
    if (remainingSupply > 0) {
      const splitShare = remainingSupply / overflow.length;
      for (const edge of overflow) {
        allocations[edge.id] = splitShare;
      }
    } else {
      for (const edge of overflow) {
        allocations[edge.id] = 0;
      }
    }
  }

  return allocations;
}

/** Pools sorted so any pool feeding another pool is processed first. */
function orderPoolsByDependency(normalized: NormalizedGraph): ProductionNode[] {
  const pools = normalized.nodes.filter((node) => node.kind === 'pool');
  if (pools.length <= 1) return pools;

  const poolIds = new Set(pools.map((pool) => pool.id));
  const inDegree = new Map<NodeId, number>(pools.map((pool) => [pool.id, 0]));
  for (const pool of pools) {
    for (const edge of normalized.incomingEdgesByNode.get(pool.id) ?? []) {
      if (poolIds.has(edge.sourceId)) inDegree.set(pool.id, (inDegree.get(pool.id) ?? 0) + 1);
    }
  }

  const ordered: ProductionNode[] = [];
  const queue = pools.filter((pool) => (inDegree.get(pool.id) ?? 0) === 0);
  const queued = new Set(queue.map((pool) => pool.id));
  while (queue.length > 0) {
    const pool = queue.shift()!;
    ordered.push(pool);
    for (const edge of normalized.outgoingEdgesByNode.get(pool.id) ?? []) {
      if (!poolIds.has(edge.targetId) || queued.has(edge.targetId)) continue;
      const remaining = (inDegree.get(edge.targetId) ?? 0) - 1;
      inDegree.set(edge.targetId, remaining);
      if (remaining <= 0) {
        const target = normalized.nodesById.get(edge.targetId);
        if (target?.kind === 'pool') {
          queue.push(target);
          queued.add(target.id);
        }
      }
    }
  }

  // Cycle fallback: append any pools the topological pass could not order.
  for (const pool of pools) {
    if (!queued.has(pool.id)) ordered.push(pool);
  }
  return ordered;
}

function edgesByItem(edges: readonly ProductionEdge[]): ProductionEdge[][] {
  const groups = new Map<string, ProductionEdge[]>();
  for (const edge of edges) {
    const key = edge.itemId.split(':').pop() ?? edge.itemId;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  return [...groups.values()];
}

function edgeAllocationsEqual(left: EdgeAllocation | undefined, right: EdgeAllocation | undefined, epsilon: number): boolean {
  if (!left || !right) return false;
  return (
    Math.abs(left.demandedRate - right.demandedRate) <= epsilon &&
    Math.abs(left.suppliedRate - right.suppliedRate) <= epsilon &&
    Math.abs(left.deficitRate - right.deficitRate) <= epsilon &&
    Math.abs(left.allocation - right.allocation) <= epsilon
  );
}

export function allocateActualFlows(
  normalized: NormalizedGraph,
  requiredPlan: RequiredPlan,
  actualPlan: ActualPlan,
  gameData: EngineGameData,
  options: AllocationOptions = {}
): AllocationResult {
  const edgeRates: Record<string, number> = {};
  const result: Record<string, EdgeAllocation> = {};
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const previous = options.previous;

  const dirtySet = options.dirtyNodeIds ? new Set<NodeId>(options.dirtyNodeIds) : null;

  // Pools redistribute what actually ARRIVES, so their incoming edges must be
  // allocated first (a pool's planned throughput can exceed deliverable inflow
  // when an immune override chain is under-supplied). Pool→pool chains resolve
  // in dependency order; cycles fall back to authored order.
  const orderedNodes = [
    ...normalized.nodes.filter((node) => node.kind !== 'pool'),
    ...orderPoolsByDependency(normalized),
  ];

  for (const node of orderedNodes) {
    const outgoing = normalized.outgoingEdgesByNode.get(node.id) ?? [];
    
    const isDirty = !previous || !dirtySet || dirtySet.has(node.id);
    let canCopy = !isDirty;
    if (canCopy && previous) {
      for (const edge of outgoing) {
        if (!previous[edge.id]) {
          canCopy = false;
          break;
        }
      }
    } else {
      canCopy = false;
    }

    if (canCopy && previous) {
      for (const edge of outgoing) {
        const prevAlloc = previous[edge.id]!;
        result[edge.id] = prevAlloc;
        edgeRates[edge.id] = prevAlloc.allocation;
      }
    } else {
      for (const itemEdges of edgesByItem(outgoing)) {
        const itemId = itemEdges[0]?.itemId ?? '';
        const actualSupply = node.kind === 'pool'
          ? (normalized.incomingEdgesByNode.get(node.id) ?? []).reduce(
              (sum, edge) => sum + (edgeRates[edge.id] ?? 0),
              0
            )
          : getNodeOutputRate(node, actualPlan, itemId);
        const allocations = allocateOutgoingEdges({
          sourceNode: node,
          itemEdges,
          actualSupply,
          normalized,
          requiredPlan,
          actualPlan,
          gameData,
          edgeRates,
          fixedRequiredPlan: options.fixedRequiredPlan,
          autoPrioritizeContestedForks: options.autoPrioritizeContestedForks,
        });

        for (const edge of itemEdges) {
          const demandedRate = getEdgeDemand(edge, normalized, requiredPlan, actualPlan, gameData, options.fixedRequiredPlan);
          const allocation = allocations[edge.id] ?? 0;
          edgeRates[edge.id] = allocation;
          result[edge.id] = {
            demandedRate,
            suppliedRate: actualSupply,
            deficitRate: Math.max(0, demandedRate - allocation),
            allocation,
          };
        }
      }
    }
  }

  for (const edge of normalized.edges) {
    if (result[edge.id]) continue;
    const sourceNode = normalized.nodesById.get(edge.sourceId);
    const suppliedRate = sourceNode ? getNodeOutputRate(sourceNode, actualPlan, edge.itemId) : 0;
    const demandedRate = getEdgeDemand(edge, normalized, requiredPlan, actualPlan, gameData);
    result[edge.id] = {
      demandedRate,
      suppliedRate,
      deficitRate: demandedRate,
      allocation: 0,
    };
  }

  const touchedEdgeIds = Object.keys(result).filter((edgeId) =>
    !edgeAllocationsEqual(result[edgeId], previous?.[edgeId], epsilon)
  );

  return { edges: result, touchedEdgeIds };
}
