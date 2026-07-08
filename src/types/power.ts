import type { NodeId, ProductionGraph } from './production-graph';
import type { AutocalcResult, ChangeOrigin } from './autocalc';

export interface PowerInput {
  graph: ProductionGraph;
  autocalc: AutocalcResult;
  autocalcTouched?: string[];
  previous?: PowerResult;
  origin?: ChangeOrigin;
}

export interface PowerNodeResult {
  role: 'consumer' | 'generator';
  drawMw: number;
  genMw: number;
}

export interface PowerResult {
  schemaVersion: number;
  nodes: Record<NodeId, PowerNodeResult>;
  world: {
    drawMw: number;
    genMw: number;
    netMw: number;
  };
}
