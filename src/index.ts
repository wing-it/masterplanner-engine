export type {
  AutocalcInput,
  AutocalcResult,
  ChangeOrigin,
  RateRollup,
} from './types/autocalc';
export type { PowerInput, PowerNodeResult, PowerResult } from './types/power';
export type {
  EngineBuildingPowerProfile,
  EngineBuildingPowerRole,
  EngineGameData,
  EngineItemRate,
  EngineRecipeDefinition,
} from './types/game-data';
export type {
  EngineBuildingRow,
  EngineGameDataSnapshot,
  EngineRecipeProducerRow,
  EngineRecipeRow,
} from './types/engine-rows';
export {
  buildEngineBuildingPowerProfile,
  buildEngineBuildingPowerProfiles,
  buildEngineGameData,
  buildEngineRecipes,
  isGeneratorRecipeByBuilding,
} from './game-data/adapter';
export type {
  Layer,
  LayerDiagnostic,
  LayerResult,
  LayerResultMeta,
} from './types/layer';
export {
  itemRateSchema,
  migrateProductionGraph,
  productionEdgeSchema,
  productionGraphSchema,
  productionGraphSchemaV1,
  productionNodeSchema,
  validateProductionGraph,
} from './types/production-graph';
export type {
  ItemId,
  ItemRate,
  MigrateProductionGraphResult,
  NodeId,
  ProductionEdge,
  ProductionGraph,
  ProductionGraphValidationCode,
  ProductionGraphValidationDiagnostic,
  ProductionGraphValidationResult,
  ProductionNode,
} from './types/production-graph';
export { normalizeGraph } from './graph/normalize';
export type { NormalizedGraph } from './graph/normalize';
export {
  findRecipe,
  isByproduct,
  itemsMatch,
  machinesForInput,
  machinesForOutput,
  ratePerMachine,
  ratesForMachines,
  resolveSomersloopMultiplier,
} from './graph/recipe-math';
export type { RateMultipliers } from './graph/recipe-math';
export { calculateRequiredPlan } from './autocalc/demand';
export type {
  DemandDiagnostic,
  DemandOptions,
  DemandResult,
  RequiredPlan,
  RequiredPlanNode,
} from './autocalc/demand';
export { calculateConstraints } from './autocalc/constraints';
export type {
  ConstraintOptions,
  ConstraintPlan,
  ConstraintPlanNode,
  ConstraintResult,
} from './autocalc/constraints';
export { calculateActualPlan, toItemRates } from './autocalc/actual';
export type {
  ActualOptions,
  ActualPlan,
  ActualPlanNode,
  ActualResult,
} from './autocalc/actual';
export {
  allocateActualFlows,
  computeBranchPull,
  deriveRoutingCoverage,
  findTerminalSinkIds,
  forkBranchesLeadToDifferentSinks,
} from './autocalc/allocation';
export type {
  AllocationOptions,
  AllocationResult,
  EdgeAllocation,
} from './autocalc/allocation';
export { solveProductionGraph } from './autocalc/solve';
export type { SolveResult } from './autocalc/solve';
export { autocalcLayer } from './autocalc/autocalc-layer';
export { debugLog } from './autocalc/debug-logger';
export {
  calculateClockFactor,
  calculatePowerShardUsage,
  consumerDrawMw,
  generatorGenMw,
  normalizeSomersloopCount,
} from './power/power-math';
export {
  DEFAULT_MAX_CLOCK_PERCENT,
  DEFAULT_POWER_EXPONENT,
  DEFAULT_POWER_SHARD_SLOTS,
} from './power/power-constants';
export { computePower } from './power/solve-power';
export { powerLayer } from './power/power-layer';
export { runPipeline, stubAutocalcLayer } from './pipeline/run-pipeline';
export { ENGINE_CACHE_VERSION } from './pipeline/engine-cache-version';
export type {
  PipelineResult,
  RecalculationMode,
  RunPipelineOptions,
} from './pipeline/run-pipeline';
export { stableValueHash } from './pipeline/hash';
export {
  createLayerCache,
  createMemoryOnlyLayerCache,
  createMemoryPersistentLayerCacheBackend,
  DEFAULT_PERSISTENCE_THRESHOLD_BYTES,
} from './pipeline/layer-cache';
export type {
  LayerCache,
  LayerCacheOptions,
  LayerCacheStats,
  LayerCachePersistentBackend,
} from './pipeline/layer-cache';
export { setDebugLogLevels } from './autocalc/debug-logger';

