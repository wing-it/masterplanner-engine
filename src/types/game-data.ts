export interface EngineItemRef {
  id: string;
  name?: string;
}

export interface EngineBuildingRef {
  id: string;
  name?: string;
}

export interface EngineItemRate {
  itemId: string | null;
  amount: number;
}

export interface EngineRecipeDefinition {
  id: string;
  name: string;
  slug?: string;
  durationSeconds: number;
  isAlternate?: boolean;
  product: EngineItemRef | null;
  inputs: EngineItemRate[];
  outputs: EngineItemRate[];
  machine: EngineBuildingRef | null;
}

export type EngineBuildingPowerRole = 'consumer' | 'generator' | 'variable-consumer' | 'power-augmenter';

export interface EngineBuildingPowerProfile {
  buildingId: string;
  role: EngineBuildingPowerRole;
  basePowerMw?: number;
  baseGeneratedMw?: number;
  powerExponent: number;
  generatorScalesLinearly: boolean;
  powerShardSlots: number;
  maxClockPercent: number;
  supportsSomersloop: boolean;
  somersloopSlots: number;
}

export interface EngineGameData {
  recipes: EngineRecipeDefinition[];
  generatorRecipes?: EngineRecipeDefinition[];
  buildingPowerById: ReadonlyMap<string, EngineBuildingPowerProfile>;
}
