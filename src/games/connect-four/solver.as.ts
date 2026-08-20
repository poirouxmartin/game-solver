// Portage AssemblyScript du solveur Puissance 4 (algorithme Pascal Pons).
// Ne se compile PAS avec tsc (syntaxe AS) : `npx asc` produit solver-as.wasm.
// API raw : toutes les fonctions exportées prennent/renvoient des entiers.

const WIDTH: i32 = 7;
const HEIGHT: i32 = 6;
const CELLS: i32 = WIDTH * HEIGHT;
const DRAW_MOVES: i32 = CELLS - 2;
const MIN_SCORE: i32 = -(CELLS / 2) + 3;
const MAX_SCORE: i32 = ((CELLS + 1) / 2) - 3;
const LOWER_THRESHOLD: i32 = MAX_SCORE - MIN_SCORE + 1;
const LOWER_STORE: i32 = MAX_SCORE - 2 * MIN_SCORE + 2;
const UPPER_STORE: i32 = -MIN_SCORE + 1;
const STOP: i32 = 1000;
const INVALID_MOVE: i32 = -1000;
const LO_MASK: u32 = 0xffffffff;
const HI_MASK: u32 = 0x1ffff;

const COLUMN_ORDER: i32[] = [3, 2, 4, 1, 5, 0, 6];

// bitboard constants (remplies par create)
let bottomLo: u32 = 0;
let bottomHi: u32 = 0;
let boardMaskLo: u32 = 0;
let boardMaskHi: u32 = 0;
let colMaskLo: u32[] = [];
let colMaskHi: u32[] = [];

// position
let currentLo: u32 = 0;
let currentHi: u32 = 0;
let maskLo: u32 = 0;
let maskHi: u32 = 0;
let moves: i32 = 0;
let height = new StaticArray<u8>(WIDTH);

// registres de travail
let lo: u32 = 0;
let hi: u32 = 0;

// clé 49 bits éclatée
let keyLo: u32 = 0;
let keyHi: u32 = 0;

// solveur
let nodeCount: u64 = 0;
let nodeLimit: u64 = 0xffffffffffffffff;
let depth: i32 = 0;
let colsScratch = new Uint8Array((DRAW_MOVES + 2) * WIDTH);
let scosScratch = new Int8Array((DRAW_MOVES + 2) * WIDTH);
let scores = new Int32Array(WIDTH);

// table de transposition (taille première)
let ttKeys = new Uint32Array(1);
let ttValues = new Uint8Array(1);
let ttSize: u32 = 1;

// popcount par table 16 bits
let POPCOUNT16 = new Uint16Array(65536);

function nextPrime(n: u32): u32 {
  if (n <= 2) return 2;
  if (n % 2 == 0) n++;
  while (true) {
    let prime = true;
    for (let d: u32 = 3; d * d <= n; d += 2) {
      if (n % d == 0) {
        prime = false;
        break;
      }
    }
    if (prime) return n;
    n += 2;
  }
}

export function create(logSize: i32): i32 {
  ttSize = nextPrime(<u32>(1 << logSize));
  ttKeys = new Uint32Array(<i32>ttSize);
  ttValues = new Uint8Array(<i32>ttSize);
  for (let i: i32 = 1; i < 65536; i++) POPCOUNT16[i] = <u16>(POPCOUNT16[i >> 1] + (i & 1));
  colMaskLo = [0, 0, 0, 0, 0, 0, 0];
  colMaskHi = [0, 0, 0, 0, 0, 0, 0];
  bottomLo = 0;
  bottomHi = 0;
  for (let c: i32 = 0; c < WIDTH; c++) {
    const b: i32 = c * (HEIGHT + 1);
    if (b < 32) bottomLo |= <u32>(1 << b);
    else bottomHi |= <u32>(1 << (b - 32));
    let ml: u32 = 0;
    let mh: u32 = 0;
    for (let r: i32 = 0; r < HEIGHT; r++) {
      const bb: i32 = b + r;
      if (bb < 32) ml |= <u32>(1 << bb);
      else mh |= <u32>(1 << (bb - 32));
    }
    colMaskLo[c] = ml;
    colMaskHi[c] = mh;
  }
  boardMaskLo = 0;
  boardMaskHi = 0;
  for (let c: i32 = 0; c < WIDTH; c++) {
    boardMaskLo |= colMaskLo[c];
    boardMaskHi |= colMaskHi[c];
  }
  reset();
  return 0;
}

