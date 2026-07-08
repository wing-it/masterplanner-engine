import { describe, expect, it, vi } from 'vitest';

import type { AutocalcInput, AutocalcResult } from '../types/autocalc';
import type { EngineBuildingPowerProfile, EngineGameData } from '../types/game-data';
import type { Layer, LayerResult } from '../types/layer';
import type { PowerInput, PowerResult } from '../types/power';
import type { ProductionGraph } from '../types/production-graph';
import { ENGINE_CACHE_VERSION } from './engine-cache-version';
import { createLayerCache, type LayerCache } from './layer-cache';
import { runPipeline } from './run-pipeline';

function graph(): ProductionGraph {
  return {
    schemaVersion: 2,
    nodes: [{ kind: 'source', id: 'source-1', itemId: 'Desc_OreIron_C', sourceType: 'manual-input', maxRatePerMin: 60 }],
    edges: [],
  };
}

function gameData(): EngineGameData {
  return {
    recipes: [],
    generatorRecipes: [],
    buildingPowerById: new Map(),
  };
}

function successfulResult(inputHash: string, nodes: AutocalcResult['nodes'] = {}): LayerResult<AutocalcResult> {
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      nodes,
      edges: {},
    },
    diagnostics: [],
    meta: {
      layerId: 'autocalc',
      inputHash,
      computedAt: 1,
      durationMs: 2,
    },
  };
}

function testLayer(result: LayerResult<AutocalcResult>): Layer<AutocalcInput, AutocalcResult, EngineGameData> & {
  compute: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'autocalc',
    inputHash: vi.fn(() => result.meta.inputHash),
    compute: vi.fn(() => result),
  };
}

function powerResult(
  inputHash: string,
  nodes: PowerResult['nodes'] = {},
  world: PowerResult['world'] = { drawMw: 0, genMw: 0, netMw: 0 },
): LayerResult<PowerResult> {
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      nodes,
      world,
    },
    diagnostics: [],
    meta: {
      layerId: 'power',
      inputHash,
      computedAt: 1,
      durationMs: 2,
    },
  };
}

function testPowerLayer(result: LayerResult<PowerResult>): Layer<PowerInput, PowerResult, EngineGameData> & {
  compute: ReturnType<typeof vi.fn>;
  inputHash: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'power',
    inputHash: vi.fn(() => result.meta.inputHash),
    compute: vi.fn(() => result),
  };
}

const DEFAULT_POWER_EXPONENT = 1.321928;

function consumerProfile(buildingId: string, basePowerMw: number): EngineBuildingPowerProfile {
  return {
    buildingId,
    role: 'consumer',
    basePowerMw,
    powerExponent: DEFAULT_POWER_EXPONENT,
    generatorScalesLinearly: false,
    powerShardSlots: 0,
    maxClockPercent: 250,
    supportsSomersloop: false,
    somersloopSlots: 0,
  };
}

function powerGameData(): EngineGameData {
  return {
    ...gameData(),
    recipes: [
      {
        id: 'iron-ingot',
        name: 'Iron Ingot',
        slug: 'iron-ingot',
        durationSeconds: 2,
        isAlternate: false,
        product: null,
        inputs: [],
        outputs: [],
        machine: { id: 'smelter', name: 'Smelter' },
      },
    ],
    buildingPowerById: new Map([['smelter', consumerProfile('smelter', 4)]]),
  };
}

function powerGraph(): ProductionGraph {
  return {
    schemaVersion: 2,
    nodes: [
      { kind: 'recipe', id: 'smelt1', recipeId: 'iron-ingot' },
      { kind: 'recipe', id: 'smelt2', recipeId: 'iron-ingot' },
    ],
    edges: [],
  };
}

function autocalcWithTouched(
  result: LayerResult<AutocalcResult>,
  touchedNodeIds: string[]
): LayerResult<AutocalcResult> {
  return {
    ...result,
    meta: { ...result.meta, touchedNodeIds },
  };
}

