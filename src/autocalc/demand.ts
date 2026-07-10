import type { NormalizedGraph } from '../graph/normalize';
import {
  findRecipe,
  isByproduct,
  itemsMatch,
  machinesForInput,
  machinesForOutput,
  ratePerMachine,
  ratesForMachines,
  resolveSomersloopMultiplier,
} from '../graph/recipe-math';
import { forkBranchesLeadToDifferentSinks } from './allocation';
import { autoRankContestedFork } from './auto-priority';
import {
  classifyIncomingEdges,
  fixedRecipeOutputRates,
  isFixedByproductEdge,
  isGeneratorRecipe,
  primaryOutputItemId,
} from './recycling';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ItemRate, NodeId, ProductionEdge, ProductionNode } from '../types/production-graph';
import { waterFill } from './water-fill';

const DEFAULT_EPSILON = 1e-6;
const DEFAULT_MAX_ITERATIONS = 50;

export interface RequiredPlanNode {
  nodeId: NodeId;
  requiredMachines: number;
  requiredInputs: Record<string, number>;
  requiredOutputs: Record<string, number>;
}

export type RequiredPlan = Record<NodeId, RequiredPlanNode>;
type DemandSeed = Record<NodeId, Record<string, number>>;

export interface DemandDiagnostic {
  layerId: 'autocalc';
  severity: 'warning';
  code: 'cycle' | 'missing-recipe';
  scope: { nodeId?: string };
  message: string;
}

export interface DemandOptions {
  previous?: RequiredPlan;
  dirtyNodeIds?: Iterable<NodeId>;
  epsilon?: number;
  maxIterations?: number;
  /**
   * Internal: size only from explicit roots (sinks with demandPerMin,
   * machineCountOverride, productionRateOverride, powerTargetMw). Skips
   * supply seeding entirely, so maximize sizing, auto-sink demand, and
   * generator fuel seeding are inert.
   */
  fixedDemandOnly?: boolean;
  /**
   * Opt-in: on contested forks without manual routing priority, rank branches
   * by downstream recipe depth so complex products win the shared input.
   */
  autoPrioritizeContestedForks?: boolean;
}

export interface DemandResult {
  plan: RequiredPlan;
  diagnostics: DemandDiagnostic[];
  touchedNodeIds: NodeId[];
  /**
   * Maximized recipe nodes whose final size came from supply seeding (supply
   * >= downstream demand). These behave like output overrides for constraint
   * scaling: the node and its upstream chain must not be scaled down.
   */
  supplyBoundMaximizedNodeIds: NodeId[];
  /**
   * The fixed-demand baseline plan (explicit roots only), present when tiered
   * supply seeding ran. Fork supply is reserved for this baseline before
   * maximize chains receive the remainder.
   */
  fixedRequiredPlan?: RequiredPlan;
}

/**
 * Fixed-demand reservation context for supply seeding. Fork splits reserve
 * flow for the fixed plan first; only branches feeding active maximize nodes
 * absorb the remainder.
 */
interface SupplySeedTiering {
  fixedPlan: RequiredPlan;
  activeMaximizeUpstream: ReadonlySet<NodeId>;
  /**
   * Branches feeding spare-capacity (`overproduceFromSurplus`) chains: the
   * lowest tier, receiving only what fixed reservations and maximize branches
   * leave behind. A branch upstream of both counts as maximize.
   */
  activeSpareUpstream: ReadonlySet<NodeId>;
}

interface SupplySeedResult {
  supplyMachinesByNode: Map<NodeId, number>;
  /**
   * Supply-seeded nodes whose size was computed while a connected input had no
   * seeded supply (see `hasUnseededConnectedInput`). Their seeded size is an
   * upper guess, so they are excluded from scale-down immunity.
   */
  unseededInputNodeIds: Set<NodeId>;
}

function getRecordValue(record: Readonly<Record<string, number>>, itemId: string): number {
  if (record[itemId] !== undefined) return record[itemId];
  for (const [key, value] of Object.entries(record)) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function addDemand(demands: Map<NodeId, Map<string, number>>, nodeId: NodeId, itemId: string, rate: number): boolean {
  if (rate <= DEFAULT_EPSILON) return false;
  const nodeDemand = demands.get(nodeId);
  if (!nodeDemand) return false;

  for (const [key, value] of nodeDemand.entries()) {
    if (itemsMatch(key, itemId)) {
      nodeDemand.set(key, value + rate);
      return true;
    }
  }

  nodeDemand.set(itemId, rate);
  return true;
}

function readDemand(nodeDemand: ReadonlyMap<string, number>, itemId: string): number {
  if (nodeDemand.has(itemId)) return nodeDemand.get(itemId)!;
  for (const [key, value] of nodeDemand.entries()) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function toRecord(rates: ItemRate[]): Record<string, number> {
  const record: Record<string, number> = {};
  for (const rate of rates) {
    if (rate.ratePerMin <= DEFAULT_EPSILON) continue;
    record[rate.itemId] = rate.ratePerMin;
  }
  return record;
}

function recipeRateOptions(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  gameData: EngineGameData
) {
  return {
    clockPercent: node.clockPercent,
    somersloopMultiplier: resolveSomersloopMultiplier(recipe, node.somersloopsInstalled, gameData),
  };
}

function machinesForPowerTarget(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  gameData: EngineGameData
): number {
  const targetMw = node.powerTargetMw;
  if (targetMw == null || !Number.isFinite(targetMw) || targetMw <= 0) return 0;

  const buildingId = recipe.machine?.id;
  if (!buildingId) return 0;

  const profile = gameData.buildingPowerById.get(buildingId);
  if (!profile || profile.role !== 'generator') return 0;

  const baseGeneratedMw = profile.baseGeneratedMw ?? 0;
  if (baseGeneratedMw <= 0) return 0;

  const clockFactor = (node.clockPercent ?? 100) / 100;
  if (clockFactor <= 0) return 0;

  return targetMw / (baseGeneratedMw * clockFactor);
}

function finiteRate(value: number | undefined): number {
  return value != null && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function recipeOutputDemandItems(recipe: EngineRecipeDefinition, nodeDemand: ReadonlyMap<string, number>): string[] {
  const itemIds = new Set<string>();
  for (const output of recipe.outputs) {
    if (!output.itemId || isByproduct(recipe, output.itemId)) continue;
    if (readDemand(nodeDemand, output.itemId) > 0) itemIds.add(output.itemId);
  }
  return [...itemIds];
}

function calculateRecipePlan(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  nodeDemand: ReadonlyMap<string, number>,
  gameData: EngineGameData,
  supplyMachinesByNode?: ReadonlyMap<NodeId, number>
): { plan: RequiredPlanNode; diagnostic?: DemandDiagnostic } {
  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) {
    return {
      plan: {
        nodeId: node.id,
        requiredMachines: 0,
        requiredInputs: {},
        requiredOutputs: {},
      },
      diagnostic: {
        layerId: 'autocalc',
        severity: 'warning',
        code: 'missing-recipe',
        scope: { nodeId: node.id },
        message: `Recipe ${node.recipeId} was not found for node ${node.id}.`,
      },
    };
  }

  const opts = recipeRateOptions(node, recipe, gameData);
  let requiredMachines = 0;

  if (node.machineCountOverride != null) {
    requiredMachines = finiteRate(node.machineCountOverride);
  } else if (node.productionRateOverride != null) {
    const outputItemId = primaryOutputItemId(recipe);
    requiredMachines = outputItemId
      ? machinesForOutput(recipe, outputItemId, finiteRate(node.productionRateOverride), opts)
      : 0;
  } else if (isGeneratorRecipe(recipe, gameData)) {
    if (node.powerTargetMw != null) {
      requiredMachines = machinesForPowerTarget(node, recipe, gameData);
    } else {
      // Fuel-limited: size by the scarcest available input.
      let machinesFromInputs = Number.POSITIVE_INFINITY;
      let hasInputDemand = false;
      for (const input of recipe.inputs) {
        if (!input.itemId) continue;
        const demand = readDemand(nodeDemand, input.itemId);
        if (demand <= DEFAULT_EPSILON) continue;
        hasInputDemand = true;
        machinesFromInputs = Math.min(
          machinesFromInputs,
          machinesForInput(recipe, input.itemId, demand, opts)
        );
      }
      requiredMachines = hasInputDemand && Number.isFinite(machinesFromInputs)
        ? machinesFromInputs
        : 0;
    }
  } else {
    for (const itemId of recipeOutputDemandItems(recipe, nodeDemand)) {
      requiredMachines = Math.max(
        requiredMachines,
        machinesForOutput(recipe, itemId, readDemand(nodeDemand, itemId), opts)
      );
    }
  }

  // Maximized and spare-capacity nodes size from what upstream supply seeding
  // allows (for spare nodes the seeded supply is leftover-only by the tiered
  // fork splits). Overrides take precedence.
  if (
    (node.maximizeOutput || node.overproduceFromSurplus) &&
    node.machineCountOverride == null &&
    node.productionRateOverride == null &&
    node.powerTargetMw == null
  ) {
    const supplyMachines = supplyMachinesByNode?.get(node.id) ?? 0;
    if (node.maximizeOutput && supplyMachines > DEFAULT_EPSILON) {
      // Known supply bound: produce exactly what supply allows. Downstream
      // demand above the bound is physically unfillable and must not inflate
      // the node — the fork allocation divides the real output instead
      // (fixed branches reserved first, the rest to elastic consumers).
      requiredMachines = supplyMachines;
    } else {
      // Bound unknown (nothing seedable upstream, or a bounded input could
      // not seed): stay demand-driven. Scale-up only for spare capacity.
      requiredMachines = Math.max(requiredMachines, supplyMachines);
    }
  }

  const rates = ratesForMachines(recipe, requiredMachines, opts);
  return {
    plan: {
      nodeId: node.id,
      requiredMachines,
      requiredInputs: toRecord(rates.inputs),
      requiredOutputs: toRecord(rates.outputs),
    },
  };
}

function componentIds(normalized: NormalizedGraph): Map<NodeId, number> {
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

function hasExplicitDemandRoot(node: ProductionNode): boolean {
  if (node.kind === 'sink') return node.demandPerMin != null && finiteRate(node.demandPerMin) > 0;
  return node.kind === 'recipe' && (
    node.machineCountOverride != null ||
    node.productionRateOverride != null ||
    node.powerTargetMw != null
  );
}

/** Maximize flag is only active when no explicit override takes precedence. */
function isActiveMaximizeRecipe(node: ProductionNode): boolean {
  return (
    node.kind === 'recipe' &&
    node.maximizeOutput === true &&
    node.machineCountOverride == null &&
    node.productionRateOverride == null &&
    node.powerTargetMw == null
  );
}

/**
 * Spare-capacity flag: sizes from leftover supply only. Inactive when any
 * explicit override takes precedence, or when maximizeOutput is also set
 * (maximize is the stronger, earlier tier).
 */
function isActiveSpareRecipe(node: ProductionNode): boolean {
  return (
    node.kind === 'recipe' &&
    node.overproduceFromSurplus === true &&
    node.maximizeOutput !== true &&
    node.machineCountOverride == null &&
    node.productionRateOverride == null &&
    node.powerTargetMw == null
  );
}

/** Any supply-seeded sizing flag, active or not (seeding-gate granularity). */
function isSupplySeededRecipe(node: ProductionNode): boolean {
  return node.kind === 'recipe' && (node.maximizeOutput === true || node.overproduceFromSurplus === true);
}

/**
 * A recipe with no override whose seeding pass will feed it "self-demand"
 * (`selfDemandContribution`, below) because at least one of its outputs has
 * no outgoing edge — i.e. an unsinked recipe. Such a node pulls as much of
 * its available input supply as it can, exactly like an explicit
 * `maximizeOutput` node, even though the flag was never set. Forks upstream
 * of it must reserve fixed-demand siblings the same way they would for a
 * true maximize node, or the reservation is skipped and the fixed sibling's
 * share leaks into this node (the "unsinked recipe over-draws" bug).
 */
function isSelfDemandSeededRecipe(
  node: ProductionNode,
  normalized: NormalizedGraph,
  gameData: EngineGameData
): boolean {
  if (node.kind !== 'recipe' || node.machineCountOverride != null || node.productionRateOverride != null) {
    return false;
  }
  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) return false;
  const outgoing = normalized.outgoingEdgesByNode.get(node.id) ?? [];
  return recipe.outputs.some((output) => {
    if (!output.itemId) return false;
    return !outgoing.some((edge) => itemsMatch(edge.itemId, output.itemId!));
  });
}

function selfDemandSeededRecipeIds(normalized: NormalizedGraph, gameData: EngineGameData): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const node of normalized.nodes) {
    if (isSelfDemandSeededRecipe(node, normalized, gameData)) ids.add(node.id);
  }
  return ids;
}

