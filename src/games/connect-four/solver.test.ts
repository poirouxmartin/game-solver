import { describe, expect, it } from 'vitest';
import { computeWinningPosition, popcount, HEIGHT, WIDTH } from './bitboard';
import { ConnectFourPosition } from './position';
import { ConnectFourSolver } from './solver';

/**
 * Référence naïve et indépendante : grille de colonnes + scan des 4 alignés.
 * Pas de bitboards, pas de décalages : sert de vérité pour le portage.
 */

type RefGrid = number[][]; // cols[c][r] = joueur (0 ou 1), du bas vers le haut

function refFromSeq(seq: number[]): { cols: RefGrid; turn: number; moves: number } {
  const cols: RefGrid = [[], [], [], [], [], [], []];
  for (let i = 0; i < seq.length; i++) cols[seq[i]].push(i % 2);
  return { cols, turn: seq.length % 2, moves: seq.length };
}

function refWinAt(cols: RefGrid, c: number, r: number, player: number): boolean {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dc, dr] of dirs) {
    let count = 1;
    for (let k = 1; ; k++) {
      const cc = c + dc * k;
      const rr = r + dr * k;
      if (cc < 0 || cc >= WIDTH || rr < 0 || rr >= HEIGHT) break;
      if (cols[cc][rr] !== player) break;
      count++;
    }
    for (let k = 1; ; k++) {
      const cc = c - dc * k;
      const rr = r - dr * k;
      if (cc < 0 || cc >= WIDTH || rr < 0 || rr >= HEIGHT) break;
      if (cols[cc][rr] !== player) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

function refCanWinNext(cols: RefGrid, turn: number): boolean {
  for (let c = 0; c < WIDTH; c++) {
    const h = cols[c].length;
    if (h >= HEIGHT) continue;
    cols[c].push(turn);
    const w = refWinAt(cols, c, h, turn);
    cols[c].pop();
    if (w) return true;
  }
  return false;
}

/** Score exact (convention Pons) depuis le point de vue du joueur au trait.
 *  Minimax pur sans bornes ni pruning : vérité pour le portage. */
function refScore(cols: RefGrid, turn: number, m: number): number {
  if (refCanWinNext(cols, turn)) return ((43 - m) / 2) | 0;
  let best = -1 << 29;
  let any = false;
  for (const c of [3, 4, 2, 5, 1, 6, 0]) {
    if (cols[c].length < HEIGHT) {
      any = true;
      cols[c].push(turn);
      const v = -refScore(cols, 1 - turn, m + 1);
      cols[c].pop();
      if (v > best) best = v;
    }
  }
  if (!any) return 0;
  return best;
}

/** Génère des positions atteignables (sans alignement) par des séquences aléatoires. */
function randomSequences(n: number, minDepth: number, maxDepth: number): number[][] {
  const out: number[][] = [];
  let attempts = 0;
  while (out.length < n && attempts < n * 40) {
    attempts++;
    const cols: RefGrid = [[], [], [], [], [], [], []];
    const seq: number[] = [];
    const depth = minDepth + Math.floor(Math.random() * (maxDepth - minDepth + 1));
    let ok = true;
    for (let d = 0; d < depth; d++) {
      const playable: number[] = [];
      for (let c = 0; c < WIDTH; c++) if (cols[c].length < HEIGHT) playable.push(c);
      if (playable.length === 0) {
        ok = false;
        break;
      }
      const c = playable[Math.floor(Math.random() * playable.length)];
      const r = cols[c].length;
      cols[c].push(d % 2);
      if (refWinAt(cols, c, r, d % 2)) {
        ok = false;
        break;
      }
      seq.push(c);
    }
    if (ok && seq.length >= minDepth) out.push(seq);
  }
  return out;
}

function positionFromSeq(seq: number[]): ConnectFourPosition {
  const p = new ConnectFourPosition();
  for (const c of seq) p.play(c);
  return p;
}

describe('bitboards : computeWinningPosition vs scan naïf', () => {
  it('trouve exactement les coups gagnants sur des positions aléatoires', () => {
    for (let t = 0; t < 2000; t++) {
      // Positions atteignables : colonnes empilées (gravité), propriété aléatoire par cellule.
      const heights = Array.from({ length: WIDTH }, () => Math.floor(Math.random() * (HEIGHT + 1)));
      const cols: RefGrid = [[], [], [], [], [], [], []];
      let mlo = 0;
      let mhi = 0;
      let plo = 0;
      let phi = 0;
      for (let c = 0; c < WIDTH; c++) {
        for (let r = 0; r < heights[c]; r++) {
          const b = c * 7 + r;
          if (b < 32) mlo |= 1 << b;
          else mhi |= 1 << (b - 32);
          if (Math.random() < 0.5) {
            if (b < 32) plo |= 1 << b;
            else phi |= 1 << (b - 32);
            cols[c].push(1);
          } else {
            cols[c].push(2);
          }
        }
      }

      const w = computeWinningPosition(plo >>> 0, phi, mlo >>> 0, mhi);
      const expected = new Set<number>();
      for (let c = 0; c < WIDTH; c++) {
        for (let r = 0; r < HEIGHT; r++) {
          if (cols[c][r] === undefined) {
            cols[c][r] = 1;
            if (refWinAt(cols, c, r, 1)) expected.add(c * 7 + r);
            delete cols[c][r];
          }
        }
      }
      expect(popcount(w.lo, w.hi)).toBe(expected.size);
      for (const b of expected) {
        const bit = b < 32 ? (w.lo >>> b) & 1 : (w.hi >>> (b - 32)) & 1;
        expect(bit).toBe(1);
      }
    }
  });
});

describe('ConnectFourPosition', () => {
  it('play/unplay rétablit exactement l’état', () => {
    const p = new ConnectFourPosition();
    const seq = [3, 4, 3, 2, 5, 3, 4, 4, 2, 1, 3, 5];
    const snapshots: ReturnType<ConnectFourPosition['snapshot']>[] = [];
    for (const c of seq) {
      p.play(c);
      snapshots.push(p.snapshot());
    }
    for (let i = seq.length - 1; i >= 0; i--) {
      p.unplay(seq[i]);
      const s = p.snapshot();
      if (i === 0) {
        expect(s.moves).toBe(0);
        expect(s.currentLo).toBe(0);
        expect(s.currentHi).toBe(0);
        expect(s.maskLo).toBe(0);
        expect(s.maskHi).toBe(0);
      } else {
        expect(s).toEqual(snapshots[i - 1]);
      }
    }
  });

  it('clé unique sur toutes les positions atteignables jusqu’à profondeur 5', () => {
    const seen = new Map<number, string>();
    const p = new ConnectFourPosition();

    const walk = (depth: number): void => {
      if (depth >= 5) return;
      for (let c = 0; c < WIDTH; c++) {
        if (!p.canPlay(c)) continue;
        p.play(c);
        if (!p.canWinNext()) {
          const key = p.key();
          const sig = `${p.currentLo},${p.currentHi},${p.maskLo},${p.maskHi}`;
          const prev = seen.get(key);
          if (prev !== undefined && prev !== sig) {
            throw new Error(`clé dupliquée ${key} : ${prev} vs ${sig}`);
          }
          seen.set(key, sig);
          walk(depth + 1);
        }
        p.unplay(c);
      }
    };
    walk(0);
    expect(seen.size).toBeGreaterThan(1000);
  });

  it('le même plateau via des ordres de coups différents a la même clé', () => {
    // [3,4,2,5] et [2,4,3,5] : P1 joue 2 et 3, P2 joue 4 et 5 dans les deux cas.
    const a = positionFromSeq([3, 4, 2, 5]);
    const b = positionFromSeq([2, 4, 3, 5]);
    expect(a.key()).toBe(b.key());
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('canWinNext correspond à la référence', () => {
    for (const seq of randomSequences(300, 1, 6)) {
      const p = positionFromSeq(seq);
      const { cols, turn } = refFromSeq(seq);
      expect(p.canWinNext()).toBe(refCanWinNext(cols, turn));
    }
  });

  it('possibleNonLosingMoves = coups qui ne laissent pas gagner l’adversaire au tour suivant', () => {
    for (const seq of randomSequences(300, 1, 6)) {
      const p = positionFromSeq(seq);
      if (p.canWinNext()) continue;
      const { cols, turn } = refFromSeq(seq);
      const result = p.possibleNonLosingMoves();
      const expected: number[] = [];
      for (let c = 0; c < WIDTH; c++) {
        if (cols[c].length >= HEIGHT) continue;
        cols[c].push(turn);
        const oppWins = refCanWinNext(cols, 1 - turn);
        cols[c].pop();
        if (!oppWins) expected.push(c);
      }
      const got: number[] = [];
      for (let c = 0; c < WIDTH; c++) {
        if (p.isInMask(c, result.lo, result.hi)) got.push(c);
      }
      expect(got).toEqual(expected);
    }
  });
});

describe('ConnectFourSolver vs référence naïve', () => {
  it('scores exacts sur positions proches de la fin', () => {
    const solver = new ConnectFourSolver(16);
    const seqs = randomSequences(25, 33, 37);
    expect(seqs.length).toBeGreaterThan(10);
    for (const seq of seqs) {
      const { cols, turn, moves } = refFromSeq(seq);
      const expected = refScore(cols, turn, moves);
      const got = solver.solve(positionFromSeq(seq));
      expect(got + 0).toBe(expected + 0);
    }
  }, 60000);

  it('solution weak = signe de la valeur exacte', () => {
    const solver = new ConnectFourSolver(16);
    for (const seq of randomSequences(15, 33, 37)) {
      const { cols, turn, moves } = refFromSeq(seq);
      const exact = refScore(cols, turn, moves);
      const got = solver.solve(positionFromSeq(seq), true);
      const expected = exact > 0 ? 1 : exact < 0 ? -1 : 0;
      expect(got).toBe(expected);
    }
  }, 60000);
});

describe('ConnectFourSolver : résultats connus', () => {
  /**
   * Positions de début validées contre le solveur en ligne de Pascal Pons
   * (https://connect4.gamesolver.org/solve?pos=…). Encodage API = colonne + 1,
   * le parseur s'arrête au premier coup invalide. Le tableau "score" est le score
   * fort par colonne du point de vue du joueur au trait ; "weak" en est le signe.
   * "analyze" = vrai si l'analyse par colonne est assez rapide pour le test.
   */
  const FIXTURES: { seq: number[]; api: string; score: number[]; weak: number; analyze: boolean }[] = [
    { seq: [3, 4, 2, 5], api: '4536', score: [2, 2, 4, 0, 2, 2, -1], weak: 1, analyze: false },
    { seq: [3, 4, 2, 5, 1, 6], api: '453627', score: [18, 12, 12, 12, 10, 6, 2], weak: 1, analyze: true },
    { seq: [3, 4, 2, 5, 1, 6, 3], api: '4536274', score: [-12, -17, -17, -17, -17, -17, -17], weak: -1, analyze: true },
    { seq: [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6], api: '735457274222717', score: [-4, -4, -3, 0, -3, -10, -4], weak: 0, analyze: true },
    { seq: [0, 6, 0, 4, 4, 6, 5, 1, 1, 1, 5, 4, 6, 0, 2, 6, 3, 5], api: '171557622265713746', score: [-2, 0, -2, 0, 0, -2, -2], weak: 0, analyze: true },
  ];

  it('solve(weak) concorde avec le solveur de Pons sur des positions de début', () => {
    for (const fx of FIXTURES) {
      const solver = new ConnectFourSolver(24);
      solver.nodeLimit = 1_000_000_000;
      const pos = positionFromSeq(fx.seq);
      expect(solver.solve(pos, true), `solve weak seq=[${fx.seq}]`).toBe(fx.weak);
    }
  }, 120000);

  it('analyse par colonne (signes) concorde avec le solveur de Pons', () => {
    for (const fx of FIXTURES) {
      if (!fx.analyze) continue;
      const solver = new ConnectFourSolver(24);
      solver.nodeLimit = 1_000_000_000;
      const pos = positionFromSeq(fx.seq);
      const analyze = solver.analyze(pos, true);
      for (let col = 0; col < WIDTH; col++) {
        expect(Math.sign(analyze[col]), `col ${col} seq=[${fx.seq}]`).toBe(Math.sign(fx.score[col]));
      }
    }
  }, 120000);

  // Position vide : gain pour le premier joueur, mais ~1 milliard de nœuds en JS
  // (~10 min) — désactivé par défaut, à lancer à la main avec un timeout généreux.
  it.skip('le premier joueur gagne depuis la position vide', () => {
    const solver = new ConnectFourSolver(24);
    expect(solver.solve(new ConnectFourPosition(), true)).toBe(1);
  }, 900000);
});