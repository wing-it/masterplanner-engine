import { describe, expect, it } from 'vitest';
import type { EngineBuildingRow, EngineRecipeProducerRow, EngineRecipeRow } from '../types/engine-rows';
import {
  buildEngineBuildingPowerProfile,
  buildEngineBuildingPowerProfiles,
  buildEngineGameData,
  buildEngineRecipes,
  isGeneratorRecipeByBuilding,
} from './adapter';

const DEFAULT_POWER_EXPONENT = 1.321928;
const DEFAULT_MAX_CLOCK_PERCENT = 250;
const DEFAULT_POWER_SHARD_SLOTS = 3;

function building(opts: {
  id: string;
  name: string;
  class_name: string;
  native_class?: string;
  building_kind?: string;
  power_consumption_mw?: number | string | null;
  power_consumption_exponent?: number | string | null;
  raw_data?: Record<string, unknown>;
}): EngineBuildingRow {
  return {
    id: opts.id,
    class_name: opts.class_name,
    native_class: opts.native_class ?? '',
    name: opts.name,
    building_kind: opts.building_kind ?? 'manufacturer',
    power_consumption_mw: opts.power_consumption_mw ?? null,
    power_consumption_exponent: opts.power_consumption_exponent ?? null,
    raw_data: opts.raw_data ?? {},
  };
}