/**
 * Tiered seeding matters when an active maximize node (or a self-demand-
 * seeded unsinked recipe, which behaves the same way) competes with a fixed
 * demand root for shared supply, and always when a spare-capacity node
 * exists (its chain must only ever receive leftover, reservations or not).
 */
function graphNeedsTieredSeeding(
  normalized: NormalizedGraph,
  selfDemandSeededIds: ReadonlySet<NodeId>
): boolean {
  if (normalized.nodes.some(isActiveSpareRecipe)) return true;
  if (selfDemandSeededIds.size === 0 && !normalized.nodes.some(isActiveMaximizeRecipe)) return false;
  return normalized.nodes.some(hasExplicitDemandRoot);
}

function addDemandSeed(seed: DemandSeed, nodeId: NodeId, itemId: string, rate: number): void {
  if (rate <= DEFAULT_EPSILON) return;
  seed[nodeId] ??= {};
  const nodeSeed = seed[nodeId]!;
  for (const [key, value] of Object.entries(nodeSeed)) {
    if (itemsMatch(key, itemId)) {
      nodeSeed[key] = value + rate;
      return;
    }
  }
  nodeSeed[itemId] = rate;
}

function applyDemandSeed(demands: Map<NodeId, Map<string, number>>, seed: DemandSeed): void {
  for (const [nodeId, itemRates] of Object.entries(seed)) {
    for (const [itemId, rate] of Object.entries(itemRates)) {
      addDemand(demands, nodeId, itemId, rate);
    }
  }
}

function sourceHasSharedOutputFork(normalized: NormalizedGraph, nodeId: NodeId): boolean {
  const countsByItem = new Map<string, number>();
  for (const edge of normalized.outgoingEdgesByNode.get(nodeId) ?? []) {
    countsByItem.set(edge.itemId, (countsByItem.get(edge.itemId) ?? 0) + 1);
  }
  return [...countsByItem.values()].some((count) => count > 1);
}

function isDemandOnlySource(source: Extract<ProductionNode, { kind: 'source' }>): boolean {
  return (
    (source.sourceType === 'water' || source.sourceType === 'resource-claim') &&
    source.machineCountOverride == null
  );
}

function canSeedSupply(source: Extract<ProductionNode, { kind: 'source' }>): boolean {
  return !isDemandOnlySource(source) && sourceOutputRate(source) > DEFAULT_EPSILON;
}

function addAvailableInput(
  availableInputs: Map<NodeId, Map<string, number>>,
  nodeId: NodeId,
  itemId: string,
  rate: number
): boolean {
  if (rate <= DEFAULT_EPSILON) return false;
  const nodeInputs = availableInputs.get(nodeId);
  if (!nodeInputs) return false;

  for (const [key, value] of nodeInputs.entries()) {
    if (itemsMatch(key, itemId)) {
      const next = value + rate;
      if (Math.abs(next - value) <= DEFAULT_EPSILON) return false;
      nodeInputs.set(key, next);
      return true;
    }
  }

  nodeInputs.set(itemId, rate);
  return true;
}

/**
 * Applies a signed delta to a node's available input for an item, returning
 * whether the stored total changed meaningfully. Unlike `addAvailableInput`
 * this accepts negative deltas (a re-propagation whose split shrank this edge's
 * share) and never accumulates stale contributions: the seed pass tracks each
 * edge's last contribution and only ever applies the difference, so a node
 * re-processed with a grown output replaces rather than double-counts.
 */
function applyAvailableInputDelta(
  availableInputs: Map<NodeId, Map<string, number>>,
  nodeId: NodeId,
  itemId: string,
  delta: number
): boolean {
  if (Math.abs(delta) <= DEFAULT_EPSILON) return false;
  const nodeInputs = availableInputs.get(nodeId);
  if (!nodeInputs) return false;

  for (const [key, value] of nodeInputs.entries()) {
    if (itemsMatch(key, itemId)) {
      const next = Math.max(0, value + delta);
      if (Math.abs(next - value) <= DEFAULT_EPSILON) return false;
      nodeInputs.set(key, next);
      return true;
    }
  }

  const next = Math.max(0, delta);
  if (next <= DEFAULT_EPSILON) return false;
  nodeInputs.set(itemId, next);
  return true;
}

/** Signed-delta counterpart to `addDemand` (see `applyAvailableInputDelta`). */
function applyDemandDelta(
  demands: Map<NodeId, Map<string, number>>,
  nodeId: NodeId,
  itemId: string,
  delta: number
): void {
  if (Math.abs(delta) <= DEFAULT_EPSILON) return;
  const nodeDemand = demands.get(nodeId);
  if (!nodeDemand) return;

  for (const [key, value] of nodeDemand.entries()) {
    if (itemsMatch(key, itemId)) {
      nodeDemand.set(key, Math.max(0, value + delta));
      return;
    }
  }

  const next = Math.max(0, delta);
  if (next <= DEFAULT_EPSILON) return;
  nodeDemand.set(itemId, next);
}

function readAvailableInput(available: ReadonlyMap<string, number>, itemId: string): number {
  if (available.has(itemId)) return available.get(itemId)!;
  for (const [key, value] of available.entries()) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function sourceOutputRate(node: Extract<ProductionNode, { kind: 'source' }>): number {
  return Math.max(0, node.maxRatePerMin);
}

function byproductEdgeCap(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  previousPlan: RequiredPlan,
  currentPlan?: Map<NodeId, Map<string, number>>,
): number {
  const sourceNode = normalized.nodesById.get(edge.sourceId);
  if (!sourceNode || sourceNode.kind !== 'recipe') return 0;

  const recipe = findRecipe(sourceNode.recipeId, gameData);
  if (!recipe) return 0;

  const fixedRates = fixedRecipeOutputRates(sourceNode, recipe, gameData);
  const fixedRate = fixedRates ? getRecordValue(fixedRates, edge.itemId) : 0;

  let currentSupply = 0;
  if (currentPlan) {
    const outputs = currentPlan.get(edge.sourceId);
    if (outputs) {
      currentSupply = outputs.get(edge.itemId) ?? 0;
    }
  }

  const supply = fixedRate > DEFAULT_EPSILON
    ? fixedRate
    : currentSupply > DEFAULT_EPSILON
      ? currentSupply
      : getRecordValue(previousPlan[edge.sourceId]?.requiredOutputs ?? {}, edge.itemId);
  if (supply <= DEFAULT_EPSILON) return 0;

  const siblingEdges = (normalized.outgoingEdgesByNode.get(edge.sourceId) ?? [])
    .filter((candidate) =>
      itemsMatch(candidate.itemId, edge.itemId) &&
      isFixedByproductEdge(candidate, normalized, gameData)
    );
  if (siblingEdges.length <= 1) return supply;

  const weights = siblingEdges.map((candidate) => {
    let targetDemand = 0;
    if (currentPlan) {
      const inputs = currentPlan.get(candidate.targetId);
      if (inputs) {
        targetDemand = inputs.get(candidate.itemId) ?? 0;
      }
    }
    if (targetDemand <= DEFAULT_EPSILON) {
      targetDemand = getRecordValue(previousPlan[candidate.targetId]?.requiredInputs ?? {}, candidate.itemId);
    }
    return { edge: candidate, weight: targetDemand };
  });
  const totalWeight = weights.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (totalWeight <= DEFAULT_EPSILON) return supply / siblingEdges.length;

  const ownWeight = weights.find((entry) => entry.edge.id === edge.id)?.weight ?? 0;
  return supply * (Math.max(0, ownWeight) / totalWeight);
}

function getBranchDemandFromPlan(
  edge: ProductionEdge,
  previousPlan: RequiredPlan,
  normalized: NormalizedGraph
): number {
  const targetPlan = previousPlan[edge.targetId];
  if (!targetPlan) return 0;
  const targetDemand = getRecordValue(targetPlan.requiredInputs, edge.itemId);
  const incoming = normalized.incomingEdgesByNode.get(edge.targetId) ?? [];
  const fanIn = incoming.filter((candidate) => itemsMatch(candidate.itemId, edge.itemId)).length;
  return fanIn > 0 ? targetDemand / fanIn : targetDemand;
}

function itemConsumedPerTerminalPrimary(
  nodeId: NodeId,
  itemId: string,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  visiting: Set<NodeId> = new Set()
): number {
  if (visiting.has(nodeId)) return 0;
  visiting.add(nodeId);

  const node = normalized.nodesById.get(nodeId);
  if (!node || node.kind !== 'recipe') return 0;

  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) return 0;

  const primaryOut = primaryOutputItemId(recipe);
  if (!primaryOut) return 0;

  const primaryRate = ratePerMachine(recipe, primaryOut, true);
  if (primaryRate <= DEFAULT_EPSILON) return 0;

  const outgoing = normalized.outgoingEdgesByNode.get(nodeId) ?? [];
  if (outgoing.length > 0) return 0;

  const inputRate = recipe.inputs
    .filter((input): input is typeof input & { itemId: string } => Boolean(input.itemId))
    .filter((input) => itemsMatch(input.itemId, itemId))
    .reduce((sum, input) => sum + ratePerMachine(recipe, input.itemId, false), 0);

  return inputRate > DEFAULT_EPSILON ? inputRate / primaryRate : 0;
}

