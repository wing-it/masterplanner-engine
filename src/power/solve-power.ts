import type { AutocalcResult } from '../types/autocalc';
import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { LayerDiagnostic } from '../types/layer';
import type { PowerInput, PowerNodeResult, PowerResult } from '../types/power';
import type { ProductionNode } from '../types/production-graph';
import { consumerDrawMw, generatorGenMw } from './power-math';

const POWER_EPSILON = 1e-6;

export interface ComputePowerOutput {
  result: PowerResult;
  diagnostics: LayerDiagnostic[];
  touchedNodeIds: string[];
}

interface NodePowerOutput {
  result: PowerNodeResult | null;
  diagnostic: LayerDiagnostic | null;
}

/**
 * Pure per-node power resolution. Returns a result for recipe nodes with a
 * resolvable consumer/generator profile, otherwise null (with a diagnostic when
 * the null is due to an error). Non-recipe nodes return null with no diagnostic.
 */
function computeNodePower(
  graphNode: ProductionNode,
  autocalcNode: AutocalcResult['nodes'][string],
  recipeMap: ReadonlyMap<string, EngineRecipeDefinition>,
  gameData: EngineGameData,
): NodePowerOutput {
  if (graphNode.kind !== 'recipe') {
    return { result: null, diagnostic: null };
  }

  const recipe = recipeMap.get(graphNode.recipeId);
  if (!recipe) {
    return {
      result: null,
      diagnostic: {
        layerId: 'power',
        severity: 'error',
        code: 'missing-recipe',
        scope: { nodeId: graphNode.id },
        message: `Recipe ${graphNode.recipeId} not found for node ${graphNode.id}.`,
      },
    };
  }

  const machineId = recipe.machine?.id;
  if (!machineId) {
    return {
      result: null,
      diagnostic: {
        layerId: 'power',
        severity: 'error',
        code: 'missing-machine',
        scope: { nodeId: graphNode.id },
        message: `Recipe ${recipe.id} has no machine for node ${graphNode.id}.`,
      },
    };
  }

  const profile = gameData.buildingPowerById.get(machineId);
  if (!profile) {
    return {
      result: null,
      diagnostic: {
        layerId: 'power',
        severity: 'error',
        code: 'no-power-profile',
        scope: { nodeId: graphNode.id },
        message: `No power profile for building ${machineId} on node ${graphNode.id}.`,
      },
    };
  }

  const machines = autocalcNode.machines ?? 0;
  const clockPercent = graphNode.clockPercent ?? 100;
  const somersloopsInstalled = graphNode.somersloopsInstalled ?? 0;

  if (profile.role === 'consumer' || profile.role === 'variable-consumer') {
    const drawMw = consumerDrawMw(profile, machines, clockPercent, somersloopsInstalled);
    return { result: { role: 'consumer', drawMw, genMw: 0 }, diagnostic: null };
  }

  if (profile.role === 'generator') {
    const genMw = generatorGenMw(profile, machines, clockPercent);
    return { result: { role: 'generator', drawMw: 0, genMw }, diagnostic: null };
  }

  // power-augmenter and any future roles are deferred.
  return {
    result: null,
    diagnostic: {
      layerId: 'power',
      severity: 'warning',
      code: 'unsupported-role',
      scope: { nodeId: graphNode.id },
      message: `Power role ${profile.role} for building ${machineId} is not supported yet.`,
    },
  };
}

function computePowerFull(
  input: PowerInput,
  gameData: EngineGameData,
  recipeMap: ReadonlyMap<string, EngineRecipeDefinition>,
): ComputePowerOutput {
  const { graph, autocalc } = input;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  const diagnostics: LayerDiagnostic[] = [];
  const powerNodes: Record<string, PowerNodeResult> = {};
  let worldDraw = 0;
  let worldGen = 0;
  const touchedNodeIds: string[] = [];

  for (const [nodeId, autocalcNode] of Object.entries(autocalc.nodes)) {
    const graphNode = nodesById.get(nodeId);
    if (!graphNode) {
      continue;
    }

    const { result, diagnostic } = computeNodePower(graphNode, autocalcNode, recipeMap, gameData);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
    if (result) {
      powerNodes[nodeId] = result;
      worldDraw += result.drawMw;
      worldGen += result.genMw;
      touchedNodeIds.push(nodeId);
    }
  }

  return {
    result: {
      schemaVersion: 1,
      nodes: powerNodes,
      world: {
        drawMw: worldDraw,
        genMw: worldGen,
        netMw: worldGen - worldDraw,
      },
    },
    diagnostics,
    touchedNodeIds,
  };
}

