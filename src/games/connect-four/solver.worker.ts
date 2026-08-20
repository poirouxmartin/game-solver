import { MIN_ANALYZE_MOVES } from './game-controller';
import { ConnectFourPosition } from './position';
import { ConnectFourSolver, SOLVE_STOP } from './solver';

export interface AnalyzeRequest {
  id: number;
  seq: number[];
}

export interface AnalyzeResponse {
  id: number;
  scores: number[] | null;
  ms: number;
  nodes: number;
}

const TT_LOG_SIZE = 22;
const NODE_LIMIT = 8_000_000;

const solver = new ConnectFourSolver(TT_LOG_SIZE);
solver.nodeLimit = NODE_LIMIT;

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { id, seq } = e.data;
  const pos = new ConnectFourPosition();
  for (const col of seq) pos.play(col);
  let scores: number[] | null = null;
  let ms = 0;
  let nodes = 0;
  if (pos.nbMoves() >= MIN_ANALYZE_MOVES) {
    const t0 = performance.now();
    const nodesBefore = solver.nodeCount;
    try {
      scores = solver.analyze(pos, true);
    } catch (err) {
      if (err !== SOLVE_STOP) throw err;
      scores = null;
    }
    ms = performance.now() - t0;
    nodes = solver.nodeCount - nodesBefore;
  }
  ctx.postMessage({ id, scores, ms, nodes } satisfies AnalyzeResponse);
};