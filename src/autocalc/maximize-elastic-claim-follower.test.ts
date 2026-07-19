import { describe, expect, it } from 'vitest';

import type { EngineGameData, EngineRecipeDefinition } from '../types/game-data';
import type { ProductionGraph } from '../types/production-graph';
import { solveProductionGraph } from './solve';

function recipe(opts: {
  id: string;
  durationSeconds: number;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
}): EngineRecipeDefinition {
  return {
    id: opts.id,
    name: opts.id,
    slug: opts.id,
    durationSeconds: opts.durationSeconds,
    product: opts.outputs[0] ? { id: opts.outputs[0].itemId } : null,
    inputs: opts.inputs,
    outputs: opts.outputs,
    machine: null,
  };
}

function gameData(recipes: EngineRecipeDefinition[]): EngineGameData {
  return { recipes, generatorRecipes: [], buildingPowerById: new Map() };
}

function graph(overrides: Partial<ProductionGraph> & Pick<ProductionGraph, 'nodes'>): ProductionGraph {
  return { schemaVersion: 2, edges: [], ...overrides };
}

/**
 * Owner-approved semantics reversal (2026-07-12): a demand-mode resource claim
 * (claimed but with no extractor/node count set -> sentinel maxRatePerMin, no
 * machineCountOverride) is an ELASTIC FOLLOWER, exactly like an unmetered water
 * pump. It supplies whatever the *bounded* inputs allow and never blocks a
 * maximize recipe from scaling to those bounded inputs. One bounded claim is
 * therefore enough to scale a whole line even when it feeds an output port with
 * no fixed downstream demand.
 *
 * This deliberately reverses the earlier F6/F8 "demand-mode claim zeros the
 * chain" guard (see maximize-partial-seed-floor.test.ts). The UX concern that
 * guard addressed (a factory silently jumping when a small consumer connects)
 * is now handled by the Finalize/lock feature instead.
 */
describe('maximizeOutput scales from a bounded claim while a demand-mode claim follows elastically', () => {
  function alloyData() {
    return gameData([
      recipe({
        id: 'alloy',
        durationSeconds: 60,
        inputs: [
          { itemId: 'iron', amount: 60 },
          { itemId: 'copper', amount: 40 },
        ],
        outputs: [{ itemId: 'alloy', amount: 20 }],
      }),
    ]);
  }

  /**
   * A maximize recipe wired to a world output port (demandPerMin 0 export sink)
   * with one bounded iron claim and one elastic copper input.
   */
  function alloyGraph(opts: { copper: 'demand-mode-claim' | 'manual-input' | 'bounded-claim' }): ProductionGraph {
    const copperSource: ProductionGraph['nodes'][number] =
      opts.copper === 'bounded-claim'
        ? { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'resource-claim', maxRatePerMin: 300, machineCountOverride: 1 }
        : opts.copper === 'manual-input'
          ? { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'manual-input', maxRatePerMin: 1_000_000_000, unbounded: true }
          // demand-mode claim: sentinel capacity, no machineCountOverride.
          : { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 };

    return graph({
      nodes: [
        // Bounded iron claim: 120 iron/min = 2 alloy machines' worth.
        { kind: 'source', id: 'iron-src', itemId: 'iron', sourceType: 'resource-claim', maxRatePerMin: 120, machineCountOverride: 1 },
        copperSource,
        { kind: 'recipe', id: 'alloys', recipeId: 'alloy', maximizeOutput: true },
        { kind: 'sink', id: 'export', itemId: 'alloy', demandPerMin: 0 },
      ],
      edges: [
        { id: 'iron-in', sourceId: 'iron-src', targetId: 'alloys', itemId: 'iron' },
        { id: 'copper-in', sourceId: 'copper-src', targetId: 'alloys', itemId: 'copper' },
        { id: 'alloy-out', sourceId: 'alloys', targetId: 'export', itemId: 'alloy' },
      ],
    });
  }

  it('scales to the bounded iron claim when the copper input is a demand-mode claim', () => {
    const { result } = solveProductionGraph(alloyGraph({ copper: 'demand-mode-claim' }), alloyData());

    // 120 iron / 60 per machine = 2 machines -> 40 alloy; copper (80/min) follows.
    expect(result.nodes.alloys?.machines).toBeCloseTo(2, 4);
    expect(result.nodes.alloys?.outputs).toContainEqual({ itemId: 'alloy', ratePerMin: 40 });
    expect(result.nodes.alloys?.inputs).toContainEqual({ itemId: 'iron', ratePerMin: 120 });
    expect(result.nodes.alloys?.inputs).toContainEqual({ itemId: 'copper', ratePerMin: 80 });
  });

  it('scales to the bounded iron claim when the copper input is an unbounded manual import', () => {
    const { result } = solveProductionGraph(alloyGraph({ copper: 'manual-input' }), alloyData());

    expect(result.nodes.alloys?.outputs).toContainEqual({ itemId: 'alloy', ratePerMin: 40 });
    expect(result.nodes.alloys?.inputs).toContainEqual({ itemId: 'copper', ratePerMin: 80 });
  });

  it('control: a second bounded claim still constrains as the tighter of the two', () => {
    // Copper bounded at 300/min = 7.5 alloy machines; iron (2 machines) is tighter.
    const { result } = solveProductionGraph(alloyGraph({ copper: 'bounded-claim' }), alloyData());

    expect(result.nodes.alloys?.outputs).toContainEqual({ itemId: 'alloy', ratePerMin: 40 });
  });

  it('stays at zero when EVERY input is a demand-mode claim (nothing bounded to scale from)', () => {
    const g = graph({
      nodes: [
        // Both inputs are demand-mode claims -> no seedable supply anywhere.
        { kind: 'source', id: 'iron-src', itemId: 'iron', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'source', id: 'copper-src', itemId: 'copper', sourceType: 'resource-claim', maxRatePerMin: 1_000_000_000 },
        { kind: 'recipe', id: 'alloys', recipeId: 'alloy', maximizeOutput: true },
        { kind: 'sink', id: 'export', itemId: 'alloy', demandPerMin: 0 },
      ],
      edges: [
        { id: 'iron-in', sourceId: 'iron-src', targetId: 'alloys', itemId: 'iron' },
        { id: 'copper-in', sourceId: 'copper-src', targetId: 'alloys', itemId: 'copper' },
        { id: 'alloy-out', sourceId: 'alloys', targetId: 'export', itemId: 'alloy' },
      ],
    });

    const { result } = solveProductionGraph(g, alloyData());

    // No bounded input can seed, so the blowup guard holds: the recipe stays at
    // zero machines (a zero-machine recipe emits no output rows).
    expect(result.nodes.alloys?.machines ?? 0).toBeCloseTo(0, 4);
    const alloyOut = result.nodes.alloys?.outputs.find((o) => o.itemId === 'alloy')?.ratePerMin ?? 0;
    expect(alloyOut).toBeCloseTo(0, 4);
  });
});
