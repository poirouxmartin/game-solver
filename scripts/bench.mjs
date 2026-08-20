// Bench NPS du solveur WASM (hors navigateur). Usage : node scripts/bench.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bytes = readFileSync(join(root, 'src', 'games', 'connect-four', 'solver-as.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => {} } });
const e = instance.exports;
e.create(22);

const CASES = [
  { name: 'solve weak 4536', seq: [3, 4, 2, 5], fn: (w) => e.solve(w ? 1 : 0), weak: true },
  { name: 'solve strong 4536', seq: [3, 4, 2, 5], fn: (w) => e.solve(w ? 1 : 0), weak: false },
  { name: 'solve strong d=15', seq: [6, 2, 4, 3, 4, 6, 1, 6, 3, 1, 1, 1, 6, 0, 6], fn: (w) => e.solve(w ? 1 : 0), weak: false },
  { name: 'analyze weak 4536', seq: [3, 4, 2, 5], fn: (w) => e.analyze(w ? 1 : 0), weak: true },
];

for (const c of CASES) {
  e.reset();
  e.clearTT();
  e.resetNodeCount();
  for (const col of c.seq) e.play(col);
  e.resetNodeCount();
  const t0 = performance.now();
  const v = c.fn(c.weak);
  const ms = performance.now() - t0;
  const nodes = Number(e.getNodeCount());
  const nps = Math.round(nodes / (ms / 1000));
  console.log(`${c.name.padEnd(22)} v=${v} ${ms.toFixed(0).padStart(5)} ms ${nodes.toLocaleString('fr-FR').padStart(12)} nœuds  ${nps.toLocaleString('fr-FR').padStart(12)} n/s`);
}