import {
  add,
  computeWinningPosition,
  computeWinningPositionInto,
  isSingleBit,
  popcount,
  shr,
  xor,
  BOTTOM_HI,
  BOTTOM_LO,
  BOARD_MASK_HI,
  BOARD_MASK_LO,
  COLUMN_MASK_HI,
  COLUMN_MASK_LO,
  HI_MASK,
  HEIGHT,
  LO_MASK,
  WIDTH,
  type Bitboard,
} from './bitboard';

export interface PositionSnapshot {
  currentLo: number;
  currentHi: number;
  maskLo: number;
  maskHi: number;
  moves: number;
  height: number[];
}

/**
 * Position Puissance 4 mutable (pour play/unplay sans allocation).
 * "current" = pions du joueur au trait ; "mask" = tous les pions.
 */
export class ConnectFourPosition {
  /** Pions du joueur au trait ; "mask" = tous les pions. */
  currentLo = 0;
  currentHi = 0;
  maskLo = 0;
  maskHi = 0;
  moves = 0;
  /** Registres de travail (résultats sans allocation), valides juste après l'appel. */
  lo = 0;
  hi = 0;
  private height = [0, 0, 0, 0, 0, 0, 0];

  reset(): void {
    this.currentLo = 0;
    this.currentHi = 0;
    this.maskLo = 0;
    this.maskHi = 0;
    this.moves = 0;
    for (let i = 0; i < WIDTH; i++) this.height[i] = 0;
  }

  snapshot(): PositionSnapshot {
    return {
      currentLo: this.currentLo,
      currentHi: this.currentHi,
      maskLo: this.maskLo,
      maskHi: this.maskHi,
      moves: this.moves,
      height: this.height.slice(),
    };
  }

  restore(s: PositionSnapshot): void {
    this.currentLo = s.currentLo;
    this.currentHi = s.currentHi;
    this.maskLo = s.maskLo;
    this.maskHi = s.maskHi;
    this.moves = s.moves;
    this.height = s.height.slice();
  }

  /** Copie en place (sans allocation) depuis une autre position. */
  copyFrom(p: ConnectFourPosition): void {
    this.currentLo = p.currentLo;
    this.currentHi = p.currentHi;
    this.maskLo = p.maskLo;
    this.maskHi = p.maskHi;
    this.moves = p.moves;
    for (let i = 0; i < WIDTH; i++) this.height[i] = p.height[i];
  }

  /**
   * Positionne la position depuis les bitboards bruts ; les hauteurs sont
   * recalculées par popcount du masque de chaque colonne.
   */
  setFromBits(cLo: number, cHi: number, mLo: number, mHi: number, mv: number): void {
    this.currentLo = cLo;
    this.currentHi = cHi;
    this.maskLo = mLo;
    this.maskHi = mHi;
    this.moves = mv;
    for (let col = 0; col < WIDTH; col++) {
      let mLoC = mLo & COLUMN_MASK_LO[col];
      const mHiC = mHi & COLUMN_MASK_HI[col];
      let count = 0;
      while (mLoC !== 0) {
        mLoC &= mLoC - 1;
        count++;
      }
      let x = mHiC;
      while (x !== 0) {
        x &= x - 1;
        count++;
      }
      this.height[col] = count;
    }
  }

  nbMoves(): number {
    return this.moves;
  }

  canPlay(col: number): boolean {
    return this.height[col] < HEIGHT;
  }

  private cellPos(col: number): number {
    return col * (HEIGHT + 1) + this.height[col];
  }

  /** Joue dans la colonne col (colonne non pleine). */
  play(col: number): void {
    const curLo = this.currentLo;
    const curHi = this.currentHi;
    const mLo = this.maskLo;
    const mHi = this.maskHi;
    this.currentLo = (curLo ^ mLo) >>> 0;
    this.currentHi = curHi ^ mHi;
    const pos = this.cellPos(col);
    if (pos < 32) this.maskLo = (mLo | (1 << pos)) >>> 0;
    else this.maskHi = mHi | (1 << (pos - 32));
    this.moves++;
    this.height[col]++;
  }

  /** Annule le dernier coup (doit être dans la colonne col). */
  unplay(col: number): void {
    this.moves--;
    this.height[col]--;
    const pos = this.cellPos(col);
    if (pos < 32) this.maskLo = (this.maskLo ^ (1 << pos)) >>> 0;
    else this.maskHi = this.maskHi ^ (1 << (pos - 32));
    this.currentLo = (this.currentLo ^ this.maskLo) >>> 0;
    this.currentHi = this.currentHi ^ this.maskHi;
  }

  /** Cellules libres jouables : (mask + bottom) & board_mask. */
  possible(): Bitboard {
    const p = add(this.maskLo, this.maskHi, BOTTOM_LO, BOTTOM_HI);
    return { lo: p.lo & BOARD_MASK_LO, hi: p.hi & BOARD_MASK_HI };
  }

