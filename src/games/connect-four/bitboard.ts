/**
 * Bitboards Puissance 4 (format Pascal Pons) : 7 colonnes x 7 bits = 49 bits.
 * Cellule (col c, rangée r) = bit c * 7 + r. La rangée 6 n'est jamais utilisée.
 * Un bitboard est une paire (lo, hi) : lo = bits 0-31, hi = bits 32-48.
 */
export const WIDTH = 7;
export const HEIGHT = 6;
export const LO_MASK = 0xffffffff;
export const HI_MASK = 0x1ffff;

export interface Bitboard {
  lo: number;
  hi: number;
}

export const COLUMN_MASK_LO: number[] = [];
export const COLUMN_MASK_HI: number[] = [];
for (let c = 0; c < WIDTH; c++) {
  const b0 = c * (HEIGHT + 1);
  let lo = 0;
  let hi = 0;
  for (let r = 0; r < HEIGHT; r++) {
    const b = b0 + r;
    if (b < 32) lo |= 1 << b;
    else hi |= 1 << (b - 32);
  }
  COLUMN_MASK_LO.push(lo >>> 0);
  COLUMN_MASK_HI.push(hi);
}

/** bottom_mask : bit bas de chaque colonne. */
export const BOTTOM_LO = (() => {
  let lo = 0;
  for (let c = 0; c < WIDTH; c++) {
    const b = c * (HEIGHT + 1);
    if (b < 32) lo |= 1 << b;
  }
  return lo >>> 0;
})();
export const BOTTOM_HI = (() => {
  let hi = 0;
  for (let c = 0; c < WIDTH; c++) {
    const b = c * (HEIGHT + 1);
    if (b >= 32) hi |= 1 << (b - 32);
  }
  return hi;
})();

/** board_mask : les 42 cellules du plateau (6 rangées x 7 colonnes), bits 0-47. */
export const BOARD_MASK_LO = (() => {
  let lo = 0;
  for (let c = 0; c < WIDTH; c++) lo |= COLUMN_MASK_LO[c];
  return lo >>> 0;
})();
export const BOARD_MASK_HI = (() => {
  let hi = 0;
  for (let c = 0; c < WIDTH; c++) hi |= COLUMN_MASK_HI[c];
  return hi;
})();

/** (lo, hi) << k sur 49 bits, k dans [1, 24]. */
export function shl(lo: number, hi: number, k: number): Bitboard {
  const hm = 17 - k;
  return {
    lo: (lo << k) & LO_MASK,
    hi: ((lo >>> (32 - k)) | (hm >= 1 ? (hi & ((1 << hm) - 1)) << k : 0)) & HI_MASK,
  };
}

/** (lo, hi) >> k sur 49 bits, k dans [1, 24]. */
export function shr(lo: number, hi: number, k: number): Bitboard {
  return {
    lo: (lo >>> k) | ((hi & ((1 << k) - 1)) << (32 - k)),
    hi: hi >>> k,
  };
}

/** Addition 49 bits. */
export function add(alo: number, ahi: number, blo: number, bhi: number): Bitboard {
  const lo = alo + blo;
  return {
    lo: (lo & LO_MASK) >>> 0,
    hi: (ahi + bhi + (lo > LO_MASK ? 1 : 0)) & HI_MASK,
  };
}

/** XOR 49 bits. */
export function xor(alo: number, ahi: number, blo: number, bhi: number): Bitboard {
  return { lo: (alo ^ blo) >>> 0, hi: ahi ^ bhi };
}

const POPCOUNT16 = new Uint16Array(65536);
for (let i = 1; i < 65536; i++) POPCOUNT16[i] = (i & 1) + POPCOUNT16[i >> 1];

export function popcount(lo: number, hi: number): number {
  return (
    POPCOUNT16[lo & 0xffff] + POPCOUNT16[lo >>> 16] + POPCOUNT16[hi & 0xffff] + ((hi >>> 16) & 1)
  );
}

/** Vrai si (lo, hi) a exactement un bit à 1. */
export function isSingleBit(lo: number, hi: number): boolean {
  if (lo !== 0) return (lo & (lo - 1)) === 0 && hi === 0;
  return hi !== 0 && (hi & (hi - 1)) === 0;
}

/**
 * Bitmap des coups gagnants possibles pour le joueur dont les pions sont "position",
 * parmi les cellules libres. Portage exact de compute_winning_position.
 * Décalages inlinés (aucune allocation, valeurs scalaires) pour la vitesse.
 */
export function computeWinningPosition(
  plo: number,
  phi: number,
  mlo: number,
  mhi: number,
): Bitboard {
  return computeWinningPositionInto(plo, phi, mlo, mhi, { lo: 0, hi: 0 });
}

