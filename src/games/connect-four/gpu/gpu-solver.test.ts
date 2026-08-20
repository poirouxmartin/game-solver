import { describe, expect, it } from 'vitest';
import { WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import {
  BOARD_MASK_HI,
  BOARD_MASK_LO,
  BOTTOM_HI,
  BOTTOM_LO,
  computeWinningPosition,
  HI_MASK,
} from '../bitboard';
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

  // Transcription 1:1 de winningPosition/possible du kernel WGSL (u32 logiques).
  // Ne passe PAS par wgsl_reflect (son interpréteur évalue `>>` en décalage
  // signé sur u32, contrairement à la spec WGSL) — comparée au référentiel bitboard.
  const U32 = (x: number): number => x & 0xffffffff;
  const wpKernel = (plo: number, phi: number, mlo: number, mhi: number): { lo: number; hi: number } => {
    const a1l = U32(plo << 1), a1h = (plo >>> 31) | (phi << 1);
    const a2l = U32(plo << 2), a2h = (plo >>> 30) | (phi << 2);
    const a3l = U32(plo << 3), a3h = (plo >>> 29) | (phi << 3);
    let rl = (a1l & a2l & a3l) >>> 0, rh = a1h & a2h & a3h;
    const s7l = U32(plo << 7), s7h = (plo >>> 25) | (phi << 7);
    const s14l = U32(plo << 14), s14h = (plo >>> 18) | (phi << 14);
    const s21l = U32(plo << 21), s21h = plo >>> 11;
    const r7l = (plo >>> 7) | (phi << 25), r7h = phi >>> 7;
    const r14l = (plo >>> 14) | (phi << 18), r14h = phi >>> 14;
    const r21l = (plo >>> 21) | (phi << 11), r21h = phi >>> 21;
    let pLo = U32(s7l & s14l), pHi = s7h & s14h;
    rl |= pLo & s21l; rh |= pHi & s21h;
    rl |= pLo & r7l; rh |= pHi & r7h;
    pLo = U32(r7l & r14l); pHi = r7h & r14h;
    rl |= pLo & s7l; rh |= pHi & s7h;
    rl |= pLo & r21l; rh |= pHi & r21h;
    const s6l = U32(plo << 6), s6h = (plo >>> 26) | (phi << 6);
    const s12l = U32(plo << 12), s12h = (plo >>> 20) | (phi << 12);
    const s18l = U32(plo << 18), s18h = plo >>> 14;
    const r6l = (plo >>> 6) | (phi << 26), r6h = phi >>> 6;
    const r12l = (plo >>> 12) | (phi << 20), r12h = phi >>> 12;
    const r18l = (plo >>> 18) | (phi << 14), r18h = phi >>> 18;
    pLo = U32(s6l & s12l); pHi = s6h & s12h;
    rl |= pLo & s18l; rh |= pHi & s18h;
    rl |= pLo & r6l; rh |= pHi & r6h;
    pLo = U32(r6l & r12l); pHi = r6h & r12h;
    rl |= pLo & s6l; rh |= pHi & s6h;
    rl |= pLo & r18l; rh |= pHi & r18h;
    const s8l = U32(plo << 8), s8h = (plo >>> 24) | (phi << 8);
    const s16l = U32(plo << 16), s16h = (plo >>> 16) | (phi << 16);
    const s24l = U32(plo << 24), s24h = plo >>> 8;
    const r8l = (plo >>> 8) | (phi << 24), r8h = phi >>> 8;
    const r16l = (plo >>> 16) | (phi << 16), r16h = phi >>> 16;
    const r24l = (plo >>> 24) | (phi << 8), r24h = phi >>> 24;
    pLo = U32(s8l & s16l); pHi = s8h & s16h;
    rl |= pLo & s24l; rh |= pHi & s24h;
    rl |= pLo & r8l; rh |= pHi & r8h;
    pLo = U32(r8l & r16l); pHi = r8h & r16h;
    rl |= pLo & s8l; rh |= pHi & s8h;
    rl |= pLo & r24l; rh |= pHi & r24h;
    return {
      lo: (rl & ~mlo & BOARD_MASK_LO) >>> 0,
      hi: (rh & ~mhi) & BOARD_MASK_HI,
    };
  };
  const possibleKernel = (maskLo: number, maskHi: number): { lo: number; hi: number } => {
    const ql0 = U32(maskLo + BOTTOM_LO) >>> 0;
    const ql = ql0 & BOARD_MASK_LO;
    const carry = ql0 < (maskLo >>> 0) ? 1 : 0;
    const qh = U32(maskHi + BOTTOM_HI + carry) & HI_MASK & BOARD_MASK_HI;
    return { lo: ql, hi: qh };
  };

  it('kernel WGSL : transcription winningPosition/possible/canWinNext identique au référentiel bitboard', () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pos = new ConnectFourPosition();
      let won = false;
      while (pos.nbMoves() < 30) {
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
      const s = pos.snapshot();
      const wpRef = computeWinningPosition(s.currentLo, s.currentHi, s.maskLo, s.maskHi);
      const wpK = wpKernel(s.currentLo, s.currentHi, s.maskLo, s.maskHi);
      expect(wpK.lo, `wp.lo moves=${pos.nbMoves()}`).toBe(wpRef.lo);
      expect(wpK.hi, `wp.hi moves=${pos.nbMoves()}`).toBe(wpRef.hi);
      const pRef = pos.possible();
      const pK = possibleKernel(s.maskLo, s.maskHi);
      expect(pK.lo, `p.lo moves=${pos.nbMoves()}`).toBe(pRef.lo);
      expect(pK.hi, `p.hi moves=${pos.nbMoves()}`).toBe(pRef.hi);
      const canWinK = (wpK.lo & pK.lo) !== 0 || (wpK.hi & pK.hi) !== 0;
      expect(canWinK, `canWinNext moves=${pos.nbMoves()}`).toBe(pos.canWinNext());
    }
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