describe('buildEngineBuildingPowerProfile', () => {
  it('smelter: consumer role, basePowerMw matches, default powerExponent', () => {
    const smelter = building({
      id: 'Desc_Smelter_C',
      name: 'Smelter',
      class_name: 'Build_Smelter_C',
      native_class: 'FGBuildableSMelder',
      building_kind: 'manufacturer',
      power_consumption_mw: 4,
      power_consumption_exponent: null,
      raw_data: {},
    });

    const profile = buildEngineBuildingPowerProfile(smelter);

    expect(profile.role).toBe('consumer');
    expect(profile.basePowerMw).toBe(4);
    expect(profile.baseGeneratedMw).toBeUndefined();
    expect(profile.powerExponent).toBeCloseTo(DEFAULT_POWER_EXPONENT, 4);
    expect(profile.generatorScalesLinearly).toBe(false);
    expect(profile.maxClockPercent).toBe(DEFAULT_MAX_CLOCK_PERCENT);
    expect(profile.powerShardSlots).toBe(DEFAULT_POWER_SHARD_SLOTS);
    expect(profile.supportsSomersloop).toBe(false);
    expect(profile.somersloopSlots).toBe(0);
  });

  it('smelter with explicit powerExponent uses that value', () => {
    const smelter = building({
      id: 'Desc_Smelter_C',
      name: 'Smelter',
      class_name: 'Build_Smelter_C',
      native_class: 'FGBuildableSMelder',
      building_kind: 'manufacturer',
      power_consumption_mw: 4,
      power_consumption_exponent: 1.5,
      raw_data: {},
    });

    const profile = buildEngineBuildingPowerProfile(smelter);
    expect(profile.powerExponent).toBe(1.5);
  });

  it('coal generator: generator role, baseGeneratedMw populated', () => {
    const coalGen = building({
      id: 'Desc_GeneratorCoal_C',
      name: 'Coal Generator',
      class_name: 'Build_GeneratorCoal_C',
      native_class: 'FGBuildableCoalGenerator',
      building_kind: 'generator',
      power_consumption_mw: null,
      power_consumption_exponent: null,
      raw_data: {
        mPowerProduction: 75,
        mDynamicProductionCapacity: 150,
        mDefaultProductionCapacity: 75,
      },
    });

    const profile = buildEngineBuildingPowerProfile(coalGen);

    expect(profile.role).toBe('generator');
    expect(profile.baseGeneratedMw).toBe(75);
    expect(profile.basePowerMw).toBeUndefined();
    expect(profile.generatorScalesLinearly).toBe(true);
    expect(profile.powerExponent).toBeCloseTo(DEFAULT_POWER_EXPONENT, 4);
  });

  it('coal generator falls back to power_consumption_mw when mPowerProduction absent', () => {
    const coalGen = building({
      id: 'Desc_GeneratorCoal_C',
      name: 'Coal Generator',
      class_name: 'Build_GeneratorCoal_C',
      native_class: 'FGBuildableCoalGenerator',
      building_kind: 'generator',
      power_consumption_mw: 60,
      power_consumption_exponent: null,
      raw_data: {},
    });

    const profile = buildEngineBuildingPowerProfile(coalGen);
    expect(profile.baseGeneratedMw).toBe(60);
  });

  it('power-augmenter: detected by class_name containing poweraugmenter', () => {
    const augmenter = building({
      id: 'Desc_PowerAugmenter_C',
      name: 'Power Augmenter',
      class_name: 'Build_PowerAugmenter_C',
      native_class: 'FGBuildablePowerAugmenter',
      building_kind: 'manufacturer',
      power_consumption_mw: null,
      power_consumption_exponent: null,
      raw_data: { mPowerProduction: 100 },
    });

    const profile = buildEngineBuildingPowerProfile(augmenter);
    expect(profile.role).toBe('power-augmenter');
    expect(profile.basePowerMw).toBeUndefined();
  });

  it('alien power augmenter: detected by name', () => {
    const alien = building({
      id: 'Desc_AlienPowerAugmenter_C',
      name: 'Alien Power Augmenter',
      class_name: 'Build_AlienPowerAugmenter_C',
      native_class: 'FGBuildable',
      building_kind: 'manufacturer',
      power_consumption_mw: null,
      power_consumption_exponent: null,
      raw_data: { mPowerProduction: 200 },
    });

    const profile = buildEngineBuildingPowerProfile(alien);
    expect(profile.role).toBe('power-augmenter');
  });

  it('variable-consumer: detected by native_class containing manufacturervariablepower', () => {
    const variable = building({
      id: 'Desc_ManufacturerVariablePower_C',
      name: 'Manufacturer Variable Power',
      class_name: 'Build_ManufacturerVariablePower_C',
      native_class: 'FGBuildableManufacturerVariablePower',
      building_kind: 'manufacturer',
      power_consumption_mw: 50,
      power_consumption_exponent: null,
      raw_data: {},
    });

    const profile = buildEngineBuildingPowerProfile(variable);
    expect(profile.role).toBe('variable-consumer');
  });

  it('supportsSomersloop: true when mProductionShardSlotSize > 0', () => {
    const miner = building({
      id: 'Desc_MinerMk1_C',
      name: 'Miner Mk.1',
      class_name: 'Build_MinerMk1_C',
      native_class: 'FGBuildableMiner',
      building_kind: 'manufacturer',
      power_consumption_mw: 30,
      power_consumption_exponent: null,
      raw_data: { mProductionShardSlotSize: 3 },
    });

    const profile = buildEngineBuildingPowerProfile(miner);
    expect(profile.supportsSomersloop).toBe(true);
    expect(profile.somersloopSlots).toBe(3);
  });

  it('supportsSomersloop: true when mCanChangeProductionBoost is true', () => {
    const ref = building({
      id: 'Desc_Refinery_C',
      name: 'Refinery',
      class_name: 'Build_Refinery_C',
      native_class: 'FGBuildableRefinery',
      building_kind: 'manufacturer',
      power_consumption_mw: 30,
      power_consumption_exponent: null,
      raw_data: { mCanChangeProductionBoost: true },
    });

    const profile = buildEngineBuildingPowerProfile(ref);
    expect(profile.supportsSomersloop).toBe(true);
    expect(profile.somersloopSlots).toBe(0);
  });

  it('powerShardSlots defaults to 3 when mPotentialShardSlots absent', () => {
    const smelter = building({
      id: 'Desc_Smelter_C',
      name: 'Smelter',
      class_name: 'Build_Smelter_C',
      native_class: 'FGBuildableSMelder',
      building_kind: 'manufacturer',
      power_consumption_mw: 4,
      power_consumption_exponent: null,
      raw_data: {},
    });

    const profile = buildEngineBuildingPowerProfile(smelter);
    expect(profile.powerShardSlots).toBe(3);
  });

  it('powerShardSlots read from mPotentialShardSlots when present', () => {
    const miner = building({
      id: 'Desc_MinerMk1_C',
      name: 'Miner Mk.1',
      class_name: 'Build_MinerMk1_C',
      native_class: 'FGBuildableMiner',
      building_kind: 'manufacturer',
      power_consumption_mw: 30,
      power_consumption_exponent: null,
      raw_data: { mProductionShardSlotSize: 4, mPotentialShardSlots: 5 },
    });

    const profile = buildEngineBuildingPowerProfile(miner);
    expect(profile.powerShardSlots).toBe(5);
  });
});

describe('buildEngineBuildingPowerProfiles', () => {
  it('builds a map keyed by building id', () => {
    const smelter = building({
      id: 'Desc_Smelter_C',
      name: 'Smelter',
      class_name: 'Build_Smelter_C',
      native_class: 'FGBuildableSMelder',
      building_kind: 'manufacturer',
      power_consumption_mw: 4,
      raw_data: {},
    });

    const coalGen = building({
      id: 'Desc_GeneratorCoal_C',
      name: 'Coal Generator',
      class_name: 'Build_GeneratorCoal_C',
      native_class: 'FGBuildableCoalGenerator',
      building_kind: 'generator',
      power_consumption_mw: null,
      raw_data: { mPowerProduction: 75 },
    });

    const profiles = buildEngineBuildingPowerProfiles([smelter, coalGen]);

    expect(profiles.size).toBe(2);
    expect(profiles.get('Desc_Smelter_C')?.role).toBe('consumer');
    expect(profiles.get('Desc_GeneratorCoal_C')?.role).toBe('generator');
  });
});

