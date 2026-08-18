import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../core/analysis';
import { NegamaxSolver } from '../../core/negamax';
import {
  EMPTY_STATE,
  evaluate,
  play,
  remainingPlies,
  ticTacToeGame,
  turn,
  type TicTacToeState,
} from './game';

function state(x: number[], o: number[]): TicTacToeState {
  let s = 0;
  for (const c of x) s |= 1 << c;
  for (const c of o) s |= (1 << c) << 9;
  return s;
}

function solve(s: TicTacToeState): number {
  return new NegamaxSolver(ticTacToeGame).solve(s, remainingPlies(s));
}

describe('règles', () => {
  it('X joue en premier', () => {
    expect(turn(EMPTY_STATE)).toBe('x');
    expect(turn(state([0], [1]))).toBe('x');
    expect(turn(state([0, 1], [4]))).toBe('o');
    expect(turn(state([0, 1], [4, 8]))).toBe('x');
  });

  it('détecte la fin de partie', () => {
    const xWon = state([0, 1, 2], [3, 5]);
    expect(evaluate(xWon)).toBe(-1); // O au trait vient de perdre
    const oWon = state([0, 3], [1, 4, 7]);
    expect(evaluate(oWon)).toBe(-1);
    const draw = state([0, 2, 4, 5, 7], [1, 3, 6, 8]);
    expect(evaluate(draw)).toBe(0);
    expect(evaluate(state([0], [1]))).toBeNull();
  });

  it('jouer un coup alterne X/O', () => {
    const s = play(state([0], [1]), 16); // cellule 4
    expect(s).toBe(state([0, 4], [1]));
  });
});

describe('solveur', () => {
  it('le jeu parfait est une nulle', () => {
    expect(solve(EMPTY_STATE)).toBe(0);
  });

  it('gagne immédiatement quand la victoire est disponible', () => {
    // X a 0-1, O en 3-4 : X joue 2 et gagne.
    expect(solve(state([0, 1], [3, 4]))).toBe(1);
  });

  it('position perdante pour le joueur au trait', () => {
    // X est au trait ; O menace 5 (ligne 3-4) et 7 (colonne 1-4), X ne peut bloquer qu'un seul.
    const s = state([0, 2, 6], [1, 3, 4]);
    expect(evaluate(s)).toBeNull();
    expect(solve(s)).toBe(-1);
  });

  it("vérifie l'identité minimax sur tous les états atteignables (5478)", () => {
    const solver = new NegamaxSolver(ticTacToeGame);
    const seen = new Set<number>();
    const stack = [EMPTY_STATE];

    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);

      if (evaluate(s) !== null) continue;

      let bestChild = -Infinity;
      const n = ticTacToeGame.moveCount(s);
      for (let i = 0; i < n; i++) {
        const child = play(s, ticTacToeGame.moveAt(s, i));
        stack.push(child);
        const v = 0 - solver.solve(child, remainingPlies(child));
        if (v > bestChild) bestChild = v;
      }

      const v = solver.solve(s, remainingPlies(s));
      expect(v, `état ${s}`).toBe(bestChild);
    }

    expect(seen.size).toBe(5478);
  });
});

describe("moteur d'analyse", () => {
  it('position initiale : tout coup est nul', () => {
    const analysis = analyzePosition(ticTacToeGame, new NegamaxSolver(ticTacToeGame), EMPTY_STATE, 9);
    expect(analysis.outcome).toBe('draw');
    expect(analysis.moves).toHaveLength(9);
    for (const m of analysis.moves) expect(m.outcome).toBe('draw');
    expect(analysis.best).toHaveLength(9);
  });

  it('signale le coup gagnant', () => {
    const s = state([0, 1], [3, 4]);
    const analysis = analyzePosition(ticTacToeGame, new NegamaxSolver(ticTacToeGame), s, remainingPlies(s));
    expect(analysis.outcome).toBe('win');
    const winning = analysis.moves.filter((m) => m.outcome === 'win').map((m) => m.move);
    expect(winning).toContain(4); // cellule 2
  });
});

describe('performance', () => {
  it('résout la position initiale 1000 fois en moins de 500 ms', () => {
    const solver = new NegamaxSolver(ticTacToeGame);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) solver.solve(EMPTY_STATE, 9);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});