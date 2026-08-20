import Phaser from 'phaser';
import { analyzePosition, outcomeOfValue, type PositionAnalysis } from '../core/analysis';
import { NegamaxSolver } from '../core/negamax';
import {
  cellOfMove,
  EMPTY_STATE,
  evaluate,
  isFull,
  play,
  remainingPlies,
  ticTacToeGame,
  turn,
  xMask,
  oMask,
  type TicTacToeState,
} from '../games/tic-tac-toe/game';

const WIDTH = 480;
const HEIGHT = 680;

const X0 = 20;
const Y0 = 150;
const CELL = 140;
const GAP = 10;

const GRID_COLOR = 0x334155;
const X_COLOR = 0x38bdf8;
const O_COLOR = 0xfbbf24;
const BADGE_WIN = 0x16a34a;
const BADGE_DRAW = 0xca8a04;
const BADGE_LOSS = 0xdc2626;

const TEXT_STYLE = (size: number, color = '#e2e8f0'): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: `${size}px`,
  color,
});

export class TicTacToeScene extends Phaser.Scene {
  private readonly solver = new NegamaxSolver(ticTacToeGame);
  private state: TicTacToeState = EMPTY_STATE;
  private gameOver = false;
  private busy = false;
  private analysisOn = true;

  private marks!: Phaser.GameObjects.Graphics;
  private badgeTexts: Phaser.GameObjects.Text[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private solverText!: Phaser.GameObjects.Text;
  private analysisButton!: Phaser.GameObjects.Text;

  create(): void {
    this.marks = this.add.graphics();
    this.drawGrid();

    this.add
      .text(WIDTH - 12, 14, 'Puissance 4 →', { ...TEXT_STYLE(13, '#94a3b8') })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        window.location.hash = '#/connect-four';
      });

    this.add.text(WIDTH / 2, 30, 'Tic-tac-toe — solveur', {
      ...TEXT_STYLE(26, '#f8fafc'),
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.statusText = this.add.text(WIDTH / 2, 76, '', { ...TEXT_STYLE(20), align: 'center' }).setOrigin(0.5);
    this.solverText = this.add.text(WIDTH / 2, 108, '', { ...TEXT_STYLE(13, '#94a3b8'), align: 'center' }).setOrigin(0.5);

    this.analysisButton = this.makeButton(360, 628, 'Analyse', () => {
      this.analysisOn = !this.analysisOn;
      this.render();
    });
    this.makeButton(120, 628, 'Nouvelle partie', () => this.newGame());

    this.add.text(WIDTH / 2, 662, 'G gagne · N nulle · P perd', {
      ...TEXT_STYLE(13, '#64748b'),
    }).setOrigin(0.5);

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onPointerDown(p));

    this.solveAll();
    this.newGame();
  }

  private solveAll(): void {
    const t0 = performance.now();
    const value = this.solver.solve(EMPTY_STATE, 9);
    const ms = performance.now() - t0;
    this.solverText.setText(
      `solution complète en ${ms.toFixed(1)} ms · ${this.solver.lastStats.nodes} nœuds · valeur : ${outcomeOfValue(value)}`,
    );
  }

