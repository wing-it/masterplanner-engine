export interface LayerDiagnostic {
  layerId: string;
  severity: 'error' | 'warning';
  code: string;
  scope: { factoryId?: string; nodeId?: string; edgeId?: string; itemId?: string };
  message: string;
}

export interface LayerResultMeta {
  layerId: string;
  inputHash: string;
  computedAt: number;
  durationMs: number;
  touchedNodeIds?: string[];
  touchedEdgeIds?: string[];
}

export interface LayerResult<Output> {
  ok: boolean;
  data: Output | null;
  diagnostics: LayerDiagnostic[];
  meta: LayerResultMeta;
}

export interface Layer<Input, Output, GameData = unknown> {
  id: string;
  compute(input: Input, gameData: GameData): LayerResult<Output> | Promise<LayerResult<Output>>;
  inputHash(input: Input, gameData: GameData): string;
}
