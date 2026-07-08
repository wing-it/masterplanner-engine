import { powerLayer } from '../power/power-layer';
import type { AutocalcInput, AutocalcResult, ChangeOrigin } from '../types/autocalc';
import type { EngineGameData } from '../types/game-data';
import type { Layer, LayerResult } from '../types/layer';
import type { PowerInput, PowerResult } from '../types/power';
import type { ProductionGraph } from '../types/production-graph';
import { createLayerCache, type LayerCache } from './layer-cache';
import { ENGINE_CACHE_VERSION } from './engine-cache-version';
import { stableValueHash } from './hash';
export { stableValueHash } from './hash';
export { ENGINE_CACHE_VERSION } from './engine-cache-version';

export type RecalculationMode = 'full' | 'progressive';

export interface RunPipelineOptions {
  upTo: 'autocalc' | 'power';
  engineGameData: EngineGameData;
  cache?: LayerCache;
  previous?: AutocalcResult;
  previousPower?: PowerResult;
  origin?: ChangeOrigin;
  recalculationMode?: RecalculationMode;
  autocalcLayer?: Layer<AutocalcInput, AutocalcResult, EngineGameData>;
  powerLayer?: Layer<PowerInput, PowerResult, EngineGameData>;
}

export interface PipelineResult {
  autocalc: LayerResult<AutocalcResult>;
  power?: LayerResult<PowerResult>;
}

export const stubAutocalcLayer: Layer<AutocalcInput, AutocalcResult, EngineGameData> = {
  id: 'autocalc',

  inputHash(input, gameData) {
    return stableValueHash({ input, gameData });
  },

  compute(input, gameData) {
    const startedAt = performance.now();
    const inputHash = this.inputHash(input, gameData);
    const computedAt = Date.now();

    return {
      ok: true,
      data: {
        schemaVersion: 1,
        nodes: {},
        edges: {},
      },
      diagnostics: [],
      meta: {
        layerId: this.id,
        inputHash,
        computedAt,
        durationMs: performance.now() - startedAt,
      },
    };
  },
};

let defaultCache: LayerCache | null = null;

function getDefaultCache(): LayerCache {
  if (!defaultCache) {
    defaultCache = createLayerCache();
  }

  return defaultCache;
}

export async function runPipeline(
  graph: ProductionGraph,
  options: RunPipelineOptions
): Promise<PipelineResult> {
  const autocalcLayer = options.autocalcLayer ?? stubAutocalcLayer;
  const powerLayerInstance = options.powerLayer ?? powerLayer;
  const cache = options.cache ?? getDefaultCache();
  const recalculationMode = options.recalculationMode ?? 'full';
  const effectiveOrigin: ChangeOrigin = recalculationMode === 'progressive'
    ? options.origin ?? { type: 'full' }
    : { type: 'full' };
  const effectivePrevious = recalculationMode === 'progressive'
    ? options.previous
    : undefined;
  const effectivePreviousPower = recalculationMode === 'progressive'
    ? options.previousPower
    : undefined;

  const autocalcInput: AutocalcInput = {
    graph,
    previous: effectivePrevious,
    origin: effectiveOrigin,
  };
  const autocalcHash = autocalcLayer.inputHash(autocalcInput, options.engineGameData);
  const autocalcCacheKey = `${autocalcLayer.id}:v${ENGINE_CACHE_VERSION}:${autocalcHash}`;
  const cachedAutocalc = await cache.get<LayerResult<AutocalcResult>>(autocalcCacheKey);

  const autocalcResult = cachedAutocalc ?? await autocalcLayer.compute(autocalcInput, options.engineGameData);
  if (!cachedAutocalc && autocalcResult.ok) {
    await cache.set(autocalcCacheKey, autocalcResult);
  }

  if (options.upTo === 'autocalc' || !autocalcResult.ok || !autocalcResult.data) {
    return { autocalc: autocalcResult };
  }

  const powerInput: PowerInput = {
    graph,
    autocalc: autocalcResult.data,
    autocalcTouched: autocalcResult.meta.touchedNodeIds ?? [],
    previous: effectivePreviousPower,
    origin: effectiveOrigin,
  };

  const powerHash = powerLayerInstance.inputHash(powerInput, options.engineGameData);
  const powerCacheKey = `${powerLayerInstance.id}:v${ENGINE_CACHE_VERSION}:${powerHash}`;
  const cachedPower = await cache.get<LayerResult<PowerResult>>(powerCacheKey);

  if (cachedPower) {
    return { autocalc: autocalcResult, power: cachedPower };
  }

  const powerResult = await powerLayerInstance.compute(powerInput, options.engineGameData);
  if (powerResult.ok) {
    await cache.set(powerCacheKey, powerResult);
  }

  return { autocalc: autocalcResult, power: powerResult };
}
