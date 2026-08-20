import type { AnalyzeRequest, AnalyzeResponse } from './solver.worker';

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

/**
 * Pool de workers WASM : analyse des 7 colonnes répartie sur plusieurs cœurs.
 * Expose la même interface (onmessage/postMessage/terminate) qu'un Worker unique.
 */
export class SolverPool {
  onmessage: ((e: MessageEvent<AnalyzeResponse>) => void) | null = null;
  private readonly workers: Worker[];
  private readonly pending = new Map<number, PendingRequest>();
  private lastId = 0;

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
    const batches = distributeCols(this.workers.length, playableCols(req.seq));
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

  terminate(): void {
    this.pending.clear();
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }

  private onWorkerResponse(data: AnalyzeResponse): void {
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