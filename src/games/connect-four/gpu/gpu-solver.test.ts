import { describe, expect, it } from 'vitest';
import { WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { ConnectFourSolver } from '../solver';
import { ConnectFourPosition } from '../position';
import { evaluateLeaf } from './gpu-engine';
import { buildWgsl, createGpuSolver, leafSearchIterative, MAX_LEAF_DEPTH } from './gpu-solver';

const hasWin = (m: bigint): boolean =>
  (m & (m >> 1n) & (m >> 2n) & (m >> 3n)) !== 0n ||
  (m & (m >> 7n) & (m >> 14n) & (m >> 21n)) !== 0n ||
  (m & (m >> 8n) & (m >> 16n) & (m >> 24n)) !== 0n ||
  (m & (m >> 6n) & (m >> 12n) & (m >> 18n)) !== 0n;

const toBig = (lo: number, hi: number): bigint => BigInt(lo >>> 0) | (BigInt(hi) << 32n);

const moverPieces = (pos: ConnectFourPosition): bigint =>
  toBig(pos.currentLo ^ pos.maskLo, pos.currentHi ^ pos.maskHi);

describe('gpu-solver : référence itérative du kernel', () => {
  it('leafSearchIterative : mêmes valeurs que evaluateLeaf (fins de partie)', { timeout: 60_000 }, () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pos = new ConnectFourPosition();
      let won = false;
      while (pos.nbMoves() < 36) {
        const playable: number[] = [];
        for (let c = 0; c < 7; c++) if (pos.canPlay(c)) playable.push(c);
        const col = playable[Math.floor(Math.random() * playable.length)];
        pos.play(col);
        if (hasWin(moverPieces(pos))) {
          won = true;
          break;
        }
      }
      if (won) continue;
      const depth = 1 + Math.floor(Math.random() * 8);
      const ref = evaluateLeaf(pos, depth);
      const iter = leafSearchIterative(pos, depth);
      expect(iter, `moves=${pos.nbMoves()} depth=${depth} ref=${ref} iter=${iter}`).toBe(ref);
    }
  });

  it('leafSearchIterative : budget 0 → heuristique (aucune expansion)', () => {
    const pos = new ConnectFourPosition();
    pos.play(3);
    pos.play(2);
    const v = leafSearchIterative(pos, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(1000);
  });

  it('buildWgsl : template complet, pas de placeholder restant', () => {
    const wgsl = buildWgsl();
    expect(wgsl).not.toMatch(/@[A-Z_]+@/);
    expect(wgsl).toContain('fn leafSearchIter');
    expect(wgsl).toContain('fn winningPosition');
    expect(wgsl).toContain('array<Frame, ' + (MAX_LEAF_DEPTH + 1) + '>');
    const opens = (wgsl.match(/\{/g) ?? []).length;
    const closes = (wgsl.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('buildWgsl : kernel syntaxiquement valide (parseur WGSL réel)', () => {
    const wgsl = buildWgsl();
    expect(() => new WgslParser().parse(wgsl)).not.toThrow();
  });

  it('createGpuSolver : null en Node (pas de navigator.gpu)', async () => {
    const solver = await createGpuSolver();
    expect(solver).toBeNull();
  });
});

describe('gpu-solver : exactitude dans le budget', () => {
  it('leafSearchIterative : signe identique au solveur exact (budget 6 sur fins de partie)', { timeout: 60_000 }, () => {
    const solver = new ConnectFourSolver(22);
    for (let attempt = 0; attempt < 60; attempt++) {
      const pos = new ConnectFourPosition();
      let won = false;
      while (pos.nbMoves() < 36) {
        const playable: number[] = [];
        for (let c = 0; c < 7; c++) if (pos.canPlay(c)) playable.push(c);
        const col = playable[Math.floor(Math.random() * playable.length)];
        pos.play(col);
        if (hasWin(moverPieces(pos))) {
          won = true;
          break;
        }
      }
      if (won) continue;
      const exact = solver.solve(pos, true);
      const iter = leafSearchIterative(pos, 6);
      expect(Math.sign(iter), `moves=${pos.nbMoves()} exact=${exact} iter=${iter}`).toBe(exact);
    }
  });
});