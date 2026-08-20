# game-solver

Solveurs de jeux à information parfaite et somme nulle, prouvés solvables (Puissance 4, et autres).

## Objectif

- Implémenter un solveur (retrograde / minimax avec alpha-bêta, mémorisation) pour plusieurs jeux solvables.
- Une UI par jeu (Phaser / PixiJS).
- Un moteur d'analyse qui étiquette chaque coup possible : `Gagne`, `Perd`, `Nulle`.

## Structure

| Dossier | Description |
|---------|-------------|
| `src/games/<game>/` | Règles + évaluation du jeu |
| `src/solvers/` | Algorithmes de résolution génériques |
| `src/analysis/` | Moteur d'analyse (nature de chaque possibilité) |
| `src/ui/<game>/` | UI d'un jeu |

## Exécution

- `npm run dev` — serveur de dev, puis ouvrir http://localhost:5173.
- Navigation par hash : `#/tic-tac-toe` (défaut), `#/connect-four`.
- `npm run test` — tests Vitest (fixtures connect-four validées contre le solveur en ligne de Pascal Pons).
- `npm run typecheck` / `npm run build` (compile aussi le WASM).
- `npm run build:wasm` — recompile `solver.as.ts` (AssemblyScript) → `solver-as.wasm` + `solver-as.wasm.ts` (octets embarqués).

## Tester Puissance 4

- Joueur humain = **Rouge** (premier joueur), solveur = **Jaune**.
- L'analyse par coup (badges **G** gagne / **N** nulle / **P** perd sur chaque colonne) démarre à partir de 7 coups joués (l'analyse de la position vide coûte ~10 minutes). Le bouton **Analyse** ON/OFF la masque ou la relance.
- L'analyse tourne dans un **pool de Web Workers** (un par cœur, WASM) : les 7 colonnes sont réparties en parallèle, l'interface reste fluide pendant le calcul (budget 8 M de nœuds par worker, repli JS si le WASM est indisponible).
- Avant 7 coups, le solveur joue l'heuristique sûre `possibleNonLosingMoves` + ordre central.
- Bouton **Nouvelle partie** pour relancer une partie.
