import { describe, expect, it } from 'vitest';
import { ConnectFourPosition } from '../position';
import { evaluateLeaf, analyzeRoot, analyzeRootFast, getLeafWasm } from './gpu-engine';
import { loadWasmSolver } from '../wasm-solver';

const hasWin = (m: bigint): boolean =>
  (m & (m >> 1n) & (m >> 2n) & (m >> 3n)) !== 0n ||
  (m & (m >> 7n) & (m >> 14n) & (m >> 21n)) !== 0n ||
  (m & (m >> 8n) & (m >> 16n) & (m >> 24n)) !== 0n ||
  (m & (m >> 6n) & (m >> 12n) & (m >> 18n)) !== 0n;
const toBig = (lo: number, hi: number): bigint => BigInt(lo >>> 0) | (BigInt(hi) << 32n);
const moverPieces = (pos: ConnectFourPosition): bigint =>
  toBig(pos.currentLo ^ pos.maskLo, pos.currentHi ^ pos.maskHi);

const genPos = (minMoves: number, maxMoves: number): ConnectFourPosition | null => {
  const pos = new ConnectFourPosition();
  let won = false;
  while (pos.nbMoves() < maxMoves) {
    const playable: number[] = [];
    for (let c = 0; c < 7; c++) if (pos.canPlay(c)) playable.push(c);
    const col = playable[Math.floor(Math.random() * playable.length)];
    pos.play(col);
    if (hasWin(moverPieces(pos))) { won = true; break; }
  }
  if (won || pos.nbMoves() < minMoves) return null;
  return pos;
};

describe('leafEval WASM', () => {
  it('parité leafEval(wasm) vs evaluateLeaf(js)', { timeout: 120_000 }, async () => {
    const w = await loadWasmSolver(14);
    const positions: ConnectFourPosition[] = [];
    while (positions.length < 400) {
      const p = genPos(0, 34);
      if (p) positions.push(p);
    }
    for (const p of positions) {
      for (const budget of [1, 2, 3, 4]) {
        w.setLeafPosition(p.currentLo, p.currentHi, p.maskLo, p.maskHi, p.nbMoves());
        const vW = w.leafEval(budget);
        const vJs = evaluateLeaf(p, budget);
        if (vW !== vJs) {
          throw new Error(`leafEval mismatch moves=${p.nbMoves()} b=${budget} wasm=${vW} js=${vJs} curLo=${p.currentLo} curHi=${p.currentHi} maskLo=${p.maskLo} maskHi=${p.maskHi}`);
        }
      }
    }
  });

  it('parité analyzeRootFast vs analyzeRoot', { timeout: 120_000 }, async () => {
    const seqs = [[], [3], [3, 2], [3, 2, 4], [3, 2, 4, 1], [3, 2, 4, 1, 5], [3, 2, 4, 1, 5, 3]];
    for (const seq of seqs) {
      const ref = analyzeRoot(seq);
      const fast = await analyzeRootFast(seq);
      expect(fast.scores).toEqual(ref.scores);
      expect(fast.exact).toBe(ref.exact);
    }
  });

  it('perf analyzeRootFast', { timeout: 120_000 }, async () => {
    const w = await getLeafWasm();
    expect(w).not.toBeNull();
    const seqs = [[], [3], [3, 2], [3, 2, 4], [3, 2, 4, 1], [3, 2, 4, 1, 5]];
    let total = 0;
    for (const seq of seqs) {
      const t0 = performance.now();
      await analyzeRootFast(seq);
      const ms = performance.now() - t0;
      total += ms;
      console.log(`fast moves=${seq.length} ${ms.toFixed(1)}ms`);
    }
    console.log(`fast TOTAL ${total.toFixed(0)}ms`);
  });
});