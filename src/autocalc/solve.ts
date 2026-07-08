import type { AutocalcResult, ChangeOrigin, RateRollup } from '../types/autocalc';
import type { EngineGameData } from '../types/game-data';
import type { LayerDiagnostic } from '../types/layer';
import type { ItemRate, NodeId, ProductionGraph } from '../types/production-graph';
import type { NormalizedGraph } from '../graph/normalize';
import { normalizeGraph } from '../graph/normalize';
import { findRecipe, isByproduct, itemsMatch, ratePerMachine, resolveSomersloopMultiplier } from '../graph/recipe-math';
import { calculateRequiredPlan, type RequiredPlan } from './demand';
import { calculateConstraints } from './constraints';
import { calculateActualPlan, toItemRates, type ActualPlan } from './actual';
import { allocateActualFlows } from './allocation';
import { debugLog } from './debug-logger';

export interface SolveResult {
  result: AutocalcResult;
  diagnostics: LayerDiagnostic[];
  touchedNodeIds?: string[];
  touchedEdgeIds?: string[];
}

const ROUND_UP_EPSILON = 1e-6;

/**
 * Per-machine output rate of a recipe for one item, including clock and
 * somersloop multipliers.
 */
function perMachineOutputRate(
  node: Extract<ProductionGraph['nodes'][number], { kind: 'recipe' }>,
  itemId: string,
  gameData: EngineGameData
): number {
  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) return 0;
  const base = ratePerMachine(recipe, itemId, true);
  if (base <= 0) return 0;
  const clockFactor = (node.clockPercent ?? 100) / 100;
  const somersloop = resolveSomersloopMultiplier(recipe, node.somersloopsInstalled, gameData);
  return base * clockFactor * somersloop;
}

const ROUND_UP_TOLERANCE = 1e-4;
const ROUND_UP_MAX_ITERATIONS = 6;

function nextWholeMachineTarget(machines: number): number {
  if (machines <= ROUND_UP_EPSILON) return 0;
  const nearestWhole = Math.round(machines);
  if (Math.abs(machines - nearestWhole) <= ROUND_UP_TOLERANCE) {
    return nearestWhole + 1;
  }
  return Math.ceil(machines - ROUND_UP_EPSILON);
}

/** Converged (post-constraint) machine counts for the given recipe nodes. */
function convergedMachines(
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  nodeIds: readonly NodeId[]
): Map<NodeId, number> {
  const demand = calculateRequiredPlan(normalized, gameData, {});
  const constraints = calculateConstraints(normalized, demand.plan, {
    immuneNodeIds: demand.supplyBoundMaximizedNodeIds,
  });
  const actual = calculateActualPlan(demand.plan, constraints, {});
  return new Map(nodeIds.map((id) => [id, actual.plan[id]?.actualMachines ?? 0]));
}

/**
 * Resolves round-up sink nodes to concrete fixed demands so each producer
 * lands on the next whole machine of its depot-free equilibrium. After this
 * the sinks are ordinary fixed-demand sinks, so every downstream pass (tiered
 * reservation, allocation) treats them normally. Mutates the normalized
 * graph's sink nodes in place.
 *
 * The producer's converged machine count does not respond 1:1 to the sink
 * demand: fixed depot demand shifts upstream elastic fork splits toward the
 * producer's branch, and a downstream maximize consumer compensates — so a
 * one-shot resolution can overshoot (e.g. 9.52 → 11.11 instead of 10). Each
 * candidate is therefore refined with a secant iteration against the
 * converged post-constraint machine count.
 */
