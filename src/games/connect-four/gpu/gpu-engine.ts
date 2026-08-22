import { ConnectFourPosition } from '../position';
import { COLUMN_ORDER } from '../solver';
import { computeWinningPosition, HEIGHT, WIDTH } from '../bitboard';

/**
 * Moteur GPU d'analyse approchée : expansion de frontière (BFS dédupliqué par
 * symétrie, DAG à arêtes multiples) puis évaluation des feuilles par minimax
 * borné en profondeur.
 *
 * Cette implémentation TypeScript est la RÉFÉRENCE du kernel WGSL (gpu-solver.ts) :
 * mêmes bitboards (lo/hi), même recherche par `possibleNonLosingMoves` que le
 * solveur exact, pour que le port WebGPU soit une traduction 1:1 testable.
 *
 * Exactitude : si toute la partie tient dans le budget (frontierDepth + leafDepth),
 * le résultat est EXACT et les colonnes sont classées -1/0/+1 comme le solveur.
 * Sinon, résultat approximatif mais tactiquement profond (bon coup conseillé).
 */

export const CELLS = WIDTH * HEIGHT; // 42
export const DRAW_MOVES = CELLS - 2; // 40
/** Score d'une victoire (domine toute heuristique, départage la vitesse de gain). */
export const WIN_SCORE = 1000;

export interface AnalyzeOptions {
  /** Profondeur d'expansion BFS de la frontière depuis la racine. */
  frontierDepth?: number;
  /** Budget de plies par feuille (recherche exacte si la partie y tient). */
  leafDepth?: number;
  /** Nombre max de nœuds de frontière (garde-fou mémoire). */
  maxLeaves?: number;
}

export interface GpuAnalysis {
  /** Score par colonne jouable (indices 0-6, null si colonne pleine). */
  scores: (number | null)[];
  /** true si tous les coups sont résolus exactement (-1/0/+1). */
  exact: boolean;
  /** Nombre de nœuds évalués (feuilles × sous-arbres). */
  nodes: number;
  /** Profondeur totale effective atteinte (frontierDepth + plies exacts par feuille). */
  effectiveDepth: number;
  /** Nombre de nœuds de frontière évalués sur le GPU. */
  leaves: number;
}

interface Edge {
  parent: number;
  move: number;
}

interface FrontierNode {
  /** Copie indépendante de la position du nœud. */
  pos: ConnectFourPosition;
  /** Arêtes (parent, coup joué) menant à ce nœud. */
  edges: Edge[];
  /** Profondeur depuis la racine (plis joués). */
  depth: number;
  /** true si le nœud est terminal exact (victoire/nulle/perte immédiate). */
  terminal: boolean;
  /** Clé canonique (symétrie miroir) de la position. */
  key: number;
}

/** Copie indépendante d'une position. */
const clonePos = (p: ConnectFourPosition): ConnectFourPosition => {
  const c = new ConnectFourPosition();
  c.copyFrom(p);
  return c;
};

/** Clé canonique d'une position sous symétrie miroir (col c ↔ 6-c). */
export const canonicalKey = (pos: ConnectFourPosition): number => {
  const k = pos.key();
  const r = reflectKey(pos);
  return k < r ? k : r;
};

/** Miroir horizontal du bitboard (colonnes 0..6 → 6..0) par blocs de 6 bits. */
const mirrorBits = (lo: number, hi: number): { lo: number; hi: number } => {
  const v2 = (lo >>> 14) & 0x3f;
  const v4 = ((lo >>> 28) & 0xf) | ((hi & 0x3) << 4);
  const rlo =
    ((hi >>> 10) & 0x3f) |
    (((hi >>> 3) & 0x3f) << 7) |
    (v4 << 14) |
    (((lo >>> 21) & 0x3f) << 21) |
    ((v2 & 0xf) << 28);
  const rhi = ((v2 >> 4) & 0x3) | (((lo >>> 7) & 0x3f) << 3) | ((lo & 0x3f) << 10);
  return { lo: rlo >>> 0, hi: rhi };
};

