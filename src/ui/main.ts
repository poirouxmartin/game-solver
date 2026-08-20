import Phaser from 'phaser';
import { ConnectFourScene } from './connect-four-scene';
import { TicTacToeScene } from './tic-tac-toe-scene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 480,
  height: 680,
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [TicTacToeScene, ConnectFourScene],
});

const TTT_KEY = 'TicTacToeScene';
const C4_KEY = 'ConnectFourScene';

function route(): void {
  const target = window.location.hash.startsWith('#/connect-four') ? C4_KEY : TTT_KEY;
  if (game.scene.isActive(target)) return;
  game.scene.stop(TTT_KEY);
  game.scene.stop(C4_KEY);
  game.scene.start(target);
}

window.addEventListener('hashchange', route);
window.setTimeout(route, 50);