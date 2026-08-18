import Phaser from 'phaser';
import { TicTacToeScene } from './tic-tac-toe-scene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 480,
  height: 680,
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [TicTacToeScene],
});