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
