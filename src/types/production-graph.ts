import { z } from 'zod';

import type { EngineGameData, EngineRecipeDefinition } from './game-data';

export type NodeId = string;
export type ItemId = string;

export const PRODUCTION_GRAPH_SCHEMA_VERSION = 2;

export interface ItemRate {
  itemId: ItemId;
  ratePerMin: number;
}

export type ProductionNode =
  | {
      kind: 'recipe';
      id: NodeId;
      recipeId: string;
      machineCountOverride?: number;
      productionRateOverride?: number;
      inputRateOverride?: ItemRate;
      clockPercent?: number;
      somersloopsInstalled?: number;
      powerTargetMw?: number;
      /**
       * Produce at least as much as upstream supply seeding allows, even when
       * downstream demand is lower. Scale-up only: when nothing upstream can
       * seed supply, the node sizes from demand exactly as without the flag.
       * Explicit machineCountOverride/productionRateOverride take precedence.
       */
      maximizeOutput?: boolean;
      /**
       * Overproduce using only LEFTOVER input supply: at contested forks this
       * node's chain receives supply after fixed demand and after maximize
       * chains, so enabling it never increases source draw or shrinks any
       * other node's plan. Extra output is routed via `routing.overflow`
       * edges (typically into a passive depot sink). Scale-up only; explicit
       * overrides take precedence, and `maximizeOutput` wins if both are set.
       */
      overproduceFromSurplus?: boolean;
    }
    | {
      kind: 'source';
      id: NodeId;
      itemId: ItemId;
      sourceType: 'resource-claim' | 'water' | 'manual-input';
      maxRatePerMin: number;
      machineCountOverride?: number;
      perExtractorRatePerMin?: number;
      /**
       * Elastic/demand-sized source: never constrains or drives production,
       * always fully supplied, machine count back-computed from demand (e.g. a
       * user-placed water pump with no fixed pump count). Purely descriptive —
       * no solver algorithm keys off this flag; it lets display layers tell a
       * real unbounded source apart from the implicit `manual-input`
       * free-import placeholder, both of which share the sentinel rate.
       */
      unbounded?: boolean;
    }
  | {
      kind: 'sink';
      id: NodeId;
      itemId: ItemId;
      demandPerMin?: number;
      /**
       * When true, the sink's demand is derived at solve time: the producer is
       * rounded up to the next whole machine and the fractional remainder is
       * diverted here. Any authored demandPerMin is ignored until resolved.
       */
      roundUp?: boolean;
    }
  | {
      /**
       * Transparent single-item aggregator ("splerger"). Sums all incoming
       * supply of `itemId` into one pool, then splits it across outgoing edges
       * once — so N parallel same-item sources feeding K consumers behave as a
       * single pooled supply, not N independent sources each splitting alone.
       * Carries 0 machines; requiredInputs == requiredOutputs == throughput.
       * The engine is factory-ignorant; the app decides where pools go.
       */
      kind: 'pool';
      id: NodeId;
      itemId: ItemId;
    };

export interface ProductionEdge {
  id: string;
  sourceId: NodeId;
  targetId: NodeId;
  itemId: ItemId;
  routing?: {
    portSide: 'input' | 'output';
    portId: string;
    priority: string[];
    /**
     * Smart-splitter-style overflow: the edge propagates zero demand and is
     * allocated last, receiving only supply left over after every other
     * consumer. Reserved in schema v2; allocation semantics land with the
     * byproduct/overflow solver work.
     */
    overflow?: boolean;
  };
}

export interface ProductionGraph {
  schemaVersion: typeof PRODUCTION_GRAPH_SCHEMA_VERSION;
  nodes: ProductionNode[];
  edges: ProductionEdge[];
}

export type ProductionGraphValidationCode =
  | 'invalid-schema'
  | 'missing-node'
  | 'item-mismatch'
  | 'deprecated-schema';

export interface ProductionGraphValidationDiagnostic {
  severity: 'error' | 'warning';
  code: ProductionGraphValidationCode;
  scope: { nodeId?: string; edgeId?: string };
  message: string;
}

export interface ProductionGraphValidationResult {
  ok: boolean;
  graph: ProductionGraph | null;
  errors: ProductionGraphValidationDiagnostic[];
  warnings: ProductionGraphValidationDiagnostic[];
}

const finiteNumberSchema = z.number().finite();

export const itemRateSchema = z.object({
  itemId: z.string().min(1),
  ratePerMin: finiteNumberSchema,
});

export const productionNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recipe'),
    id: z.string().min(1),
    recipeId: z.string().min(1),
    machineCountOverride: finiteNumberSchema.optional(),
    productionRateOverride: finiteNumberSchema.optional(),
    inputRateOverride: itemRateSchema.optional(),
    clockPercent: finiteNumberSchema.optional(),
    somersloopsInstalled: finiteNumberSchema.optional(),
    powerTargetMw: finiteNumberSchema.optional(),
    maximizeOutput: z.boolean().optional(),
    overproduceFromSurplus: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('source'),
    id: z.string().min(1),
    itemId: z.string().min(1),
    sourceType: z.enum(['resource-claim', 'water', 'manual-input']),
    maxRatePerMin: finiteNumberSchema,
    machineCountOverride: finiteNumberSchema.optional(),
    perExtractorRatePerMin: finiteNumberSchema.optional(),
    unbounded: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('sink'),
    id: z.string().min(1),
    itemId: z.string().min(1),
    demandPerMin: finiteNumberSchema.optional(),
    roundUp: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('pool'),
    id: z.string().min(1),
    itemId: z.string().min(1),
  }),
]);

