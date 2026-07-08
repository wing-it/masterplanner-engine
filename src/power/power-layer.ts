import type { EngineGameData } from '../types/game-data';
import type { Layer, LayerResult } from '../types/layer';
import type { PowerInput, PowerResult } from '../types/power';
import { stableValueHash } from '../pipeline/hash';
import { computePower } from './solve-power';

export const powerLayer: Layer<PowerInput, PowerResult, EngineGameData> = {
  id: 'power',

  inputHash(input, gameData) {
    // Power only depends on machine counts, not edge allocation.
    const machineCounts = Object.entries(input.autocalc.nodes)
      .map(([nodeId, node]) => ({ nodeId, machines: node.machines }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

    // Only recipe-node config fields that affect power are included.
    const powerRelevantNodes = input.graph.nodes
      .filter((node) => node.kind === 'recipe')
      .map((node) => ({
        id: node.id,
        recipeId: node.recipeId,
        clockPercent: node.clockPercent,
        somersloopsInstalled: node.somersloopsInstalled,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    return stableValueHash({
      machineCounts,
      powerRelevantNodes,
      gameData: {
        buildingPowerById: gameData.buildingPowerById,
        generatorRecipes: gameData.generatorRecipes,
      },
    });
  },

  compute(input, gameData) {
    const startedAt = performance.now();
    const hash = this.inputHash(input, gameData);
    const computedAt = Date.now();

    const { result, diagnostics, touchedNodeIds } = computePower(input, gameData);

    return {
      ok: true,
      data: result,
      diagnostics,
      meta: {
        layerId: this.id,
        inputHash: hash,
        computedAt,
        durationMs: performance.now() - startedAt,
        touchedNodeIds,
      },
    };
  },
};
