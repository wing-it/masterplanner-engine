import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ItemId, ItemRate } from '../types/production-graph';

function normalizeItemId(itemId: string | null | undefined): string | null {
  return itemId ? itemId.split(':').pop() ?? itemId : null;
}

export function itemsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeItemId(left);
  const b = normalizeItemId(right);
  return Boolean(a && b && a === b);
}

/**
 * Whether `itemId` is a byproduct of `recipe` rather than its primary
 * product. A recipe with no declared `product` (e.g. a multi-output
 * refinery recipe with no marked primary, or a generator recipe) is
 * treated as having no byproducts at all — every output is primary and
 * eligible to drive machine sizing (see the multi-output max-rule in
 * demand.ts). Keep this as the single engine definition of byproduct status.
 */
export function isByproduct(recipe: EngineRecipeDefinition, itemId: ItemId): boolean {
  if (!recipe.product) return false;
  return !itemsMatch(recipe.product.id, itemId);
}

function cyclesPerMin(recipe: EngineRecipeDefinition): number {
  return recipe.durationSeconds > 0 ? 60 / recipe.durationSeconds : 0;
}

/** Per-machine rate at 100% clock, no somersloop/purity multipliers. */
export function ratePerMachine(recipe: EngineRecipeDefinition, itemId: ItemId, isOutput: boolean): number {
  const list = isOutput ? recipe.outputs : recipe.inputs;
  const match = list.find((row) => itemsMatch(row.itemId, itemId));
  if (!match) return 0;
  return match.amount * cyclesPerMin(recipe);
}

export interface RateMultipliers {
  clockPercent?: number; // default 100
  somersloopMultiplier?: number; // default 1; outputs only
}

function overclock(opts?: RateMultipliers): number {
  return (opts?.clockPercent ?? 100) / 100;
}

export function machinesForOutput(
  recipe: EngineRecipeDefinition,
  itemId: ItemId,
  requiredRatePerMin: number,
  opts?: RateMultipliers
): number {
  const rate = ratePerMachine(recipe, itemId, true) * overclock(opts) * (opts?.somersloopMultiplier ?? 1);
  if (rate <= 0) return 0;
  return requiredRatePerMin / rate;
}

export function machinesForInput(
  recipe: EngineRecipeDefinition,
  itemId: ItemId,
  requiredRatePerMin: number,
  opts?: RateMultipliers
): number {
  const rate = ratePerMachine(recipe, itemId, false) * overclock(opts);
  if (rate <= 0) return 0;
  return requiredRatePerMin / rate;
}

export function ratesForMachines(
  recipe: EngineRecipeDefinition,
  machines: number,
  opts?: RateMultipliers
): { inputs: ItemRate[]; outputs: ItemRate[] } {
  const oc = overclock(opts);
  const sl = opts?.somersloopMultiplier ?? 1;

  const inputs: ItemRate[] = recipe.inputs
    .filter((input): input is typeof input & { itemId: string } => Boolean(input.itemId))
    .map((input) => ({
      itemId: input.itemId,
      ratePerMin: ratePerMachine(recipe, input.itemId, false) * oc * machines,
    }));

  const outputs: ItemRate[] = recipe.outputs
    .filter((output): output is typeof output & { itemId: string } => Boolean(output.itemId))
    .map((output) => ({
      itemId: output.itemId,
      ratePerMin: ratePerMachine(recipe, output.itemId, true) * oc * sl * machines,
    }));

  return { inputs, outputs };
}

/**
 * Somersloop output multiplier (1 + installed/slots), resolved from the
 * recipe's building power profile. Returns 1 (no boost) if the building
 * doesn't support somersloops or none are installed.
 */
export function resolveSomersloopMultiplier(
  recipe: EngineRecipeDefinition,
  somersloopsInstalled: number | undefined,
  gameData: EngineGameData
): number {
  if (!somersloopsInstalled) return 1;
  const buildingId = recipe.machine?.id;
  const profile = buildingId ? gameData.buildingPowerById.get(buildingId) : undefined;
  if (!profile?.supportsSomersloop || profile.somersloopSlots <= 0) return 1;
  return 1 + somersloopsInstalled / profile.somersloopSlots;
}

export function findRecipe(recipeId: string, gameData: EngineGameData): EngineRecipeDefinition | undefined {
  return (
    gameData.recipes.find((recipe) => recipe.id === recipeId) ??
    gameData.generatorRecipes?.find((recipe) => recipe.id === recipeId)
  );
}
