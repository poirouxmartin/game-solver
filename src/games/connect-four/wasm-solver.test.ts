import { describe, expect, it } from 'vitest';
import { ConnectFourSolver } from './solver';
import { ConnectFourPosition } from './position';
import { loadWasmSolver, WASM_STOP, type WasmSolver } from './wasm-solver';

/** Fixtures de l'API du solveur de Pons (coups encodés 1-based). */
const SOLVE_FIXTURES: { seq: number[]; value: number }[] = [
  { seq: [3, 4, 2, 5], value: 1 },
  { seq: [3, 4, 2, 5, 1, 6], value: 1 },
  { seq: [3, 4, 2, 5, 1, 6, 3], value: -1 },
  { seq: [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6], value: 0 },
  { seq: [0, 6, 0, 4, 4, 6, 5, 1, 1, 1, 5, 4, 6, 0, 2, 6, 3, 5], value: 0 },
];

/** Fixtures pour la parité analyse par colonne (sans 4536, trop coûteuse à froid). */
const ANALYZE_FIXTURES: number[][] = [
  [3, 4, 2, 5, 1, 6],
  [3, 4, 2, 5, 1, 6, 3],
  [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6],
];

const playJs = (seq: number[]): ConnectFourPosition => {
  const p = new ConnectFourPosition();
  for (const col of seq) p.play(col);
  return p;
};

const playWasm = (w: WasmSolver, seq: number[]): void => {
  w.reset();
  for (const col of seq) w.play(col);
};

describe('solveur WASM (parité JS + API Pons)', () => {
  let w: WasmSolver;

  it('résout les fixtures comme le solveur de Pons', async () => {
    w = await loadWasmSolver(22);
    for (const f of SOLVE_FIXTURES) {
      playWasm(w, f.seq);
      const v = w.solve(true);
      expect(v, `fixture [${f.seq}]`).toBe(f.value);
    }
  });

  it('analyse par colonne identique au JS (valeurs -1/0/+1)', { timeout: 120_000 }, async () => {
    const js = new ConnectFourSolver(22);
    for (const seq of ANALYZE_FIXTURES) {
      const jsScores = js.analyze(playJs(seq), true);
      playWasm(w, seq);
      const ok = w.analyze(true);
      expect(ok).toBe(0);
      for (let col = 0; col < 7; col++) {
        expect(w.scoreAt(col), `fixture [${seq}] colonne ${col}`).toBe(jsScores[col]);
      }
    }
  });

  it('analyzeCol par colonne identique au JS (chemin multi-cœurs)', { timeout: 120_000 }, () => {
    const js = new ConnectFourSolver(22);
    for (const seq of ANALYZE_FIXTURES) {
      const jsScores = js.analyze(playJs(seq), true);
      playWasm(w, seq);
      for (let col = 0; col < 7; col++) {
        const ok = w.analyzeCol(col, true);
        expect(ok).toBe(0);
        expect(w.scoreAt(col), `fixture [${seq}] colonne ${col}`).toBe(jsScores[col]);
      }
    }
  });

  it('détecte le dépassement de budget', () => {
    w.reset();
    w.setNodeLimit(1_000);
    for (let col = 0; col < 3; col++) w.play(col);
    const v = w.solve(true);
    expect(v).toBe(WASM_STOP);
    w.setNodeLimit(8_000_000);
  });

  it('NPS WASM vs JS (position d=15, à froid)', () => {
    const seq = [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6];
    const js = new ConnectFourSolver(22);
    js.nodeCount = 0;
    let t0 = performance.now();
    const vJs = js.solve(playJs(seq), false);
    const msJs = performance.now() - t0;

    w.reset();
    w.clearTT();
    w.resetNodeCount();
    playWasm(w, seq);
    t0 = performance.now();
    const vWasm = w.solve(false);
    const msWasm = performance.now() - t0;

    expect(vJs).toBe(vWasm);
    const jsNps = js.nodeCount / (msJs / 1000);
    const wasmNps = w.getNodeCount() / (msWasm / 1000);
    console.log(
      `[parité NPS d=15] JS ${Math.round(jsNps).toLocaleString('fr-FR')} n/s (${msJs.toFixed(0)} ms, ${js.nodeCount} nœuds) | WASM ${Math.round(wasmNps).toLocaleString('fr-FR')} n/s (${msWasm.toFixed(0)} ms, ${w.getNodeCount()} nœuds) → ×${(wasmNps / jsNps).toFixed(2)}`,
    );
  });
});