describe('runPipeline', () => {
  it('runs the autocalc layer for upTo autocalc', async () => {
    const result = successfulResult('hash-1');
    const layer = testLayer(result);

    const pipelineResult = await runPipeline(graph(), {
      upTo: 'autocalc',
      engineGameData: gameData(),
      cache: createLayerCache({ persistentBackend: null }),
      autocalcLayer: layer,
    });

    expect(layer.compute).toHaveBeenCalledTimes(1);
    expect(pipelineResult.autocalc).toEqual(result);
  });

  it('stores a successful cache miss and uses the cached result next time', async () => {
    const result = successfulResult('hash-1', {
      node: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const layer = testLayer(result);
    const cache = createLayerCache({ persistentBackend: null });
    const productionGraph = graph();
    const recipes = gameData();

    await expect(runPipeline(productionGraph, {
      upTo: 'autocalc',
      engineGameData: recipes,
      cache,
      autocalcLayer: layer,
    })).resolves.toEqual({ autocalc: result });
    await expect(runPipeline(productionGraph, {
      upTo: 'autocalc',
      engineGameData: recipes,
      cache,
      autocalcLayer: layer,
    })).resolves.toEqual({ autocalc: result });

    expect(layer.compute).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, memorySets: 1 });
  });

  it('versions cache keys so results from older engine code are not served', async () => {
    const result = successfulResult('hash-1');
    const layer = testLayer(result);
    const inner = createLayerCache({ persistentBackend: null });
    const seenKeys: string[] = [];
    const cache: LayerCache = {
      ...inner,
      get: ((key: string) => {
        seenKeys.push(key);
        return inner.get(key);
      }) as LayerCache['get'],
      set: ((key: string, value: never) => {
        seenKeys.push(key);
        return inner.set(key, value);
      }) as LayerCache['set'],
    };
    // A result cached by older engine code under the unversioned key must not hit.
    await inner.set('autocalc:hash-1', successfulResult('stale-hash'));

    await runPipeline(graph(), {
      upTo: 'autocalc',
      engineGameData: gameData(),
      cache,
      autocalcLayer: layer,
    });

    expect(seenKeys.length).toBeGreaterThan(0);
    expect(seenKeys.every((key) => key.startsWith(`autocalc:v${ENGINE_CACHE_VERSION}:`))).toBe(true);
    expect(layer.compute).toHaveBeenCalledTimes(1);
  });

  it('passes previous result and origin through to the layer input', async () => {
    const previous: AutocalcResult = {
      schemaVersion: 1,
      nodes: { source: { machines: 1, scale: 1, inputs: [], outputs: [] } },
      edges: {},
    };
    const origin = { type: 'source' as const, nodeId: 'source-1' };
    const result = successfulResult('hash-previous');
    const layer = testLayer(result);

    await runPipeline(graph(), {
      upTo: 'autocalc',
      engineGameData: gameData(),
      cache: createLayerCache({ persistentBackend: null }),
      previous,
      origin,
      recalculationMode: 'progressive',
      autocalcLayer: layer,
    });

    expect(layer.compute).toHaveBeenCalledWith(
      expect.objectContaining({ previous, origin }),
      expect.any(Object)
    );
  });

  it('defaults to full recalculation and does not pass previous result or edit origin to the autocalc layer', async () => {
    const previous: AutocalcResult = {
      schemaVersion: 1,
      nodes: { source: { machines: 1, scale: 1, inputs: [], outputs: [] } },
      edges: {},
    };
    const result = successfulResult('hash-full-default');
    const layer = testLayer(result);

    await runPipeline(graph(), {
      upTo: 'autocalc',
      engineGameData: gameData(),
      cache: createLayerCache({ persistentBackend: null }),
      previous,
      origin: { type: 'source', nodeId: 'source-1' },
      autocalcLayer: layer,
    });

    expect(layer.compute).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: undefined,
        origin: { type: 'full' },
      }),
      expect.any(Object)
    );
  });

  it('returns failed layer results without writing them to cache', async () => {
    const failedResult: LayerResult<AutocalcResult> = {
      ok: false,
      data: null,
      diagnostics: [{
        layerId: 'autocalc',
        severity: 'error',
        code: 'boom',
        scope: {},
        message: 'Nope.',
      }],
      meta: {
        layerId: 'autocalc',
        inputHash: 'hash-failed',
        computedAt: 1,
        durationMs: 2,
      },
    };
    const layer = testLayer(failedResult);
    const cache = createLayerCache({ persistentBackend: null });
    const productionGraph = graph();
    const recipes = gameData();

    await expect(runPipeline(productionGraph, {
      upTo: 'autocalc',
      engineGameData: recipes,
      cache,
      autocalcLayer: layer,
    })).resolves.toEqual({ autocalc: failedResult });
    await expect(runPipeline(productionGraph, {
      upTo: 'autocalc',
      engineGameData: recipes,
      cache,
      autocalcLayer: layer,
    })).resolves.toEqual({ autocalc: failedResult });

    expect(layer.compute).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, memorySets: 0 });
  });

  it('runs the power layer for upTo power', async () => {
    const autocalc = successfulResult('hash-autocalc', {
      node: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const power = powerResult('hash-power', {
      node: { role: 'consumer', drawMw: 4, genMw: 0 },
    }, { drawMw: 4, genMw: 0, netMw: -4 });
    const autocalcLayerMock = testLayer(autocalc);
    const powerLayerMock = testPowerLayer(power);

    const result = await runPipeline(graph(), {
      upTo: 'power',
      engineGameData: gameData(),
      cache: createLayerCache({ persistentBackend: null }),
      autocalcLayer: autocalcLayerMock,
      powerLayer: powerLayerMock,
    });

    expect(autocalcLayerMock.compute).toHaveBeenCalledTimes(1);
    expect(powerLayerMock.compute).toHaveBeenCalledTimes(1);
    expect(result.autocalc).toEqual(autocalc);
    expect(result.power).toEqual(power);
  });

  it('defaults to full recalculation and does not pass previous power or edit origin to the power layer', async () => {
    const autocalc = successfulResult('hash-autocalc', {
      node: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const power = powerResult('hash-power', {
      node: { role: 'consumer', drawMw: 4, genMw: 0 },
    }, { drawMw: 4, genMw: 0, netMw: -4 });
    const previousPower: PowerResult = {
      schemaVersion: 1,
      nodes: {
        node: { role: 'consumer', drawMw: 1, genMw: 0 },
      },
      world: { drawMw: 1, genMw: 0, netMw: -1 },
    };
    const autocalcLayerMock = testLayer(autocalc);
    const powerLayerMock = testPowerLayer(power);

    await runPipeline(graph(), {
      upTo: 'power',
      engineGameData: gameData(),
      cache: createLayerCache({ persistentBackend: null }),
      autocalcLayer: autocalcLayerMock,
      powerLayer: powerLayerMock,
      previous: autocalc.data!,
      previousPower,
      origin: { type: 'recipe-node', nodeId: 'node' },
    });

    expect(powerLayerMock.compute).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: undefined,
        origin: { type: 'full' },
      }),
      expect.any(Object)
    );
  });

  it('caches a successful power result and returns it on the next run', async () => {
    const autocalc = successfulResult('hash-autocalc', {
      node: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const power = powerResult('hash-power', {
      node: { role: 'consumer', drawMw: 4, genMw: 0 },
    }, { drawMw: 4, genMw: 0, netMw: -4 });
    const autocalcLayerMock = testLayer(autocalc);
    const powerLayerMock = testPowerLayer(power);
    const cache = createLayerCache({ persistentBackend: null });

    await expect(runPipeline(graph(), {
      upTo: 'power',
      engineGameData: gameData(),
      cache,
      autocalcLayer: autocalcLayerMock,
      powerLayer: powerLayerMock,
    })).resolves.toEqual({ autocalc, power });

    await expect(runPipeline(graph(), {
      upTo: 'power',
      engineGameData: gameData(),
      cache,
      autocalcLayer: autocalcLayerMock,
      powerLayer: powerLayerMock,
    })).resolves.toEqual({ autocalc, power });

    expect(autocalcLayerMock.compute).toHaveBeenCalledTimes(1);
    expect(powerLayerMock.compute).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 2, memorySets: 2 });
  });

  it('recomputes only the changed power node when previousPower and origin are supplied', async () => {
    const baseAutocalc = successfulResult('hash-autocalc-base', {
      smelt1: { machines: 1, scale: 1, inputs: [], outputs: [] },
      smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
    });
    const editedAutocalc = autocalcWithTouched(
      successfulResult('hash-autocalc-edited', {
        smelt1: { machines: 2, scale: 1, inputs: [], outputs: [] },
        smelt2: { machines: 1, scale: 1, inputs: [], outputs: [] },
      }),
      ['smelt1'],
    );

    const autocalcLayerMock = {
      id: 'autocalc',
      inputHash: vi.fn()
        .mockReturnValueOnce(baseAutocalc.meta.inputHash)
        .mockReturnValueOnce(editedAutocalc.meta.inputHash),
      compute: vi.fn()
        .mockReturnValueOnce(baseAutocalc)
        .mockReturnValueOnce(editedAutocalc),
    };

    const cache = createLayerCache({ persistentBackend: null });
    const productionGraph = powerGraph();
    const engineGameData = powerGameData();

    const base = await runPipeline(productionGraph, {
      upTo: 'power',
      engineGameData,
      cache,
      autocalcLayer: autocalcLayerMock,
    });

    expect(base.autocalc.ok).toBe(true);
    expect(base.power?.ok).toBe(true);
    expect(base.power?.data?.nodes.smelt1.drawMw).toBeCloseTo(4, 5);

    const edited = await runPipeline(productionGraph, {
      upTo: 'power',
      engineGameData,
      cache,
      autocalcLayer: autocalcLayerMock,
      previous: baseAutocalc.data!,
      previousPower: base.power?.data!,
      origin: { type: 'recipe-node', nodeId: 'smelt1' },
      recalculationMode: 'progressive',
    });

    expect(edited.autocalc.ok).toBe(true);
    expect(edited.power?.ok).toBe(true);
    expect(edited.power?.data?.nodes.smelt2).toBe(base.power?.data?.nodes.smelt2);
    expect(edited.power?.data?.nodes.smelt1.drawMw).toBeCloseTo(8, 5);
    expect(edited.power?.meta.touchedNodeIds).toEqual(['smelt1']);
  });

  it('does not run or cache the power layer when autocalc fails', async () => {
    const failedResult: LayerResult<AutocalcResult> = {
      ok: false,
      data: null,
      diagnostics: [{
        layerId: 'autocalc',
        severity: 'error',
        code: 'boom',
        scope: {},
        message: 'Nope.',
      }],
      meta: {
        layerId: 'autocalc',
        inputHash: 'hash-failed',
        computedAt: 1,
        durationMs: 2,
      },
    };
    const power = powerResult('hash-power');
    const autocalcLayerMock = testLayer(failedResult);
    const powerLayerMock = testPowerLayer(power);
    const cache = createLayerCache({ persistentBackend: null });

    await expect(runPipeline(graph(), {
      upTo: 'power',
      engineGameData: gameData(),
      cache,
      autocalcLayer: autocalcLayerMock,
      powerLayer: powerLayerMock,
    })).resolves.toEqual({ autocalc: failedResult });

    expect(powerLayerMock.compute).not.toHaveBeenCalled();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, memorySets: 0 });
  });
});