function resolveRoundUpSinks(normalized: NormalizedGraph, gameData: EngineGameData): void {
  const roundUpSinks = normalized.nodes.filter(
    (node): node is Extract<typeof node, { kind: 'sink' }> => node.kind === 'sink' && node.roundUp === true
  );
  if (roundUpSinks.length === 0) return;

  interface RoundUpEntry {
    sink: Extract<ProductionGraph['nodes'][number], { kind: 'sink' }>;
    producerId: NodeId;
    perMachine: number;
    target: number;
    demand: number;
    previousDemand: number;
    previousMachines: number;
    done: boolean;
  }

  // Baseline: all round-up sinks contribute nothing.
  for (const sink of roundUpSinks) sink.demandPerMin = 0;

  const entries: RoundUpEntry[] = [];
  for (const sink of roundUpSinks) {
    const incoming = normalized.incomingEdgesByNode.get(sink.id) ?? [];
    const producerEdge = incoming.find((edge) => itemsMatch(edge.itemId, sink.itemId)) ?? incoming[0];
    const producer = producerEdge ? normalized.nodesById.get(producerEdge.sourceId) : undefined;
    if (!producer || producer.kind !== 'recipe') continue;
    const perMachine = perMachineOutputRate(producer, sink.itemId, gameData);
    if (perMachine <= ROUND_UP_EPSILON) continue;
    entries.push({
      sink,
      producerId: producer.id,
      perMachine,
      target: 0,
      demand: 0,
      previousDemand: 0,
      previousMachines: 0,
      done: false,
    });
  }
  if (entries.length === 0) return;

  const producerIds = entries.map((entry) => entry.producerId);
  const baseline = convergedMachines(normalized, gameData, producerIds);

  for (const entry of entries) {
    const machines = baseline.get(entry.producerId) ?? 0;
    entry.previousMachines = machines;
    entry.target = nextWholeMachineTarget(machines);
    const extraMachines = Math.max(0, entry.target - machines);
    entry.done = extraMachines <= ROUND_UP_TOLERANCE;
    entry.demand = extraMachines * entry.perMachine;
    entry.sink.demandPerMin = entry.demand;
  }

  for (let iteration = 0; iteration < ROUND_UP_MAX_ITERATIONS; iteration += 1) {
    if (entries.every((entry) => entry.done)) break;

    const machinesById = convergedMachines(normalized, gameData, producerIds);

    for (const entry of entries) {
      if (entry.done) continue;
      const machines = machinesById.get(entry.producerId) ?? 0;
      const error = entry.target - machines;
      if (Math.abs(error) <= ROUND_UP_TOLERANCE) {
        entry.done = true;
        continue;
      }

      // Secant slope (machines per unit of sink demand); falls back to the
      // naive 1:1 response when the last step was degenerate.
      const demandStep = entry.demand - entry.previousDemand;
      const machinesStep = machines - entry.previousMachines;
      const slope = Math.abs(demandStep) > ROUND_UP_EPSILON && machinesStep > ROUND_UP_EPSILON
        ? machinesStep / demandStep
        : 1 / entry.perMachine;

      entry.previousDemand = entry.demand;
      entry.previousMachines = machines;
      entry.demand = Math.max(0, entry.demand + error / slope);
      entry.sink.demandPerMin = entry.demand;
    }
  }
}

function reconstructRequiredPlan(previous: AutocalcResult): RequiredPlan {
  const plan: RequiredPlan = {};
  for (const [nodeId, nodeData] of Object.entries(previous.nodes)) {
    const scale = nodeData.scale > 0 ? nodeData.scale : 1;
    const requiredInputs: Record<string, number> = {};
    for (const input of nodeData.inputs) {
      requiredInputs[input.itemId] = input.ratePerMin / scale;
    }
    const requiredOutputs: Record<string, number> = {};
    for (const output of nodeData.outputs) {
      requiredOutputs[output.itemId] = output.ratePerMin / scale;
    }
    plan[nodeId] = {
      nodeId,
      requiredMachines: nodeData.machines / scale,
      requiredInputs,
      requiredOutputs,
    };
  }
  return plan;
}

function reconstructActualPlan(previous: AutocalcResult): ActualPlan {
  const plan: ActualPlan = {};
  for (const [nodeId, nodeData] of Object.entries(previous.nodes)) {
    const scale = nodeData.scale > 0 ? nodeData.scale : 1;
    const requiredInputs: Record<string, number> = {};
    const actualInputs: Record<string, number> = {};
    for (const input of nodeData.inputs) {
      requiredInputs[input.itemId] = input.ratePerMin / scale;
      actualInputs[input.itemId] = input.ratePerMin;
    }
    const requiredOutputs: Record<string, number> = {};
    const actualOutputs: Record<string, number> = {};
    for (const output of nodeData.outputs) {
      requiredOutputs[output.itemId] = output.ratePerMin / scale;
      actualOutputs[output.itemId] = output.ratePerMin;
    }
    plan[nodeId] = {
      nodeId,
      requiredMachines: nodeData.machines / scale,
      actualMachines: nodeData.machines,
      scale: nodeData.scale,
      requiredInputs,
      actualInputs,
      requiredOutputs,
      actualOutputs,
    };
  }
  return plan;
}

