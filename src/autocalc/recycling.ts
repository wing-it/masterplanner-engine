import type { NormalizedGraph } from '../graph/normalize';
import {
  findRecipe,
  itemsMatch,
  machinesForOutput,
  ratesForMachines,
  resolveSomersloopMultiplier,
} from '../graph/recipe-math';
import { edgeIdentifiers, matchesIdentifier } from './edge-identity';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionEdge, ProductionNode } from '../types/production-graph';

const DEFAULT_EPSILON = 1e-6;

function getRecordValue(record: Readonly<Record<string, number>>, itemId: string): number {
  if (record[itemId] !== undefined) return record[itemId]!;
  for (const [key, value] of Object.entries(record)) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function toRecord(rates: readonly { itemId: string; ratePerMin: number }[]): Record<string, number> {
  const record: Record<string, number> = {};
  for (const rate of rates) {
    if (rate.ratePerMin <= DEFAULT_EPSILON) continue;
    record[rate.itemId] = rate.ratePerMin;
  }
  return record;
}

function finiteRate(value: number | undefined): number {
  return value != null && Number.isFinite(value) ? Math.max(0, value) : 0;
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

export function primaryOutputItemId(recipe: EngineRecipeDefinition): string | null {
  return recipe.product?.id ?? recipe.outputs.find((output) => output.itemId)?.itemId ?? null;
}

/**
 * Whether a recipe runs in a power generator. Authoritative signal is the
 * machine's building role; the output-count heuristic is only a fallback for
 * recipes whose building profile is unavailable (e.g. bare unit-test fixtures).
 *
 * The heuristic alone is wrong for nuclear/plutonium plants: they *emit* a
 * waste byproduct, so `outputs.length > 0`, yet they are still generators. Left
 * misclassified, a power-target plant is sized by its waste-output demand
 * instead of its fuel burn, letting a downstream consumer scale it without
 * bound.
 */
export function isGeneratorRecipe(recipe: EngineRecipeDefinition, gameData?: EngineGameData): boolean {
  const buildingId = recipe.machine?.id;
  if (buildingId && gameData) {
    const role = gameData.buildingPowerById.get(buildingId)?.role;
    if (role != null) return role === 'generator';
  }
  return recipe.outputs.length === 0 && recipe.inputs.length > 0;
}

export function fixedRecipeOutputRates(
  node: Extract<ProductionNode, { kind: 'recipe' }>,
  recipe: EngineRecipeDefinition,
  gameData: EngineGameData
): Record<string, number> | null {
  const opts = recipeRateOptions(node, recipe, gameData);

  if (node.machineCountOverride != null) {
    return toRecord(ratesForMachines(recipe, finiteRate(node.machineCountOverride), opts).outputs);
  }

  if (node.productionRateOverride != null) {
    const outputItemId = primaryOutputItemId(recipe);
    if (!outputItemId) return {};
    const machines = machinesForOutput(recipe, outputItemId, finiteRate(node.productionRateOverride), opts);
    return toRecord(ratesForMachines(recipe, machines, opts).outputs);
  }

  return null;
}

export function isFixedByproductEdge(
  edge: ProductionEdge,
  normalized: NormalizedGraph,
  gameData: EngineGameData
): boolean {
  const sourceNode = normalized.nodesById.get(edge.sourceId);
  if (!sourceNode || sourceNode.kind !== 'recipe') return false;

  const recipe = findRecipe(sourceNode.recipeId, gameData);
  if (!recipe || isGeneratorRecipe(recipe, gameData)) return false;

  const fixedRates = fixedRecipeOutputRates(sourceNode, recipe, gameData);
  if (fixedRates && getRecordValue(fixedRates, edge.itemId) > DEFAULT_EPSILON) return true;

  const primary = primaryOutputItemId(recipe);
  return !primary || !itemsMatch(edge.itemId, primary);
}

function rankForEdge(edge: ProductionEdge, relevantEdges: readonly ProductionEdge[]): number | null {
  const priority = edge.routing?.priority ?? [];
  if (priority.length === 0) return null;

  const identifiers = edgeIdentifiers(edge);
  for (const identifier of identifiers) {
    const rank = priority.indexOf(identifier);
    if (rank >= 0) return rank;
  }

  for (const peerId of priority) {
    const peerIndex = relevantEdges.findIndex((candidate) => matchesIdentifier(candidate, peerId));
    if (peerIndex >= 0 && relevantEdges[peerIndex]?.id === edge.id) return priority.indexOf(peerId);
  }

  return null;
}

export function classifyIncomingEdges(
  relevant: ProductionEdge[],
  normalized: NormalizedGraph,
  gameData: EngineGameData
): ProductionEdge[][] {
  let priority: string[] = [];
  for (const edge of relevant) {
    if (edge.routing?.priority && edge.routing.priority.length > 0) {
      priority = edge.routing.priority;
      break;
    }
  }

  const defaultClass = (edge: ProductionEdge): number => {
    if (edge.routing?.overflow) return 3;
    if (isFixedByproductEdge(edge, normalized, gameData)) return 1;
    return 2;
  };

  if (priority.length > 0) {
    const rankedGroups = new Map<number, ProductionEdge[]>();
    const unranked: ProductionEdge[] = [];

    for (const edge of relevant) {
      const rank = rankForEdge(edge, relevant);
      if (rank !== null && rank >= 0) {
        if (!rankedGroups.has(rank)) rankedGroups.set(rank, []);
        rankedGroups.get(rank)!.push(edge);
      } else {
        unranked.push(edge);
      }
    }

    const sortedRanks = Array.from(rankedGroups.keys()).sort((a, b) => a - b);
    const tiers: ProductionEdge[][] = [];
    for (const rank of sortedRanks) {
      tiers.push(rankedGroups.get(rank)!);
    }

    unranked.sort((a, b) => {
      const ca = defaultClass(a);
      const cb = defaultClass(b);
      if (ca !== cb) return ca - cb;
      return a.id.localeCompare(b.id);
    });

    let currentClass = -1;
    let currentTier: ProductionEdge[] = [];
    for (const edge of unranked) {
      const cls = defaultClass(edge);
      if (cls !== currentClass) {
        if (currentTier.length > 0) {
          tiers.push(currentTier);
        }
        currentTier = [edge];
        currentClass = cls;
      } else {
        currentTier.push(edge);
      }
    }
    if (currentTier.length > 0) {
      tiers.push(currentTier);
    }

    return tiers;
  } else {
    const byClass = new Map<number, ProductionEdge[]>();
    for (const edge of relevant) {
      const cls = defaultClass(edge);
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls)!.push(edge);
    }

    const tiers: ProductionEdge[][] = [];
    for (const cls of [1, 2, 3]) {
      const group = byClass.get(cls);
      if (group && group.length > 0) {
        group.sort((a, b) => a.id.localeCompare(b.id));
        tiers.push(group);
      }
    }
    return tiers;
  }
}

