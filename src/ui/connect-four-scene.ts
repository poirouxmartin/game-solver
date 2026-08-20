import Phaser from 'phaser';
import { ConnectFourGame, MIN_ANALYZE_MOVES, type C4Outcome } from '../games/connect-four/game-controller';
import { ConnectFourSolver } from '../games/connect-four/solver';

const SCREEN_W = 480;
const SCREEN_H = 680;

const BOARD_X = 30;
const BOARD_Y = 156;
const CELL = 60;
const SLOT_R = 24;

const COLS = 7;
const ROWS = 6;

const RED = 0xef4444;
const YELLOW = 0xfbbf24;
const SLOT = 0x1e293b;
const SLOT_EDGE = 0x334155;
const HOVER = 0xffffff;
const BADGE_WIN = 0x16a34a;
const BADGE_DRAW = 0xca8a04;
const BADGE_LOSS = 0xdc2626;

const TEXT_STYLE = (size: number, color = '#e2e8f0'): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: `${size}px`,
  color,
});

const slotXY = (col: number, row: number): { x: number; y: number } => ({
  x: BOARD_X + col * CELL + CELL / 2,
  y: BOARD_Y + (ROWS - 1 - row) * CELL + CELL / 2,
});

const outcomeLabel = (o: C4Outcome): string => (o === 'win' ? 'gagne' : o === 'draw' ? 'nulle' : 'perd');

export class ConnectFourScene extends Phaser.Scene {
  private readonly c4 = new ConnectFourGame(new ConnectFourSolver(24));
  private heights = [0, 0, 0, 0, 0, 0, 0];
  private busy = false;
  private analysisOn = true;
  private analyzeMs = 0;
  private analyzeNodes = 0;
  private hoverCol = -1;

  private staticGraphics!: Phaser.GameObjects.Graphics;
  private marks!: Phaser.GameObjects.Graphics;
  private hoverGraphics!: Phaser.GameObjects.Graphics;
  private badgeTexts: Phaser.GameObjects.Text[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private solverText!: Phaser.GameObjects.Text;
  private analysisButton!: Phaser.GameObjects.Text;

  create(): void {
    this.c4.solver.nodeLimit = 30_000_000;
    this.staticGraphics = this.add.graphics();
    this.marks = this.add.graphics();
    this.hoverGraphics = this.add.graphics();
    this.drawBoard();

    this.add
      .text(12, 14, '← Tic-tac-toe', { ...TEXT_STYLE(13, '#94a3b8') })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        window.location.hash = '#/tic-tac-toe';
      });

    this.add.text(SCREEN_W / 2, 30, 'Puissance 4 — solveur', {
      ...TEXT_STYLE(26, '#f8fafc'),
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.statusText = this.add.text(SCREEN_W / 2, 76, '', { ...TEXT_STYLE(20), align: 'center' }).setOrigin(0.5);
    this.solverText = this.add.text(SCREEN_W / 2, 108, '', { ...TEXT_STYLE(13, '#94a3b8'), align: 'center' }).setOrigin(0.5);

    this.analysisButton = this.makeButton(360, 628, 'Analyse', () => {
      this.analysisOn = !this.analysisOn;
      if (this.analysisOn && !this.c4.gameOver) {
        this.c4.analyze();
        this.trackAnalysis();
      }
      this.render();
    });
    this.makeButton(120, 628, 'Nouvelle partie', () => this.newGame());

    this.add.text(SCREEN_W / 2, 662, 'G gagne · N nulle · P perd', {
      ...TEXT_STYLE(13, '#64748b'),
    }).setOrigin(0.5);

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onPointerDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onPointerMove(p));

    this.newGame();
  }

