# masterplanner-engine

[![CI](https://github.com/winget86/masterplanner-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/winget86/masterplanner-engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Factory production calculation engine for [Satisfactory](https://www.satisfactorygame.com/): a serializable production graph in, balanced machine counts, rates, and power out.

This is a pure calculation library. It has no UI, no storage, and no app-level dependencies — you feed it a graph and game data, and it hands back a solved plan.

## Install

Not published to npm. Add it as a git dependency or clone it into a workspace:

```bash
git clone https://github.com/winget86/masterplanner-engine.git
cd masterplanner-engine
npm install
```

## Usage

```ts
import {
  validateProductionGraph,
  normalizeGraph,
  solveProductionGraph,
  type ProductionGraph,
} from '@masterplanner/engine';

const graph: ProductionGraph = {
  schemaVersion: 2,
  nodes: [
    { kind: 'source', id: 'ore', itemId: 'iron-ore', sourceType: 'resource-claim', maxRatePerMin: 120 },
    { kind: 'recipe', id: 'smelter', recipeId: 'iron-ingot' },
    { kind: 'sink', id: 'output', itemId: 'iron-ingot', demandPerMin: 30 },
  ],
  edges: [
    { id: 'e1', sourceId: 'ore', targetId: 'smelter', itemId: 'iron-ore' },
    { id: 'e2', sourceId: 'smelter', targetId: 'output', itemId: 'iron-ingot' },
  ],
};

// Validate + migrate older schema versions before solving.
const validation = validateProductionGraph(graph);

// Normalize into the adjacency-indexed shape the solver expects.
const normalized = normalizeGraph(graph);

// Solving requires game data (recipes, buildings, power profiles) built via
// `buildEngineGameData` from your own Satisfactory data source — see
// src/game-data/adapter.ts.
const { result, diagnostics } = solveProductionGraph(graph, gameData);
```

`solveProductionGraph` is incremental: pass `{ previous, origin }` to re-solve only the parts of the graph affected by a change instead of recomputing the whole plan.

## Architecture

- **`autocalc/`** — the solver: demand propagation, constraint resolution, actual-flow allocation, and byproduct recycling.
- **`power/`** — power draw and generation math (clock scaling, power shards, generator fuel).
- **`graph/`** — recipe math and graph normalization shared by every layer.
- **`pipeline/`** — layer execution with caching and stable hashing, for wiring the engine into an incremental app pipeline.
- **`game-data/`** — adapter that turns raw Satisfactory building/recipe rows into the `EngineGameData` shape the engine consumes.
- **`types/`** — schemas and types for production graphs, game data, and layer results (Zod-validated, versioned/migratable).

## Scripts

| Command | Description |
| --- | --- |
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` | Type-check with `tsc --noEmit` |

## Testing

Tests live alongside their source files (`*.test.ts`) and run under [Vitest](https://vitest.dev/).

## License

[MIT](LICENSE)
