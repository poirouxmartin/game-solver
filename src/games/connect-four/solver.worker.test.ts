import { describe, expect, it } from 'vitest';
import { ConnectFourPosition } from './position';
import { loadWasmSolver } from './wasm-solver';
import { JsEngine, NODE_LIMIT, TT_LOG_SIZE, WasmEngine } from './solver.worker';
import { analyzeRoot, analyzeRootParallel, evaluateLeaf } from './gpu/gpu-engine';

/** Positions profondes, coûts d'analyse weak à froid mesurés : d18 ≈ 244k nœuds (JS), d15 ≈ 153k (JS). */
const D18 = [0, 6, 0, 4, 4, 6, 5, 1, 1, 1, 5, 4, 6, 0, 2, 6, 3, 5];
const D15 = [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6];
const COLS = [0, 1, 2, 3, 4, 5, 6];

describe('budget de nœuds des moteurs (réinitialisé par requête, pas cumulatif)', () => {
  it('JsEngine : deux analyses de positions différentes sous le même budget', () => {
    const engine = new JsEngine(300_000);
    const r1 = engine.analyzeCols(D18, COLS);
    const r2 = engine.analyzeCols(D15, COLS);
    expect(r1.scores).not.toBeNull();
    // Sans réinitialisation, le budget serait cumulé (≈397k > 300k) → la 2e analyse renverrait null.
    expect(r2.scores).not.toBeNull();
    expect(r1.nodes).toBeGreaterThan(0);
    expect(r2.nodes).toBeGreaterThan(0);
  });

  it('WasmEngine : deux analyses de positions différentes sous le même budget', async () => {
    const solver = await loadWasmSolver(22);
    const engine = new WasmEngine(solver, 280_000);
    const r1 = engine.analyzeCols(D18, COLS);
    const r2 = engine.analyzeCols(D15, COLS);
    expect(r1.scores).not.toBeNull();
    expect(r2.scores).not.toBeNull();
    expect(r1.nodes).toBeGreaterThan(0);
    expect(r2.nodes).toBeGreaterThan(0);
  });
});

describe('budget réel du worker (constantes de production)', () => {
  it('la colonne la plus coûteuse de 4536 est analysée sous NODE_LIMIT', { timeout: 300_000 }, async () => {
    const solver = await loadWasmSolver(TT_LOG_SIZE);
    const engine = new WasmEngine(solver);
    // Colonne 6 de [3,4,2,5] : ≈ 32,4 M nœuds à froid (la plus chère des 7) — doit passer sous 40 M.
    const r = engine.analyzeCols([3, 4, 2, 5], [6]);
    expect(r.scores).not.toBeNull();
    expect(r.nodes).toBeLessThanOrEqual(NODE_LIMIT);
    expect(r.nodes).toBeGreaterThan(0);
  });
});

describe('évaluation de feuilles (étage approximatif des workers)', () => {
  it('WasmEngine/JsEngine evalLeaves ≡ evaluateLeaf JS (batch mélangé)', { timeout: 120_000 }, async () => {
    const wasmSolver = await loadWasmSolver(14);
    const wasmEngine = new WasmEngine(wasmSolver);
    const jsEngine = new JsEngine(300_000);

    const jobs: ConnectFourPosition[] = [];
    for (let attempt = 0; attempt < 4000 && jobs.length < 60; attempt++) {
      const pos = new ConnectFourPosition();
      let won = false;
      const target = 8 + Math.floor(Math.random() * 20);
      while (pos.nbMoves() < target) {
        const playable: number[] = [];
        for (let c = 0; c < 7; c++) if (pos.canPlay(c)) playable.push(c);
        const col = playable[Math.floor(Math.random() * playable.length)];
        pos.play(col);
        const mover = BigInt(pos.currentLo >>> 0) | (BigInt(pos.currentHi) << 32n);
        if ((mover & (mover >> 1n) & (mover >> 2n) & (mover >> 3n)) !== 0n) { won = true; break; }
      }
      if (!won && pos.nbMoves() >= 8) jobs.push(pos);
    }
    expect(jobs.length).toBeGreaterThan(30);

    const flat: number[] = [];
    for (const p of jobs) flat.push(p.currentLo, p.currentHi, p.maskLo, p.maskHi, p.nbMoves(), 4);
    const vWasm = wasmEngine.evalLeaves(flat);
    const vJs = jsEngine.evalLeaves(flat);
    expect(vJs.length).toBe(jobs.length);
    expect(vWasm.length).toBe(jobs.length);
    for (let i = 0; i < jobs.length; i++) {
      const ref = evaluateLeaf(jobs[i], 4);
      expect(vJs[i]).toBe(ref);
      expect(vWasm[i]).toBe(ref);
    }
  });

  it('analyzeRootParallel avec dispatch par lots ≡ analyzeRoot', { timeout: 120_000 }, async () => {
    const seqs = [[], [3], [3, 2, 4], [3, 2, 4, 1, 5]];
    for (const seq of seqs) {
      const ref = analyzeRoot(seq);
      const par = await analyzeRootParallel(seq, async (jobs) => {
        const map = new Map<number, number>();
        for (const j of jobs) map.set(j.nodeIndex, evaluateLeaf(j.pos, j.budget));
        return map;
      });
      expect(par.scores).toEqual(ref.scores);
      expect(par.exact).toBe(ref.exact);
    }
  });
});