function computePowerIncremental(
  input: PowerInput,
  gameData: EngineGameData,
  recipeMap: ReadonlyMap<string, EngineRecipeDefinition>,
): ComputePowerOutput {
  const { graph, autocalc, previous, autocalcTouched, origin } = input;
  if (!previous) {
    throw new Error('computePowerIncremental requires input.previous');
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  // Dirty set = L1-touched machine changes ∪ the edited node (clock/somersloop/
  // recipe may have changed even if machines didn't) ∪ added/removed nodes.
  // Added nodes are already reported by L1 (actual.ts changedNodeIds marks
  // !prior as touched), but include them defensively. Removed nodes are NOT
  // reported by L1 because it iterates only current keys, so the symmetric
  // difference is required to keep the world delta correct.
  const dirtySet = new Set<string>(autocalcTouched ?? []);
  if (origin && 'nodeId' in origin) {
    dirtySet.add(origin.nodeId);
  }

  const currentIds = new Set(Object.keys(autocalc.nodes));
  const previousIds = new Set(Object.keys(previous.nodes));
  for (const nodeId of previousIds) {
    if (!currentIds.has(nodeId)) {
      dirtySet.add(nodeId);
    }
  }
  for (const nodeId of currentIds) {
    if (!previousIds.has(nodeId)) {
      dirtySet.add(nodeId);
    }
  }

  const diagnostics: LayerDiagnostic[] = [];
  const powerNodes: Record<string, PowerNodeResult> = {};
  let worldDraw = previous.world.drawMw;
  let worldGen = previous.world.genMw;
  const touchedNodeIds: string[] = [];

  for (const [nodeId, autocalcNode] of Object.entries(autocalc.nodes)) {
    const graphNode = nodesById.get(nodeId);
    const oldDraw = previous.nodes[nodeId]?.drawMw ?? 0;
    const oldGen = previous.nodes[nodeId]?.genMw ?? 0;

    if (!dirtySet.has(nodeId)) {
      const previousNode = previous.nodes[nodeId];
      if (previousNode) {
        powerNodes[nodeId] = previousNode;
      }
      continue;
    }

    if (!graphNode) {
      // Node is no longer in the graph but still in autocalc: treat as removed.
      worldDraw -= oldDraw;
      worldGen -= oldGen;
      touchedNodeIds.push(nodeId);
      continue;
    }

    const { result, diagnostic } = computeNodePower(graphNode, autocalcNode, recipeMap, gameData);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }

    const newDraw = result?.drawMw ?? 0;
    const newGen = result?.genMw ?? 0;

    if (result) {
      powerNodes[nodeId] = result;
    }

    worldDraw += newDraw - oldDraw;
    worldGen += newGen - oldGen;

    const previousNode = previous.nodes[nodeId];
    const presenceChanged = result ? !previousNode : Boolean(previousNode);
    const valueChanged =
      Math.abs(newDraw - oldDraw) > POWER_EPSILON ||
      Math.abs(newGen - oldGen) > POWER_EPSILON;
    if (presenceChanged || valueChanged) {
      touchedNodeIds.push(nodeId);
    }
  }

  // Subtract contributions from nodes that were removed from autocalc.
  for (const nodeId of previousIds) {
    if (currentIds.has(nodeId)) {
      continue;
    }
    if (!dirtySet.has(nodeId)) {
      continue;
    }
    const oldDraw = previous.nodes[nodeId]?.drawMw ?? 0;
    const oldGen = previous.nodes[nodeId]?.genMw ?? 0;
    worldDraw -= oldDraw;
    worldGen -= oldGen;
    touchedNodeIds.push(nodeId);
  }

  return {
    result: {
      schemaVersion: 1,
      nodes: powerNodes,
      world: {
        drawMw: worldDraw,
        genMw: worldGen,
        netMw: worldGen - worldDraw,
      },
    },
    diagnostics,
    touchedNodeIds,
  };
}

/**
 * Compute per-node power draw/generation and the world rollup.
 *
 * This is a pure function of (graph node config, autocalc machine counts, game
 * data). Edges and allocation do not affect power, so they are ignored.
 *
 * When `input.previous` and `input.origin` are supplied (and origin is not
 * 'full'), only the dirty power nodes are recomputed and the world rollup is
 * delta-updated. The caller must pass origin.type === 'full' (or omit previous)
 * when game data or any other non-node-scoped input changes, because this layer
 * cannot detect such changes from PowerResult alone.
 */
export function computePower(input: PowerInput, gameData: EngineGameData): ComputePowerOutput {
  const recipeMap = buildRecipeMap(gameData);

  if (!input.previous || !input.origin || input.origin.type === 'full') {
    return computePowerFull(input, gameData, recipeMap);
  }

  return computePowerIncremental(input, gameData, recipeMap);
}

function buildRecipeMap(gameData: EngineGameData): Map<string, EngineRecipeDefinition> {
  const recipes = [...(gameData.recipes ?? []), ...(gameData.generatorRecipes ?? [])];
  return new Map(recipes.map((recipe) => [recipe.id, recipe]));
}
