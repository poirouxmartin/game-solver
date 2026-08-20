import { ConnectFourPosition } from '../position';
import { COLUMN_ORDER } from '../solver';
import { BOTTOM_HI, BOTTOM_LO, BOARD_MASK_HI, BOARD_MASK_LO, WIDTH } from '../bitboard';
import {
  buildAnalysis,
  CELLS,
  DEFAULT_FRONTIER_DEPTH,
  DEFAULT_LEAF_DEPTH,
  DEFAULT_MAX_LEAVES,
  DRAW_MOVES,
  expandFrontier,
  heuristic,
  WIN_SCORE,
  type GpuAnalysis,
  type LeafJob,
} from './gpu-engine';

/** Profondeur de plis max supportée par le kernel WGSL (taille de la pile explicite). */
export const MAX_LEAF_DEPTH = 12;

/** Taille d'un workgroup du kernel. */
const WORKGROUP_SIZE = 64;

/** Nombre de u32 par feuille dans le buffer d'entrée (lo/hi current + lo/hi mask + moves). */
const LEAF_STRIDE = 5;

export interface GpuSolver {
  /** true si un adaptateur WebGPU est disponible et initialisé. */
  isSupported(): boolean;
  /** Analyse approchée/exacte selon le budget (frontière CPU + feuilles GPU). */
  analyze(seq: number[], options?: GpuAnalyzeOptions): Promise<GpuAnalysis>;
  /** Bench du kernel seul : feuilles traitées par seconde, estimation de NPS. */
  bench(leaves?: number, budget?: number): Promise<{ leaves: number; ms: number; leavesPerSec: number; usPerLeaf: number; estNps: number }>;
  /** Libère l'adaptateur/device (garde-fou, l'objet reste inutilisable). */
  destroy(): void;
}

export interface GpuAnalyzeOptions {
  frontierDepth?: number;
  leafDepth?: number;
  maxLeaves?: number;
}

interface KernelFrame {
  pos: ConnectFourPosition;
  depth: number;
  phase: number;
  possibleLo: number;
  possibleHi: number;
  best: number;
  moveIdx: number;
  lastCol: number;
  value: number;
}

const clonePos = (p: ConnectFourPosition): ConnectFourPosition => {
  const s = p.snapshot();
  const c = new ConnectFourPosition();
  c.restore(s);
  return c;
};

/**
 * Référence itérative du kernel WGSL (la récursion est interdite en WGSL, on
 * gère une pile explicite). Même machine à états, mêmes décisions que le
 * negamaxLike de gpu-engine — testée contre evaluateLeaf pour garantir que le
 * port WGSL (traduction 1:1) est correct.
 */
export const leafSearchIterative = (pos: ConnectFourPosition, budget: number): number => {
  if (pos.canWinNext()) return WIN_SCORE;
  const stack: KernelFrame[] = [
    { pos: clonePos(pos), depth: budget, phase: 0, possibleLo: 0, possibleHi: 0, best: -1_000_000, moveIdx: 0, lastCol: -1, value: 0 },
  ];
  let sp = 1;
  while (sp > 0) {
    const f = stack[sp - 1];
    if (f.phase === 0) {
      f.pos.possibleNonLosingMovesInto();
      const pnlLo = f.pos.lo;
      const pnlHi = f.pos.hi;
      if (pnlLo === 0 && pnlHi === 0) {
        f.value = -Math.floor((CELLS - f.pos.nbMoves()) / 2);
        f.phase = 2;
      } else if (f.pos.nbMoves() >= DRAW_MOVES) {
        f.value = 0;
        f.phase = 2;
      } else if (f.depth <= 0) {
        f.value = heuristic(f.pos);
        f.phase = 2;
      } else {
        f.possibleLo = pnlLo;
        f.possibleHi = pnlHi;
        f.best = -1_000_000;
        f.moveIdx = 0;
        f.lastCol = -1;
        f.phase = 1;
      }
    } else if (f.phase === 1) {
      if (f.lastCol >= 0) {
        f.pos.unplay(f.lastCol);
        f.lastCol = -1;
      }
      let found = false;
      let col = 0;
      while (!found && f.moveIdx < WIDTH) {
        col = COLUMN_ORDER[f.moveIdx];
        f.moveIdx++;
        if (f.pos.canPlay(col) && f.pos.isInMask(col, f.possibleLo, f.possibleHi)) found = true;
      }
      if (!found) {
        f.value = f.best === -1_000_000 ? heuristic(f.pos) : f.best;
        f.phase = 2;
      } else {
        f.lastCol = col;
        f.pos.play(col);
        stack[sp] = { pos: clonePos(f.pos), depth: f.depth - 1, phase: 0, possibleLo: 0, possibleHi: 0, best: -1_000_000, moveIdx: 0, lastCol: -1, value: 0 };
        sp++;
      }
    } else {
      if (sp === 1) return f.value;
      const childVal = f.value;
      sp--;
      const parent = stack[sp - 1];
      const v = -childVal;
      if (v > parent.best) parent.best = v;
      parent.phase = 1;
    }
  }
  return 0;
};

