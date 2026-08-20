import { ConnectFourPosition } from '../position';
import { COLUMN_ORDER } from '../solver';
import { computeWinningPosition, HEIGHT, WIDTH, xor } from '../bitboard';

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
  const s = p.snapshot();
  const c = new ConnectFourPosition();
  c.restore(s);
  return c;
};

/** Clé canonique d'une position sous symétrie miroir (col c ↔ 6-c). */
export const canonicalKey = (pos: ConnectFourPosition): number => {
  const k = pos.key();
  const r = reflectKey(pos);
  return k < r ? k : r;
};

/** Clé de la position miroir : current et mask réfléchis, même convention 49 bits. */
const reflectKey = (pos: ConnectFourPosition): number => {
  const mirror = (srcLo: number, srcHi: number): { lo: number; hi: number } => {
    let lo = 0;
    let hi = 0;
    for (let c = 0; c < WIDTH; c++) {
      const rc = WIDTH - 1 - c;
      const cell = c * (HEIGHT + 1);
      const rcell = rc * (HEIGHT + 1);
      for (let r = 0; r < HEIGHT; r++) {
        const src = cell + r;
        const dst = rcell + r;
        const bit = src < 32 ? (srcLo >>> src) & 1 : (srcHi >>> (src - 32)) & 1;
        if (bit === 0) continue;
        if (dst < 32) lo |= 1 << dst;
        else hi |= 1 << (dst - 32);
      }
    }
    return { lo: lo >>> 0, hi };
  };
  const m = mirror(pos.maskLo, pos.maskHi);
  const c = mirror(pos.currentLo, pos.currentHi);
  const kLo = (c.lo + m.lo) >>> 0;
  const kHi = (c.hi + m.hi + (c.lo + m.lo > 0xffffffff ? 1 : 0)) & 0x1ffff;
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

/** Heuristique de feuille (utilisée seulement si le budget s'épuise avant le terminal). */
export const heuristic = (pos: ConnectFourPosition): number => {
  if (pos.canWinNext()) return WIN_SCORE;
  pos.possibleNonLosingMovesInto();
  if (pos.lo === 0 && pos.hi === 0) return -WIN_SCORE;
  const opp = xor(pos.currentLo, pos.currentHi, pos.maskLo, pos.maskHi);
  const oppWin = computeWinningPosition(opp.lo, opp.hi, pos.maskLo, pos.maskHi);
  const p = pos.possible();
  let threats = 0;
  let oppThreats = 0;
  for (let col = 0; col < WIDTH; col++) {
    if (!pos.canPlay(col)) continue;
    const inOppWin = (oppWin.lo & p.lo & colMaskLo(col)) !== 0 || (oppWin.hi & p.hi & colMaskHi(col)) !== 0;
    if (inOppWin) oppThreats++;
    if (pos.isWinningMove(col)) threats++;
  }
  return threats - oppThreats;
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

const negamaxLike = (pos: ConnectFourPosition, depth: number): number => {
  pos.possibleNonLosingMovesInto();
  const possibleLo = pos.lo;
  const possibleHi = pos.hi;
  if (possibleLo === 0 && possibleHi === 0) return -Math.floor((CELLS - pos.nbMoves()) / 2);
  if (pos.nbMoves() >= DRAW_MOVES) return 0;
  if (depth <= 0) return heuristic(pos);
  let best = -Infinity;
  for (const col of COLUMN_ORDER) {
    if (!pos.canPlay(col)) continue;
    if (!pos.isInMask(col, possibleLo, possibleHi)) continue;
    pos.play(col);
    const v = -negamaxLike(pos, depth - 1);
    pos.unplay(col);
    if (v > best) best = v;
  }
  return best === -Infinity ? heuristic(pos) : best;
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

/** Analyse complète : séquence de coups → scores par colonne. */
export const analyzeRoot = (
  seq: number[],
  options: AnalyzeOptions = {},
): GpuAnalysis => {
  const opts: Required<AnalyzeOptions> = {
    frontierDepth: options.frontierDepth ?? 6,
    leafDepth: options.leafDepth ?? 4,
    maxLeaves: options.maxLeaves ?? 100_000,
  };
  const root = new ConnectFourPosition();
  for (const col of seq) root.play(col);
  const remaining = CELLS - root.nbMoves();

  const t0 = performance.now();
  const nodes = expandFrontier(root, opts);
  const exact = remaining <= opts.frontierDepth + opts.leafDepth;

  const leafValues = new Map<number, number>();
  let leafCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.terminal) continue;
    if (node.depth >= opts.frontierDepth) {
      const budget = Math.min(opts.leafDepth, remaining - node.depth);
      leafValues.set(i, evaluateLeaf(node.pos, budget));
      leafCount++;
    }
  }

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
      scores[col] = -evaluateLeaf(root, remaining - 1);
    }
    root.unplay(col);
  }

  const ms = performance.now() - t0;
  const nodesEvaluated = leafCount * Math.pow(WIDTH, opts.leafDepth);

  return {
    scores,
    exact,
    nodes: nodesEvaluated,
    effectiveDepth: opts.frontierDepth + opts.leafDepth,
    leaves: leafCount,
  };
};

/** Constantes par défaut exportées pour la config du kernel WGSL. */
export const DEFAULT_FRONTIER_DEPTH = 6;
export const DEFAULT_LEAF_DEPTH = 4;
export const DEFAULT_MAX_LEAVES = 100_000;