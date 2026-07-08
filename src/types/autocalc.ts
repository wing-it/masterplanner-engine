import type { ItemRate, NodeId, ProductionGraph } from './production-graph';

export interface RateRollup {
  inputs: ItemRate[];
  outputs: ItemRate[];
  machines: number;
}

export interface AutocalcResult {
  schemaVersion: number;
  nodes: Record<NodeId, {
    machines: number;
    scale: number;
    inputs: ItemRate[];
    outputs: ItemRate[];
  }>;
  edges: Record<string, {
    demandedRate: number;
    suppliedRate: number;
    deficitRate: number;
    allocation: number;
  }>;
  rollups?: { world: RateRollup };
}

export type ChangeOrigin =
  | { type: 'recipe-node'; nodeId: NodeId }
  | { type: 'source'; nodeId: NodeId }
  | { type: 'edge'; edgeId: string }
  | { type: 'routing'; nodeId: NodeId; portId: string }
  | { type: 'full' };

export interface AutocalcInput {
  graph: ProductionGraph;
  previous?: AutocalcResult;
  origin?: ChangeOrigin;
}
