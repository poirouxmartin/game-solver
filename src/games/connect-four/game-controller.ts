import { computeWinningPosition, xor } from './bitboard';
import { ConnectFourPosition } from './position';
import { COLUMN_ORDER, type ConnectFourSolver } from './solver';

/** L'analyse parfaite n'est lancée qu'à partir de ce nombre de coups (plus cher avant). */
export const MIN_ANALYZE_MOVES = 7;

export type C4Outcome = 'win' | 'draw' | 'loss';

const COLS = 7;
const ROWS = 6;

/**
 * Contrôleur d'une partie Puissance 4 humain (Rouge) contre solveur (Jaune).
 * Le joueur au trait est Rouge quand nbMoves() est pair.
 */
export class ConnectFourGame {
  readonly pos = new ConnectFourPosition();
  readonly solver: ConnectFourSolver;
  scores: number[] | null = null;
  gameOver = false;
  winner: 'red' | 'yellow' | null = null;
  lastAnalyzeMs = 0;
  lastAnalyzeNodes = 0;

  constructor(solver: ConnectFourSolver) {
    this.solver = solver;
  }

  reset(): void {
    this.pos.reset();
    this.scores = null;
    this.gameOver = false;
    this.winner = null;
    this.lastAnalyzeMs = 0;
    this.lastAnalyzeNodes = 0;
  }

  sideToMoveIsRed(): boolean {
    return this.pos.nbMoves() % 2 === 0;
  }

  /** Pions du joueur qui vient de jouer (l'adversaire du joueur au trait). */
  opponentMask(): { lo: number; hi: number } {
    return xor(this.pos.currentLo, this.pos.currentHi, this.pos.maskLo, this.pos.maskHi);
  }

  /** Coup du joueur humain (Rouge). */
  playHuman(col: number): void {
    this.pos.play(col);
    this.scores = null;
    this.finishIfGameOver();
  }

  /** Coup du solveur (Jaune). */
  playSolver(): void {
    this.pos.play(this.solverCol());
    this.scores = null;
    this.finishIfGameOver();
  }

  /** Analyse par colonne (weak) du point de vue du joueur au trait. Faux si indisponible. */
  analyze(): boolean {
    this.scores = null;
    this.lastAnalyzeMs = 0;
    this.lastAnalyzeNodes = 0;
    if (this.pos.nbMoves() < MIN_ANALYZE_MOVES) return false;
    const t0 = performance.now();
    const nodesBefore = this.solver.nodeCount;
    try {
      this.scores = this.solver.analyze(this.pos, true);
    } catch {
      this.scores = null;
      return false;
    }
    this.lastAnalyzeMs = performance.now() - t0;
    this.lastAnalyzeNodes = this.solver.nodeCount - nodesBefore;
    return true;
  }

  /** Issue de la position pour le joueur au trait, d'après la dernière analyse. */
  outcome(): C4Outcome | null {
    if (!this.scores) return null;
    let best = -2;
    for (let col = 0; col < COLS; col++) {
      if (!this.pos.canPlay(col)) continue;
      best = Math.max(best, this.scores[col]);
    }
    return best > 0 ? 'win' : best < 0 ? 'loss' : 'draw';
  }

  /** Coup choisi par le solveur : gain immédiat, sinon meilleure analyse, sinon heuristique sûre. */
  solverCol(): number {
    for (let col = 0; col < COLS; col++) {
      if (this.pos.canPlay(col) && this.pos.isWinningMove(col)) return col;
    }
    if (this.scores) {
      let best = -1;
      let bestScore = -Infinity;
      for (let col = 0; col < COLS; col++) {
        if (!this.pos.canPlay(col)) continue;
        const s = this.scores[col];
        if (s > bestScore) {
          bestScore = s;
          best = col;
        }
      }
      if (best !== -1) return best;
    }
    const p = this.pos.possibleNonLosingMoves();
    const hasSafe = p.lo !== 0 || p.hi !== 0;
    for (const col of COLUMN_ORDER) {
      if (this.pos.canPlay(col) && (!hasSafe || this.pos.isInMask(col, p.lo, p.hi))) return col;
    }
    for (const col of COLUMN_ORDER) if (this.pos.canPlay(col)) return col;
    return 0;
  }

  private finishIfGameOver(): void {
    if (this.pos.nbMoves() === COLS * ROWS) {
      this.gameOver = true;
      this.winner = null;
      return;
    }
    if (this.hasWinner()) {
      this.gameOver = true;
      this.winner = this.pos.nbMoves() % 2 === 1 ? 'red' : 'yellow';
    }
  }

  private hasWinner(): boolean {
    const opp = this.opponentMask();
    const w = computeWinningPosition(opp.lo, opp.hi, this.pos.maskLo, this.pos.maskHi);
    return w.lo !== 0 || w.hi !== 0;
  }
}