export function reset(): void {
  currentLo = 0;
  currentHi = 0;
  maskLo = 0;
  maskHi = 0;
  moves = 0;
  for (let i: i32 = 0; i < WIDTH; i++) height[i] = 0;
  nodeCount = 0;
  depth = 0;
}

export function clearTT(): void {
  for (let i: u32 = 0; i < ttSize; i++) ttKeys[i] = 0;
}

export function setNodeLimit(limit: u64): void {
  nodeLimit = limit;
}

export function resetNodeCount(): void {
  nodeCount = 0;
}

export function getNodeCount(): u64 {
  return nodeCount;
}

// ---------- position ----------

function cellPos(col: i32): i32 {
  return col * (HEIGHT + 1) + <i32>height[col];
}

export function canPlay(col: i32): i32 {
  return <i32>height[col] < HEIGHT ? 1 : 0;
}

export function play(col: i32): void {
  const curLo: u32 = currentLo;
  const curHi: u32 = currentHi;
  const mLo: u32 = maskLo;
  const mHi: u32 = maskHi;
  currentLo = curLo ^ mLo;
  currentHi = curHi ^ mHi;
  const pos: i32 = cellPos(col);
  if (pos < 32) maskLo = mLo | <u32>(1 << pos);
  else maskHi = mHi | <u32>(1 << (pos - 32));
  moves++;
  height[col] = <u8>(height[col] + 1);
}

export function unplay(col: i32): void {
  moves--;
  height[col] = <u8>(height[col] - 1);
  const pos: i32 = cellPos(col);
  if (pos < 32) maskLo = maskLo ^ <u32>(1 << pos);
  else maskHi = maskHi ^ <u32>(1 << (pos - 32));
  currentLo = currentLo ^ maskLo;
  currentHi = currentHi ^ maskHi;
}

export function nbMoves(): i32 {
  return moves;
}

function possibleInto(): void {
  const lo0: u64 = <u64>maskLo + <u64>bottomLo;
  lo = <u32>(lo0 & <u64>LO_MASK) & boardMaskLo;
  hi = <u32>((<u64>maskHi + <u64>bottomHi + (lo0 >>> 32)) & <u64>HI_MASK) & boardMaskHi;
}

function computeKeyInto(): void {
  const lo0: u64 = <u64>currentLo + <u64>maskLo;
  keyLo = <u32>(lo0 & <u64>LO_MASK);
  const carry: u64 = lo0 >>> 32;
  keyHi = <u32>((<u64>currentHi + <u64>maskHi + carry) & <u64>HI_MASK);
}

// ---------- bitboards ----------

function isSingleBit(lo0: u32, hi0: u32): i32 {
  if (lo0 != 0) return <i32>(lo0 & (lo0 - 1)) == 0 && hi0 == 0 ? 1 : 0;
  return hi0 != 0 && (hi0 & (hi0 - 1)) == 0 ? 1 : 0;
}

function popcount(lo0: u32, hi0: u32): i32 {
  return <i32>(
    POPCOUNT16[lo0 & 0xffff] + POPCOUNT16[lo0 >>> 16] + POPCOUNT16[hi0 & 0xffff] + ((hi0 >>> 16) & 1)
  );
}