function forkInputPerTerminalOutput(
  nodeId: NodeId,
  forkItemId: string,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  visiting: Set<NodeId> = new Set()
): number {
  if (visiting.has(nodeId)) return 0;
  visiting.add(nodeId);

  const node = normalized.nodesById.get(nodeId);
  if (!node || node.kind !== 'recipe') return 0;

  const recipe = findRecipe(node.recipeId, gameData);
  if (!recipe) return 0;

  const outgoing = normalized.outgoingEdgesByNode.get(nodeId) ?? [];
  const forkInputRate = recipe.inputs
    .filter((input): input is typeof input & { itemId: string } => Boolean(input.itemId))
    .filter((input) => itemsMatch(input.itemId, forkItemId))
    .reduce((sum, input) => sum + ratePerMachine(recipe, input.itemId, false), 0);

  if (outgoing.length === 0) {
    const primaryOut = primaryOutputItemId(recipe);
    if (!primaryOut) return 0;
    const primaryRate = ratePerMachine(recipe, primaryOut, true);
    return primaryRate > DEFAULT_EPSILON ? forkInputRate / primaryRate : 0;
  }

  if (forkInputRate <= DEFAULT_EPSILON) return 0;

  let total = 0;
  for (const outEdge of outgoing) {
    const itemOutRate = ratePerMachine(recipe, outEdge.itemId, true);
    if (itemOutRate <= DEFAULT_EPSILON) continue;
    const forkPerOutItem = forkInputRate / itemOutRate;
    const itemPerTerminal = itemConsumedPerTerminalPrimary(
      outEdge.targetId,
      outEdge.itemId,
      normalized,
      gameData,
      new Set(visiting)
    );
    total += forkPerOutItem * itemPerTerminal;
  }
  return total;
}

function estimateColdStartBranchWeight(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  gameData: EngineGameData
): number {
  const weight = forkInputPerTerminalOutput(edge.targetId, edge.itemId, normalized, gameData);
  if (weight > DEFAULT_EPSILON) return weight;

  const target = normalized.nodesById.get(edge.targetId);
  if (target?.kind !== 'recipe') return 1;
  const recipe = findRecipe(target.recipeId, gameData);
  if (!recipe) return 1;
  const inputRate = ratePerMachine(recipe, edge.itemId, false);
  return inputRate > DEFAULT_EPSILON ? inputRate : 1;
}

function getConnectedInputSupplyCeiling(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  previousPlan: RequiredPlan,
  supplyMachinesByNode?: ReadonlyMap<NodeId, number>
): number | null {
  const source = normalized.nodesById.get(edge.sourceId);
  if (!source) return null;

  if (source.kind === 'source') {
    if (isDemandOnlySource(source)) return null;
    return sourceOutputRate(source);
  }

  if (source.kind === 'recipe') {
    const recipe = findRecipe(source.recipeId, gameData);
    if (recipe) {
      const fixedOutputs = fixedRecipeOutputRates(source, recipe, gameData);
      const fixedRate = fixedOutputs ? getRecordValue(fixedOutputs, edge.itemId) : 0;
      if (fixedRate > DEFAULT_EPSILON) return fixedRate;

      const supplyMachines = supplyMachinesByNode?.get(source.id) ?? 0;
      if (supplyMachines > DEFAULT_EPSILON) {
        const outputs = ratesForMachines(recipe, supplyMachines, recipeRateOptions(source, recipe, gameData)).outputs;
        const seededRate = outputs.find((output) => itemsMatch(output.itemId, edge.itemId))?.ratePerMin ?? 0;
        if (seededRate > DEFAULT_EPSILON) return seededRate;
      }
    }

    // An active maximize/spare node's true ceiling comes from supply seeding
    // alone; a stale planned rate would self-reinforce across incremental
    // re-solves.
    if (isActiveMaximizeRecipe(source) || isActiveSpareRecipe(source)) return null;

    const plannedRate = getRecordValue(previousPlan[source.id]?.requiredOutputs ?? {}, edge.itemId);
    if (plannedRate > DEFAULT_EPSILON) return plannedRate;
  }

  return null;
}

function physicalBranchPullCeiling(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  previousPlan: RequiredPlan
): number {
  const target = normalized.nodesById.get(edge.targetId);
  if (target?.kind !== 'recipe') return Number.POSITIVE_INFINITY;

  const recipe = findRecipe(target.recipeId, gameData);
  if (!recipe) return Number.POSITIVE_INFINITY;

  const forkInputRate = ratePerMachine(recipe, edge.itemId, false);
  if (forkInputRate <= DEFAULT_EPSILON) return Number.POSITIVE_INFINITY;

  let maxMachines = Number.POSITIVE_INFINITY;
  if (target.machineCountOverride != null) {
    maxMachines = Math.min(maxMachines, finiteRate(target.machineCountOverride));
  } else if (target.productionRateOverride != null) {
    const outputItemId = primaryOutputItemId(recipe);
    if (outputItemId) {
      maxMachines = Math.min(
        maxMachines,
        machinesForOutput(
          recipe,
          outputItemId,
          finiteRate(target.productionRateOverride),
          recipeRateOptions(target, recipe, gameData)
        )
      );
    }
  }

  let hasOtherInput = false;

  const incoming = normalized.incomingEdgesByNode.get(edge.targetId) ?? [];
  for (const input of recipe.inputs.filter((candidate): candidate is typeof candidate & { itemId: string } => Boolean(candidate.itemId))) {
    if (itemsMatch(input.itemId, edge.itemId)) continue;
    hasOtherInput = true;

    const inputRate = ratePerMachine(recipe, input.itemId, false);
    if (inputRate <= DEFAULT_EPSILON) continue;

    const connected = incoming.filter((candidate) => itemsMatch(candidate.itemId, input.itemId));
    if (connected.length === 0) continue;

    let supply = 0;
    let hasKnownSupply = false;
    for (const connectedEdge of connected) {
      const ceiling = getConnectedInputSupplyCeiling(connectedEdge, normalized, gameData, previousPlan);
      if (ceiling == null) continue;
      supply += ceiling;
      hasKnownSupply = true;
    }

    if (hasKnownSupply) {
      maxMachines = Math.min(maxMachines, supply / inputRate);
    }
  }

  if (!hasOtherInput) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxMachines)) return Number.POSITIVE_INFINITY;
  return Math.max(0, maxMachines * forkInputRate);
}

function splitSupplySaturationRedistribute(
  edges: readonly ProductionEdge[],
  supplyRate: number,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  previousPlan: RequiredPlan
): Map<string, number> {
  const pulls = edges.map((edge) => {
    const plannedDemand = getBranchDemandFromPlan(edge, previousPlan, normalized);
    const pull = plannedDemand > DEFAULT_EPSILON
      ? plannedDemand
      : estimateColdStartBranchWeight(edge, normalized, gameData) * supplyRate;
    return { edge, pull };
  });

  const { allocations } = waterFill(
    pulls.map(({ edge, pull }) => ({ id: edge.id, cap: pull })),
    supplyRate,
    DEFAULT_EPSILON
  );
  return allocations;
}

function splitSupplyDivergentPriority(
  edges: readonly ProductionEdge[],
  supplyRate: number,
  previousPlan: RequiredPlan,
  normalized: NormalizedGraph,
  gameData: EngineGameData
): Map<string, number> {
  const ranked = edges
    .map((edge) => ({ edge, rank: rankForEdge(edge, edges) }))
    .filter((entry): entry is { edge: ProductionEdge; rank: number } => entry.rank != null)
    .sort((left, right) => left.rank - right.rank || left.edge.id.localeCompare(right.edge.id))
    .map((entry) => entry.edge);

  return splitSupplyPriorityOrdered(ranked, edges, supplyRate, previousPlan, normalized, gameData);
}

function splitSupplyPriorityOrdered(
  orderedEdges: readonly ProductionEdge[],
  allEdges: readonly ProductionEdge[],
  supplyRate: number,
  previousPlan: RequiredPlan,
  normalized: NormalizedGraph,
  gameData: EngineGameData
): Map<string, number> {
  const allocations = new Map<string, number>();
  let remaining = Math.max(0, supplyRate);

  for (const edge of orderedEdges) {
    const physicalPull = physicalBranchPullCeiling(edge, normalized, gameData, previousPlan);
    const pull = Number.isFinite(physicalPull)
      ? physicalPull
      : remaining;
    const allocated = Math.min(remaining, Math.max(0, pull));
    allocations.set(edge.id, allocated);
    remaining -= allocated;
  }

  const unranked = allEdges.filter((edge) => !allocations.has(edge.id));
  if (unranked.length > 0 && remaining > DEFAULT_EPSILON) {
    const remainder = splitSupplySaturationRedistribute(unranked, remaining, normalized, gameData, previousPlan);
    for (const edge of unranked) {
      allocations.set(edge.id, remainder.get(edge.id) ?? 0);
    }
  }

  for (const edge of allEdges) allocations.set(edge.id, allocations.get(edge.id) ?? 0);
  return allocations;
}

/**
 * Reservation-first fork split: each branch first receives its fixed-plan
 * demand (getBranchDemandFromPlan under-reserves on same-item fan-in, matching
 * the proportional split's existing approximation); the remainder goes only to
 * branches feeding active maximize nodes, proportional to their elastic pull.
 */
/**
 * Proportional-to-weight distribution with per-entry caps: capped entries are
 * clamped and their unused share re-flows to the rest, like waterFill but
 * weighted. Returns per-index shares; unplaceable leftover stays undistributed.
 */
