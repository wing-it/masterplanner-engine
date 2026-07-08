import { itemsMatch } from '../graph/recipe-math';
import type { ItemRate, NodeId } from '../types/production-graph';
import type { ConstraintResult } from './constraints';
import type { RequiredPlan } from './demand';

const DEFAULT_EPSILON = 1e-6;

export interface ActualPlanNode {
  nodeId: NodeId;
  requiredMachines: number;
  actualMachines: number;
  scale: number;
  requiredInputs: Record<string, number>;
  actualInputs: Record<string, number>;
  requiredOutputs: Record<string, number>;
  actualOutputs: Record<string, number>;
}

export type ActualPlan = Record<NodeId, ActualPlanNode>;

export interface ActualResult {
  plan: ActualPlan;
  touchedNodeIds: NodeId[];
}

export interface ActualOptions {
  previous?: ActualPlan;
  dirtyNodeIds?: Iterable<NodeId>;
  epsilon?: number;
}

function scaleRecord(record: Readonly<Record<string, number>>, scale: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([itemId, rate]) => [itemId, rate * scale])
  );
}

function recordsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
  epsilon: number
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftValue = getRecordValue(left, key);
    const rightValue = getRecordValue(right, key);
    if (Math.abs(leftValue - rightValue) > epsilon) return false;
  }
  return true;
}

function getRecordValue(record: Readonly<Record<string, number>>, itemId: string): number {
  if (record[itemId] !== undefined) return record[itemId]!;
  for (const [key, value] of Object.entries(record)) {
    if (itemsMatch(key, itemId)) return value;
  }
  return 0;
}

function changedNodeIds(plan: ActualPlan, previous: ActualPlan | undefined, epsilon: number): NodeId[] {
  if (!previous) return Object.keys(plan);

  return Object.keys(plan).filter((nodeId) => {
    const current = plan[nodeId];
    const prior = previous[nodeId];
    if (!current || !prior) return true;
    return (
      Math.abs(current.actualMachines - prior.actualMachines) > epsilon ||
      Math.abs(current.scale - prior.scale) > epsilon ||
      !recordsEqual(current.actualInputs, prior.actualInputs, epsilon) ||
      !recordsEqual(current.actualOutputs, prior.actualOutputs, epsilon)
    );
  });
}

export function toItemRates(record: Readonly<Record<string, number>>): ItemRate[] {
  return Object.entries(record)
    .filter(([, ratePerMin]) => ratePerMin > DEFAULT_EPSILON)
    .map(([itemId, ratePerMin]) => ({ itemId, ratePerMin }));
}

export function calculateActualPlan(
  requiredPlan: RequiredPlan,
  constraints: ConstraintResult,
  options: ActualOptions = {}
): ActualResult {
  const plan: ActualPlan = {};
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const previous = options.previous;

  const dirtySet = options.dirtyNodeIds ? new Set<NodeId>(options.dirtyNodeIds) : null;

  for (const [nodeId, requiredNode] of Object.entries(requiredPlan)) {
    const scale = constraints.plan[nodeId]?.scale ?? constraints.globalScale;
    const priorNode = previous?.[nodeId];

    const isDirty = dirtySet ? dirtySet.has(nodeId) : true;
    const canReuse = priorNode && !isDirty &&
      Math.abs(scale - priorNode.scale) <= epsilon &&
      Math.abs(requiredNode.requiredMachines - priorNode.requiredMachines) <= epsilon;

    if (canReuse) {
      plan[nodeId] = priorNode;
    } else {
      const actualInputs = scaleRecord(requiredNode.requiredInputs, scale);
      const actualOutputs = scaleRecord(requiredNode.requiredOutputs, scale);

      plan[nodeId] = {
        nodeId,
        requiredMachines: requiredNode.requiredMachines,
        actualMachines: requiredNode.requiredMachines * scale,
        scale,
        requiredInputs: requiredNode.requiredInputs,
        actualInputs,
        requiredOutputs: requiredNode.requiredOutputs,
        actualOutputs,
      };
    }
  }

  return {
    plan,
    touchedNodeIds: changedNodeIds(plan, previous, epsilon),
  };
}
