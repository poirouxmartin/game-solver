// Génère src/games/connect-four/solver-as.wasm.ts depuis le .wasm compilé.
// Usage : node scripts/gen-wasm-ts.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wasmPath = join(root, 'src', 'games', 'connect-four', 'solver-as.wasm');
const outPath = join(root, 'src', 'games', 'connect-four', 'solver-as.wasm.ts');

const bytes = readFileSync(wasmPath);
const parts = [];
for (let i = 0; i < bytes.length; i += 16) {
  parts.push(bytes.subarray(i, i + 16).join(','));
}
const body = `// Fichier généré — ne pas éditer. Source : solver-as.wasm (AssemblyScript).
// Régénérer avec : npm run build:wasm
export const SOLVER_WASM_BYTES = new Uint8Array([
${parts.map((p) => '  ' + p).join(',\n')}
]);
`;
writeFileSync(outPath, body);
console.log(`OK ${outPath} (${bytes.length} octets)`);