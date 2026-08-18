import type { SolverGame } from '../../core/negamax';

/**
 * Tic-tac-toe sur bitboards.
 * État : X dans les bits 0-8, O dans les bits 9-17 (18 bits, tient dans un entier).
 * Cellule i -> bit (1 << i). X joue toujours en premier.
 */
export type TicTacToeState = number;

export const EMPTY_STATE: TicTacToeState = 0;

const FULL = 0x1ff;
const X_MASK = 0x1ff;

const WIN_MASKS = [
  0x007, 0x038, 0x1c0, // lignes
  0x049, 0x092, 0x124, // colonnes
  0x111, 0x054, // diagonales
];

const WIN_TABLE = new Uint8Array(512);
for (let m = 0; m < 512; m++) {
  WIN_TABLE[m] = WIN_MASKS.some((w) => (m & w) === w) ? 1 : 0;
}

const POPCOUNT = new Uint8Array(512);
for (let m = 0; m < 512; m++) {
  POPCOUNT[m] = (m & 1) + POPCOUNT[m >> 1];
}

const LOG2_TABLE = new Int8Array(512);
for (let i = 0; i < 9; i++) LOG2_TABLE[1 << i] = i;

// Ordre de priorité pour le move ordering : centre, coins, bords.
const ORDERED_BITS = [16, 1, 4, 64, 256, 2, 8, 32, 128];

const MOVES_BY_MASK: Uint16Array[] = [];
for (let m = 0; m < 512; m++) {
  MOVES_BY_MASK[m] = Uint16Array.from(ORDERED_BITS.filter((b) => (m & b) !== 0));
}

export function xMask(state: TicTacToeState): number {
  return state & X_MASK;
}

export function oMask(state: TicTacToeState): number {
  return (state >>> 9) & X_MASK;
}

export function legalMask(state: TicTacToeState): number {
  return ~(xMask(state) | oMask(state)) & FULL;
}

export function turn(state: TicTacToeState): 'x' | 'o' {
  return POPCOUNT[xMask(state)] === POPCOUNT[oMask(state)] ? 'x' : 'o';
}

export function hasWin(mask: number): boolean {
  return WIN_TABLE[mask] === 1;
}

export function isFull(state: TicTacToeState): boolean {
  return (xMask(state) | oMask(state)) === FULL;
}

/** Coup = bit mask. Renvoie l'index de cellule correspondant. */
export function cellOfMove(move: number): number {
  return LOG2_TABLE[move];
}

export function remainingPlies(state: TicTacToeState): number {
  return 9 - POPCOUNT[(state & FULL) | ((state >>> 9) & FULL)];
}

export function play(state: TicTacToeState, move: number): TicTacToeState {
  if (POPCOUNT[xMask(state)] === POPCOUNT[oMask(state)]) return state | move;
  return state | (move << 9);
}

/** null si non terminal ; -1 si le joueur au trait vient de perdre ; 0 si nulle (plateau plein). */
export function evaluate(state: TicTacToeState): number | null {
  if (WIN_TABLE[state & X_MASK] || WIN_TABLE[(state >>> 9) & X_MASK]) return -1;
  if (((state & X_MASK) | ((state >>> 9) & X_MASK)) === FULL) return 0;
  return null;
}

export const ticTacToeGame: SolverGame<TicTacToeState> = {
  evaluate,
  moveCount: (state) => POPCOUNT[legalMask(state)],
  moveAt: (state, index) => MOVES_BY_MASK[legalMask(state)][index],
  isLegal: (state, move) => (legalMask(state) & move) !== 0,
  play,
  key: (state) => state,
};