/** Clé de la position miroir : current et mask réfléchis, même convention 49 bits. */
const reflectKey = (pos: ConnectFourPosition): number => {
  const m = mirrorBits(pos.maskLo, pos.maskHi);
  const c = mirrorBits(pos.currentLo, pos.currentHi);
  const sumLo = c.lo + m.lo;
  const kLo = sumLo >>> 0;
  const kHi = (c.hi + m.hi + (sumLo > 0xffffffff ? 1 : 0)) & 0x1ffff;
  return kHi * 4294967296 + kLo;
};

/** Expansion BFS de la frontière (DAG, dédup par symétrie). */
export const expandFrontier = (
  root: ConnectFourPosition,
  options: Required<AnalyzeOptions>,
): FrontierNode[] => {
  const nodes: FrontierNode[] = [
    { pos: clonePos(root), edges: [], depth: 0, terminal: false, key: canonicalKey(root) },
  ];
  const seen = new Map<number, number>(); // clé canonique → indice du nœud
  seen.set(canonicalKey(root), 0);
  let head = 0;
  while (head < nodes.length) {
    const node = nodes[head];
    const expandable =
      node.depth < options.frontierDepth &&
      !node.terminal &&
      node.pos.nbMoves() < DRAW_MOVES;
    if (!expandable) {
      head++;
      continue;
    }
    node.pos.possibleNonLosingMovesInto();
    const forcedLoss = node.pos.lo === 0 && node.pos.hi === 0;
    const winsNext = node.pos.canWinNext();
    if (forcedLoss || winsNext) {
      node.terminal = true;
      head++;
      continue;
    }
    for (const col of COLUMN_ORDER) {
      if (nodes.length >= options.maxLeaves) break;
      if (!node.pos.canPlay(col)) continue;
      if (!node.pos.isInMask(col, node.pos.lo, node.pos.hi)) continue;
      node.pos.play(col);
      const key = canonicalKey(node.pos);
      const existing = seen.get(key);
      if (existing === undefined) {
        const idx = nodes.length;
        seen.set(key, idx);
        nodes.push({ pos: clonePos(node.pos), edges: [{ parent: head, move: col }], depth: node.depth + 1, terminal: false, key });
      } else {
        nodes[existing].edges.push({ parent: head, move: col });
      }
      node.pos.unplay(col);
    }
    head++;
  }
  return nodes;
};

/**
 * Évaluation d'une feuille par minimax borné en profondeur (référence CPU du
 * kernel WGSL). `depth` = budget de plis restant ; exact si la partie y tient.
 */
export const evaluateLeaf = (pos: ConnectFourPosition, depth: number): number => {
  return leafSearch(pos, depth);
};

const colMaskLo = (col: number): number => {
  let lo = 0;
  const cell = col * (HEIGHT + 1);
  for (let r = 0; r < HEIGHT; r++) {
    const b = cell + r;
    if (b < 32) lo |= 1 << b;
  }
  return lo >>> 0;
};

const colMaskHi = (col: number): number => {
  let hi = 0;
  const cell = col * (HEIGHT + 1);
  for (let r = 0; r < HEIGHT; r++) {
    const b = cell + r;
    if (b >= 32) hi |= 1 << (b - 32);
  }
  return hi;
};

/** Masques par colonne précalculés (chemin chaud). */
const COL_MASK_LO: readonly number[] = Array.from({ length: WIDTH }, (_, c) => colMaskLo(c));
const COL_MASK_HI: readonly number[] = Array.from({ length: WIDTH }, (_, c) => colMaskHi(c));

/**
 * Heuristique de feuille (utilisée seulement si le budget s'épuise avant le
 * terminal). Mêmes valeurs que la version naïve, mais possible/winning/oppWin
 * ne sont calculés qu'une fois.
 */