function computeRollups(
  nodes: Record<NodeId, { machines: number; inputs: ItemRate[]; outputs: ItemRate[] }>,
  excludedNodeIds?: ReadonlySet<NodeId>
): { world: RateRollup } {
  const worldRollup = {
    machines: 0,
    inputs: new Map<string, number>(),
    outputs: new Map<string, number>(),
  };

  for (const [nodeId, nodeResult] of Object.entries(nodes)) {
    // Pools are transparent passthroughs; their in==out would double-count.
    if (excludedNodeIds?.has(nodeId)) continue;
    worldRollup.machines += nodeResult.machines;
    for (const input of nodeResult.inputs) {
      worldRollup.inputs.set(
        input.itemId,
        (worldRollup.inputs.get(input.itemId) ?? 0) + input.ratePerMin
      );
    }
    for (const output of nodeResult.outputs) {
      worldRollup.outputs.set(
        output.itemId,
        (worldRollup.outputs.get(output.itemId) ?? 0) + output.ratePerMin
      );
    }
  }

  const world: RateRollup = {
    machines: worldRollup.machines,
    inputs: Array.from(worldRollup.inputs.entries()).map(([itemId, ratePerMin]) => ({
      itemId,
      ratePerMin,
    })),
    outputs: Array.from(worldRollup.outputs.entries()).map(([itemId, ratePerMin]) => ({
      itemId,
      ratePerMin,
    })),
  };

  return { world };
}

function addDownstreamReachableNodes(normalized: ReturnType<typeof normalizeGraph>, startNodeId: NodeId, dirtyNodes: Set<NodeId>): void {
  const queue = [startNodeId];
  const visited = new Set<NodeId>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    dirtyNodes.add(nodeId);

    for (const edge of normalized.outgoingEdgesByNode.get(nodeId) ?? []) {
      queue.push(edge.targetId);
    }
  }
}

function componentForNode(normalized: ReturnType<typeof normalizeGraph>, startNodeId: NodeId): Set<NodeId> {
  const component = new Set<NodeId>();
  if (!normalized.nodesById.has(startNodeId)) return component;

  const queue = [startNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (component.has(nodeId)) continue;
    component.add(nodeId);

    for (const edge of normalized.outgoingEdgesByNode.get(nodeId) ?? []) {
      if (normalized.nodesById.has(edge.targetId)) queue.push(edge.targetId);
    }
    for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
      if (normalized.nodesById.has(edge.sourceId)) queue.push(edge.sourceId);
    }
  }

  return component;
}

function componentHasSharedOutputFork(
  normalized: ReturnType<typeof normalizeGraph>,
  component: ReadonlySet<NodeId>
): boolean {
  for (const nodeId of component) {
    const outgoing = normalized.outgoingEdgesByNode.get(nodeId) ?? [];
    const countsByItem = new Map<string, number>();
    for (const edge of outgoing) {
      if (!component.has(edge.targetId)) continue;
      countsByItem.set(edge.itemId, (countsByItem.get(edge.itemId) ?? 0) + 1);
    }
    if ([...countsByItem.values()].some((count) => count > 1)) {
      return true;
    }
  }
  return false;
}

function originComponent(
  normalized: ReturnType<typeof normalizeGraph>,
  origin: ChangeOrigin
): Set<NodeId> | null {
  if (origin.type === 'recipe-node' || origin.type === 'source' || origin.type === 'routing') {
    return componentForNode(normalized, origin.nodeId);
  }

  if (origin.type === 'edge') {
    const edge = normalized.edges.find((candidate) => candidate.id === origin.edgeId);
    if (!edge) return null;
    return componentForNode(normalized, edge.sourceId);
  }

  return null;
}

