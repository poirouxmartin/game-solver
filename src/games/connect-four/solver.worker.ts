import { MIN_ANALYZE_MOVES } from './game-controller';
import { ConnectFourPosition } from './position';
import { ConnectFourSolver, SOLVE_STOP } from './solver';
import { loadWasmSolver, WASM_STOP, type WasmSolver } from './wasm-solver';

export interface AnalyzeRequest {
  id: number;
  seq: number[];
  /** Colonnes à analyser (défaut : toutes). */
  cols?: number[];
}

export interface AnalyzeResponse {
  id: number;
  /** Colonnes couvertes (mêmes indices que scores). */
  cols: number[];
  scores: number[] | null;
  ms: number;
  nodes: number;
}

const TT_LOG_SIZE = 22;
const NODE_LIMIT = 32_000_000;
const WIDTH = 7;

export interface Engine {
  analyzeCols(seq: number[], cols: number[]): { scores: number[] | null; nodes: number };
}

export class JsEngine implements Engine {
  private readonly solver: ConnectFourSolver;

  constructor(nodeLimit = NODE_LIMIT) {
    this.solver = new ConnectFourSolver(TT_LOG_SIZE);
    this.solver.nodeLimit = nodeLimit;
  }

  analyzeCols(seq: number[], cols: number[]): { scores: number[] | null; nodes: number } {
    const pos = new ConnectFourPosition();
    for (const col of seq) pos.play(col);

    this.solver.nodeCount = 0;
    try {
      const all = this.solver.analyze(pos, true);
      const scores = cols.map((col) => all[col]);
      return { scores, nodes: this.solver.nodeCount };
    } catch (err) {
      if (err !== SOLVE_STOP) throw err;
      return { scores: null, nodes: this.solver.nodeCount };
    }
  }
}

export class WasmEngine implements Engine {
  private readonly solver: WasmSolver;

  constructor(solver: WasmSolver, nodeLimit = NODE_LIMIT) {
    this.solver = solver;
    this.solver.setNodeLimit(nodeLimit);
  }

  analyzeCols(seq: number[], cols: number[]): { scores: number[] | null; nodes: number } {
    this.solver.reset();
    for (const col of seq) this.solver.play(col);
    const scores: number[] = [];
    for (const col of cols) {
      const ok = this.solver.analyzeCol(col, true);
      if (ok === WASM_STOP) return { scores: null, nodes: this.solver.getNodeCount() };
      scores.push(this.solver.scoreAt(col));
    }
    return { scores, nodes: this.solver.getNodeCount() };
  }
}

export async function createEngine(nodeLimit = NODE_LIMIT): Promise<Engine> {
  try {
    return new WasmEngine(await loadWasmSolver(TT_LOG_SIZE), nodeLimit);
  } catch (err) {
    console.warn('Solveur WASM indisponible, repli JS :', err);
    return new JsEngine(nodeLimit);
  }
}

const enginePromise = createEngine();

// Hors worker (tests Node), `self` est indéfini : on n'installe le message handler que dans le worker.
const ctx = typeof self !== 'undefined' ? (self as unknown as Worker) : null;

if (ctx) {
  ctx.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
    const { id, seq, cols } = e.data;
    const engine = await enginePromise;
    const pos = new ConnectFourPosition();
    for (const col of seq) pos.play(col);
    let scores: number[] | null = null;
    let ms = 0;
    let nodes = 0;
    let wanted: number[] = [];
    if (pos.nbMoves() >= MIN_ANALYZE_MOVES) {
      wanted = cols ?? Array.from({ length: WIDTH }, (_, col) => col);
      const t0 = performance.now();
      const result = engine.analyzeCols(seq, wanted);
      ms = performance.now() - t0;
      scores = result.scores;
      nodes = result.nodes;
    }
    ctx.postMessage({ id, cols: wanted, scores, ms, nodes } satisfies AnalyzeResponse);
  };
}