function distributeProportionalWithCaps(
  entries: ReadonlyArray<{ index: number; weight: number; cap: number }>,
  total: number
): Map<number, number> {
  const shares = new Map<number, number>();
  for (const entry of entries) shares.set(entry.index, 0);

  let remaining = Math.max(0, total);
  let active = entries.filter((entry) => entry.weight > DEFAULT_EPSILON && entry.cap > DEFAULT_EPSILON);

  while (active.length > 0 && remaining > DEFAULT_EPSILON) {
    const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= DEFAULT_EPSILON) break;

    const capped = active.filter(
      (entry) => entry.cap - (shares.get(entry.index) ?? 0) < remaining * (entry.weight / totalWeight) - DEFAULT_EPSILON
    );

    if (capped.length === 0) {
      for (const entry of active) {
        shares.set(entry.index, (shares.get(entry.index) ?? 0) + remaining * (entry.weight / totalWeight));
      }
      remaining = 0;
      break;
    }

    for (const entry of capped) {
      const headroom = Math.max(0, entry.cap - (shares.get(entry.index) ?? 0));
      shares.set(entry.index, entry.cap);
      remaining -= headroom;
    }
    const cappedIndices = new Set(capped.map((entry) => entry.index));
    active = active.filter((entry) => !cappedIndices.has(entry.index));
    remaining = Math.max(0, remaining);
  }

  return shares;
}

function splitSupplyWithFixedReservation(
  edges: readonly ProductionEdge[],
  supplyRate: number,
  reserved: readonly number[],
  totalReserved: number,
  previousPlan: RequiredPlan,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  activeMaximizeUpstream: ReadonlySet<NodeId>,
  activeSpareUpstream?: ReadonlySet<NodeId>
): Map<string, number> {
  const allocations = new Map<string, number>();

  if (supplyRate <= totalReserved + DEFAULT_EPSILON) {
    for (let index = 0; index < edges.length; index += 1) {
      allocations.set(
        edges[index]!.id,
        totalReserved > DEFAULT_EPSILON ? supplyRate * (reserved[index]! / totalReserved) : 0
      );
    }
    return allocations;
  }

  const isMaximizeBranch = (edge: ProductionEdge) => activeMaximizeUpstream.has(edge.targetId);
  const isSpareBranch = (edge: ProductionEdge) =>
    !isMaximizeBranch(edge) && (activeSpareUpstream?.has(edge.targetId) ?? false);
  const hasSpareBranch = edges.some(isSpareBranch);

  /**
   * Legacy weighting, per tier: elastic pull from the previous plan; when the
   * whole tier has no pull yet (cold start), heuristic weights capped by the
   * physical ceiling net of the reservation. The next iteration corrects.
   */
  const tierWeights = (indices: readonly number[]): number[] => {
    const pulls = indices.map((index) =>
      Math.max(0, getBranchDemandFromPlan(edges[index]!, previousPlan, normalized) - reserved[index]!)
    );
    if (pulls.reduce((sum, value) => sum + value, 0) > DEFAULT_EPSILON) return pulls;
    return indices.map((index) => {
      const edge = edges[index]!;
      const weight = estimateColdStartBranchWeight(edge, normalized, gameData);
      const ceiling = physicalBranchPullCeiling(edge, normalized, gameData, previousPlan);
      return Number.isFinite(ceiling)
        ? Math.min(weight, Math.max(0, ceiling - reserved[index]!))
        : weight;
    });
  };

  let remainder = supplyRate - totalReserved;

  // Tier 2: maximize branches. When a spare branch is competing, cap each
  // maximize branch at its physical pull ceiling so genuine leftover can flow
  // down; without spare competition keep the legacy uncapped proportional
  // split (identical behavior to before spare mode existed).
  const maximizeIndices = edges
    .map((edge, index) => (isMaximizeBranch(edge) ? index : -1))
    .filter((index) => index >= 0);
  const maximizeWeights = tierWeights(maximizeIndices);
  const maximizeEntries = maximizeIndices.map((index, position) => {
    const ceiling = hasSpareBranch
      ? physicalBranchPullCeiling(edges[index]!, normalized, gameData, previousPlan)
      : Number.POSITIVE_INFINITY;
    return {
      index,
      weight: maximizeWeights[position]!,
      cap: Number.isFinite(ceiling)
        ? Math.max(0, ceiling - reserved[index]!)
        : Number.POSITIVE_INFINITY,
    };
  });
  const maximizeShares = distributeProportionalWithCaps(maximizeEntries, remainder);
  for (const [, share] of maximizeShares) remainder -= share;
  remainder = Math.max(0, remainder);

  // Tier 3: spare-capacity branches absorb only what everyone else left.
  const spareIndices = edges
    .map((edge, index) => (isSpareBranch(edge) ? index : -1))
    .filter((index) => index >= 0);
  const rawSpareWeights = tierWeights(spareIndices);
  const spareHasWeight = rawSpareWeights.some((weight) => weight > DEFAULT_EPSILON);
  const spareEntries = spareIndices.map((index, position) => {
    const ceiling = physicalBranchPullCeiling(edges[index]!, normalized, gameData, previousPlan);
    return {
      index,
      // Guarantee leftover reaches spare branches even before any pull exists.
      weight: spareHasWeight ? rawSpareWeights[position]! : 1,
      cap: Number.isFinite(ceiling)
        ? Math.max(0, ceiling - reserved[index]!)
        : Number.POSITIVE_INFINITY,
    };
  });
  const spareShares = distributeProportionalWithCaps(spareEntries, remainder);

  for (let index = 0; index < edges.length; index += 1) {
    const extra = (maximizeShares.get(index) ?? 0) + (spareShares.get(index) ?? 0);
    allocations.set(edges[index]!.id, reserved[index]! + extra);
  }
  return allocations;
}

function splitSupplyAcrossOutgoingEdges(
  edges: readonly ProductionEdge[],
  supplyRate: number,
  previousPlan: RequiredPlan,
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  tiering?: SupplySeedTiering,
  autoPrioritizeContestedForks?: boolean
): Map<string, number> {
  if (edges.length === 0) return new Map();
  if (edges.length === 1) return new Map([[edges[0]!.id, supplyRate]]);

  // Overflow edges receive only what every other branch leaves behind: split
  // the regular branches over their claimed demand first, then spill the rest.
  const overflowEdges = edges.filter((edge) => edge.routing?.overflow);
  if (overflowEdges.length > 0 && overflowEdges.length < edges.length) {
    const regular = edges.filter((edge) => !edge.routing?.overflow);
    const regularDemand = regular.reduce(
      (sum, edge) => sum + getBranchDemandFromPlan(edge, previousPlan, normalized),
      0
    );
    const allocations = splitSupplyAcrossOutgoingEdges(
      regular,
      Math.min(supplyRate, regularDemand),
      previousPlan,
      normalized,
      gameData,
      tiering,
      autoPrioritizeContestedForks
    );
    const allocatedTotal = [...allocations.values()].reduce((sum, value) => sum + value, 0);
    const spill = Math.max(0, supplyRate - allocatedTotal) / overflowEdges.length;
    for (const edge of overflowEdges) allocations.set(edge.id, spill);
    return allocations;
  }

  const hasRouting = edges.some((edge) => rankForEdge(edge, edges) != null);
  if (hasRouting) {
    if (forkBranchesLeadToDifferentSinks(edges, normalized, new Map())) {
      return splitSupplyDivergentPriority(edges, supplyRate, previousPlan, normalized, gameData);
    }
    return splitDemandAcrossEdges(edges, supplyRate, previousPlan);
  }

  // Fixed demand (overrides, explicit sinks) reserves fork supply before
  // maximize chains size from the remainder; spare-capacity chains always go
  // through the tiered split (they take the leftover tier, reservations or not).
  if (tiering) {
    const hasMaximizeBranch = edges.some((edge) => tiering.activeMaximizeUpstream.has(edge.targetId));
    const hasSpareBranch = edges.some(
      (edge) =>
        !tiering.activeMaximizeUpstream.has(edge.targetId) &&
        tiering.activeSpareUpstream.has(edge.targetId)
    );
    if (hasMaximizeBranch || hasSpareBranch) {
      // Only genuinely fixed branches (not maximize/spare) reserve their
      // fixed-plan demand: maximize branches take the remainder and spare
      // branches take the leftover, so both must reserve 0. Reserving a
      // maximize branch's downstream fixed demand here would dilute a
      // competing fixed tap in the scarce split below (it would grab supply
      // proportional to a demand it is meant to absorb elastically, not claim).
      const reserved = edges.map((edge) => {
        const isMaximize = tiering.activeMaximizeUpstream.has(edge.targetId);
        const isSpare = !isMaximize && tiering.activeSpareUpstream.has(edge.targetId);
        if (isMaximize || isSpare) return 0;
        return getBranchDemandFromPlan(edge, tiering.fixedPlan, normalized);
      });
      const totalReserved = reserved.reduce((sum, value) => sum + value, 0);
      if (totalReserved > DEFAULT_EPSILON || hasSpareBranch) {
        return splitSupplyWithFixedReservation(
          edges,
          supplyRate,
          reserved,
          totalReserved,
          previousPlan,
          normalized,
          gameData,
          tiering.activeMaximizeUpstream,
          tiering.activeSpareUpstream
        );
      }
    }
  }

  if (autoPrioritizeContestedForks && forkBranchesLeadToDifferentSinks(edges, normalized, new Map())) {
    const ordered = autoRankContestedFork(edges, normalized);
    if (ordered) {
      return splitSupplyPriorityOrdered(ordered, edges, supplyRate, previousPlan, normalized, gameData);
    }
  }

  const totalDemand = edges.reduce(
    (sum, edge) => sum + getBranchDemandFromPlan(edge, previousPlan, normalized),
    0
  );

  if (totalDemand > DEFAULT_EPSILON) {
    const allocations = new Map<string, number>();
    for (const edge of edges) {
      const demand = getBranchDemandFromPlan(edge, previousPlan, normalized);
      allocations.set(edge.id, supplyRate * (demand / totalDemand));
    }
    return allocations;
  }

  if (forkBranchesLeadToDifferentSinks(edges, normalized, new Map())) {
    return splitSupplySaturationRedistribute(edges, supplyRate, normalized, gameData, previousPlan);
  }

  const totalWeight = edges.reduce(
    (sum, edge) => sum + estimateColdStartBranchWeight(edge, normalized, gameData),
    0
  );
  if (totalWeight > DEFAULT_EPSILON) {
    const allocations = new Map<string, number>();
    for (const edge of edges) {
      const weight = estimateColdStartBranchWeight(edge, normalized, gameData);
      allocations.set(edge.id, supplyRate * (weight / totalWeight));
    }
    return allocations;
  }

  return splitSupplySaturationRedistribute(edges, supplyRate, normalized, gameData, previousPlan);
}