/** Winning positions pour "plo/phi" parmi les cellules libres. Résultat dans lo/hi. */
function computeWinningPositionInto(plo: u32, phi: u32, mlo: u32, mhi: u32): void {
  let a1l: u32 = plo << 1;
  let a1h: u32 = ((plo >>> 31) | ((phi & 0xffff) << 1)) & HI_MASK;
  let a2l: u32 = plo << 2;
  let a2h: u32 = ((plo >>> 30) | ((phi & 0x7fff) << 2)) & HI_MASK;
  let a3l: u32 = plo << 3;
  let a3h: u32 = ((plo >>> 29) | ((phi & 0x3fff) << 3)) & HI_MASK;
  let rl: u32 = a1l & a2l & a3l;
  let rh: u32 = a1h & a2h & a3h;

  const s7l: u32 = plo << 7;
  const s7h: u32 = ((plo >>> 25) | ((phi & 0x3ff) << 7)) & HI_MASK;
  const s14l: u32 = plo << 14;
  const s14h: u32 = ((plo >>> 18) | ((phi & 0x7) << 14)) & HI_MASK;
  const s21l: u32 = plo << 21;
  const s21h: u32 = (plo >>> 11) & HI_MASK;
  const r7l: u32 = (plo >>> 7) | ((phi & 0x7f) << 25);
  const r7h: u32 = phi >>> 7;
  const r14l: u32 = (plo >>> 14) | ((phi & 0x3fff) << 18);
  const r14h: u32 = phi >>> 14;
  const r21l: u32 = (plo >>> 21) | ((phi & 0x1fffff) << 11);
  const r21h: u32 = phi >>> 21;
  let pLo: u32 = s7l & s14l;
  let pHi: u32 = s7h & s14h;
  rl |= pLo & s21l;
  rh |= pHi & s21h;
  rl |= pLo & r7l;
  rh |= pHi & r7h;
  pLo = r7l & r14l;
  pHi = r7h & r14h;
  rl |= pLo & s7l;
  rh |= pHi & s7h;
  rl |= pLo & r21l;
  rh |= pHi & r21h;

  const s6l: u32 = plo << 6;
  const s6h: u32 = ((plo >>> 26) | ((phi & 0x7ff) << 6)) & HI_MASK;
  const s12l: u32 = plo << 12;
  const s12h: u32 = ((plo >>> 20) | ((phi & 0x1f) << 12)) & HI_MASK;
  const s18l: u32 = plo << 18;
  const s18h: u32 = (plo >>> 14) & HI_MASK;
  const r6l: u32 = (plo >>> 6) | ((phi & 0x3f) << 26);
  const r6h: u32 = phi >>> 6;
  const r12l: u32 = (plo >>> 12) | ((phi & 0xfff) << 20);
  const r12h: u32 = phi >>> 12;
  const r18l: u32 = (plo >>> 18) | ((phi & 0x3ffff) << 14);
  const r18h: u32 = phi >>> 18;
  pLo = s6l & s12l;
  pHi = s6h & s12h;
  rl |= pLo & s18l;
  rh |= pHi & s18h;
  rl |= pLo & r6l;
  rh |= pHi & r6h;
  pLo = r6l & r12l;
  pHi = r6h & r12h;
  rl |= pLo & s6l;
  rh |= pHi & s6h;
  rl |= pLo & r18l;
  rh |= pHi & r18h;

  const s8l: u32 = plo << 8;
  const s8h: u32 = ((plo >>> 24) | ((phi & 0x1ff) << 8)) & HI_MASK;
  const s16l: u32 = plo << 16;
  const s16h: u32 = ((plo >>> 16) | ((phi & 0x1) << 16)) & HI_MASK;
  const s24l: u32 = plo << 24;
  const s24h: u32 = (plo >>> 8) & HI_MASK;
  const r8l: u32 = (plo >>> 8) | ((phi & 0xff) << 24);
  const r8h: u32 = phi >>> 8;
  const r16l: u32 = (plo >>> 16) | ((phi & 0xffff) << 16);
  const r16h: u32 = phi >>> 16;
  const r24l: u32 = (plo >>> 24) | ((phi & 0xffffff) << 8);
  const r24h: u32 = phi >>> 24;
  pLo = s8l & s16l;
  pHi = s8h & s16h;
  rl |= pLo & s24l;
  rh |= pHi & s24h;
  rl |= pLo & r8l;
  rh |= pHi & r8h;
  pLo = r8l & r16l;
  pHi = r8h & r16h;
  rl |= pLo & s8l;
  rh |= pHi & s8h;
  rl |= pLo & r24l;
  rh |= pHi & r24h;

  lo = (rl & ~mlo) & boardMaskLo;
  hi = (rh & ~mhi) & boardMaskHi;
}