  private newGame(): void {
    this.state = EMPTY_STATE;
    this.gameOver = false;
    this.busy = false;
    this.render();
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void): Phaser.GameObjects.Text {
    const btn = this.add
      .text(x, y, label, {
        ...TEXT_STYLE(16, '#cbd5e1'),
        backgroundColor: '#1e293b',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerdown', onClick);
    return btn;
  }

  private drawGrid(): void {
    const g = this.add.graphics();
    g.lineStyle(4, GRID_COLOR, 1);
    for (let i = 1; i < 3; i++) {
      const p = X0 + i * (CELL + GAP) - GAP / 2;
      g.lineBetween(p, Y0, p, Y0 + 3 * CELL + 2 * GAP);
      const q = Y0 + i * (CELL + GAP) - GAP / 2;
      g.lineBetween(X0, q, X0 + 3 * CELL + 2 * GAP, q);
    }
  }

  private cellAt(px: number, py: number): number | null {
    const col = Math.floor((px - X0) / (CELL + GAP));
    const row = Math.floor((py - Y0) / (CELL + GAP));
    if (row < 0 || row > 2 || col < 0 || col > 2) return null;
    const cx = X0 + col * (CELL + GAP);
    const cy = Y0 + row * (CELL + GAP);
    if (px < cx || px > cx + CELL || py < cy || py > cy + CELL) return null;
    return row * 3 + col;
  }

  private centerOf(cell: number): { x: number; y: number } {
    const col = cell % 3;
    const row = Math.floor(cell / 3);
    return { x: X0 + col * (CELL + GAP) + CELL / 2, y: Y0 + row * (CELL + GAP) + CELL / 2 };
  }

  private onPointerDown(p: Phaser.Input.Pointer): void {
    if (this.gameOver || this.busy) return;
    const cell = this.cellAt(p.x, p.y);
    if (cell === null) return;
    const move = 1 << cell;
    if (!ticTacToeGame.isLegal(this.state, move)) return;

    this.state = play(this.state, move);
    if (this.finishIfGameOver()) {
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    this.time.delayedCall(60, () => this.solverMove());
  }

  private solverMove(): void {
    const analysis = this.analyze();
    const move = analysis.best[0];
    this.state = play(this.state, move);
    this.busy = false;
    this.finishIfGameOver();
    this.render();
  }

  private finishIfGameOver(): boolean {
    if (evaluate(this.state) === null) return false;
    this.gameOver = true;
    return true;
  }

  private analyze(): PositionAnalysis {
    return analyzePosition(ticTacToeGame, this.solver, this.state, remainingPlies(this.state));
  }

  private render(): void {
    this.marks.clear();

    const x = xMask(this.state);
    const o = oMask(this.state);
    for (let cell = 0; cell < 9; cell++) {
      const bit = 1 << cell;
      const { x: cx, y: cy } = this.centerOf(cell);
      if (x & bit) this.drawX(cx, cy);
      else if (o & bit) this.drawO(cx, cy);
    }

    for (const t of this.badgeTexts) t.destroy();
    this.badgeTexts = [];

    let outcomeLabel: string | null = null;
    if (this.analysisOn && !this.gameOver) {
      const analysis = this.analyze();
      outcomeLabel = analysis.outcome === 'win' ? 'gagne' : analysis.outcome === 'draw' ? 'nulle' : 'perd';
      const outcomeMap = new Map(analysis.moves.map((m) => [m.move, m.outcome]));
      for (let cell = 0; cell < 9; cell++) {
        const bit = 1 << cell;
        if ((x | o) & bit) continue;
        const outcome = outcomeMap.get(bit);
        if (outcome === undefined) continue;
        const { x: cx, y: cy } = this.centerOf(cell);
        const color = outcome === 'win' ? BADGE_WIN : outcome === 'draw' ? BADGE_DRAW : BADGE_LOSS;
        this.marks.fillStyle(color, 0.9);
        this.marks.fillCircle(cx, cy, 22);
        const letter = outcome === 'win' ? 'G' : outcome === 'draw' ? 'N' : 'P';
        this.badgeTexts.push(
          this.add.text(cx, cy, letter, { ...TEXT_STYLE(18, '#ffffff'), fontStyle: 'bold' }).setOrigin(0.5),
        );
      }
    }

    this.analysisButton.setText(`Analyse : ${this.analysisOn ? 'ON' : 'OFF'}`);

    let status: string;
    if (this.gameOver) {
      status = isFull(this.state) ? 'Partie nulle' : `${turn(this.state) === 'x' ? 'O' : 'X'} gagne !`;
    } else if (this.busy) {
      status = 'Le solveur calcule…';
    } else {
      status = `À vous (${turn(this.state).toUpperCase()})${outcomeLabel ? ` · position : ${outcomeLabel}` : ''}`;
    }
    this.statusText.setText(status);
  }

  private drawX(cx: number, cy: number): void {
    this.marks.lineStyle(10, X_COLOR, 1);
    this.marks.lineBetween(cx - 44, cy - 44, cx + 44, cy + 44);
    this.marks.lineBetween(cx + 44, cy - 44, cx - 44, cy + 44);
  }

  private drawO(cx: number, cy: number): void {
    this.marks.lineStyle(10, O_COLOR, 1);
    this.marks.strokeCircle(cx, cy, 48);
  }
}