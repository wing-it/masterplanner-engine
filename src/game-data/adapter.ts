import type {
  EngineBuildingPowerProfile,
  EngineGameData,
  EngineItemRate,
  EngineRecipeDefinition,
} from '../types/game-data';
import type {
  EngineBuildingRow,
  EngineGameDataSnapshot,
  EngineRecipeProducerRow,
  EngineRecipeRow,
} from '../types/engine-rows';
import {
  DEFAULT_MAX_CLOCK_PERCENT,
  DEFAULT_POWER_EXPONENT,
  DEFAULT_POWER_SHARD_SLOTS,
} from '../power/power-constants';

function toNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readRawNumber(rawData: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(rawData[key] as number | string | null | undefined);
    if (value !== undefined && value > 0) {
      return value;
    }
  }
  return undefined;
}

function readRawBoolean(rawData: Record<string, unknown>, key: string): boolean {
  const value = rawData[key];
  return value === true || value === 'True';
}

export function buildEngineBuildingPowerProfile(building: EngineBuildingRow): EngineBuildingPowerProfile {
  const rawData = building.raw_data ?? {};
  const className = building.class_name.toLowerCase();
  const nativeClass = building.native_class.toLowerCase();
  const name = building.name.toLowerCase();

  let role: EngineBuildingPowerProfile['role'] = 'consumer';
  if (
    className.includes('poweraugmenter') ||
    className.includes('alienpower') ||
    name.includes('alien power augmenter')
  ) {
    role = 'power-augmenter';
  } else if (building.building_kind === 'generator') {
    role = 'generator';
  } else if (nativeClass.includes('manufacturervariablepower')) {
    role = 'variable-consumer';
  }

  const somersloopSlots = (() => {
    const slotSize = toNumber(rawData.mProductionShardSlotSize as number | string | null | undefined);
    return slotSize !== undefined && slotSize > 0 ? slotSize : 0;
  })();

  const supportsSomersloop = somersloopSlots > 0 || readRawBoolean(rawData, 'mCanChangeProductionBoost');

  const baseGeneratedMw = (() => {
    const fromRaw = readRawNumber(rawData, ['mPowerProduction', 'mDynamicProductionCapacity', 'mDefaultProductionCapacity']);
    if (fromRaw !== undefined) {
      return fromRaw;
    }
    const consumption = toNumber(building.power_consumption_mw);
    if (building.building_kind === 'generator' && consumption !== undefined && consumption > 0) {
      return consumption;
    }
    return undefined;
  })();

  const basePowerMw = (() => {
    if (role === 'generator' || role === 'power-augmenter') {
      return undefined;
    }
    const consumption = toNumber(building.power_consumption_mw);
    return consumption !== undefined && consumption > 0 ? consumption : undefined;
  })();

  const powerExponent = toNumber(building.power_consumption_exponent) ?? DEFAULT_POWER_EXPONENT;

  const powerShardSlots = (() => {
    const shardSlots = toNumber(rawData.mPotentialShardSlots as number | string | null | undefined);
    return shardSlots !== undefined && shardSlots > 0 ? shardSlots : DEFAULT_POWER_SHARD_SLOTS;
  })();

  return {
    buildingId: building.id,
    role,
    basePowerMw,
    baseGeneratedMw,
    powerExponent,
    generatorScalesLinearly: role === 'generator',
    powerShardSlots,
    maxClockPercent: DEFAULT_MAX_CLOCK_PERCENT,
    supportsSomersloop,
    somersloopSlots,
  };
}

export function buildEngineBuildingPowerProfiles(
  buildings: EngineBuildingRow[]
): ReadonlyMap<string, EngineBuildingPowerProfile> {
  const profiles = new Map<string, EngineBuildingPowerProfile>();
  for (const building of buildings) {
    profiles.set(building.id, buildEngineBuildingPowerProfile(building));
  }
  return profiles;
}

function findPrimaryBuildingId(
  recipeId: string,
  recipeProducers: EngineRecipeProducerRow[]
): string | null {
  const producers = recipeProducers.filter((p) => p.recipe_id === recipeId);
  if (producers.length === 0) return null;
  const sorted = producers.sort((a, b) => {
    const aOrder = a.building_class_name.length;
    const bOrder = b.building_class_name.length;
    return aOrder - bOrder;
  });
  return sorted[0]?.building_id ?? null;
}

export function isGeneratorRecipeByBuilding(
  recipeId: string,
  recipeProducers: EngineRecipeProducerRow[],
  buildingPowerById: ReadonlyMap<string, EngineBuildingPowerProfile>
): boolean {
  const buildingId = findPrimaryBuildingId(recipeId, recipeProducers);
  if (!buildingId) return false;
  const profile = buildingPowerById.get(buildingId);
  return profile?.role === 'generator';
}

export function buildEngineRecipes(
  recipes: EngineRecipeRow[],
  recipeProducers: EngineRecipeProducerRow[],
  buildingPowerById: ReadonlyMap<string, EngineBuildingPowerProfile>
): EngineRecipeDefinition[] {
  const result: EngineRecipeDefinition[] = [];

  for (const recipe of recipes) {
    const machineBuildingId = findPrimaryBuildingId(recipe.id, recipeProducers);
    const machineBuilding = machineBuildingId
      ? buildingPowerById.get(machineBuildingId)
      : undefined;

    result.push({
      id: recipe.id,
      name: recipe.name,
      durationSeconds: toNumber(recipe.duration_seconds) ?? 0,
      isAlternate: recipe.is_alternate,
      product: null,
      inputs: [],
      outputs: [],
      machine: machineBuildingId
        ? { id: machineBuildingId }
        : null,
    });
  }

  return result;
}

export function buildEngineGameData(snapshot: EngineGameDataSnapshot): EngineGameData {
  const buildingPowerById = buildEngineBuildingPowerProfiles(snapshot.buildings);

  const allRecipes = buildEngineRecipes(
    snapshot.recipes,
    snapshot.recipeProducers,
    buildingPowerById
  );

  const generatorRecipes = allRecipes.filter((recipe) =>
    isGeneratorRecipeByBuilding(recipe.id, snapshot.recipeProducers, buildingPowerById)
  );

  return {
    recipes: allRecipes,
    generatorRecipes,
    buildingPowerById,
  };
}
