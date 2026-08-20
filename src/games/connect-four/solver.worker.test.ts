import { describe, expect, it } from 'vitest';
import { loadWasmSolver } from './wasm-solver';
import { JsEngine, WasmEngine } from './solver.worker';

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