/**
 * Kernel WGSL : recherche par feuille (minimax borné en profondeur, pile
 * explicite, mêmes bitboards 49 bits et mêmes décisions que leafSearchIterative).
 * Chaque invocation évalue UNE feuille du buffer d'entrée.
 */
export const buildWgsl = (): string => {
  const maxDepth = MAX_LEAF_DEPTH;
  const wgsl = `
const CELLS: u32 = 42u;
const DRAW_MOVES: u32 = 40u;
const WIN_SCORE: i32 = 1000i;
const BOTTOM_LO: u32 = ${BOTTOM_LO}u;
const BOTTOM_HI: u32 = ${BOTTOM_HI}u;
const BOARD_MASK_LO: u32 = ${BOARD_MASK_LO}u;
const BOARD_MASK_HI: u32 = ${BOARD_MASK_HI}u;
const HI_MASK: u32 = 0x1ffffu;
const COLUMN_ORDER: array<u32, 7> = array<u32, 7>(3u, 2u, 4u, 1u, 5u, 0u, 6u);
const NO_MOVE: u32 = 4294967295u;
const NEG_INF: i32 = -1000000i;

struct Pos2 { lo: u32, hi: u32 }

struct Position {
  currentLo: u32,
  currentHi: u32,
  maskLo: u32,
  maskHi: u32,
  moves: u32,
}

struct Frame {
  pos: Position,
  depth: i32,
  phase: u32,
  possibleLo: u32,
  possibleHi: u32,
  best: i32,
  moveIdx: u32,
  lastCol: u32,
  value: i32,
}

struct LeafIn {
  currentLo: u32,
  currentHi: u32,
  maskLo: u32,
  maskHi: u32,
  moves: u32,
}

struct Params { budget: u32, leafCount: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read> inLeaves: array<LeafIn>;
@group(0) @binding(1) var<storage, read_write> outValues: array<i32>;
@group(0) @binding(2) var<uniform> params: Params;

fn popcount32(v: u32) -> u32 {
  var x = v;
  x = x - ((x >> 1u) & 0x55555555u);
  x = (x & 0x33333333u) + ((x >> 2u) & 0x33333333u);
  x = (x + (x >> 4u)) & 0x0f0f0f0fu;
  return (x * 0x01010101u) >> 24u;
}

fn columnMask(col: u32) -> Pos2 {
  var lo: u32 = 0u;
  var hi: u32 = 0u;
  let b0 = col * 7u;
  for (var r: u32 = 0u; r < 6u; r++) {
    let b = b0 + r;
    if (b < 32u) { lo = lo | (1u << b); }
    else { hi = hi | (1u << (b - 32u)); }
  }
  return Pos2(lo, hi);
}

fn cellPos(col: u32, maskLo: u32, maskHi: u32) -> u32 {
  let cm = columnMask(col);
  let h = popcount32(maskLo & cm.lo) + popcount32(maskHi & cm.hi);
  return col * 7u + h;
}

fn canPlay(col: u32, maskLo: u32, maskHi: u32) -> bool {
  let cm = columnMask(col);
  let h = popcount32(maskLo & cm.lo) + popcount32(maskHi & cm.hi);
  return h < 6u;
}

fn isInMask(col: u32, lo: u32, hi: u32, maskLo: u32, maskHi: u32) -> bool {
  let pos = cellPos(col, maskLo, maskHi);
  if (pos < 32u) { return ((lo >> pos) & 1u) != 0u; }
  return ((hi >> (pos - 32u)) & 1u) != 0u;
}

fn play(pos: Position, col: u32) -> Position {
  let cell = cellPos(col, pos.maskLo, pos.maskHi);
  var maskLo = pos.maskLo;
  var maskHi = pos.maskHi;
  if (cell < 32u) { maskLo = maskLo | (1u << cell); }
  else { maskHi = maskHi | (1u << (cell - 32u)); }
  return Position(pos.currentLo ^ pos.maskLo, pos.currentHi ^ pos.maskHi, maskLo, maskHi, pos.moves + 1u);
}

fn unplay(pos: Position, col: u32) -> Position {
  let cm = columnMask(col);
  let h = popcount32(pos.maskLo & cm.lo) + popcount32(pos.maskHi & cm.hi);
  let cell = col * 7u + (h - 1u);
  var maskLo = pos.maskLo;
  var maskHi = pos.maskHi;
  if (cell < 32u) { maskLo = maskLo ^ (1u << cell); }
  else { maskHi = maskHi ^ (1u << (cell - 32u)); }
  return Position(pos.currentLo ^ maskLo, pos.currentHi ^ maskHi, maskLo, maskHi, pos.moves - 1u);
}

fn isSingleBit(lo: u32, hi: u32) -> bool {
  if (lo != 0u) { return (lo & (lo - 1u)) == 0u && hi == 0u; }
  return hi != 0u && (hi & (hi - 1u)) == 0u;
}

fn winningPosition(plo: u32, phi: u32, mlo: u32, mhi: u32) -> Pos2 {
  let a1l = plo << 1u;
  let a1h = (plo >> 31u) | (phi << 1u);
  let a2l = plo << 2u;
  let a2h = (plo >> 30u) | (phi << 2u);
  let a3l = plo << 3u;
  let a3h = (plo >> 29u) | (phi << 3u);
  var rl = a1l & a2l & a3l;
  var rh = a1h & a2h & a3h;

  let s7l = plo << 7u;
  let s7h = (plo >> 25u) | (phi << 7u);
  let s14l = plo << 14u;
  let s14h = (plo >> 18u) | (phi << 14u);
  let s21l = plo << 21u;
  let s21h = plo >> 11u;
  let r7l = (plo >> 7u) | (phi << 25u);
  let r7h = phi >> 7u;
  let r14l = (plo >> 14u) | (phi << 18u);
  let r14h = phi >> 14u;
  let r21l = (plo >> 21u) | (phi << 11u);
  let r21h = phi >> 21u;
  var pLo = s7l & s14l;
  var pHi = s7h & s14h;
  rl = rl | (pLo & s21l);
  rh = rh | (pHi & s21h);
  rl = rl | (pLo & r7l);
  rh = rh | (pHi & r7h);
  pLo = r7l & r14l;
  pHi = r7h & r14h;
  rl = rl | (pLo & s7l);
  rh = rh | (pHi & s7h);
  rl = rl | (pLo & r21l);
  rh = rh | (pHi & r21h);

  let s6l = plo << 6u;
  let s6h = (plo >> 26u) | (phi << 6u);
  let s12l = plo << 12u;
  let s12h = (plo >> 20u) | (phi << 12u);
  let s18l = plo << 18u;
  let s18h = plo >> 14u;
  let r6l = (plo >> 6u) | (phi << 26u);
  let r6h = phi >> 6u;
  let r12l = (plo >> 12u) | (phi << 20u);
  let r12h = phi >> 12u;
  let r18l = (plo >> 18u) | (phi << 14u);
  let r18h = phi >> 18u;
  pLo = s6l & s12l;
  pHi = s6h & s12h;
  rl = rl | (pLo & s18l);
  rh = rh | (pHi & s18h);
  rl = rl | (pLo & r6l);
  rh = rh | (pHi & r6h);
  pLo = r6l & r12l;
  pHi = r6h & r12h;
  rl = rl | (pLo & s6l);
  rh = rh | (pHi & s6h);
  rl = rl | (pLo & r18l);
  rh = rh | (pHi & r18h);

  let s8l = plo << 8u;
  let s8h = (plo >> 24u) | (phi << 8u);
  let s16l = plo << 16u;
  let s16h = (plo >> 16u) | (phi << 16u);
  let s24l = plo << 24u;
  let s24h = plo >> 8u;
  let r8l = (plo >> 8u) | (phi << 24u);
  let r8h = phi >> 8u;
  let r16l = (plo >> 16u) | (phi << 16u);
  let r16h = phi >> 16u;
  let r24l = (plo >> 24u) | (phi << 8u);
  let r24h = phi >> 24u;
  pLo = s8l & s16l;
  pHi = s8h & s16h;
  rl = rl | (pLo & s24l);
  rh = rh | (pHi & s24h);
  rl = rl | (pLo & r8l);
  rh = rh | (pHi & r8h);
  pLo = r8l & r16l;
  pHi = r8h & r16h;
  rl = rl | (pLo & s8l);
  rh = rh | (pHi & s8h);
  rl = rl | (pLo & r24l);
  rh = rh | (pHi & r24h);

  let outLo = (rl & (~mlo)) & BOARD_MASK_LO;
  let outHi = (rh & (~mhi)) & BOARD_MASK_HI;
  return Pos2(outLo, outHi);
}

fn possible(pos: Position) -> Pos2 {
  let ql0 = pos.maskLo + BOTTOM_LO;
  let ql = ql0 & BOARD_MASK_LO;
  let carry = select(0u, 1u, ql0 < pos.maskLo);
  let qh = (pos.maskHi + BOTTOM_HI + carry) & HI_MASK & BOARD_MASK_HI;
  return Pos2(ql, qh);
}

fn possibleNonLosing(pos: Position) -> Pos2 {
  let ql0 = pos.maskLo + BOTTOM_LO;
  let ql = ql0 & BOARD_MASK_LO;
  let carry = select(0u, 1u, ql0 < pos.maskLo);
  let qh = (pos.maskHi + BOTTOM_HI + carry) & HI_MASK & BOARD_MASK_HI;
  let xl = pos.currentLo ^ pos.maskLo;
  let xh = pos.currentHi ^ pos.maskHi;
  let oppWin = winningPosition(xl, xh, pos.maskLo, pos.maskHi);
  var fl = ql & oppWin.lo;
  var fh = qh & oppWin.hi;
  if ((fl | fh) != 0u) {
    if (!isSingleBit(fl, fh)) { return Pos2(0u, 0u); }
  } else {
    fl = ql;
    fh = qh;
  }
  let sl = (oppWin.lo >> 1u) | (oppWin.hi << 31u);
  let sh = oppWin.hi >> 1u;
  return Pos2(fl & (~sl), fh & (~sh));
}

fn canWinNext(pos: Position) -> bool {
  let p = possible(pos);
  let w = winningPosition(pos.currentLo, pos.currentHi, pos.maskLo, pos.maskHi);
  return (w.lo & p.lo) != 0u || (w.hi & p.hi) != 0u;
}

fn isWinningMove(col: u32, pos: Position) -> bool {
  let p = possible(pos);
  let w = winningPosition(pos.currentLo, pos.currentHi, pos.maskLo, pos.maskHi);
  let cm = columnMask(col);
  return (w.lo & p.lo & cm.lo) != 0u || (w.hi & p.hi & cm.hi) != 0u;
}

fn heuristic(pos: Position) -> i32 {
  if (canWinNext(pos)) { return WIN_SCORE; }
  let pnl = possibleNonLosing(pos);
  if ((pnl.lo | pnl.hi) == 0u) { return -WIN_SCORE; }
  let opp = Pos2(pos.currentLo ^ pos.maskLo, pos.currentHi ^ pos.maskHi);
  let oppWin = winningPosition(opp.lo, opp.hi, pos.maskLo, pos.maskHi);
  let p = possible(pos);
  var threats: i32 = 0i;
  var oppThreats: i32 = 0i;
  for (var col: u32 = 0u; col < 7u; col++) {
    if (!canPlay(col, pos.maskLo, pos.maskHi)) { continue; }
    let cm = columnMask(col);
    if ((oppWin.lo & p.lo & cm.lo) != 0u || (oppWin.hi & p.hi & cm.hi) != 0u) { oppThreats = oppThreats + 1i; }
    if (isWinningMove(col, pos)) { threats = threats + 1i; }
  }
  return threats - oppThreats;
}

fn leafSearchIter(pos: Position, budget: u32) -> i32 {
  if (canWinNext(pos)) { return WIN_SCORE; }

  var stack: array<Frame, ${maxDepth + 1}>;
  var sp: u32 = 1u;
  stack[0] = Frame(pos, i32(budget), 0u, 0u, 0u, NEG_INF, 0u, NO_MOVE, 0i);

  while (sp > 0u) {
    var f = stack[sp - 1u];
    if (f.phase == 0u) {
      let pnl = possibleNonLosing(f.pos);
      if ((pnl.lo | pnl.hi) == 0u) {
        f.value = -i32((CELLS - f.pos.moves) / 2u);
        f.phase = 2u;
      } else if (f.pos.moves >= DRAW_MOVES) {
        f.value = 0i;
        f.phase = 2u;
      } else if (f.depth <= 0i) {
        f.value = heuristic(f.pos);
        f.phase = 2u;
      } else {
        f.possibleLo = pnl.lo;
        f.possibleHi = pnl.hi;
        f.best = NEG_INF;
        f.moveIdx = 0u;
        f.lastCol = NO_MOVE;
        f.phase = 1u;
      }
      stack[sp - 1u] = f;
    } else if (f.phase == 1u) {
      if (f.lastCol != NO_MOVE) {
        f.pos = unplay(f.pos, f.lastCol);
        f.lastCol = NO_MOVE;
      }
      var found = false;
      var col: u32 = 0u;
      while (!found && f.moveIdx < 7u) {
        col = COLUMN_ORDER[f.moveIdx];
        f.moveIdx = f.moveIdx + 1u;
        if (canPlay(col, f.pos.maskLo, f.pos.maskHi) && isInMask(col, f.possibleLo, f.possibleHi, f.pos.maskLo, f.pos.maskHi)) {
          found = true;
        }
      }
      if (!found) {
        f.value = select(heuristic(f.pos), f.best, f.best != NEG_INF);
        f.phase = 2u;
      } else {
        f.lastCol = col;
        f.pos = play(f.pos, col);
        stack[sp - 1u] = f;
        stack[sp] = Frame(f.pos, f.depth - 1i, 0u, 0u, 0u, NEG_INF, 0u, NO_MOVE, 0i);
        sp = sp + 1u;
      }
    } else {
      if (sp == 1u) { return f.value; }
      let childVal = f.value;
      sp = sp - 1u;
      var parent = stack[sp - 1u];
      let v = -childVal;
      if (v > parent.best) { parent.best = v; }
      parent.phase = 1u;
      stack[sp - 1u] = parent;
    }
  }
  return 0i;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.leafCount) { return; }
  let leaf = inLeaves[idx];
  let pos = Position(leaf.currentLo, leaf.currentHi, leaf.maskLo, leaf.maskHi, leaf.moves);
  outValues[idx] = leafSearchIter(pos, params.budget);
}
`;
  return wgsl;
};