describe('isGeneratorRecipeByBuilding', () => {
  const coalGenBuilding = building({
    id: 'Desc_GeneratorCoal_C',
    name: 'Coal Generator',
    class_name: 'Build_GeneratorCoal_C',
    native_class: 'FGBuildableCoalGenerator',
    building_kind: 'generator',
    power_consumption_mw: null,
    raw_data: { mPowerProduction: 75 },
  });

  const smelterBuilding = building({
    id: 'Desc_Smelter_C',
    name: 'Smelter',
    class_name: 'Build_Smelter_C',
    native_class: 'FGBuildableSMelder',
    building_kind: 'manufacturer',
    power_consumption_mw: 4,
    raw_data: {},
  });

  const producerCoal: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_GeneratorCoal_C',
    building_id: 'Desc_GeneratorCoal_C',
    building_class_name: 'Build_GeneratorCoal_C',
  };

  const producerIronIngot: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_IronIngot_C',
    building_id: 'Desc_Smelter_C',
    building_class_name: 'Build_Smelter_C',
  };

  const buildingPowerById = buildEngineBuildingPowerProfiles([coalGenBuilding, smelterBuilding]);

  it('returns true for recipe whose machine building has generator role', () => {
    expect(
      isGeneratorRecipeByBuilding('Recipe_GeneratorCoal_C', [producerCoal], buildingPowerById)
    ).toBe(true);
  });

  it('returns false for recipe whose machine building is not a generator', () => {
    expect(
      isGeneratorRecipeByBuilding('Recipe_IronIngot_C', [producerIronIngot], buildingPowerById)
    ).toBe(false);
  });

  it('returns false for recipe with no producers', () => {
    expect(
      isGeneratorRecipeByBuilding('Recipe_Unknown_C', [], buildingPowerById)
    ).toBe(false);
  });

  it('returns false for recipe whose building not in buildingPowerById', () => {
    const unknownProducer: EngineRecipeProducerRow = {
      recipe_id: 'Recipe_UnknownBuilding_C',
      building_id: 'Desc_UnknownBuilding_C',
      building_class_name: 'Build_UnknownBuilding_C',
    };
    expect(
      isGeneratorRecipeByBuilding('Recipe_UnknownBuilding_C', [unknownProducer], buildingPowerById)
    ).toBe(false);
  });
});

describe('buildEngineRecipes', () => {
  const coalGenBuilding = building({
    id: 'Desc_GeneratorCoal_C',
    name: 'Coal Generator',
    class_name: 'Build_GeneratorCoal_C',
    native_class: 'FGBuildableCoalGenerator',
    building_kind: 'generator',
    power_consumption_mw: null,
    raw_data: { mPowerProduction: 75 },
  });

  const smelterBuilding = building({
    id: 'Desc_Smelter_C',
    name: 'Smelter',
    class_name: 'Build_Smelter_C',
    native_class: 'FGBuildableSMelder',
    building_kind: 'manufacturer',
    power_consumption_mw: 4,
    raw_data: {},
  });

  const coalRecipe: EngineRecipeRow = {
    id: 'Recipe_GeneratorCoal_C',
    class_name: 'GeneratorRecipe_Coal_C',
    name: 'Coal',
    duration_seconds: 4,
    is_alternate: false,
    raw_data: {},
  };

  const ironRecipe: EngineRecipeRow = {
    id: 'Recipe_IronIngot_C',
    class_name: 'Recipe_IronIngot_C',
    name: 'Iron Ingot',
    duration_seconds: 2,
    is_alternate: false,
    raw_data: {},
  };

  const producerCoal: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_GeneratorCoal_C',
    building_id: 'Desc_GeneratorCoal_C',
    building_class_name: 'Build_GeneratorCoal_C',
  };

  const producerIron: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_IronIngot_C',
    building_id: 'Desc_Smelter_C',
    building_class_name: 'Build_Smelter_C',
  };

  const buildingPowerById = buildEngineBuildingPowerProfiles([coalGenBuilding, smelterBuilding]);
  const recipes = buildEngineRecipes([coalRecipe, ironRecipe], [producerCoal, producerIron], buildingPowerById);

  it('returns a recipe definition for each input recipe', () => {
    expect(recipes.length).toBe(2);
  });

  it('sets machine reference from primary building', () => {
    const coalRecipeDef = recipes.find((r) => r.id === 'Recipe_GeneratorCoal_C');
    expect(coalRecipeDef?.machine?.id).toBe('Desc_GeneratorCoal_C');

    const ironRecipeDef = recipes.find((r) => r.id === 'Recipe_IronIngot_C');
    expect(ironRecipeDef?.machine?.id).toBe('Desc_Smelter_C');
  });
});