function recipeMachinesFromAvailableInputs(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  available: ReadonlyMap<string, number>,
  gameData: EngineGameData,
  normalized: NormalizedGraph
): number {
  const opts = recipeRateOptions(node, recipe, gameData);
  const incoming = normalized.incomingEdgesByNode.get(node.id) ?? [];
  let machines = Number.POSITIVE_INFINITY;
  let hasSuppliedInput = false;

  for (const input of recipe.inputs) {
    if (!input.itemId) continue;
    const inputRate = ratePerMachine(recipe, input.itemId, false) * ((node.clockPercent ?? 100) / 100);
    if (inputRate <= 0) continue;

    // An input backed anywhere by an elastic source is never limiting: the
    // elastic feeder is trusted to make up any shortfall, so a small nonzero
    // amount from a finite co-supplier (e.g. a cyclic byproduct sharing the
    // same pool) must not cap machine sizing below what other inputs allow.
    const matching = incoming.filter((edge) => itemsMatch(edge.itemId, input.itemId));
    if (matching.length > 0 && matching.some((edge) => hasElasticBackstop(edge.sourceId, normalized))) {
      continue;
    }

    let suppliedRate = readAvailableInput(available, input.itemId);
    if (node.inputRateOverride && itemsMatch(node.inputRateOverride.itemId, input.itemId)) {
      suppliedRate += node.inputRateOverride.ratePerMin;
    }

    if (suppliedRate <= DEFAULT_EPSILON) continue;
    hasSuppliedInput = true;
    machines = Math.min(machines, machinesForInput(recipe, input.itemId, suppliedRate, opts));
  }

  if (!hasSuppliedInput) return 0;
  return Number.isFinite(machines) ? machines : 0;
}

/**
 * A connected input with zero seeded supply that survived the exemptions in
 * `hasUnsuppliedConnectedInput` (fed by a recipe chain or demand-only source).
 * A supply-seeded size computed while such an input exists is an upper guess
 * from the other inputs only — not a trustworthy floor — so the node keeps its
 * demand-driven size (no floor, no scale-down immunity). Inputs fed purely by
 * elastic water sources are exempt: water sizes to whatever is asked, so it
 * never bounds the node and cannot invalidate a floor from the other inputs.
 */
function hasUnseededConnectedInput(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  available: ReadonlyMap<string, number>,
  normalized: NormalizedGraph
): boolean {
  const incoming = normalized.incomingEdgesByNode.get(node.id) ?? [];

  for (const input of recipe.inputs) {
    if (!input.itemId) continue;
    if (ratePerMachine(recipe, input.itemId, false) <= DEFAULT_EPSILON) continue;
    const matching = incoming.filter((edge) => itemsMatch(edge.itemId, input.itemId));
    if (matching.length === 0) continue;

    let suppliedRate = readAvailableInput(available, input.itemId);
    if (node.inputRateOverride && itemsMatch(node.inputRateOverride.itemId, input.itemId)) {
      suppliedRate += node.inputRateOverride.ratePerMin;
    }
    if (suppliedRate > DEFAULT_EPSILON) continue;

    const allElasticWater = matching.every((edge) => {
      const source = normalized.nodesById.get(edge.sourceId);
      return source?.kind === 'source' && source.sourceType === 'water' && isDemandOnlySource(source);
    });
    if (!allElasticWater) return true;
  }

  return false;
}

/**
 * A stronger condition than `hasUnseededConnectedInput`: an unseeded connected
 * input fed *directly* by a demand-mode resource claim (a raw resource that
 * reports a sentinel "unbounded" capacity and cannot seed). This is the case
 * where the supply-seeded size is not just an upper guess but actively wrong —
 * the claim is the intended bottleneck yet the seed sizes from the *other*
 * inputs, unbounded. Such a node must fall back to demand-driven sizing.
 *
 * An input fed by a recipe/pool chain is NOT this case: it is either transient
 * (will propagate) or a real intermediate whose own supply the constraint pass
 * can scale against — so its node keeps the seed as a pin-ceiling.
 */
function hasUnseededDirectClaimInput(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  available: ReadonlyMap<string, number>,
  normalized: NormalizedGraph
): boolean {
  const incoming = normalized.incomingEdgesByNode.get(node.id) ?? [];

  for (const input of recipe.inputs) {
    if (!input.itemId) continue;
    if (ratePerMachine(recipe, input.itemId, false) <= DEFAULT_EPSILON) continue;
    const matching = incoming.filter((edge) => itemsMatch(edge.itemId, input.itemId));
    if (matching.length === 0) continue;

    let suppliedRate = readAvailableInput(available, input.itemId);
    if (node.inputRateOverride && itemsMatch(node.inputRateOverride.itemId, input.itemId)) {
      suppliedRate += node.inputRateOverride.ratePerMin;
    }
    if (suppliedRate > DEFAULT_EPSILON) continue;

    const hasDemandModeClaim = matching.some((edge) => {
      const source = normalized.nodesById.get(edge.sourceId);
      return (
        source?.kind === 'source' &&
        source.sourceType === 'resource-claim' &&
        isDemandOnlySource(source)
      );
    });
    if (hasDemandModeClaim) return true;
  }

  return false;
}

/**
 * Whether a node feeding an unsuppliable input is an "exempt" feeder — a
 * source that legitimately does not seed supply on its own (demand-only) or a
 * recipe whose output will arrive once the graph settles. A `pool` node is
 * transparent to this check: it is exempt if any of its own inflows is an
 * exempt feeder, so the exemption still propagates when a second supplier
 * (e.g. a cyclic byproduct) forces the builder to insert a pool between the
 * exempt source and the consumer. Recursion is capped at one pool hop — a
 * pool never feeds another pool — purely as a cycle guard.
 */
function isExemptFeeder(sourceId: NodeId, normalized: NormalizedGraph, depth = 0): boolean {
  const source = normalized.nodesById.get(sourceId);
  if (source?.kind === 'source' && isDemandOnlySource(source)) return true;
  if (source?.kind === 'recipe') return true;
  if (source?.kind === 'pool' && depth < 1) {
    return (normalized.incomingEdgesByNode.get(sourceId) ?? []).some((edge) =>
      isExemptFeeder(edge.sourceId, normalized, depth + 1)
    );
  }
  return false;
}

/**
 * Whether an input is backed, directly or through one pool hop, by a
 * genuinely elastic (demand-only/unbounded) source such as an unmetered
 * water pump. Narrower than `isExemptFeeder`: a plain recipe source does NOT
 * count here, only a real elastic source does. Used to keep a small finite
 * co-supplier sharing the same pool (e.g. a cyclic byproduct trickle) from
 * being mistaken for the input's full available supply — an elastic backstop
 * is trusted to cover any shortfall, so the input must never cap generator
 * sizing at whatever partial amount the finite co-supplier happens to
 * deliver on a given pass. Recursion is capped at one pool hop as a cycle
 * guard, mirroring `isExemptFeeder`.
 */
function hasElasticBackstop(sourceId: NodeId, normalized: NormalizedGraph, depth = 0): boolean {
  const source = normalized.nodesById.get(sourceId);
  if (source?.kind === 'source' && isDemandOnlySource(source)) return true;
  if (source?.kind === 'pool' && depth < 1) {
    return (normalized.incomingEdgesByNode.get(sourceId) ?? []).some((edge) =>
      hasElasticBackstop(edge.sourceId, normalized, depth + 1)
    );
  }
  return false;
}

function hasUnsuppliedConnectedInput(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  available: ReadonlyMap<string, number>,
  normalized: NormalizedGraph
): boolean {
  const incoming = normalized.incomingEdgesByNode.get(node.id) ?? [];

  for (const input of recipe.inputs) {
    if (!input.itemId) continue;
    const inputRate = ratePerMachine(recipe, input.itemId, false);
    if (inputRate <= DEFAULT_EPSILON) continue;

    const connected = incoming.some((edge) => itemsMatch(edge.itemId, input.itemId));
    if (!connected) continue;

    let suppliedRate = readAvailableInput(available, input.itemId);
    if (node.inputRateOverride && itemsMatch(node.inputRateOverride.itemId, input.itemId)) {
      suppliedRate += node.inputRateOverride.ratePerMin;
    }

    if (suppliedRate <= DEFAULT_EPSILON) {
      const hasExemptSource = incoming.some((edge) => {
        if (!itemsMatch(edge.itemId, input.itemId)) return false;
        return isExemptFeeder(edge.sourceId, normalized);
      });
      if (!hasExemptSource) return true;
    }
  }

  return false;
}

/**
 * Effective fuel rate a source offers to a generator.
 * - Manual inputs and sources with an explicit machine override provide their
 *   full finite rate.
 * - Demand-mode water/resource claims do not seed generator demand.
 */
function sourceEffectiveGeneratorRate(
  source: Extract<ProductionNode, { kind: 'source' }>
): number {
  if (source.sourceType === 'manual-input' || source.machineCountOverride != null) {
    return source.maxRatePerMin;
  }
  return 0;
}

/**
 * Seeds input demand for generator recipes so the backward pass sizes them from
 * available fuel. Demand-mode resource claims are ignored here so they cannot
 * drive production without an explicit downstream target.
 */
function seedGeneratorInputDemand(
  normalized: NormalizedGraph,
  demands: Map<NodeId, Map<string, number>>,
  availableInputs: Map<NodeId, Map<string, number>>,
  gameData: EngineGameData
): void {
  for (const node of normalized.nodes) {
    if (node.kind !== 'recipe') continue;
    const recipe = findRecipe(node.recipeId, gameData);
    if (!recipe || !isGeneratorRecipe(recipe, gameData)) continue;

    const nodeAvailable = availableInputs.get(node.id) ?? new Map<string, number>();
    for (const input of recipe.inputs) {
      if (!input.itemId) continue;

      const incoming = (normalized.incomingEdgesByNode.get(node.id) ?? []).filter((edge) =>
        itemsMatch(edge.itemId, input.itemId)
      );
      if (incoming.length === 0) continue;

      const allFromSources = incoming.every((edge) => {
        const source = normalized.nodesById.get(edge.sourceId);
        return source?.kind === 'source';
      });

      let sourceCap = 0;
      if (allFromSources) {
        for (const edge of incoming) {
          const source = normalized.nodesById.get(edge.sourceId);
          if (source?.kind === 'source') {
            sourceCap += sourceEffectiveGeneratorRate(source);
          }
        }
      }

      // An input backed anywhere (directly or through one pool hop) by a
      // genuinely elastic source never limits generator sizing: the elastic
      // source is trusted to cover whatever a finite co-supplier (e.g. a
      // small cyclic byproduct sharing the same pool) falls short of. Without
      // this, a byproduct's small trickle would seed a tiny, wrong demand
      // that caps the generator far below what its other inputs (fuel) allow.
      if (incoming.some((edge) => hasElasticBackstop(edge.sourceId, normalized))) continue;

      const availableRate = readAvailableInput(nodeAvailable, input.itemId);
      const demandRate = sourceCap > 0 ? Math.min(availableRate, sourceCap) : availableRate;

      if (demandRate > DEFAULT_EPSILON) {
        addDemand(demands, node.id, input.itemId, demandRate);
      }
    }
  }
}