export const productionEdgeSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  itemId: z.string().min(1),
  routing: z
    .object({
      portSide: z.enum(['input', 'output']),
      portId: z.string().min(1),
      priority: z.array(z.string().min(1)),
      overflow: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Frozen schema v1: carried a `grouping` array assigning nodes to app
 * factories. v2 removed it — factory membership is an app concern and never
 * enters the engine. Kept only so stored v1 graphs keep parsing.
 */
const groupAssignmentSchemaV1 = z.object({
  nodeId: z.string().min(1),
  factoryId: z.string().min(1),
  subfactoryId: z.string().min(1).optional(),
});

export const productionGraphSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(productionNodeSchema),
  edges: z.array(productionEdgeSchema),
  grouping: z.array(groupAssignmentSchemaV1),
});

export const productionGraphSchema = z.object({
  schemaVersion: z.literal(2),
  nodes: z.array(productionNodeSchema),
  edges: z.array(productionEdgeSchema),
});

export type MigrateProductionGraphResult =
  | { ok: true; graph: ProductionGraph; migratedFrom: 1 | null }
  | { ok: false; errors: ProductionGraphValidationDiagnostic[] };

/**
 * Accepts any supported stored graph document and returns it at the current
 * schema version. v1 documents drop `grouping` (factory membership lives
 * app-side); v2 documents pass through unchanged.
 */
export function migrateProductionGraph(input: unknown): MigrateProductionGraphResult {
  const v2 = productionGraphSchema.safeParse(input);
  if (v2.success) {
    return { ok: true, graph: v2.data, migratedFrom: null };
  }

  const v1 = productionGraphSchemaV1.safeParse(input);
  if (v1.success) {
    return {
      ok: true,
      graph: {
        schemaVersion: PRODUCTION_GRAPH_SCHEMA_VERSION,
        nodes: v1.data.nodes,
        edges: v1.data.edges,
      },
      migratedFrom: 1,
    };
  }

  return { ok: false, errors: v2.error.issues.map(schemaIssueToDiagnostic) };
}

function normalizeItemId(itemId: string | null | undefined): string | null {
  return itemId ? itemId.split(':').pop() ?? itemId : null;
}

function itemsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeItemId(left);
  const normalizedRight = normalizeItemId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function recipeById(gameData: EngineGameData | undefined): Map<string, EngineRecipeDefinition> {
  const recipes = [...(gameData?.recipes ?? []), ...(gameData?.generatorRecipes ?? [])];
  return new Map(recipes.map((recipe) => [recipe.id, recipe]));
}

function nodeProducesItem(
  node: ProductionNode,
  itemId: string,
  recipes: ReadonlyMap<string, EngineRecipeDefinition>
): boolean | null {
  if (node.kind === 'source' || node.kind === 'pool') return itemsMatch(node.itemId, itemId);
  if (node.kind === 'sink') return false;

  const recipe = recipes.get(node.recipeId);
  if (!recipe) return null;
  return recipe.outputs.some((output) => itemsMatch(output.itemId, itemId));
}

function nodeConsumesItem(
  node: ProductionNode,
  itemId: string,
  recipes: ReadonlyMap<string, EngineRecipeDefinition>
): boolean | null {
  if (node.kind === 'sink' || node.kind === 'pool') return itemsMatch(node.itemId, itemId);
  if (node.kind === 'source') return false;

  const recipe = recipes.get(node.recipeId);
  if (!recipe) return null;
  return recipe.inputs.some((input) => itemsMatch(input.itemId, itemId));
}

function schemaIssueToDiagnostic(issue: z.ZodIssue): ProductionGraphValidationDiagnostic {
  return {
    severity: 'error',
    code: 'invalid-schema',
    scope: {},
    message: `${issue.path.join('.') || 'graph'}: ${issue.message}`,
  };
}

export function validateProductionGraph(
  graph: unknown,
  gameData?: EngineGameData
): ProductionGraphValidationResult {
  const migrated = migrateProductionGraph(graph);
  if (!migrated.ok) {
    return { ok: false, graph: null, errors: migrated.errors, warnings: [] };
  }

  const productionGraph = migrated.graph;
  const errors: ProductionGraphValidationDiagnostic[] = [];
  const warnings: ProductionGraphValidationDiagnostic[] = [];

  if (migrated.migratedFrom !== null) {
    warnings.push({
      severity: 'warning',
      code: 'deprecated-schema',
      scope: {},
      message: `Graph uses deprecated schema v${migrated.migratedFrom}; migrated to v${PRODUCTION_GRAPH_SCHEMA_VERSION}.`,
    });
  }

  const nodesById = new Map(productionGraph.nodes.map((node) => [node.id, node]));

  for (const edge of productionGraph.edges) {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);

    if (!source) {
      errors.push({
        severity: 'error',
        code: 'missing-node',
        scope: { edgeId: edge.id, nodeId: edge.sourceId },
        message: `Edge ${edge.id} references missing source node ${edge.sourceId}.`,
      });
    }
    if (!target) {
      errors.push({
        severity: 'error',
        code: 'missing-node',
        scope: { edgeId: edge.id, nodeId: edge.targetId },
        message: `Edge ${edge.id} references missing target node ${edge.targetId}.`,
      });
    }
  }

  const recipes = recipeById(gameData);
  for (const edge of productionGraph.edges) {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    if (!source || !target) continue;

    const produces = nodeProducesItem(source, edge.itemId, recipes);
    const consumes = nodeConsumesItem(target, edge.itemId, recipes);
    if (produces === false || consumes === false) {
      warnings.push({
        severity: 'warning',
        code: 'item-mismatch',
        scope: { edgeId: edge.id },
        message: `Edge ${edge.id} carries ${edge.itemId}, which does not match its source output or target input.`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    graph: productionGraph,
    errors,
    warnings,
  };
}
