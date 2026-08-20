import { HEIGHT, WIDTH } from './bitboard';
import type { ConnectFourPosition } from './position';
import { ConnectFourTranspositionTable } from './transposition-table';

export const INVALID_MOVE = -1000;

/** Signal levé quand le budget de nœuds est dépassé (solveur stoppé). */
export const SOLVE_STOP = Symbol('solve-stop');

const CELLS = WIDTH * HEIGHT;
const DRAW_MOVES = CELLS - 2; // 40
const MIN_SCORE = -(CELLS / 2) + 3; // -18
const MAX_SCORE = ((CELLS + 1) / 2) - 3; // 18
const LOWER_THRESHOLD = MAX_SCORE - MIN_SCORE + 1; // 37
const LOWER_STORE = MAX_SCORE - 2 * MIN_SCORE + 2; // +56
const UPPER_STORE = -MIN_SCORE + 1; // +19

/** Ordre d'exploration des colonnes, du centre vers les bords : {3, 2, 4, 1, 5, 0, 6}. */
export const COLUMN_ORDER = [3, 2, 4, 1, 5, 0, 6];

export class ConnectFourSolver {
  nodeCount = 0;
  nodeLimit = Infinity;

  private readonly tt: ConnectFourTranspositionTable;
  private readonly cols: Uint8Array[] = [];
  private readonly scos: Int8Array[] = [];
  private depth = 0;

  constructor(logSize = 24) {
    this.tt = new ConnectFourTranspositionTable(logSize);
  }

  reset(): void {
    this.nodeCount = 0;
    this.tt.reset();
  }

  private negamax(P: ConnectFourPosition, alpha: number, beta: number): number {
    if (++this.nodeCount >= this.nodeLimit) throw SOLVE_STOP;

    P.possibleNonLosingMovesInto();
    const possibleLo = P.lo;
    const possibleHi = P.hi;
    if (possibleLo === 0 && possibleHi === 0) {
      // aucun coup non perdant : l'adversaire gagne au coup suivant
      return ((-(CELLS - P.nbMoves())) / 2) | 0;
    }
    if (P.nbMoves() >= DRAW_MOVES) return 0;

    let min = ((-(CELLS - 2 - P.nbMoves())) / 2) | 0;
    if (alpha < min) {
      alpha = min;
      if (alpha >= beta) return alpha;
    }
    let max = ((CELLS - 1 - P.nbMoves()) / 2) | 0;
    if (beta > max) {
      beta = max;
      if (alpha >= beta) return beta;
    }

    const key = P.key();
    const val = this.tt.get(key);
    if (val !== 0) {
      if (val > LOWER_THRESHOLD) {
        min = val - LOWER_STORE;
        if (alpha < min) {
          alpha = min;
          if (alpha >= beta) return alpha;
        }
      } else {
        max = val - UPPER_STORE;
        if (beta > max) {
          beta = max;
          if (alpha >= beta) return beta;
        }
      }
    }

    this.depth++;
    const cols = (this.cols[this.depth] ??= new Uint8Array(WIDTH));
    const scos = (this.scos[this.depth] ??= new Int8Array(WIDTH));
    let m = 0;
    for (let i = WIDTH - 1; i >= 0; i--) {
      const col = COLUMN_ORDER[i];
      if (P.isInMask(col, possibleLo, possibleHi)) {
        const sc = P.moveScoreInto(col);
        let j = m;
        while (j > 0 && scos[j - 1] > sc) {
          scos[j] = scos[j - 1];
          cols[j] = cols[j - 1];
          j--;
        }
        scos[j] = sc;
        cols[j] = col;
        m++;
      }
    }

    for (let j = m - 1; j >= 0; j--) {
      const col = cols[j];
      P.play(col);
      const score = -this.negamax(P, -beta, -alpha);
      P.unplay(col);
      if (score >= beta) {
        this.tt.put(key, score + LOWER_STORE);
        this.depth--;
        return score;
      }
      if (score > alpha) alpha = score;
    }

    this.tt.put(key, alpha + UPPER_STORE);
    this.depth--;
    return alpha;
  }

  /**
   * Score de la position depuis le point de vue du joueur au trait.
   * weak = true : seulement gagne/nulle/perd (-1, 0, 1).
   */
  solve(P: ConnectFourPosition, weak = false): number {
    if (P.canWinNext()) {
      const s = ((CELLS + 1 - P.nbMoves()) / 2) | 0;
      return weak ? 1 : s;
    }
    let min = ((-(CELLS - P.nbMoves())) / 2) | 0;
    let max = ((CELLS + 1 - P.nbMoves()) / 2) | 0;
    if (weak) {
      min = -1;
      max = 1;
    }
    while (min < max) {
      let med = min + (((max - min) / 2) | 0);
      if (med <= 0 && ((min / 2) | 0) < med) med = (min / 2) | 0;
      else if (med >= 0 && ((max / 2) | 0) > med) med = (max / 2) | 0;
      const r = this.negamax(P, med, med + 1);
      if (r <= med) max = r;
      else min = r;
    }
    if (weak) return min > 0 ? 1 : min < 0 ? -1 : 0;
    return min;
  }

  /** Score de chaque colonne jouable (INVALID_MOVE sinon). onProgress après chaque colonne. */
  analyze(P: ConnectFourPosition, weak = false, onProgress?: (done: number) => void): number[] {
    const scores = new Array(WIDTH).fill(INVALID_MOVE);
    for (let col = 0; col < WIDTH; col++) {
      if (P.canPlay(col)) {
        if (P.isWinningMove(col)) {
          const s = ((CELLS + 1 - P.nbMoves()) / 2) | 0;
          scores[col] = weak ? 1 : s;
        } else {
          P.play(col);
          scores[col] = -this.solve(P, weak) || 0;
          P.unplay(col);
        }
      }
      onProgress?.(col + 1);
    }
    return scores;
  }
}