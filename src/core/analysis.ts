import { LOSS, WIN, type NegamaxSolver, type SolverGame } from './negamax';

export type Outcome = 'win' | 'draw' | 'loss';

export interface MoveOutcome {
  move: number;
  outcome: Outcome;
}

export interface PositionAnalysis {
  moves: MoveOutcome[];
  /** Coups atteignant la meilleure issue (celle de `outcome`). */
  best: number[];
  /** Issue de la position pour le joueur au trait. */
  outcome: Outcome;
}

export function outcomeOfValue(v: number): Outcome {
  if (v >= WIN) return 'win';
  if (v <= LOSS) return 'loss';
  return 'draw';
}

/**
 * Étiquète chaque coup légal d'une position : gagne / perd / nulle pour le joueur au trait.
 */
export function analyzePosition<S>(
  game: SolverGame<S>,
  solver: NegamaxSolver<S>,
  state: S,
  maxDepth: number,
): PositionAnalysis {
  const n = game.moveCount(state);
  const moves: MoveOutcome[] = [];
  let best = -Infinity;
  const bestMoves: number[] = [];

  for (let i = 0; i < n; i++) {
    const move = game.moveAt(state, i);
    const childValue = solver.solve(game.play(state, move), maxDepth - 1);
    const v = 0 - childValue; // perspective du joueur au trait
    const outcome = outcomeOfValue(v);
    moves.push({ move, outcome });
    if (v > best) {
      best = v;
      bestMoves.length = 0;
      bestMoves.push(move);
    } else if (v === best) {
      bestMoves.push(move);
    }
  }

  return { moves, best: bestMoves, outcome: outcomeOfValue(best) };
}