  /** Clé 49 bits = current + mask (non ambiguë). */
  key(): number {
    const lo = this.currentLo + this.maskLo;
    const kLo = (lo & LO_MASK) >>> 0;
    const kHi = (this.currentHi + this.maskHi + (lo > LO_MASK ? 1 : 0)) & HI_MASK;
    return kHi * 4294967296 + kLo;
  }

  private winningPosition(): Bitboard {
    return computeWinningPosition(this.currentLo, this.currentHi, this.maskLo, this.maskHi);
  }

  private opponentWinningPosition(): Bitboard {
    const o = xor(this.currentLo, this.currentHi, this.maskLo, this.maskHi);
    return computeWinningPosition(o.lo, o.hi, this.maskLo, this.maskHi);
  }

  canWinNext(): boolean {
    const p = this.possible();
    const w = this.winningPosition();
    return (w.lo & p.lo) !== 0 || (w.hi & p.hi) !== 0;
  }

  isWinningMove(col: number): boolean {
    const p = this.possible();
    const w = this.winningPosition();
    return (
      (w.lo & p.lo & COLUMN_MASK_LO[col]) !== 0 || (w.hi & p.hi & COLUMN_MASK_HI[col]) !== 0
    );
  }

  /** Nombre de coups gagnants que le joueur aurait en jouant dans col. */
  moveScore(col: number): number {
    const pos = this.cellPos(col);
    const pLo = this.currentLo;
    const pHi = this.currentHi;
    const mLo = pos < 32 ? (pLo | (1 << pos)) >>> 0 : pLo;
    const mHi = pos < 32 ? pHi : pHi | (1 << (pos - 32));
    const w = computeWinningPosition(mLo, mHi, this.maskLo, this.maskHi);
    return popcount(w.lo, w.hi);
  }

  /** Variante sans allocation de moveScore : résultat de cwp dans lo/hi. */
  moveScoreInto(col: number): number {
    const pos = this.cellPos(col);
    const pLo = this.currentLo;
    const pHi = this.currentHi;
    const mLo = pos < 32 ? (pLo | (1 << pos)) >>> 0 : pLo;
    const mHi = pos < 32 ? pHi : pHi | (1 << (pos - 32));
    computeWinningPositionInto(mLo, mHi, this.maskLo, this.maskHi, this);
    return popcount(this.lo, this.hi);
  }

  /** Variante sans allocation de possibleNonLosingMoves : résultat dans lo/hi. */
  possibleNonLosingMovesInto(): void {
    const lo = this.maskLo + BOTTOM_LO;
    const ql = ((lo & LO_MASK) >>> 0) & BOARD_MASK_LO;
    const qh = (this.maskHi + BOTTOM_HI + (lo > LO_MASK ? 1 : 0)) & HI_MASK & BOARD_MASK_HI;
    const xl = (this.currentLo ^ this.maskLo) >>> 0;
    const xh = this.currentHi ^ this.maskHi;
    computeWinningPositionInto(xl, xh, this.maskLo, this.maskHi, this);
    const ol = this.lo;
    const oh = this.hi;
    let fl = (ql & ol) >>> 0;
    let fh = qh & oh;
    if (fl !== 0 || fh !== 0) {
      if (!isSingleBit(fl, fh)) {
        this.lo = 0;
        this.hi = 0;
        return;
      }
    } else {
      fl = ql;
      fh = qh;
    }
    const sl = (ol >>> 1) | ((oh & 1) << 31);
    const sh = oh >>> 1;
    this.lo = (fl & ~sl) >>> 0;
    this.hi = fh & ~sh;
  }

  /**
   * Bitmap des coups non perdants (le joueur au trait ne peut pas gagner d'un coup ici :
   * c'est au solveur de le garantir avant l'appel). Portage de possibleNonLosingMoves.
   */
  possibleNonLosingMoves(): Bitboard {
    const possible = this.possible();
    const oppWin = this.opponentWinningPosition();
    let pLo = (possible.lo & oppWin.lo) >>> 0;
    let pHi = possible.hi & oppWin.hi;
    if (pLo !== 0 || pHi !== 0) {
      if (!isSingleBit(pLo, pHi)) return { lo: 0, hi: 0 };
    } else {
      pLo = possible.lo;
      pHi = possible.hi;
    }
    const s = shr(oppWin.lo, oppWin.hi, 1);
    return { lo: (pLo & ~s.lo) >>> 0, hi: pHi & ~s.hi };
  }

  /** Vrai si la prochaine cellule de la colonne col est dans le bitboard donné. */
  isInMask(col: number, lo: number, hi: number): boolean {
    const pos = this.cellPos(col);
    return pos < 32 ? ((lo >>> pos) & 1) !== 0 : ((hi >>> (pos - 32)) & 1) !== 0;
  }
}