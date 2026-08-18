export const TT_EXACT = 0;
export const TT_LOWER = 1;
export const TT_UPPER = 2;

export interface TtEntry {
  value: number;
  move: number;
  depth: number;
  flag: number;
}

/**
 * Table de transposition clé -> entrée, sans allocation par probe.
 * Clé : entier (identifiant d'état fourni par le jeu).
 * Écriture par collision (dernière entrée gagne), capacité puissance de 2.
 */
export class TranspositionTable {
  private readonly keys: Uint32Array;
  private readonly values: Int16Array;
  private readonly moves: Int16Array;
  private readonly depths: Uint8Array;
  private readonly flags: Uint8Array;
  private readonly mask: number;
  hits = 0;

  constructor(capacity = 1 << 16) {
    let size = 16;
    while (size < capacity) size <<= 1;
    this.mask = size - 1;
    this.keys = new Uint32Array(size);
    this.values = new Int16Array(size);
    this.moves = new Int16Array(size);
    this.depths = new Uint8Array(size);
    this.flags = new Uint8Array(size);
  }

  probe(key: number, out: TtEntry): boolean {
    const i = key & this.mask;
    if (this.keys[i] !== key) return false;
    this.hits++;
    out.value = this.values[i];
    out.move = this.moves[i];
    out.depth = this.depths[i];
    out.flag = this.flags[i];
    return true;
  }

  store(key: number, value: number, move: number, depth: number, flag: number): void {
    const i = key & this.mask;
    this.keys[i] = key;
    this.values[i] = value;
    this.moves[i] = move;
    this.depths[i] = depth;
    this.flags[i] = flag;
  }

  clear(): void {
    this.keys.fill(0);
    this.hits = 0;
  }
}