/** Recherche tous les @PLACEHOLDER@ restants (le template doit être complet). */
const assertWgslComplete = (wgsl: string): void => {
  if (/@[A-Z_]+@/.test(wgsl)) throw new Error('Template WGSL incomplet : placeholder restant.');
};

/** Normalise les options avec un leafDepth borné par la taille de pile du kernel. */
const normalizeOptions = (options?: GpuAnalyzeOptions): Required<GpuAnalyzeOptions> => ({
  frontierDepth: options?.frontierDepth ?? DEFAULT_FRONTIER_DEPTH,
  leafDepth: Math.min(options?.leafDepth ?? DEFAULT_LEAF_DEPTH, MAX_LEAF_DEPTH),
  maxLeaves: options?.maxLeaves ?? DEFAULT_MAX_LEAVES,
});

/** Construit le solveur GPU, ou null si WebGPU est indisponible. */
export const createGpuSolver = async (): Promise<GpuSolver | null> => {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const wgsl = buildWgsl();
  assertWgslComplete(wgsl);
  const module = device.createShaderModule({ code: wgsl });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: { module, entryPoint: 'main' },
  });

  let inBuffer: GPUBuffer | null = null;
  let outBuffer: GPUBuffer | null = null;
  let readback: GPUBuffer | null = null;
  let paramsBuffer: GPUBuffer | null = null;
  let bindGroup: GPUBindGroup | null = null;
  let capacity = 0;
  let destroyed = false;

  const ensureBuffers = (leafCount: number): void => {
    if (capacity >= leafCount && paramsBuffer) return;
    const inBytes = Math.max(leafCount, 1) * LEAF_STRIDE * 4;
    const outBytes = Math.max(leafCount, 1) * 4;
    inBuffer?.destroy();
    outBuffer?.destroy();
    readback?.destroy();
    inBuffer = device.createBuffer({ size: inBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    outBuffer = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readback = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    paramsBuffer ??= device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inBuffer } },
        { binding: 1, resource: { buffer: outBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });
    capacity = leafCount;
  };

  /** Évalue toutes les feuilles en un seul dispatch GPU. */
  const evaluateLeaves = async (jobs: LeafJob[], budget: number): Promise<Map<number, number>> => {
    const result = new Map<number, number>();
    if (jobs.length === 0) return result;
    if (destroyed) throw new Error('GpuSolver détruit.');
    ensureBuffers(jobs.length);
    const data = new Uint32Array(jobs.length * LEAF_STRIDE);
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const s = j.pos.snapshot();
      data[i * LEAF_STRIDE] = s.currentLo >>> 0;
      data[i * LEAF_STRIDE + 1] = s.currentHi >>> 0;
      data[i * LEAF_STRIDE + 2] = s.maskLo >>> 0;
      data[i * LEAF_STRIDE + 3] = s.maskHi >>> 0;
      data[i * LEAF_STRIDE + 4] = s.moves;
    }
    const paramsData = new Uint32Array([budget >>> 0, jobs.length >>> 0, 0, 0]);
    device.queue.writeBuffer(inBuffer!, 0, data);
    device.queue.writeBuffer(paramsBuffer!, 0, paramsData);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup!);
    pass.dispatchWorkgroups(Math.ceil(jobs.length / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer!, 0, readback!, 0, jobs.length * 4);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readback!.mapAsync(GPUMapMode.READ);
    const out = new Int32Array(readback!.getMappedRange());
    for (let i = 0; i < jobs.length; i++) result.set(jobs[i].nodeIndex, out[i]);
    readback!.unmap();
    return result;
  };

  return {
    isSupported: () => !destroyed,
    analyze: async (seq, options) => {
      const opts = normalizeOptions(options);
      const root = new ConnectFourPosition();
      for (const col of seq) root.play(col);
      const remaining = CELLS - root.nbMoves();
      const nodes = expandFrontier(root, opts);
      const jobs: LeafJob[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.terminal || node.depth < opts.frontierDepth) continue;
        jobs.push({ nodeIndex: i, pos: node.pos, budget: Math.min(opts.leafDepth, remaining - node.depth) });
      }
      const leafValues = await evaluateLeaves(jobs, Math.min(opts.leafDepth, remaining - opts.frontierDepth));
      return buildAnalysis(root, nodes, leafValues, remaining, opts);
    },
    bench: async (leaves = 100_000, budget = 4) => {
      const b = Math.max(1, Math.min(budget, MAX_LEAF_DEPTH));
      const jobs: LeafJob[] = [];
      const base = new ConnectFourPosition();
      for (const c of [3, 2, 4, 1, 5]) base.play(c);
      for (let i = 0; i < leaves; i++) {
        const pos = new ConnectFourPosition();
        for (const c of [3, 2, 4, 1, 5]) pos.play(c);
        jobs.push({ nodeIndex: i, pos, budget: b });
      }
      const t0 = performance.now();
      await evaluateLeaves(jobs, b);
      const ms = performance.now() - t0;
      const leavesPerSec = leaves / (ms / 1000);
      return {
        leaves,
        ms,
        leavesPerSec,
        usPerLeaf: (ms * 1000) / leaves,
        estNps: leavesPerSec * Math.pow(WIDTH, b),
      };
    },
    destroy: () => {
      destroyed = true;
      inBuffer?.destroy();
      outBuffer?.destroy();
      readback?.destroy();
      paramsBuffer?.destroy();
      device.destroy();
    },
  };
};

export { buildAnalysis, expandFrontier, MAX_LEAF_DEPTH as KERNEL_MAX_DEPTH };