function upstreamOfNodesMatching(
  normalized: NormalizedGraph,
  rootPredicate: (node: ProductionNode) => boolean
): Set<NodeId> {
  const upstream = new Set<NodeId>();
  const queue: NodeId[] = [];

  for (const node of normalized.nodes) {
    if (!rootPredicate(node)) continue;
    upstream.add(node.id);
    queue.push(node.id);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
      if (upstream.has(edge.sourceId)) continue;
      upstream.add(edge.sourceId);
      queue.push(edge.sourceId);
    }
  }

  return upstream;
}

function upstreamOfMaximizedSet(normalized: NormalizedGraph, activeOnly = false): Set<NodeId> {
  return upstreamOfNodesMatching(
    normalized,
    activeOnly ? isActiveMaximizeRecipe : (node) => node.kind === 'recipe' && node.maximizeOutput === true
  );
}

function seedSupplyDrivenDemand(
  normalized: NormalizedGraph,
  demands: Map<NodeId, Map<string, number>>,
  gameData: EngineGameData,
  previousPlan: RequiredPlan,
  dirtySet?: Set<NodeId>,
  tiering?: SupplySeedTiering,
  autoPrioritizeContestedForks?: boolean
): SupplySeedResult {
  const supplyMachinesByNode = new Map<NodeId, number>();
  const unseededInputNodeIds = new Set<NodeId>();
  // Sources feeding either supply-seeded flavor (maximize or spare) must seed.
  const upstreamOfMaximized = upstreamOfNodesMatching(normalized, isSupplySeededRecipe);
  const components = componentIds(normalized);
  const componentsWithDemand = new Set<number>();
  const componentsWithSupplyFork = new Set<number>();
  for (const node of normalized.nodes) {
    if (!hasExplicitDemandRoot(node)) continue;
    const componentId = components.get(node.id);
    if (componentId != null) componentsWithDemand.add(componentId);
  }
  for (const node of normalized.nodes) {
    if (node.kind !== 'source' || !sourceHasSharedOutputFork(normalized, node.id)) continue;
    const componentId = components.get(node.id);
    if (componentId != null) componentsWithSupplyFork.add(componentId);
  }

  const availableInputs = new Map<NodeId, Map<string, number>>();
  const recipeOutputs = new Map<NodeId, Record<string, number>>();
  // Last rate this pass propagated along each outgoing edge / recorded as a
  // terminal recipe's own surplus demand. Propagation applies the delta since
  // the last value so re-processing a node with a grown output replaces its
  // prior contribution instead of double-counting it (a maximize recipe fed
  // through a pool can be dequeued at partial supply, then again at full).
  const edgeContribution = new Map<string, number>();
  const selfDemandContribution = new Map<string, number>();
  const queue: NodeId[] = [];
  const queued = new Set<NodeId>();

  for (const node of normalized.nodes) {
    availableInputs.set(node.id, new Map<string, number>());
  }

  function enqueue(nodeId: NodeId): void {
    if (queued.has(nodeId)) return;
    queued.add(nodeId);
    queue.push(nodeId);
    dirtySet?.add(nodeId);
  }

  for (const node of normalized.nodes) {
    const componentId = components.get(node.id);
    const componentHasDemand = componentId != null && componentsWithDemand.has(componentId);
    const componentHasSupplyFork = componentId != null && componentsWithSupplyFork.has(componentId);

    if (node.kind === 'recipe' && (node.machineCountOverride != null || node.productionRateOverride != null || node.powerTargetMw != null)) {
      enqueue(node.id);
      continue;
    }

    if (componentId == null) continue;
    // Sources feeding a maximized node must seed even when their component
    // has explicit demand, so the maximized node can size from supply.
    if (componentHasDemand && !componentHasSupplyFork && !upstreamOfMaximized.has(node.id)) continue;

    if (node.kind === 'source' && canSeedSupply(node)) {
      enqueue(node.id);
    } else if (node.kind === 'recipe' && node.inputRateOverride && node.inputRateOverride.ratePerMin > DEFAULT_EPSILON) {
      enqueue(node.id);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    queued.delete(nodeId);
    const node = normalized.nodesById.get(nodeId);
    if (!node) continue;

    let outputs: Record<string, number> = {};
    if (node.kind === 'source') {
      if (isDemandOnlySource(node)) {
        continue;
      }
      outputs = { [node.itemId]: sourceOutputRate(node) };
    } else if (node.kind === 'recipe') {
      const recipe = findRecipe(node.recipeId, gameData);
      if (!recipe) continue;
      const fixedOutputs = fixedRecipeOutputRates(node, recipe, gameData);
      if (fixedOutputs) {
        outputs = fixedOutputs;
      } else if (node.powerTargetMw != null && isGeneratorRecipe(recipe, gameData)) {
        // A power-target generator is a fixed-size root: its output (nuclear
        // waste) is capped by the power target, not by however much fuel is
        // available, so downstream maximize consumers see the real waste bound.
        const machines = machinesForPowerTarget(node, recipe, gameData);
        outputs = toRecord(ratesForMachines(recipe, machines, recipeRateOptions(node, recipe, gameData)).outputs);
      } else {
        const available = availableInputs.get(node.id) ?? new Map<string, number>();
        const machines = hasUnsuppliedConnectedInput(node, recipe, available, normalized)
          ? 0
          : recipeMachinesFromAvailableInputs(
              node,
              recipe,
              available,
              gameData,
              normalized
            );
        if (node.maximizeOutput || node.overproduceFromSurplus) {
          // Last processing wins: the queue re-enqueues the node whenever its
          // available inputs meaningfully change, so this reflects final state.
          const partialSeed = hasUnseededConnectedInput(node, recipe, available, normalized);
          if (partialSeed) {
            // A partially-seeded size is not a trustworthy floor and grants no
            // scale-down immunity — the constraint pass may still pull it down
            // if an unseeded intermediate input turns out to bind lower.
            unseededInputNodeIds.add(node.id);
          } else {
            unseededInputNodeIds.delete(node.id);
          }

          if (hasUnseededDirectClaimInput(node, recipe, available, normalized)) {
            // Seed sized from the wrong inputs (a demand-mode raw claim, the
            // intended bottleneck, could not seed): discard it so the node
            // stays demand-driven rather than pinning to an inflated size.
            supplyMachinesByNode.delete(node.id);
          } else {
            // Seed is a real ceiling (all bottlenecks are seeded intermediates
            // or bounded sources): keep it so the node pins to it and a large
            // downstream demand cannot inflate it past deliverable supply.
            supplyMachinesByNode.set(node.id, machines);
          }
        }
        outputs = toRecord(ratesForMachines(recipe, machines, recipeRateOptions(node, recipe, gameData)).outputs);
      }
    } else if (node.kind === 'pool') {
      // Pool the entire incoming supply of its item, then fan it out once.
      const available = availableInputs.get(node.id) ?? new Map<string, number>();
      const pooled = readAvailableInput(available, node.itemId);
      if (pooled <= DEFAULT_EPSILON) continue;
      outputs = { [node.itemId]: pooled };
    } else {
      continue;
    }

    const previousOutputs = recipeOutputs.get(node.id) ?? {};
    if (recordsEqual(previousOutputs, outputs, DEFAULT_EPSILON)) continue;
    recipeOutputs.set(node.id, outputs);

    for (const [itemId, rate] of Object.entries(outputs)) {
      const outgoing = (normalized.outgoingEdgesByNode.get(node.id) ?? []).filter((edge) => itemsMatch(edge.itemId, itemId));
      if (outgoing.length === 0 && node.kind === 'recipe') {
        if (node.machineCountOverride == null && node.productionRateOverride == null) {
          const selfKey = `${node.id}:${itemId}`;
          const previous = selfDemandContribution.get(selfKey) ?? 0;
          applyDemandDelta(demands, node.id, itemId, rate - previous);
          selfDemandContribution.set(selfKey, rate);
        }
        continue;
      }

      const allocations = splitSupplyAcrossOutgoingEdges(
        outgoing,
        rate,
        previousPlan,
        normalized,
        gameData,
        tiering,
        autoPrioritizeContestedForks
      );
      for (const edge of outgoing) {
        const splitRate = allocations.get(edge.id) ?? 0;
        const delta = splitRate - (edgeContribution.get(edge.id) ?? 0);
        if (Math.abs(delta) <= DEFAULT_EPSILON) continue;
        edgeContribution.set(edge.id, splitRate);
        const target = normalized.nodesById.get(edge.targetId);
        if (target?.kind === 'sink' && target.demandPerMin == null) {
          applyDemandDelta(demands, target.id, edge.itemId, delta);
          continue;
        }
        if (applyAvailableInputDelta(availableInputs, edge.targetId, edge.itemId, delta)) {
          enqueue(edge.targetId);
        }
      }
    }
  }

  seedGeneratorInputDemand(normalized, demands, availableInputs, gameData);

  return { supplyMachinesByNode, unseededInputNodeIds };
}

function rankForEdge(edge: ProductionEdge, relevantEdges: readonly ProductionEdge[]): number | null {
  const priority = edge.routing?.priority ?? [];
  if (priority.length === 0) return null;

  const identifiers = [edge.id, edge.sourceId, edge.targetId];
  for (const identifier of identifiers) {
    const rank = priority.indexOf(identifier);
    if (rank >= 0) return rank;
  }

  for (const peerId of priority) {
    const peerIndex = relevantEdges.findIndex((candidate) =>
      candidate.id === peerId || candidate.sourceId === peerId || candidate.targetId === peerId
    );
    if (peerIndex >= 0 && relevantEdges[peerIndex]?.id === edge.id) return priority.indexOf(peerId);
  }

  return null;
}

function splitDemandAcrossEdges(
  edges: readonly ProductionEdge[],
  demandRate: number,
  previousPlan: RequiredPlan,
  normalized?: NormalizedGraph,
  gameData?: EngineGameData,
  supplyMachinesByNode?: ReadonlyMap<NodeId, number>
): Map<string, number> {
  const allocations = new Map<string, number>();
  if (edges.length === 0) return allocations;

  const splitBySupplyCeiling = (candidateEdges: readonly ProductionEdge[], rate: number): boolean => {
    if (!normalized || !gameData || candidateEdges.length <= 1) return false;

    const entries = candidateEdges.map((edge) => ({
      edge,
      ceiling: getConnectedInputSupplyCeiling(edge, normalized, gameData, previousPlan, supplyMachinesByNode),
    }));
    const finite = entries.filter(
      (entry): entry is { edge: ProductionEdge; ceiling: number } => entry.ceiling != null
    );
    if (finite.length === 0) return false;

    // Branches with known supply drain first; branches whose supply is
    // unknown (elastic chains that size to whatever is demanded) only absorb
    // what the known branches cannot cover.
    const { allocations: fill, remaining } = waterFill(
      finite.map((entry) => ({ id: entry.edge.id, cap: entry.ceiling })),
      rate,
      DEFAULT_EPSILON
    );
    for (const [edgeId, allocated] of fill) allocations.set(edgeId, allocated);

    const unbounded = entries.filter((entry) => entry.ceiling == null);
    if (unbounded.length > 0) {
      const splitRate = remaining / unbounded.length;
      for (const { edge } of unbounded) allocations.set(edge.id, splitRate);
    } else if (remaining > DEFAULT_EPSILON) {
      // Shortage: attribute the uncovered demand proportionally to capacity
      // so the deficit lands where supply is expected, not evenly.
      const totalCeiling = finite.reduce((sum, entry) => sum + entry.ceiling, 0);
      for (const { edge, ceiling } of finite) {
        const current = allocations.get(edge.id) ?? 0;
        allocations.set(edge.id, current + remaining * (ceiling / totalCeiling));
      }
    }

    for (const edge of candidateEdges) allocations.set(edge.id, allocations.get(edge.id) ?? 0);
    return true;
  };

  const splitBySourceCapacity = (candidateEdges: readonly ProductionEdge[], rate: number): boolean => {
    if (!normalized || candidateEdges.length <= 1) return false;
    const capacities = candidateEdges.map((edge) => {
      const source = normalized.nodesById.get(edge.sourceId);
      if (source?.kind !== 'source' || isDemandOnlySource(source)) return 0;
      return sourceOutputRate(source);
    });
    if (capacities.some((capacity) => capacity <= DEFAULT_EPSILON)) return false;
    const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
    if (totalCapacity <= DEFAULT_EPSILON) return false;

    for (let index = 0; index < candidateEdges.length; index += 1) {
      const edge = candidateEdges[index]!;
      const capacity = capacities[index]!;
      allocations.set(edge.id, rate * (capacity / totalCapacity));
    }
    return true;
  };

  const ranked = edges
    .map((edge) => ({ edge, rank: rankForEdge(edge, edges) }))
    .filter((entry): entry is { edge: ProductionEdge; rank: number } => entry.rank != null)
    .sort((left, right) => left.rank - right.rank || left.edge.id.localeCompare(right.edge.id));

  if (ranked.length === 0) {
    if (splitBySupplyCeiling(edges, demandRate)) {
      return allocations;
    }
    if (splitBySourceCapacity(edges, demandRate)) {
      return allocations;
    }
    const splitRate = demandRate / edges.length;
    for (const edge of edges) allocations.set(edge.id, splitRate);
    return allocations;
  }

  let remaining = demandRate;
  for (const { edge } of ranked) {
    const sourcePlan = previousPlan[edge.sourceId];
    const knownCapacity = sourcePlan ? getRecordValue(sourcePlan.requiredOutputs, edge.itemId) : Infinity;
    const allocated = Math.min(remaining, Math.max(0, knownCapacity));
    allocations.set(edge.id, allocated);
    remaining -= allocated;
  }

  const unranked = edges.filter((edge) => !allocations.has(edge.id));
  if (
    unranked.length > 0 &&
    !splitBySupplyCeiling(unranked, remaining) &&
    !splitBySourceCapacity(unranked, remaining)
  ) {
    const splitRate = remaining / unranked.length;
    for (const edge of unranked) allocations.set(edge.id, splitRate);
  }
  for (const edge of edges) allocations.set(edge.id, allocations.get(edge.id) ?? 0);
  return allocations;
}

function propagateInputs(
  normalized: NormalizedGraph,
  nodeId: NodeId,
  requiredInputs: Readonly<Record<string, number>>,
  demands: Map<NodeId, Map<string, number>>,
  previousPlan: RequiredPlan,
  gameData: EngineGameData,
  processedNodeIds?: ReadonlySet<NodeId>,
  lateDemandSeed?: DemandSeed,
  supplyMachinesByNode?: ReadonlyMap<NodeId, number>
): void {
  const incoming = normalized.incomingEdgesByNode.get(nodeId) ?? [];

  function addPropagatedDemand(targetNodeId: NodeId, itemId: string, rate: number): void {
    if (!addDemand(demands, targetNodeId, itemId, rate)) return;
    if (processedNodeIds?.has(targetNodeId) && lateDemandSeed) {
      addDemandSeed(lateDemandSeed, targetNodeId, itemId, rate);
    }
  }

  for (const [itemId, requiredRate] of Object.entries(requiredInputs)) {
    const relevant = incoming.filter((edge) => itemsMatch(edge.itemId, itemId));

    const tiers = classifyIncomingEdges(relevant, normalized, gameData);
    let remaining = requiredRate;

    for (const tier of tiers) {
      const byproductInTier = tier.filter((e) => isFixedByproductEdge(e, normalized, gameData));
      const elasticInTier = tier.filter((e) => !isFixedByproductEdge(e, normalized, gameData) && !e.routing?.overflow);
      const overflowInTier = tier.filter((e) => e.routing?.overflow);

      for (const edge of byproductInTier) {
        const cap = byproductEdgeCap(edge, normalized, gameData, previousPlan, demands);
        const allocated = Math.min(cap, remaining);
        addPropagatedDemand(edge.sourceId, edge.itemId, allocated);
        remaining -= allocated;
      }
      remaining = Math.max(0, remaining);

      if (elasticInTier.length > 0) {
        const split = splitDemandAcrossEdges(
          elasticInTier,
          remaining,
          previousPlan,
          normalized,
          gameData,
          supplyMachinesByNode
        );
        for (const edge of elasticInTier) {
          addPropagatedDemand(edge.sourceId, edge.itemId, split.get(edge.id) ?? 0);
        }
        remaining = 0;
      }

      if (overflowInTier.length > 0 && remaining > 0) {
        const splitShare = remaining / overflowInTier.length;
        for (const edge of overflowInTier) {
          addPropagatedDemand(edge.sourceId, edge.itemId, splitShare);
        }
        remaining = 0;
      }
    }
  }
}

function seedDemandRoots(
  normalized: NormalizedGraph,
  demands: Map<NodeId, Map<string, number>>,
  gameData: EngineGameData,
  previousPlan: RequiredPlan,
  dirtySet?: Set<NodeId>,
  skipSupplySeeding?: boolean,
  tiering?: SupplySeedTiering,
  autoPrioritizeContestedForks?: boolean
): SupplySeedResult {
  for (const node of normalized.nodes) {
    if (node.kind === 'sink') {
      if (node.demandPerMin != null) addDemand(demands, node.id, node.itemId, finiteRate(node.demandPerMin));
      continue;
    }

    if (node.kind !== 'recipe') continue;
    const recipe = findRecipe(node.recipeId, gameData);
    if (!recipe) continue;

    if (node.machineCountOverride != null) {
      const rates = ratesForMachines(recipe, finiteRate(node.machineCountOverride), recipeRateOptions(node, recipe, gameData));
      for (const output of rates.outputs) addDemand(demands, node.id, output.itemId, output.ratePerMin);
    }

    const outputItemId = primaryOutputItemId(recipe);
    if (node.productionRateOverride != null && outputItemId) {
      addDemand(demands, node.id, outputItemId, finiteRate(node.productionRateOverride));
      continue;
    }

    if (node.powerTargetMw != null && outputItemId) {
      if (isGeneratorRecipe(recipe, gameData)) {
        // A generator's power target is MW, not an item rate. Seed each output
        // (e.g. nuclear waste) at the rate the power-sized machine count yields.
        const machines = machinesForPowerTarget(node, recipe, gameData);
        const rates = ratesForMachines(recipe, machines, recipeRateOptions(node, recipe, gameData));
        for (const output of rates.outputs) addDemand(demands, node.id, output.itemId, output.ratePerMin);
      } else {
        addDemand(demands, node.id, outputItemId, finiteRate(node.powerTargetMw));
      }
    }
  }

  if (skipSupplySeeding) {
    return { supplyMachinesByNode: new Map<NodeId, number>(), unseededInputNodeIds: new Set<NodeId>() };
  }
  return seedSupplyDrivenDemand(
    normalized,
    demands,
    gameData,
    previousPlan,
    dirtySet,
    tiering,
    autoPrioritizeContestedForks
  );
}

function backwardOrder(normalized: NormalizedGraph): NodeId[] {
  const remainingOutgoing = new Map<NodeId, number>();
  const queue: NodeId[] = [];
  const order: NodeId[] = [];

  for (const node of normalized.nodes) {
    const count = normalized.outgoingEdgesByNode.get(node.id)?.length ?? 0;
    remainingOutgoing.set(node.id, count);
    if (count === 0) queue.push(node.id);
  }

  while (queue.length > 0 || order.length < normalized.nodes.length) {
    if (queue.length === 0) {
      const unvisited = normalized.nodes
        .map((node) => node.id)
        .filter((nodeId) => !order.includes(nodeId))
        .sort();
      if (!unvisited[0]) break;
      queue.push(unvisited[0]);
    }

    const nodeId = queue.shift()!;
    if (order.includes(nodeId)) continue;
    order.push(nodeId);

    for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
      const remaining = (remainingOutgoing.get(edge.sourceId) ?? 0) - 1;
      remainingOutgoing.set(edge.sourceId, remaining);
      if (remaining <= 0) queue.push(edge.sourceId);
    }
  }

  return order;
}

