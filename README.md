# game-solver

Solvers for two-player, zero-sum, perfect-information games. An engine looks for a good move in
a given time; a solver returns the exact value of a position, assuming nobody makes another
mistake, and only answers once it has proved it.

Project page: [martinpoiroux.com/en/projects/game-solver](https://martinpoiroux.com/en/projects/game-solver/)

## Games

- **Tic-tac-toe**: solved in a handful of nodes.
- **Connect 4**: the real target. Every playable column is labelled **W** (win), **D** (draw)
  or **L** (loss) for the side to move.

## How it works

- Memoised negamax alpha-beta on a bitboard (`src/core/`, `src/games/connect-four/`).
- The hot loop is written in AssemblyScript and compiled to WebAssembly
  (`solver.as.ts` -> `solver-as.wasm`), with a plain TypeScript fallback.
- Analysis runs in a pool of Web Workers, one per core and one column each, so the UI stays
  responsive. Budget: 8 M nodes per worker.
- An experimental WebGPU path (`gpu/`), used by the Connect 4 view when a GPU adapter is available.
- The empty Connect 4 position costs about ten minutes to solve, so per-move analysis starts at
  move 7; before that the solver plays a safe heuristic (centre first, never enter a losing line).

Correctness is not judged by eye: test positions are checked against Pascal Pons' reference
solver.

## Run

```bash
npm install
npm run dev          # http://localhost:5173, #/tic-tac-toe or #/connect-four
npm test             # Vitest
npm run typecheck
npm run build        # also compiles the WASM module
```

## License

MIT
