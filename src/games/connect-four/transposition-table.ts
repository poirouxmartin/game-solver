/**
 * Table de transposition du solveur Puissance 4 (design Pascal Pons).
 * Direct-mapped : une entrée par index, écrasement sur collision.
 * index = key % size avec size premier et impair, clé partielle = 25 bits bas de key.
 * Comme gcd(size, 2^25) = 1 et 25 + log2(size) = 49 bits, la paire (index, clé partielle)
 * identifie chaque clé de façon unique (théorème des restes chinois) : aucune fausse collision.
 * valeur 0 = entrée vide ; sinon borne inf (>= 38) ou sup (<= 37).
 */
export class ConnectFourTranspositionTable {
  readonly size: number;
  private readonly keys: Uint32Array;
  private readonly values: Uint8Array;

  constructor(logSize = 24) {
    this.size = nextPrime(1 << logSize);
    this.keys = new Uint32Array(this.size);
    this.values = new Uint8Array(this.size);
  }

  get(key: number): number {
    const i = key % this.size;
    return this.keys[i] === (key & 0x1ffffff) ? this.values[i] : 0;
  }

  put(key: number, value: number): void {
    const i = key % this.size;
    this.keys[i] = key & 0x1ffffff;
    this.values[i] = value;
  }

  reset(): void {
    this.keys.fill(0);
  }
}

function nextPrime(n: number): number {
  if (n <= 2) return 2;
  if (n % 2 === 0) n++;
  for (;; n += 2) {
    let prime = true;
    for (let d = 3; d * d <= n; d += 2) {
      if (n % d === 0) {
        prime = false;
        break;
      }
    }
    if (prime) return n;
  }
}