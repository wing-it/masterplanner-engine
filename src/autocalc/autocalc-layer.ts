import type { AutocalcInput, AutocalcResult } from '../types/autocalc';
import type { EngineGameData } from '../types/game-data';
import type { Layer, LayerResult } from '../types/layer';
import { validateProductionGraph } from '../types/production-graph';
import { stableValueHash } from '../pipeline/hash';
import { solveProductionGraph } from './solve';

export const autocalcLayer: Layer<AutocalcInput, AutocalcResult, EngineGameData> = {
  id: 'autocalc',

  inputHash(input, gameData) {
    return stableValueHash({ input, gameData });
  },

  compute(input, gameData) {
    const startedAt = performance.now();
    const hash = this.inputHash(input, gameData);
    const computedAt = Date.now();

    const valResult = validateProductionGraph(input.graph, gameData);
    if (!valResult.ok) {
      return {
        ok: false,
        data: null,
        diagnostics: valResult.errors.map((err) => ({
          layerId: 'autocalc',
          severity: err.severity,
          code: err.code,
          scope: err.scope,
          message: err.message,
        })),
        meta: {
          layerId: this.id,
          inputHash: hash,
          computedAt,
          durationMs: performance.now() - startedAt,
        },
      };
    }

    const solve = solveProductionGraph(valResult.graph!, gameData, {
      previous: input.previous,
      origin: input.origin,
    });

    const diagnostics = [
      ...valResult.warnings.map((warn) => ({
        layerId: 'autocalc',
        severity: warn.severity,
        code: warn.code,
        scope: warn.scope,
        message: warn.message,
      })),
      ...solve.diagnostics,
    ];

    return {
      ok: true,
      data: solve.result,
      diagnostics,
      meta: {
        layerId: this.id,
        inputHash: hash,
        computedAt,
        durationMs: performance.now() - startedAt,
        touchedNodeIds: solve.touchedNodeIds,
        touchedEdgeIds: solve.touchedEdgeIds,
      },
    };
  },
};