describe('buildEngineGameData', () => {
  const coalGenBuilding = building({
    id: 'Desc_GeneratorCoal_C',
    name: 'Coal Generator',
    class_name: 'Build_GeneratorCoal_C',
    native_class: 'FGBuildableCoalGenerator',
    building_kind: 'generator',
    power_consumption_mw: null,
    raw_data: { mPowerProduction: 75 },
  });

  const smelterBuilding = building({
    id: 'Desc_Smelter_C',
    name: 'Smelter',
    class_name: 'Build_Smelter_C',
    native_class: 'FGBuildableSMelder',
    building_kind: 'manufacturer',
    power_consumption_mw: 4,
    raw_data: {},
  });

  const coalRecipe: EngineRecipeRow = {
    id: 'Recipe_GeneratorCoal_C',
    class_name: 'GeneratorRecipe_Coal_C',
    name: 'Coal',
    duration_seconds: 4,
    is_alternate: false,
    raw_data: {},
  };

  const ironRecipe: EngineRecipeRow = {
    id: 'Recipe_IronIngot_C',
    class_name: 'Recipe_IronIngot_C',
    name: 'Iron Ingot',
    duration_seconds: 2,
    is_alternate: false,
    raw_data: {},
  };

  const producerCoal: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_GeneratorCoal_C',
    building_id: 'Desc_GeneratorCoal_C',
    building_class_name: 'Build_GeneratorCoal_C',
  };

  const producerIron: EngineRecipeProducerRow = {
    recipe_id: 'Recipe_IronIngot_C',
    building_id: 'Desc_Smelter_C',
    building_class_name: 'Build_Smelter_C',
  };

  it('populates buildingPowerById from buildings', () => {
    const gameData = buildEngineGameData({
      buildings: [coalGenBuilding, smelterBuilding],
      recipes: [coalRecipe, ironRecipe],
      recipeProducers: [producerCoal, producerIron],
    });

    expect(gameData.buildingPowerById.size).toBe(2);
    expect(gameData.buildingPowerById.get('Desc_Smelter_C')?.role).toBe('consumer');
    expect(gameData.buildingPowerById.get('Desc_GeneratorCoal_C')?.role).toBe('generator');
  });

  it('populates recipes with all recipes', () => {
    const gameData = buildEngineGameData({
      buildings: [coalGenBuilding, smelterBuilding],
      recipes: [coalRecipe, ironRecipe],
      recipeProducers: [producerCoal, producerIron],
    });

    expect(gameData.recipes.length).toBe(2);
  });

  it('populates generatorRecipes filtered by building role', () => {
    const gameData = buildEngineGameData({
      buildings: [coalGenBuilding, smelterBuilding],
      recipes: [coalRecipe, ironRecipe],
      recipeProducers: [producerCoal, producerIron],
    });

    expect(gameData.generatorRecipes?.length).toBe(1);
    const firstGenerator = gameData.generatorRecipes?.[0];
    expect(firstGenerator?.id).toBe('Recipe_GeneratorCoal_C');
  });

  it('generatorRecipes is empty when no generator buildings exist', () => {
    const gameData = buildEngineGameData({
      buildings: [smelterBuilding],
      recipes: [ironRecipe],
      recipeProducers: [producerIron],
    });

    expect(gameData.generatorRecipes?.length).toBe(0);
  });

  it('returns correct basePowerMw and baseGeneratedMw for consumers and generators', () => {
    const gameData = buildEngineGameData({
      buildings: [coalGenBuilding, smelterBuilding],
      recipes: [coalRecipe, ironRecipe],
      recipeProducers: [producerCoal, producerIron],
    });

    const smelterProfile = gameData.buildingPowerById.get('Desc_Smelter_C');
    expect(smelterProfile?.basePowerMw).toBe(4);
    expect(smelterProfile?.baseGeneratedMw).toBeUndefined();

    const coalGenProfile = gameData.buildingPowerById.get('Desc_GeneratorCoal_C');
    expect(coalGenProfile?.baseGeneratedMw).toBe(75);
    expect(coalGenProfile?.basePowerMw).toBeUndefined();
  });
});
