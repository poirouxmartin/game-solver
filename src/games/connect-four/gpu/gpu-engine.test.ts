import { describe, expect, it } from 'vitest';
import { ConnectFourSolver, INVALID_MOVE } from '../solver';
import { ConnectFourPosition } from '../position';
import { analyzeRoot, evaluateLeaf, expandFrontier } from './gpu-engine';

/** Vrai si le bitboard 49 bits contient un alignement de 4. */
const hasWin = (m: bigint): boolean =>
  (m & (m >> 1n) & (m >> 2n) & (m >> 3n)) !== 0n ||
  (m & (m >> 7n) & (m >> 14n) & (m >> 21n)) !== 0n ||
  (m & (m >> 8n) & (m >> 16n) & (m >> 24n)) !== 0n ||
  (m & (m >> 6n) & (m >> 12n) & (m >> 18n)) !== 0n;

const toBig = (lo: number, hi: number): bigint => BigInt(lo >>> 0) | (BigInt(hi) << 32n);

/** Pions du joueur qui vient de jouer (after play). */
const moverPieces = (pos: ConnectFourPosition): bigint =>
  toBig(pos.currentLo ^ pos.maskLo, pos.currentHi ^ pos.maskHi);

interface Endgame {
  seq: number[];
  pos: ConnectFourPosition;
}

/** Génère des fins de partie aléatoires légales avec `remaining` cellules libres. */
const randomEndgames = (remaining: number, count: number): Endgame[] => {
  const out: Endgame[] = [];
  const maxMoves = 42 - remaining;
  let attempts = 0;
  while (out.length < count && attempts < 5000) {
    attempts++;
    const pos = new ConnectFourPosition();
    const seq: number[] = [];
    let won = false;
    while (pos.nbMoves() < maxMoves) {
      const playable: number[] = [];
      for (let c = 0; c < 7; c++) if (pos.canPlay(c)) playable.push(c);
      const col = playable[Math.floor(Math.random() * playable.length)];
      pos.play(col);
      seq.push(col);
      if (hasWin(moverPieces(pos))) {
        won = true;
        break;
      }
    }
    if (!won && pos.nbMoves() === maxMoves) out.push({ seq, pos });
  }
  return out;
};

describe('gpu-engine : parité avec le solveur exact (positions dans le budget)', () => {
  it('evaluateLeaf : signe identique au solveur exact pour les fins de partie', { timeout: 60_000 }, () => {
    const solver = new ConnectFourSolver(22);
    for (const { pos } of randomEndgames(6, 12)) {
      const exact = solver.solve(pos, true);
      const gpu = evaluateLeaf(pos, 6);
      expect(Math.sign(gpu), `moves=${pos.nbMoves()} exact=${exact} gpu=${gpu}`).toBe(exact);
    }
  });

  it('analyzeRoot : scores par colonne identiques au solveur (budget couvrant la partie)', { timeout: 120_000 }, () => {
    const solver = new ConnectFourSolver(22);
    for (const { seq, pos } of randomEndgames(8, 8)) {
      const exact = solver.analyze(pos, true);
      const gpu = analyzeRoot(seq, { frontierDepth: 2, leafDepth: 10, maxLeaves: 50_000 });
      expect(gpu.exact, 'budget 2+10 doit couvrir ≤ 8 cellules').toBe(true);
      for (let col = 0; col < 7; col++) {
        const e = exact[col];
        if (e === INVALID_MOVE) continue;
        const g = gpu.scores[col];
        expect(Math.sign(g as number), `colonne ${col} exact=${e} gpu=${g}`).toBe(e);
      }
    }
  });

  it('expandFrontier : la racine est le nœud 0 et la profondeur est bornée', () => {
    const pos = new ConnectFourPosition();
    const nodes = expandFrontier(pos, { frontierDepth: 3, leafDepth: 4, maxLeaves: 100_000 });
    expect(nodes[0].depth).toBe(0);
    for (const n of nodes) expect(n.depth).toBeLessThanOrEqual(3);
    expect(nodes.length).toBeGreaterThan(1);
  });

  it('analyzeRoot : la position vide renvoie 7 scores (approximation)', { timeout: 120_000 }, () => {
    const gpu = analyzeRoot([], { frontierDepth: 6, leafDepth: 3, maxLeaves: 100_000 });
    expect(gpu.scores).toHaveLength(7);
    for (const s of gpu.scores) expect(s).not.toBeNull();
    expect(gpu.exact).toBe(false);
  });
});