/** Variante sans allocation : écrit le résultat dans `out` et le retourne. */
export function computeWinningPositionInto(
  plo: number,
  phi: number,
  mlo: number,
  mhi: number,
  out: Bitboard,
): Bitboard {
  // (plo, phi) << 1
  let a1l = (plo << 1) & LO_MASK;
  let a1h = ((plo >>> 31) | ((phi & 0xffff) << 1)) & HI_MASK;
  // << 2
  let a2l = (plo << 2) & LO_MASK;
  let a2h = ((plo >>> 30) | ((phi & 0x7fff) << 2)) & HI_MASK;
  // << 3
  let a3l = (plo << 3) & LO_MASK;
  let a3h = ((plo >>> 29) | ((phi & 0x3fff) << 3)) & HI_MASK;
  let rl = (a1l & a2l & a3l) >>> 0;
  let rh = a1h & a2h & a3h;

  // << 7, << 14, << 21
  const s7l = (plo << 7) & LO_MASK;
  const s7h = ((plo >>> 25) | ((phi & 0x3ff) << 7)) & HI_MASK;
  const s14l = (plo << 14) & LO_MASK;
  const s14h = ((plo >>> 18) | ((phi & 0x7) << 14)) & HI_MASK;
  const s21l = (plo << 21) & LO_MASK;
  const s21h = (plo >>> 11) & HI_MASK;
  // >> 7, >> 14, >> 21
  const r7l = (plo >>> 7) | ((phi & 0x7f) << 25);
  const r7h = phi >>> 7;
  const r14l = (plo >>> 14) | ((phi & 0x3fff) << 18);
  const r14h = phi >>> 14;
  const r21l = (plo >>> 21) | ((phi & 0x1fffff) << 11);
  const r21h = phi >>> 21;
  let pLo = (s7l & s14l) >>> 0;
  let pHi = s7h & s14h;
  rl |= pLo & s21l;
  rh |= pHi & s21h;
  rl |= pLo & r7l;
  rh |= pHi & r7h;
  pLo = (r7l & r14l) >>> 0;
  pHi = r7h & r14h;
  rl |= pLo & s7l;
  rh |= pHi & s7h;
  rl |= pLo & r21l;
  rh |= pHi & r21h;

  // << 6, << 12, << 18
  const s6l = (plo << 6) & LO_MASK;
  const s6h = ((plo >>> 26) | ((phi & 0x7ff) << 6)) & HI_MASK;
  const s12l = (plo << 12) & LO_MASK;
  const s12h = ((plo >>> 20) | ((phi & 0x1f) << 12)) & HI_MASK;
  const s18l = (plo << 18) & LO_MASK;
  const s18h = (plo >>> 14) & HI_MASK;
  // >> 6, >> 12, >> 18
  const r6l = (plo >>> 6) | ((phi & 0x3f) << 26);
  const r6h = phi >>> 6;
  const r12l = (plo >>> 12) | ((phi & 0xfff) << 20);
  const r12h = phi >>> 12;
  const r18l = (plo >>> 18) | ((phi & 0x3ffff) << 14);
  const r18h = phi >>> 18;
  pLo = (s6l & s12l) >>> 0;
  pHi = s6h & s12h;
  rl |= pLo & s18l;
  rh |= pHi & s18h;
  rl |= pLo & r6l;
  rh |= pHi & r6h;
  pLo = (r6l & r12l) >>> 0;
  pHi = r6h & r12h;
  rl |= pLo & s6l;
  rh |= pHi & s6h;
  rl |= pLo & r18l;
  rh |= pHi & r18h;

  // << 8, << 16, << 24
  const s8l = (plo << 8) & LO_MASK;
  const s8h = ((plo >>> 24) | ((phi & 0x1ff) << 8)) & HI_MASK;
  const s16l = (plo << 16) & LO_MASK;
  const s16h = ((plo >>> 16) | ((phi & 0x1) << 16)) & HI_MASK;
  const s24l = (plo << 24) & LO_MASK;
  const s24h = (plo >>> 8) & HI_MASK;
  // >> 8, >> 16, >> 24
  const r8l = (plo >>> 8) | ((phi & 0xff) << 24);
  const r8h = phi >>> 8;
  const r16l = (plo >>> 16) | ((phi & 0xffff) << 16);
  const r16h = phi >>> 16;
  const r24l = (plo >>> 24) | ((phi & 0xffffff) << 8);
  const r24h = phi >>> 24;
  pLo = (s8l & s16l) >>> 0;
  pHi = s8h & s16h;
  rl |= pLo & s24l;
  rh |= pHi & s24h;
  rl |= pLo & r8l;
  rh |= pHi & r8h;
  pLo = (r8l & r16l) >>> 0;
  pHi = r8h & r16h;
  rl |= pLo & s8l;
  rh |= pHi & s8h;
  rl |= pLo & r24l;
  rh |= pHi & r24h;

  out.lo = (rl & ~mlo & BOARD_MASK_LO) >>> 0;
  out.hi = (rh & ~mhi) & BOARD_MASK_HI;
  return out;
}