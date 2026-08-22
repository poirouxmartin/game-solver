import { SOLVER_WASM_BYTES } from './solver-as.wasm.ts';

/** Valeur renvoyée par solve/analyze quand le budget de nœuds est dépassé. */
export const WASM_STOP = 1000;

/** Enveloppe du solveur Puissance 4 compilé en WebAssembly (AssemblyScript). */
export interface WasmSolver {
  create(logSize: number): number;
  reset(): void;
  clearTT(): void;
  setNodeLimit(limit: number): void;
  resetNodeCount(): void;
  getNodeCount(): number;
  canPlay(col: number): number;
  play(col: number): void;
  unplay(col: number): void;
  nbMoves(): number;
  solve(weak: boolean): number;
  analyze(weak: boolean): number;
  analyzeCol(col: number, weak: boolean): number;
  scoreAt(col: number): number;
  /** Étage évaluation de feuilles (kernel CPU rapide) : positionne puis évalue. */
  setLeafPosition(cLo: number, cHi: number, mLo: number, mHi: number, moves: number): void;
  leafEval(budget: number): number;
}

/** Charge et initialise le solveur WASM (octets embarqués dans le bundle). */
export async function loadWasmSolver(logSize = 22): Promise<WasmSolver> {
  return instantiateWasm(SOLVER_WASM_BYTES.buffer, logSize);
}

/** Instancie le solveur WASM depuis les octets compilés. */
export async function instantiateWasm(bytes: ArrayBuffer, logSize = 22): Promise<WasmSolver> {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => {} } });
  const e = instance.exports as Record<string, (...args: (number | bigint)[]) => number>;

  const asm = (name: string): (...args: (number | bigint)[]) => number => {
    const fn = e[name];
    if (typeof fn !== 'function') throw new Error(`export wasm manquant : ${name}`);
    return fn;
  };

  const solver: WasmSolver = {
    create: (l) => asm('create')(l),
    reset: () => asm('reset')(),
    clearTT: () => asm('clearTT')(),
    setNodeLimit: (limit) => asm('setNodeLimit')(BigInt(limit)),
    resetNodeCount: () => asm('resetNodeCount')(),
    getNodeCount: () => Number(asm('getNodeCount')()),
    canPlay: (col) => asm('canPlay')(col),
    play: (col) => asm('play')(col),
    unplay: (col) => asm('unplay')(col),
    nbMoves: () => asm('nbMoves')(),
    solve: (weak) => asm('solve')(weak ? 1 : 0),
    analyze: (weak) => asm('analyze')(weak ? 1 : 0),
    analyzeCol: (col, weak) => asm('analyzeCol')(col, weak ? 1 : 0),
    scoreAt: (col) => asm('scoreAt')(col),
    setLeafPosition: (cLo, cHi, mLo, mHi, mv) =>
      asm('setLeafPosition')(cLo | 0, cHi | 0, mLo | 0, mHi | 0, mv),
    leafEval: (budget) => asm('leafEval')(budget),
  };
  solver.create(logSize);
  return solver;
}