export function solveProductionGraph(
  graph: ProductionGraph,
  gameData: EngineGameData,
  options?: {
    previous?: AutocalcResult;
    origin?: ChangeOrigin;
    /**
     * Opt-in: on contested forks without manual routing priority, rank
     * branches by downstream recipe depth so complex products win the shared
     * input. Manual routing priorities always take precedence.
     */
    autoPrioritizeContestedForks?: boolean;
  }
): SolveResult {
  const previous = options?.previous;
  const origin = options?.origin;
  const autoPrioritizeContestedForks = options?.autoPrioritizeContestedForks;

  const startedAt = performance.now();
  debugLog('outer', 'Starting solveProductionGraph', {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    originType: origin?.type,
  });

  const normalized = normalizeGraph(graph);
  // Convert round-up sinks into concrete fixed demands before any pass runs.
  resolveRoundUpSinks(normalized, gameData);
  const originForkComponent = origin
    ? originComponent(normalized, origin)
    : null;
  const shouldPromoteForkOrigin =
    !!originForkComponent &&
    origin?.type !== 'full' &&
    componentHasSharedOutputFork(normalized, originForkComponent);
  const effectiveOrigin =
    origin?.type === 'routing'
      ? { type: 'full' as const }
      : shouldPromoteForkOrigin
        ? { type: 'fork-component' as const, nodeIds: originForkComponent }
        : origin;

  // Determine initial dirty sets
  const initialDirtyNodes = new Set<NodeId>();
  const initialDirtyEdges = new Set<string>();

  if (previous && effectiveOrigin) {
    if (effectiveOrigin.type === 'recipe-node' || effectiveOrigin.type === 'source') {
      addDownstreamReachableNodes(normalized, effectiveOrigin.nodeId, initialDirtyNodes);
    } else if (effectiveOrigin.type === 'edge') {
      initialDirtyEdges.add(effectiveOrigin.edgeId);
      const graphEdge = graph.edges.find((e) => e.id === effectiveOrigin.edgeId) ||
                        normalized.edges.find((e) => e.id === effectiveOrigin.edgeId);
      if (graphEdge) {
        initialDirtyNodes.add(graphEdge.sourceId);
        addDownstreamReachableNodes(normalized, graphEdge.targetId, initialDirtyNodes);
      } else {
        // Fallback: edge was deleted, dirty all nodes
        for (const node of normalized.nodes) {
          initialDirtyNodes.add(node.id);
        }
      }
    } else if (effectiveOrigin.type === 'fork-component') {
      for (const nodeId of effectiveOrigin.nodeIds) initialDirtyNodes.add(nodeId);
      for (const edge of normalized.edges) {
        if (effectiveOrigin.nodeIds.has(edge.sourceId) || effectiveOrigin.nodeIds.has(edge.targetId)) {
          initialDirtyEdges.add(edge.id);
        }
      }
    } else if (effectiveOrigin.type === 'full') {
      for (const node of normalized.nodes) initialDirtyNodes.add(node.id);
      for (const edge of normalized.edges) initialDirtyEdges.add(edge.id);
    }
  } else {
    for (const node of normalized.nodes) initialDirtyNodes.add(node.id);
    for (const edge of normalized.edges) initialDirtyEdges.add(edge.id);
  }

  // Reconstruct previous plans if possible. Full-dirty solves must cold-start
  // demand so removed routing/overrides cannot seed stale branch pulls.
  const previousRequiredPlan = previous && effectiveOrigin?.type !== 'full' && effectiveOrigin?.type !== 'fork-component'
    ? reconstructRequiredPlan(previous)
    : undefined;
  const previousActualPlan = previous ? reconstructActualPlan(previous) : undefined;
  const previousEdgeAllocations = previous ? previous.edges : undefined;

  // Run passes
  const demand = calculateRequiredPlan(normalized, gameData, {
    previous: previousRequiredPlan,
    dirtyNodeIds: initialDirtyNodes,
    autoPrioritizeContestedForks,
  });

  const constraints = calculateConstraints(normalized, demand.plan, {
    immuneNodeIds: demand.supplyBoundMaximizedNodeIds,
  });

  const actualDirtyNodes = new Set<NodeId>(initialDirtyNodes);
  for (const id of demand.touchedNodeIds) {
    actualDirtyNodes.add(id);
  }
  const actual = calculateActualPlan(demand.plan, constraints, {
    previous: previousActualPlan,
    dirtyNodeIds: actualDirtyNodes,
  });

  const allocationDirtyNodeIds = new Set<NodeId>(initialDirtyNodes);
  for (const id of demand.touchedNodeIds) {
    allocationDirtyNodeIds.add(id);
  }
  for (const id of actual.touchedNodeIds) {
    allocationDirtyNodeIds.add(id);
  }
  for (const edge of normalized.edges) {
    if (demand.touchedNodeIds.includes(edge.targetId)) {
      allocationDirtyNodeIds.add(edge.sourceId);
    }
  }
  const allocation = allocateActualFlows(normalized, demand.plan, actual.plan, gameData, {
    previous: previousEdgeAllocations,
    dirtyNodeIds: allocationDirtyNodeIds,
    fixedRequiredPlan: demand.fixedRequiredPlan,
    autoPrioritizeContestedForks,
  });

  // Assemble node results
  const nodes: AutocalcResult['nodes'] = {};
  for (const node of normalized.nodes) {
    const wasTouched = !previous || actual.touchedNodeIds?.includes(node.id);
    if (!wasTouched && previous?.nodes[node.id]) {
      nodes[node.id] = previous.nodes[node.id]!;
    } else {
      const act = actual.plan[node.id];
      let machines = act ? act.actualMachines : 0;
      if (node.kind === 'source') {
        if (node.machineCountOverride != null) {
          machines = node.machineCountOverride;
        } else {
          const perExtractor = node.perExtractorRatePerMin ?? 0;
          if (perExtractor > 0 && act) {
            const actualOutputRate = act.actualOutputs[node.itemId] ?? 0;
            machines = actualOutputRate / perExtractor;
          } else {
            machines = 0;
          }
        }
      }
      nodes[node.id] = {
        machines,
        scale: act ? act.scale : 1,
        inputs: act ? toItemRates(act.actualInputs) : [],
        outputs: act ? toItemRates(act.actualOutputs) : [],
      };
    }
  }

  // Log recipe statuses
  for (const node of normalized.nodes) {
    if (node.kind === 'recipe') {
      const act = actual.plan[node.id];
      const hasMachines = act && act.actualMachines > 0;
      if (hasMachines) {
        debugLog(
          'recipe',
          `Recipe node "${node.id}" (${node.recipeId}) is being processed with ${act.actualMachines.toFixed(2)} machines.`
        );
      } else {
        debugLog(
          'recipe',
          `Recipe node "${node.id}" (${node.recipeId}) is undriven with 0 required machines (no sink, override, or input supply).`
        );
      }
    }
  }

  // Assemble edge results
  const edges: AutocalcResult['edges'] = {};
  for (const [edgeId, alloc] of Object.entries(allocation.edges)) {
    const wasTouched = !previous || allocation.touchedEdgeIds?.includes(edgeId);
    if (!wasTouched && previous?.edges[edgeId]) {
      edges[edgeId] = previous.edges[edgeId]!;
    } else {
      edges[edgeId] = {
        demandedRate: alloc.demandedRate,
        suppliedRate: alloc.suppliedRate,
        deficitRate: alloc.deficitRate,
        allocation: alloc.allocation,
      };
    }
  }

  const poolNodeIds = new Set<NodeId>(
    normalized.nodes.filter((node) => node.kind === 'pool').map((node) => node.id)
  );
  const rollups = computeRollups(nodes, poolNodeIds);

  const result: AutocalcResult = {
    schemaVersion: 2,
    nodes,
    edges,
    rollups,
  };

  const recipeDiagnostics: LayerDiagnostic[] = [];
  for (const node of normalized.nodes) {
    if (node.kind === 'recipe') {
      const recipe = findRecipe(node.recipeId, gameData);
      if (recipe) {
        // 1. Unresolved byproducts
        for (const output of recipe.outputs) {
          if (output.itemId && isByproduct(recipe, output.itemId)) {
            const outgoing = (normalized.outgoingEdgesByNode.get(node.id) ?? [])
              .filter((edge) => itemsMatch(edge.itemId, output.itemId));
            if (outgoing.length === 0) {
              recipeDiagnostics.push({
                layerId: 'autocalc' as const,
                severity: 'warning',
                code: 'unresolved-byproduct',
                scope: { nodeId: node.id, itemId: output.itemId },
                message: `Byproduct ${output.itemId} has no sink and may block production`,
              });
            }
          }
        }
        // 2. Unconnected inputs
        for (const input of recipe.inputs) {
          if (input.itemId) {
            const incoming = (normalized.incomingEdgesByNode.get(node.id) ?? [])
              .filter((edge) => itemsMatch(edge.itemId, input.itemId));
            if (incoming.length === 0) {
              recipeDiagnostics.push({
                layerId: 'autocalc' as const,
                severity: 'warning',
                code: 'unconnected-input',
                scope: { nodeId: node.id, itemId: input.itemId },
                message: `Recipe input ${input.itemId} has no incoming edge`,
              });
            }
          }
        }
      }
    }
  }

  const diagnostics: LayerDiagnostic[] = [
    ...demand.diagnostics.map((d) => ({
      layerId: 'autocalc' as const,
      severity: d.severity,
      code: d.code,
      scope: d.scope,
      message: d.message,
    })),
    ...recipeDiagnostics,
  ];

  const durationMs = performance.now() - startedAt;
  debugLog('outer', 'Finished solveProductionGraph', {
    durationMs,
    touchedNodes: actual.touchedNodeIds?.length ?? 0,
    touchedEdges: allocation.touchedEdgeIds?.length ?? 0,
  });

  return {
    result,
    diagnostics,
    touchedNodeIds: actual.touchedNodeIds,
    touchedEdgeIds: allocation.touchedEdgeIds,
  };
}
