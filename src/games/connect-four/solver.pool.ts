import type { AnalyzeRequest, AnalyzeResponse } from './solver.worker';
import type { ConnectFourPosition } from './position';

const WIDTH = 7;
const ROWS = 6;

/** Colonnes jouables d'une séquence de coups (hauteur < 6). */
export const playableCols = (seq: number[]): number[] => {
  const height = new Array(WIDTH).fill(0);
  for (const col of seq) height[col]++;
  return Array.from({ length: WIDTH }, (_, col) => col).filter((col) => height[col] < ROWS);
};

/** Répartit des colonnes en paquets (rond-robin) sur `numWorkers` workers. */
export const distributeCols = (numWorkers: number, cols: number[]): number[][] => {
  const buckets = Array.from({ length: numWorkers }, () => [] as number[]);
  cols.forEach((col, i) => buckets[i % numWorkers].push(col));
  return buckets;
};

interface PendingRequest {
  outstanding: number;
  totalNodes: number;
  maxMs: number;
  anyNull: boolean;
  scores: (number | null)[];
}

interface LeafPending {
  parts: number[][];
  outstanding: number;
  resolve: (values: number[]) => void;
}

/**
 * Feuille à évaluer par l'étage approximatif (bitboards + budget).
 * Structurellement compatible avec LeafJob de gpu/gpu-engine.
 */
export interface PoolLeafJob {
  pos: ConnectFourPosition;
  budget: number;
}

/**
 * Pool de workers WASM : analyse des 7 colonnes répartie sur plusieurs cœurs.
 * Expose la même interface (onmessage/postMessage/terminate) qu'un Worker unique.
 */
export class SolverPool {
  onmessage: ((e: MessageEvent<AnalyzeResponse>) => void) | null = null;
  private readonly workers: Worker[];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly leafPending = new Map<number, LeafPending>();
  private lastId = 0;
  private leafSeq = 0;

  constructor(numWorkers = 4) {
    const n = Math.min(Math.max(1, numWorkers), WIDTH);
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<AnalyzeResponse>) => this.onWorkerResponse(e.data);
      this.workers.push(w);
    }
  }

  postMessage(req: AnalyzeRequest): void {
    const batches = distributeCols(this.workers.length, playableCols(req.seq ?? []));
    const pending: PendingRequest = {
      outstanding: batches.filter((b) => b.length > 0).length,
      totalNodes: 0,
      maxMs: 0,
      anyNull: false,
      scores: new Array(WIDTH).fill(null),
    };
    this.pending.set(req.id, pending);
    this.lastId = Math.max(this.lastId, req.id);
    for (let i = 0; i < batches.length; i++) {
      if (batches[i].length > 0) {
        this.workers[i].postMessage({ id: req.id, seq: req.seq, cols: batches[i] });
      }
    }
    if (pending.outstanding === 0) {
      this.pending.delete(req.id);
      this.dispatch({ id: req.id, cols: [], scores: null, ms: 0, nodes: 0 });
    }
  }

  /**
   * Évalue des feuilles en parallèle sur les workers (étage approximatif).
   * Résolu avec les valeurs dans l'ordre des jobs. Ids négatifs : jamais en
   * collision avec les ids d'analyse exacte du scène.
   */
  analyzeLeaves(jobs: PoolLeafJob[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      if (this.workers.length === 0) {
        reject(new Error('pool terminé'));
        return;
      }
      const id = -(++this.leafSeq);
      const n = this.workers.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const p = j.pos;
        chunks[i % n].push(
          p.currentLo,
          p.currentHi,
          p.maskLo,
          p.maskHi,
          p.nbMoves(),
          j.budget,
        );
      }
      let outstanding = 0;
      for (const c of chunks) if (c.length > 0) outstanding++;
      this.leafPending.set(id, { parts: new Array(n), outstanding, resolve });
      for (let w = 0; w < n; w++) {
        if (chunks[w].length > 0) {
          this.workers[w].postMessage({ id, leaves: chunks[w], part: w } satisfies AnalyzeRequest & { part: number });
        }
      }
      if (outstanding === 0) {
        this.leafPending.delete(id);
        resolve([]);
      }
    });
  }

  terminate(): void {
    this.pending.clear();
    this.leafPending.clear();
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }

  private onWorkerResponse(data: AnalyzeResponse): void {
    const leaf = this.leafPending.get(data.id);
    if (leaf) {
      leaf.parts[data.part ?? 0] = data.values ?? [];
      if (--leaf.outstanding <= 0) {
        this.leafPending.delete(data.id);
        const n = leaf.parts.length;
        const out: number[] = [];
        for (let t = 0; ; t++) {
          let any = false;
          for (let w = 0; w < n; w++) {
            const v = leaf.parts[w]?.[t];
            if (v !== undefined) {
              out.push(v);
              any = true;
            }
          }
          if (!any) break;
        }
        leaf.resolve(out);
      }
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    pending.outstanding--;
    pending.totalNodes += data.nodes;
    pending.maxMs = Math.max(pending.maxMs, data.ms);
    if (data.scores === null) {
      pending.anyNull = true;
    } else {
      for (let i = 0; i < data.cols.length; i++) {
        pending.scores[data.cols[i]] = data.scores[i];
      }
    }
    if (pending.outstanding > 0) return;
    this.pending.delete(data.id);
    this.dispatch({
      id: data.id,
      cols: [],
      scores: pending.anyNull ? null : (pending.scores as number[]),
      ms: pending.maxMs,
      nodes: pending.totalNodes,
    });
  }

  private dispatch(response: AnalyzeResponse): void {
    if (this.onmessage) this.onmessage({ data: response } as MessageEvent<AnalyzeResponse>);
  }
}