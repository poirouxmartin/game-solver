import { MIN_ANALYZE_MOVES } from './game-controller';
import { ConnectFourPosition } from './position';
import { ConnectFourSolver, SOLVE_STOP } from './solver';
import { loadWasmSolver, WASM_STOP, type WasmSolver } from './wasm-solver';
import { evaluateLeaf } from './gpu/gpu-engine';

export interface AnalyzeRequest {
  id: number;
  /** Séquence de coups (analyse exacte). */
  seq?: number[];
  /** Colonnes à analyser (défaut : toutes). */
  cols?: number[];
  /** Feuilles à évaluer : [cLo,cHi,mLo,mHi,moves,budget] × N (étage GPU/CPU). */
  leaves?: number[];
  /** Index de partition (réponses feuilles multi-workers). */
  part?: number;
}

export interface AnalyzeResponse {
  id: number;
  /** Colonnes couvertes (mêmes indices que scores). */
  cols: number[];
  scores: number[] | null;
  ms: number;
  nodes: number;
  /** Valeurs des feuilles (même ordre que la requête), si requête feuilles. */
  values?: number[];
  /** Index de partition (réponses feuilles multi-workers). */
  part?: number;
}

// Mesure (colonne 6 de [3,4,2,5], position la plus dure connue) : les TT plus
// petites sont ~10 % plus rapides (sondes dans le L3) mais gonflent les nœuds
// : logSize 20-21 dépassent NODE_LIMIT=40M (troncature) là où 22 finit à 32,5M.
export const TT_LOG_SIZE = 22;
export const NODE_LIMIT = 40_000_000;
const WIDTH = 7;

export interface Engine {
  analyzeCols(seq: number[], cols: number[]): { scores: number[] | null; nodes: number };
  /** Évalue des feuilles aplaties [cLo,cHi,mLo,mHi,moves,budget] × N. */
  evalLeaves(flat: number[]): number[];
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

  evalLeaves(flat: number[]): number[] {
    const values: number[] = [];
    const pos = new ConnectFourPosition();
    for (let i = 0; i + 5 < flat.length; i += 6) {
      pos.setFromBits(flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]);
      values.push(evaluateLeaf(pos, flat[i + 5]));
    }
    return values;
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

  evalLeaves(flat: number[]): number[] {
    const values: number[] = [];
    for (let i = 0; i + 5 < flat.length; i += 6) {
      this.solver.setLeafPosition(flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]);
      values.push(this.solver.leafEval(flat[i + 5]));
    }
    return values;
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
    const { id, seq, cols, leaves, part } = e.data;
    const engine = await enginePromise;
    if (leaves !== undefined) {
      const t0 = performance.now();
      const values = engine.evalLeaves(leaves);
      ctx.postMessage({ id, cols: [], scores: null, ms: performance.now() - t0, nodes: 0, values, part } satisfies AnalyzeResponse);
      return;
    }
    const pos = new ConnectFourPosition();
    for (const col of seq ?? []) pos.play(col);
    let scores: number[] | null = null;
    let ms = 0;
    let nodes = 0;
    let wanted: number[] = [];
    if (pos.nbMoves() >= MIN_ANALYZE_MOVES) {
      wanted = cols ?? Array.from({ length: WIDTH }, (_, col) => col);
      const t0 = performance.now();
      const result = engine.analyzeCols(seq ?? [], wanted);
      ms = performance.now() - t0;
      scores = result.scores;
      nodes = result.nodes;
    }
    ctx.postMessage({ id, cols: wanted, scores, ms, nodes } satisfies AnalyzeResponse);
  };
}