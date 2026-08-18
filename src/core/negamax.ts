import {
  TranspositionTable,
  TT_EXACT,
  TT_LOWER,
  TT_UPPER,
  type TtEntry,
} from './transposition-table';

export const WIN = 1;
export const DRAW = 0;
export const LOSS = -1;

const INF = 2;

export interface SolverGame<S> {
  /** Valeur depuis le point de vue du joueur au trait, ou null si non terminal. */
  evaluate(state: S): number | null;
  moveCount(state: S): number;
  /** Coup i (ordre fourni par le jeu : déjà ordonné pour le move ordering). */
  moveAt(state: S, index: number): number;
  isLegal(state: S, move: number): boolean;
  play(state: S, move: number): S;
  key(state: S): number;
}

export interface SolveStats {
  nodes: number;
  ttHits: number;
}

/**
 * Negamax avec alpha-bêta et table de transposition.
 * solve() renvoie la valeur exacte de jeu (1 gagne, 0 nulle, -1 perd) pour le joueur au trait.
 */
export class NegamaxSolver<S> {
  private readonly entry: TtEntry = { value: 0, move: -1, depth: 0, flag: TT_EXACT };
  private nodes = 0;
  lastStats: SolveStats = { nodes: 0, ttHits: 0 };

  constructor(
    private readonly game: SolverGame<S>,
    private readonly tt: TranspositionTable = new TranspositionTable(),
  ) {}

  solve(state: S, maxDepth: number): number {
    this.nodes = 0;
    const hitsBefore = this.tt.hits;
    const value = this.search(state, -INF, INF, maxDepth);
    this.lastStats = { nodes: this.nodes, ttHits: this.tt.hits - hitsBefore };
    return value === 0 ? 0 : value;
  }

  private search(state: S, alpha: number, beta: number, depth: number): number {
    const evalResult = this.game.evaluate(state);
    if (evalResult !== null) return evalResult;

    const key = this.game.key(state);
    this.entry.move = -1;
    if (this.tt.probe(key, this.entry)) {
      if (this.entry.depth >= depth) {
        if (this.entry.flag === TT_EXACT) return this.entry.value;
        if (this.entry.flag === TT_LOWER && this.entry.value >= beta) return this.entry.value;
        if (this.entry.flag === TT_UPPER && this.entry.value <= alpha) return this.entry.value;
      }
    }

    this.nodes++;
    if (depth <= 0) return DRAW;

    const alphaOrig = alpha;
    let best = -INF;
    let bestMove = -1;
    const ttMove = this.entry.move;
    const n = this.game.moveCount(state);

    for (let i = -1; i < n; i++) {
      let move: number;
      if (i === -1) {
        if (ttMove === -1) continue;
        if (!this.game.isLegal(state, ttMove)) continue;
        move = ttMove;
      } else {
        const m = this.game.moveAt(state, i);
        if (m === ttMove) continue;
        move = m;
      }

      const child = this.game.play(state, move);
      const v = 0 - this.search(child, -beta, -alpha, depth - 1);
      if (v > best) {
        best = v;
        if (v > alpha) {
          alpha = v;
          bestMove = move;
        }
        if (alpha >= beta) break;
      }
    }

    const flag = best >= beta ? TT_LOWER : best > alphaOrig ? TT_EXACT : TT_UPPER;
    this.tt.store(key, best, bestMove, depth, flag);
    return best;
  }
}