function canWinNext(): i32 {
  possibleInto();
  const plo: u32 = lo;
  const phi: u32 = hi;
  computeWinningPositionInto(currentLo, currentHi, maskLo, maskHi);
  return (lo & plo) != 0 || (hi & phi) != 0 ? 1 : 0;
}

function isWinningMove(col: i32): i32 {
  possibleInto();
  const plo: u32 = lo;
  const phi: u32 = hi;
  computeWinningPositionInto(currentLo, currentHi, maskLo, maskHi);
  return (lo & plo & colMaskLo[col]) != 0 || (hi & phi & colMaskHi[col]) != 0 ? 1 : 0;
}

function isInMask(col: i32, lo0: u32, hi0: u32): i32 {
  const pos: i32 = cellPos(col);
  if (pos < 32) return <i32>((lo0 >>> pos) & 1);
  return <i32>((hi0 >>> (pos - 32)) & 1);
}

function moveScoreInto(col: i32): i32 {
  const pos: i32 = cellPos(col);
  const pLo: u32 = currentLo;
  const pHi: u32 = currentHi;
  const mLo: u32 = pos < 32 ? (pLo | <u32>(1 << pos)) : pLo;
  const mHi: u32 = pos < 32 ? pHi : (pHi | <u32>(1 << (pos - 32)));
  computeWinningPositionInto(mLo, mHi, maskLo, maskHi);
  return popcount(lo, hi);
}

function possibleNonLosingMovesInto(): void {
  const ql0: u64 = <u64>maskLo + <u64>bottomLo;
  const ql: u32 = <u32>(ql0 & <u64>LO_MASK) & boardMaskLo;
  const qh: u32 = <u32>((<u64>maskHi + <u64>bottomHi + (ql0 >>> 32)) & <u64>HI_MASK) & boardMaskHi;
  const xl: u32 = currentLo ^ maskLo;
  const xh: u32 = currentHi ^ maskHi;
  computeWinningPositionInto(xl, xh, maskLo, maskHi);
  const ol: u32 = lo;
  const oh: u32 = hi;
  let fl: u32 = ql & ol;
  let fh: u32 = qh & oh;
  if (fl != 0 || fh != 0) {
    if (isSingleBit(fl, fh) == 0) {
      lo = 0;
      hi = 0;
      return;
    }
  } else {
    fl = ql;
    fh = qh;
  }
  const sl: u32 = (ol >>> 1) | ((oh & 1) << 31);
  const sh: u32 = oh >>> 1;
  lo = fl & ~sl;
  hi = fh & ~sh;
}

// ---------- table de transposition ----------

function ttGet(key: u64): i32 {
  const i: u32 = <u32>(key % <u64>ttSize);
  const tag: u64 = key & <u64>0x1ffffff;
  return ttKeys[i] == <u32>tag ? <i32>ttValues[i] : 0;
}

function ttPut(key: u64, value: i32): void {
  const i: u32 = <u32>(key % <u64>ttSize);
  const tag: u64 = key & <u64>0x1ffffff;
  ttKeys[i] = <u32>tag;
  ttValues[i] = <u8>value;
}

// ---------- recherche ----------

