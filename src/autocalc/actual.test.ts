import { describe, expect, it } from 'vitest';

import type { ConstraintResult } from './constraints';
import type { RequiredPlan } from './demand';
import { calculateActualPlan } from './actual';

function constraints(
  scales: Record<string, { scale: number; immune?: boolean }>,
  globalScale = 1
): ConstraintResult {
  return {
    globalScale,
    componentScales: { 0: globalScale },
    immuneNodeIds: Object.entries(scales)
      .filter(([, value]) => value.immune)
      .map(([nodeId]) => nodeId),
    plan: Object.fromEntries(
      Object.entries(scales).map(([nodeId, value]) => [
        nodeId,
        {
          nodeId,
          scale: value.scale,
          immune: value.immune ?? false,
          componentId: 0,
        },
      ])
    ),
  };
}

describe('calculateActualPlan', () => {
  it('halves machines, inputs, and outputs at scale 0.5', () => {
    const required: RequiredPlan = {
      smelter: {
        nodeId: 'smelter',
        requiredMachines: 4,
        requiredInputs: { ore: 120 },
        requiredOutputs: { ingot: 120 },
      },
    };

    const result = calculateActualPlan(required, constraints({ smelter: { scale: 0.5 } }));

    expect(result.plan.smelter?.actualMachines).toBeCloseTo(2, 5);
    expect(result.plan.smelter?.actualInputs.ore).toBeCloseTo(60, 5);
    expect(result.plan.smelter?.actualOutputs.ingot).toBeCloseTo(60, 5);
    expect(result.plan.smelter?.scale).toBeCloseTo(0.5, 5);
  });

  it('keeps immune nodes at full required capacity', () => {
    const required: RequiredPlan = {
      recipe: {
        nodeId: 'recipe',
        requiredMachines: 4,
        requiredInputs: { ore: 120 },
        requiredOutputs: { ingot: 120 },
      },
    };

    const result = calculateActualPlan(required, constraints({ recipe: { scale: 1, immune: true } }, 0.25));

    expect(result.plan.recipe?.actualMachines).toBeCloseTo(4, 5);
    expect(result.plan.recipe?.actualInputs.ore).toBeCloseTo(120, 5);
    expect(result.plan.recipe?.actualOutputs.ingot).toBeCloseTo(120, 5);
    expect(result.plan.recipe?.scale).toBe(1);
  });

  it('preserves zero machines on source and sink nodes while scaling rates', () => {
    const required: RequiredPlan = {
      source: {
        nodeId: 'source',
        requiredMachines: 0,
        requiredInputs: {},
        requiredOutputs: { ore: 120 },
      },
      sink: {
        nodeId: 'sink',
        requiredMachines: 0,
        requiredInputs: { ore: 120 },
        requiredOutputs: {},
      },
    };

    const result = calculateActualPlan(required, constraints({
      source: { scale: 0.5 },
      sink: { scale: 0.5 },
    }));

    expect(result.plan.source?.actualMachines).toBe(0);
    expect(result.plan.sink?.actualMachines).toBe(0);
    expect(result.plan.source?.actualOutputs.ore).toBeCloseTo(60, 5);
    expect(result.plan.sink?.actualInputs.ore).toBeCloseTo(60, 5);
  });

  it('reports touched nodes by comparing actual outputs with the previous result', () => {
    const required: RequiredPlan = {
      unchanged: {
        nodeId: 'unchanged',
        requiredMachines: 1,
        requiredInputs: {},
        requiredOutputs: { item: 60 },
      },
      changed: {
        nodeId: 'changed',
        requiredMachines: 1,
        requiredInputs: {},
        requiredOutputs: { item: 60 },
      },
    };
    const previous = calculateActualPlan(
      required,
      constraints({
        unchanged: { scale: 1 },
        changed: { scale: 1 },
      })
    ).plan;

    const result = calculateActualPlan(
      required,
      constraints({
        unchanged: { scale: 1 },
        changed: { scale: 0.5 },
      }),
      { previous }
    );

    expect(result.touchedNodeIds).toEqual(['changed']);
  });
});