export const heuristic = (pos: ConnectFourPosition): number => {
  const p = pos.possible();
  const w = computeWinningPosition(pos.currentLo, pos.currentHi, pos.maskLo, pos.maskHi);
  if ((w.lo & p.lo) !== 0 || (w.hi & p.hi) !== 0) return WIN_SCORE;
  pos.possibleNonLosingMovesInto();
  if (pos.lo === 0 && pos.hi === 0) return -WIN_SCORE;
  const ol = (pos.currentLo ^ pos.maskLo) >>> 0;
  const oh = pos.currentHi ^ pos.maskHi;
  const ow = computeWinningPosition(ol, oh, pos.maskLo, pos.maskHi);
  let threats = 0;
  let oppThreats = 0;
  for (let col = 0; col < WIDTH; col++) {
    if (!pos.canPlay(col)) continue;
    const mLo = COL_MASK_LO[col];
    const mHi = COL_MASK_HI[col];
    if (((ow.lo & p.lo & mLo) !== 0) || ((ow.hi & p.hi & mHi) !== 0)) oppThreats++;
    if (((w.lo & p.lo & mLo) !== 0) || ((w.hi & p.hi & mHi) !== 0)) threats++;
  }
  return threats - oppThreats;
};

/**
 * Table de transposition partagée entre toutes les feuilles d'une analyse
 * (les sous-arbres se recouvrent fortement). Entrée packée :
 * depth(6b) << 13 | flag(2b) << 11 | (valeur + 1024) sur 11 bits.
 * Valeurs identiques au minimax pur : la parité avec le kernel est conservée.
 */
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
let leafTt = new Map<number, number>();

/** Réinitialise la table de transposition des feuilles. */
export const clearLeafTt = (): void => {
  leafTt.clear();
};

const negamaxLike = (pos: ConnectFourPosition, depth: number, alpha = -Infinity, beta = Infinity): number => {
  pos.possibleNonLosingMovesInto();
  const possibleLo = pos.lo;
  const possibleHi = pos.hi;
  if (possibleLo === 0 && possibleHi === 0) return -Math.floor((CELLS - pos.nbMoves()) / 2);
  if (pos.nbMoves() >= DRAW_MOVES) return 0;
  if (depth <= 0) return heuristic(pos);
  const key = canonicalKey(pos);
  let a = alpha;
  let b = beta;
  const entry = leafTt.get(key);
  if (entry !== undefined && (entry >>> 13) >= depth) {
    const tv = (entry & 2047) - 1024;
    const flag = (entry >>> 11) & 3;
    if (flag === TT_EXACT) return tv;
    if (flag === TT_LOWER) {
      if (tv > a) a = tv;
    } else if (tv < b) b = tv;
    if (a >= b) return tv;
  }
  let best = -Infinity;
  for (const col of COLUMN_ORDER) {
    if (!pos.canPlay(col)) continue;
    if (!pos.isInMask(col, possibleLo, possibleHi)) continue;
    pos.play(col);
    let v: number;
    if (best === -Infinity) {
      v = -negamaxLike(pos, depth - 1, -b, -a);
    } else {
      v = -negamaxLike(pos, depth - 1, -a - 1, -a);
      if (v > a && v < b) v = -negamaxLike(pos, depth - 1, -b, -v);
    }
    pos.unplay(col);
    if (v > best) best = v;
    if (v > a) a = v;
    if (a >= b) break;
  }
  if (best === -Infinity) return heuristic(pos);
  const flag = best <= alpha ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
  if (leafTt.size < 4_000_000) {
    leafTt.set(key, ((depth & 63) << 13) | (flag << 11) | (best + 1024));
  }
  return best;
};

const leafSearch = (pos: ConnectFourPosition, depth: number): number => {
  if (pos.canWinNext()) return WIN_SCORE;
  return negamaxLike(pos, depth);
};

/**
 * Réduction negamax des valeurs des feuilles vers la racine
 * (DAG : un nœud peut avoir plusieurs parents, sa valeur leur sert à tous).
 * Renvoie les valeurs résolues par nœud.
 */
