export interface EngineBuildingRow {
  id: string;
  class_name: string;
  native_class: string;
  name: string;
  building_kind: string;
  power_consumption_mw: number | string | null;
  power_consumption_exponent: number | string | null;
  raw_data: Record<string, unknown>;
}

export interface EngineRecipeRow {
  id: string;
  class_name: string;
  name: string;
  duration_seconds: number | string;
  is_alternate: boolean;
  raw_data: Record<string, unknown>;
}

export interface EngineRecipeProducerRow {
  recipe_id: string;
  building_id: string;
  building_class_name: string;
}

export interface EngineGameDataSnapshot {
  buildings: EngineBuildingRow[];
  recipes: EngineRecipeRow[];
  recipeProducers: EngineRecipeProducerRow[];
}
