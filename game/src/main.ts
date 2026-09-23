// Boot and wiring (GAME_DESIGN.md §9.4). Owner: O3.
// createApp() builds every module through its §10.4 interface and runs the state machine.
import './ui/tokens.css';
import './ui/styles.css';
import { createApp } from './core/app';
import { installTestHooks } from './core/debug';

function boot(): void {
  const root = document.getElementById('app') ?? document.body;
  try {
    const app = createApp(root);
    installTestHooks({
      playReplay: (levelId, b64) => app.playReplay(levelId, b64),
      state: () => app.debugState(),
      command: (c) => app.command(c),
      toScreen: (x, y) => app.toScreen(x, y),
    });
  } catch (e) {
    console.error('[yurapita] failed to start', e);
    installTestHooks({ state: () => ({ state: 'ERROR', error: String(e) }) });
    const msg = document.createElement('p');
    msg.textContent = 'ゆらしてピタッ を起動できませんでした / Swing & Stick could not start.';
    msg.style.cssText = 'font: 16px system-ui; padding: 24px; text-align: center';
    root.appendChild(msg);
  }
}

boot();