function recordsEqual(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
  epsilon: number
): boolean {
  const leftRecord = left ?? {};
  const rightRecord = right ?? {};
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    const leftValue = getRecordValue(leftRecord, key);
    const rightValue = getRecordValue(rightRecord, key);
    if (Math.abs(leftValue - rightValue) > epsilon) return false;
  }
  return true;
}

function nodePlansEqual(
  a: RequiredPlanNode | undefined,
  b: RequiredPlanNode | undefined,
  epsilon: number
): boolean {
  if (!a || !b) return false;
  if (Math.abs(a.requiredMachines - b.requiredMachines) > epsilon) return false;
  return (
    recordsEqual(a.requiredInputs, b.requiredInputs, epsilon) &&
    recordsEqual(a.requiredOutputs, b.requiredOutputs, epsilon)
  );
}

function runDemandIteration(
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  previousPlan: RequiredPlan,
  demandSeed: DemandSeed,
  dirtySet: Set<NodeId>,
  epsilon: number,
  seedOptions?: {
    skipSupplySeeding?: boolean;
    tiering?: SupplySeedTiering;
    autoPrioritizeContestedForks?: boolean;
  }
): {
  plan: RequiredPlan;
  diagnostics: DemandDiagnostic[];
  nextDirtySet: Set<NodeId>;
  lateDemandSeed: DemandSeed;
  supplyMachinesByNode: Map<NodeId, number>;
  unseededInputNodeIds: Set<NodeId>;
} {
  const demands = new Map<NodeId, Map<string, number>>();
  const diagnostics: DemandDiagnostic[] = [];
  const plan: RequiredPlan = {};
  const nextDirtySet = new Set<NodeId>();
  const lateDemandSeed: DemandSeed = {};
  const processedNodeIds = new Set<NodeId>();

  for (const node of normalized.nodes) {
    demands.set(node.id, new Map<string, number>());
  }
  applyDemandSeed(demands, demandSeed);
  const { supplyMachinesByNode, unseededInputNodeIds } = seedDemandRoots(
    normalized,
    demands,
    gameData,
    previousPlan,
    dirtySet,
    seedOptions?.skipSupplySeeding,
    seedOptions?.tiering,
    seedOptions?.autoPrioritizeContestedForks
  );

  for (const nodeId of backwardOrder(normalized)) {
    const node = normalized.nodesById.get(nodeId);
    if (!node) continue;

    const nodeDemand = demands.get(nodeId) ?? new Map<string, number>();
    const isDirty = dirtySet.has(nodeId);
    const priorNodePlan = previousPlan[nodeId];

    if (!isDirty && priorNodePlan) {
      plan[nodeId] = priorNodePlan;
      propagateInputs(normalized, nodeId, priorNodePlan.requiredInputs, demands, previousPlan, gameData, processedNodeIds, lateDemandSeed, supplyMachinesByNode);
    } else {
      if (node.kind === 'source') {
        const demandRate = readDemand(nodeDemand, node.itemId);
        plan[node.id] = {
          nodeId: node.id,
          requiredMachines: 0,
          requiredInputs: {},
          requiredOutputs: { [node.itemId]: demandRate },
        };
      } else if (node.kind === 'sink') {
        const demandRate = readDemand(nodeDemand, node.itemId);
        plan[node.id] = {
          nodeId: node.id,
          requiredMachines: 0,
          requiredInputs: { [node.itemId]: demandRate },
          requiredOutputs: {},
        };
        propagateInputs(normalized, node.id, plan[node.id].requiredInputs, demands, previousPlan, gameData, processedNodeIds, lateDemandSeed, supplyMachinesByNode);
      } else if (node.kind === 'pool') {
        // Transparent passthrough: mirror demand in==out, then split the
        // demand back across the pooled incoming edges.
        const demandRate = readDemand(nodeDemand, node.itemId);
        plan[node.id] = {
          nodeId: node.id,
          requiredMachines: 0,
          requiredInputs: { [node.itemId]: demandRate },
          requiredOutputs: { [node.itemId]: demandRate },
        };
        propagateInputs(normalized, node.id, plan[node.id].requiredInputs, demands, previousPlan, gameData, processedNodeIds, lateDemandSeed, supplyMachinesByNode);
      } else {
        const recipePlan = calculateRecipePlan(node, nodeDemand, gameData, supplyMachinesByNode);
        plan[node.id] = recipePlan.plan;
        if (recipePlan.diagnostic) diagnostics.push(recipePlan.diagnostic);
        propagateInputs(normalized, node.id, recipePlan.plan.requiredInputs, demands, previousPlan, gameData, processedNodeIds, lateDemandSeed, supplyMachinesByNode);
      }

      const nodePlan = plan[nodeId]!;
      const changed = !priorNodePlan || !nodePlansEqual(nodePlan, priorNodePlan, epsilon);

      if (changed) {
        for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
          nextDirtySet.add(edge.sourceId);
        }

        for (const edge of normalized.outgoingEdgesByNode.get(nodeId) ?? []) {
          nextDirtySet.add(edge.targetId);
        }
      } else if (node.kind === 'recipe') {
        for (const edge of normalized.incomingEdgesByNode.get(nodeId) ?? []) {
          nextDirtySet.add(edge.sourceId);
        }
      }
    }

    processedNodeIds.add(nodeId);
  }

  for (const nodeId of Object.keys(lateDemandSeed)) {
    nextDirtySet.add(nodeId);
  }

  return { plan, diagnostics, nextDirtySet, lateDemandSeed, supplyMachinesByNode, unseededInputNodeIds };
}