export const reduceTree = (
  nodes: FrontierNode[],
  leafValues: Map<number, number>,
): { values: number[]; resolved: boolean[] } => {
  const values = new Array<number>(nodes.length).fill(0);
  const resolved = new Array<boolean>(nodes.length).fill(false);
  for (const [i, v] of leafValues) {
    values[i] = v;
    resolved[i] = true;
  }
  // nœuds terminaux (arrêtés en BFS) : valeur exacte
  for (let i = 0; i < nodes.length; i++) {
    if (resolved[i] || !nodes[i].terminal) continue;
    const pos = nodes[i].pos;
    if (pos.nbMoves() >= DRAW_MOVES) {
      values[i] = 0;
      resolved[i] = true;
    } else if (pos.canWinNext()) {
      values[i] = WIN_SCORE;
      resolved[i] = true;
    } else {
      values[i] = -Math.floor((CELLS - pos.nbMoves()) / 2);
      resolved[i] = true;
    }
  }
  const childCount = new Array<number>(nodes.length).fill(0);
  const childDone = new Array<number>(nodes.length).fill(0);
  const childBest = new Array<number>(nodes.length).fill(-Infinity);

  for (let i = 0; i < nodes.length; i++) {
    for (const e of nodes[i].edges) {
      if (i > e.parent) childCount[e.parent] += 1;
    }
  }
  // remontée : chaque nœud résolu propage -valeur à ses parents (negamax)
  for (let i = nodes.length - 1; i >= 1; i--) {
    if (!resolved[i]) continue;
    const v = -values[i];
    for (const e of nodes[i].edges) {
      const parent = e.parent;
      childDone[parent]++;
      if (v > childBest[parent]) childBest[parent] = v;
      if (childDone[parent] === childCount[parent] && !resolved[parent]) {
        resolved[parent] = true;
        values[parent] = childBest[parent];
      }
    }
  }
  return { values, resolved };
};

/** Une feuille à évaluer (nœud de frontière non terminal, en profondeur max). */
export interface LeafJob {
  nodeIndex: number;
  pos: ConnectFourPosition;
  budget: number;
}

/** Évaluation des feuilles par le moteur CPU (référence). */
export const evaluateLeavesCpu = (jobs: LeafJob[]): Map<number, number> => {
  const map = new Map<number, number>();
  for (const j of jobs) map.set(j.nodeIndex, evaluateLeaf(j.pos, j.budget));
  return map;
};

/**
 * Pipeline commun (frontière déjà construite) : réduction DAG des valeurs des
 * feuilles puis scores par colonne, dans la convention du solveur exact.
 */
export const buildAnalysis = (
  root: ConnectFourPosition,
  nodes: FrontierNode[],
  leafValues: Map<number, number>,
  remaining: number,
  opts: Required<AnalyzeOptions>,
): GpuAnalysis => {
  const exact = remaining <= opts.frontierDepth + opts.leafDepth;
  const { values, resolved } = reduceTree(nodes, leafValues);

  const scores: (number | null)[] = new Array(WIDTH).fill(null);
  for (let col = 0; col < WIDTH; col++) {
    if (!root.canPlay(col)) continue;
    if (root.isWinningMove(col)) {
      scores[col] = WIN_SCORE;
      continue;
    }
    root.play(col);
    const key = canonicalKey(root);
    const childIdx = nodes.findIndex((n) => n.key === key);
    if (childIdx > 0 && resolved[childIdx]) {
      scores[col] = -values[childIdx];
    } else {
      scores[col] = -evaluateLeaf(root, Math.min(opts.leafDepth, remaining - 1));
    }
    root.unplay(col);
  }

  return {
    scores,
    exact,
    nodes: leafValues.size * Math.pow(WIDTH, opts.leafDepth),
    effectiveDepth: opts.frontierDepth + opts.leafDepth,
    leaves: leafValues.size,
  };
};

const resolveOptions = (options: AnalyzeOptions): Required<AnalyzeOptions> => ({
  frontierDepth: options.frontierDepth ?? 6,
  leafDepth: options.leafDepth ?? 4,
  maxLeaves: options.maxLeaves ?? 100_000,
});