  private newGame(): void {
    this.c4.reset();
    this.heights = [0, 0, 0, 0, 0, 0, 0];
    this.busy = false;
    this.hoverCol = -1;
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

  private drawBoard(): void {
    const g = this.staticGraphics;
    g.fillStyle(SLOT, 1);
    g.lineStyle(2, SLOT_EDGE, 1);
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const { x, y } = slotXY(col, row);
        g.fillCircle(x, y, SLOT_R);
        g.strokeCircle(x, y, SLOT_R);
      }
    }
  }

  private colAt(px: number): number | null {
    const col = Math.floor((px - BOARD_X) / CELL);
    if (col < 0 || col > COLS - 1) return null;
    return col;
  }

  private onPointerDown(p: Phaser.Input.Pointer): void {
    if (this.c4.gameOver || this.busy) return;
    const col = this.colAt(p.x);
    if (col === null || !this.c4.pos.canPlay(col)) return;
    this.c4.playHuman(col);
    this.heights[col]++;
    if (this.c4.gameOver) {
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    this.time.delayedCall(60, () => this.solveStep());
  }

  private solveStep(): void {
    this.c4.analyze();
    this.c4.playSolver();
    this.busy = false;
    if (this.analysisOn && !this.c4.gameOver) {
      this.c4.analyze();
      this.trackAnalysis();
    }
    this.render();
  }

  private trackAnalysis(): void {
    this.analyzeMs = 0;
    this.analyzeNodes = 0;
    if (!this.c4.scores) return;
    this.analyzeMs = this.c4.lastAnalyzeMs;
    this.analyzeNodes = this.c4.lastAnalyzeNodes;
  }

  private onPointerMove(p: Phaser.Input.Pointer): void {
    this.hoverCol = this.colAt(p.x) ?? -1;
    this.renderHover();
  }

  private renderHover(): void {
    this.hoverGraphics.clear();
    if (this.c4.gameOver || this.busy || this.hoverCol < 0 || !this.c4.pos.canPlay(this.hoverCol)) return;
    this.hoverGraphics.fillStyle(HOVER, 0.05);
    this.hoverGraphics.fillRect(BOARD_X + this.hoverCol * CELL, BOARD_Y, CELL, CELL * ROWS);
    this.hoverGraphics.lineStyle(2, HOVER, 0.35);
    const { x, y } = slotXY(this.hoverCol, this.heights[this.hoverCol]);
    this.hoverGraphics.strokeCircle(x, y, SLOT_R + 1);
  }

  private render(): void {
    this.marks.clear();

    const { pos } = this.c4;
    const opp = this.c4.opponentMask();
    const redToMove = this.c4.sideToMoveIsRed();
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const b = col * 7 + row;
        const inMask = b < 32 ? ((pos.maskLo >>> b) & 1) !== 0 : ((pos.maskHi >>> (b - 32)) & 1) !== 0;
        if (!inMask) continue;
        const inCurrent = b < 32 ? ((pos.currentLo >>> b) & 1) !== 0 : ((pos.currentHi >>> (b - 32)) & 1) !== 0;
        const isRed = inCurrent === redToMove;
        const { x, y } = slotXY(col, row);
        this.marks.fillStyle(isRed ? RED : YELLOW, 1);
        this.marks.fillCircle(x, y, SLOT_R - 2);
      }
    }

    for (const t of this.badgeTexts) t.destroy();
    this.badgeTexts = [];

    if (this.analysisOn && !this.c4.gameOver && this.c4.scores) {
      for (let col = 0; col < COLS; col++) {
        if (!this.c4.pos.canPlay(col)) continue;
        const s = this.c4.scores[col];
        const outcome: C4Outcome = s > 0 ? 'win' : s < 0 ? 'loss' : 'draw';
        const color = outcome === 'win' ? BADGE_WIN : outcome === 'draw' ? BADGE_DRAW : BADGE_LOSS;
        const { x, y } = slotXY(col, this.heights[col]);
        this.marks.fillStyle(color, 0.9);
        this.marks.fillCircle(x, y, 25);
        const letter = outcome === 'win' ? 'G' : outcome === 'draw' ? 'N' : 'P';
        this.badgeTexts.push(
          this.add.text(x, y, letter, { ...TEXT_STYLE(18, '#ffffff'), fontStyle: 'bold' }).setOrigin(0.5),
        );
      }
    }

    const outcome = this.c4.outcome();

    this.analysisButton.setText(`Analyse : ${this.analysisOn ? 'ON' : 'OFF'}`);

    let status: string;
    if (this.c4.gameOver) {
      status =
        this.c4.winner === null
          ? 'Partie nulle'
          : this.c4.winner === 'red'
            ? 'Rouge gagne !'
            : 'Jaune gagne !';
    } else if (this.busy) {
      status = 'Le solveur calcule…';
    } else {
      const side = this.c4.sideToMoveIsRed() ? 'Rouge' : 'Jaune';
      status = `À vous (${side})${outcome ? ` · position : ${outcomeLabel(outcome)}` : ''}`;
    }
    this.statusText.setText(status);

    if (this.c4.pos.nbMoves() < MIN_ANALYZE_MOVES) {
      this.solverText.setText('analyse parfaite à partir de 7 coups joués');
    } else if (!this.analysisOn) {
      this.solverText.setText('analyse masquée (bouton Analyse)');
    } else if (this.c4.scores) {
      this.solverText.setText(
        `analyse en ${this.analyzeMs.toFixed(0)} ms · ${this.analyzeNodes.toLocaleString('fr-FR')} nœuds · ${outcome ? `position : ${outcomeLabel(outcome)}` : ''}`,
      );
    } else {
      this.solverText.setText('analyse indisponible');
    }

    this.renderHover();
  }
}