function plansEqual(left: RequiredPlan, right: RequiredPlan, epsilon: number): boolean {
  const nodeIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const nodeId of nodeIds) {
    const a = left[nodeId];
    const b = right[nodeId];
    if (!nodePlansEqual(a, b, epsilon)) return false;
  }
  return true;
}

function changedNodeIds(left: RequiredPlan, right: RequiredPlan | undefined, epsilon: number): NodeId[] {
  if (!right) return Object.keys(left);
  return Object.keys(left).filter((nodeId) => !nodePlansEqual(left[nodeId], right[nodeId], epsilon));
}

function demandSeedsEqual(left: DemandSeed, right: DemandSeed, epsilon: number): boolean {
  const nodeIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const nodeId of nodeIds) {
    if (!recordsEqual(left[nodeId], right[nodeId], epsilon)) return false;
  }
  return true;
}

export function calculateRequiredPlan(
  normalized: NormalizedGraph,
  gameData: EngineGameData,
  options: DemandOptions = {}
): DemandResult {
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const diagnostics: DemandDiagnostic[] = [];
  const previousPlan = options.previous ?? {};
  let currentPlan: RequiredPlan = {};

  let dirtySet = options.dirtyNodeIds
    ? new Set<NodeId>(options.dirtyNodeIds)
    : new Set<NodeId>(normalized.nodes.map((n) => n.id));

  let prevIterPlan = previousPlan;
  let demandSeed: DemandSeed = {};
  let supplyMachinesByNode = new Map<NodeId, number>();
  let unseededInputNodeIds = new Set<NodeId>();

  const skipSupplySeeding = options.fixedDemandOnly === true;

  // Reservation baseline for tiered supply seeding: the plan driven purely by
  // explicit roots, computed once so it stays constant across iterations.
  const selfDemandSeededIds = skipSupplySeeding
    ? new Set<NodeId>()
    : selfDemandSeededRecipeIds(normalized, gameData);
  let tiering: SupplySeedTiering | undefined;
  if (!skipSupplySeeding && graphNeedsTieredSeeding(normalized, selfDemandSeededIds)) {
    const fixed = calculateRequiredPlan(normalized, gameData, {
      epsilon,
      maxIterations,
      fixedDemandOnly: true,
    });
    // A non-converged baseline must not reserve; fall back to legacy splits.
    if (!fixed.diagnostics.some((diagnostic) => diagnostic.code === 'cycle')) {
      tiering = {
        fixedPlan: fixed.plan,
        activeMaximizeUpstream: new Set([
          ...upstreamOfMaximizedSet(normalized, true),
          ...upstreamOfNodesMatching(normalized, (node) => selfDemandSeededIds.has(node.id)),
        ]),
        activeSpareUpstream: upstreamOfNodesMatching(normalized, isActiveSpareRecipe),
      };
    }
  }
  const seedOptions = {
    skipSupplySeeding,
    tiering,
    autoPrioritizeContestedForks: options.autoPrioritizeContestedForks,
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const result = runDemandIteration(normalized, gameData, prevIterPlan, demandSeed, dirtySet, epsilon, seedOptions);
    currentPlan = result.plan;
    diagnostics.push(...result.diagnostics);
    supplyMachinesByNode = result.supplyMachinesByNode;
    unseededInputNodeIds = result.unseededInputNodeIds;

    if (plansEqual(currentPlan, prevIterPlan, epsilon) && demandSeedsEqual(result.lateDemandSeed, demandSeed, epsilon)) {
      return {
        plan: currentPlan,
        diagnostics,
        touchedNodeIds: changedNodeIds(currentPlan, options.previous, epsilon),
        supplyBoundMaximizedNodeIds: supplyBoundMaximizedNodeIds(normalized, currentPlan, supplyMachinesByNode, unseededInputNodeIds, epsilon),
        fixedRequiredPlan: tiering?.fixedPlan,
      };
    }

    dirtySet = result.nextDirtySet;
    prevIterPlan = currentPlan;
    demandSeed = result.lateDemandSeed;
  }

  diagnostics.push({
    layerId: 'autocalc',
    severity: 'warning',
    code: 'cycle',
    scope: {},
    message: `Demand pass did not converge within ${maxIterations} iterations.`,
  });

  return {
    plan: currentPlan,
    diagnostics,
    touchedNodeIds: changedNodeIds(currentPlan, options.previous, epsilon),
    supplyBoundMaximizedNodeIds: supplyBoundMaximizedNodeIds(normalized, currentPlan, supplyMachinesByNode, unseededInputNodeIds, epsilon),
    fixedRequiredPlan: tiering?.fixedPlan,
  };
}

/**
 * Maximized nodes whose final size equals what supply seeding allowed. Only
 * these get override-style scaling immunity; demand-bound maximized nodes
 * (demand exceeds seedable supply, or nothing upstream seeds) scale exactly
 * like unflagged nodes.
 */
function supplyBoundMaximizedNodeIds(
  normalized: NormalizedGraph,
  plan: RequiredPlan,
  supplyMachinesByNode: ReadonlyMap<NodeId, number>,
  unseededInputNodeIds: ReadonlySet<NodeId>,
  epsilon: number
): NodeId[] {
  const ids: NodeId[] = [];
  for (const node of normalized.nodes) {
    if (node.kind !== 'recipe' || (!node.maximizeOutput && !node.overproduceFromSurplus)) continue;
    if (node.machineCountOverride != null || node.productionRateOverride != null || node.powerTargetMw != null) continue;
    // A size computed while a connected input had no seeded supply is an upper
    // guess from the other inputs, not a real supply bound — no immunity.
    if (unseededInputNodeIds.has(node.id)) continue;
    const supplyMachines = supplyMachinesByNode.get(node.id) ?? 0;
    if (supplyMachines <= epsilon) continue;
    const requiredMachines = plan[node.id]?.requiredMachines ?? 0;
    if (requiredMachines <= supplyMachines + epsilon) ids.push(node.id);
  }
  return ids;
}