const collectJobs = (
  root: ConnectFourPosition,
  nodes: FrontierNode[],
  opts: Required<AnalyzeOptions>,
): { jobs: LeafJob[]; remaining: number } => {
  const remaining = CELLS - root.nbMoves();
  const jobs: LeafJob[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.terminal || node.depth < opts.frontierDepth) continue;
    jobs.push({ nodeIndex: i, pos: node.pos, budget: Math.min(opts.leafDepth, remaining - node.depth) });
  }
  return { jobs, remaining };
};

/** Analyse complète (CPU, référence JS) : séquence de coups → scores par colonne. */
export const analyzeRoot = (
  seq: number[],
  options: AnalyzeOptions = {},
): GpuAnalysis => {
  const opts = resolveOptions(options);
  const root = new ConnectFourPosition();
  for (const col of seq) root.play(col);
  clearLeafTt();

  const nodes = expandFrontier(root, opts);
  const { jobs, remaining } = collectJobs(root, nodes, opts);
  const leafValues = evaluateLeavesCpu(jobs);
  return buildAnalysis(root, nodes, leafValues, remaining, opts);
};

// ---------- variante rapide : feuilles évaluées en WASM ----------

import { loadWasmSolver, type WasmSolver } from '../wasm-solver';

let leafWasm: WasmSolver | null = null;
let leafWasmPromise: Promise<WasmSolver | null> | null = null;

/** Instance WASM dédiée à l'évaluation de feuilles (TT inutilisée → logSize réduit). */
export const getLeafWasm = (): Promise<WasmSolver | null> => {
  if (!leafWasmPromise) {
    leafWasmPromise = loadWasmSolver(14)
      .then((s) => {
        leafWasm = s;
        return s;
      })
      .catch(() => null);
  }
  return leafWasmPromise;
};

/**
 * Analyse complète avec feuilles évaluées en parallèle via `evalBatch`
 * (pool de workers). Repli local si le dispatch échoue.
 */
export const analyzeRootParallel = async (
  seq: number[],
  evalBatch: (jobs: LeafJob[]) => Promise<Map<number, number>>,
  options: AnalyzeOptions = {},
): Promise<GpuAnalysis> => {
  const opts = resolveOptions(options);
  const root = new ConnectFourPosition();
  for (const col of seq) root.play(col);
  clearLeafTt();

  const nodes = expandFrontier(root, opts);
  const { jobs, remaining } = collectJobs(root, nodes, opts);
  let leafValues: Map<number, number>;
  try {
    leafValues = await evalBatch(jobs);
  } catch {
    leafValues = evaluateLeavesCpu(jobs);
  }
  return buildAnalysis(root, nodes, leafValues, remaining, opts);
};

/** Évalue les jobs sur l'instance WASM locale (mono-cœur). */
const evaluateLeavesWasmLocal = async (jobs: LeafJob[]): Promise<Map<number, number>> => {
  const wasm = await getLeafWasm();
  if (!wasm) return evaluateLeavesCpu(jobs);
  const map = new Map<number, number>();
  for (const j of jobs) {
    const p = j.pos;
    wasm.setLeafPosition(p.currentLo, p.currentHi, p.maskLo, p.maskHi, p.nbMoves());
    map.set(j.nodeIndex, wasm.leafEval(j.budget));
  }
  return map;
};

/**
 * Analyse complète avec feuilles évaluées en WASM (×3-5 vs JS), repli JS si
 * l'instance ne charge pas. Mêmes valeurs que analyzeRoot.
 */
export const analyzeRootFast = async (
  seq: number[],
  options: AnalyzeOptions = {},
): Promise<GpuAnalysis> => analyzeRootParallel(seq, evaluateLeavesWasmLocal, options);

/** Constantes par défaut exportées pour la config du kernel WGSL. */
export const DEFAULT_FRONTIER_DEPTH = 6;
export const DEFAULT_LEAF_DEPTH = 4;
export const DEFAULT_MAX_LEAVES = 100_000;