function negamax(alpha: i32, beta: i32): i32 {
  if (++nodeCount >= nodeLimit) return STOP;

  possibleNonLosingMovesInto();
  const possibleLo: u32 = lo;
  const possibleHi: u32 = hi;
  if (possibleLo == 0 && possibleHi == 0) {
    return -((CELLS - moves) / 2);
  }
  if (moves >= DRAW_MOVES) return 0;

  let min: i32 = -((CELLS - 2 - moves) / 2);
  if (alpha < min) {
    alpha = min;
    if (alpha >= beta) return alpha;
  }
  let max: i32 = (CELLS - 1 - moves) / 2;
  if (beta > max) {
    beta = max;
    if (alpha >= beta) return beta;
  }

  computeKeyInto();
  const key: u64 = (<u64>keyHi << 32) | <u64>keyLo;
  const val: i32 = ttGet(key);
  if (val != 0) {
    if (val > LOWER_THRESHOLD) {
      min = val - LOWER_STORE;
      if (alpha < min) {
        alpha = min;
        if (alpha >= beta) return alpha;
      }
    } else {
      max = val - UPPER_STORE;
      if (beta > max) {
        beta = max;
        if (alpha >= beta) return beta;
      }
    }
  }

  depth++;
  const base: i32 = depth * WIDTH;
  let m: i32 = 0;
  for (let i: i32 = WIDTH - 1; i >= 0; i--) {
    const col: i32 = COLUMN_ORDER[i];
    if (isInMask(col, possibleLo, possibleHi) != 0) {
      const sc: i32 = moveScoreInto(col);
      let j: i32 = m;
      while (j > 0 && scosScratch[base + j - 1] > sc) {
        scosScratch[base + j] = scosScratch[base + j - 1];
        colsScratch[base + j] = colsScratch[base + j - 1];
        j--;
      }
      scosScratch[base + j] = <i8>sc;
      colsScratch[base + j] = <u8>col;
      m++;
    }
  }

  for (let j: i32 = m - 1; j >= 0; j--) {
    const col: i32 = <i32>colsScratch[base + j];
    play(col);
    const r: i32 = negamax(-beta, -alpha);
    if (r == STOP) {
      unplay(col);
      depth--;
      return STOP;
    }
    const score: i32 = -r;
    unplay(col);
    if (score >= beta) {
      ttPut(key, score + LOWER_STORE);
      depth--;
      return score;
    }
    if (score > alpha) alpha = score;
  }

  ttPut(key, alpha + UPPER_STORE);
  depth--;
  return alpha;
}

export function solve(weak: i32): i32 {
  if (canWinNext() != 0) {
    const s: i32 = (CELLS + 1 - moves) / 2;
    return weak != 0 ? 1 : s;
  }
  let min: i32 = -((CELLS - moves) / 2);
  let max: i32 = (CELLS + 1 - moves) / 2;
  if (weak != 0) {
    min = -1;
    max = 1;
  }
  while (min < max) {
    let med: i32 = min + ((max - min) / 2);
    if (med <= 0 && (min / 2) < med) med = min / 2;
    else if (med >= 0 && (max / 2) > med) med = max / 2;
    const r: i32 = negamax(med, med + 1);
    if (r == STOP) return STOP;
    if (r <= med) max = r;
    else min = r;
  }
  if (weak != 0) return min > 0 ? 1 : (min < 0 ? -1 : 0);
  return min;
}

export function analyze(weak: i32): i32 {
  for (let col: i32 = 0; col < WIDTH; col++) {
    if (canPlay(col) == 0) {
      scores[col] = INVALID_MOVE;
      continue;
    }
    if (isWinningMove(col) != 0) {
      const s: i32 = (CELLS + 1 - moves) / 2;
      scores[col] = weak != 0 ? 1 : s;
    } else {
      play(col);
      const r: i32 = solve(weak);
      if (r == STOP) {
        unplay(col);
        return STOP;
      }
      scores[col] = -r;
      unplay(col);
    }
  }
  return 0;
}

export function scoreAt(col: i32): i32 {
  return scores[col];
}

/** Analyse une seule colonne : 0 si OK, STOP si budget dépassé. score lisible via scoreAt. */
export function analyzeCol(col: i32, weak: i32): i32 {
  if (canPlay(col) == 0) return INVALID_MOVE;
  if (isWinningMove(col) != 0) {
    const s: i32 = (CELLS + 1 - moves) / 2;
    scores[col] = weak != 0 ? 1 : s;
    return 0;
  }
  play(col);
  const r: i32 = solve(weak);
  unplay(col);
  if (r == STOP) return STOP;
  scores[col] = -r;
  return 0;
}