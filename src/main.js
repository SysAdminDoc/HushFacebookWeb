// Boot order matters: settings and network hooks are set up synchronously at
// document-start, before Facebook's first script runs. The settings panel waits for <body>.

import { pageAccess, pageWindow, version, whenRootReady } from './core/env.js';
import { createLog } from './core/log.js';
import { createGmStorage } from './core/storage.js';
import { boot, DUPLICATE } from './boot.js';
import { executionTarget, startGameFrame } from './features/games/frame.js';

const RUNNING = 'data-hushfacebook-web';

// Two copies would wrap fetch twice and draw two panels. The second one stays out of the
// way and leaves a note the first one reports. The mark goes on the page window, which
// exists before <html> does, and on <html>, which copies in other worlds can see.
const RUNNING_KEY = Symbol.for('hushfacebook-web.running');
const target = executionTarget(pageWindow);
if (target === 'game') {
  if (pageAccess === 'page') {
    const log = createLog();
    startGameFrame({ win: pageWindow, storage: createGmStorage({ log }), log });
  }
  else console.warn('[HushFacebook Web] Instant Games ad blocking needs the userscript to run in the page.');
} else if (target === 'facebook') {
  const running = pageWindow[RUNNING_KEY] ?? document.documentElement?.getAttribute(RUNNING);
  if (running) {
    whenRootReady(() => document.documentElement.setAttribute(DUPLICATE, version));
    console.warn(`[HushFacebook Web] v${version} didn't start because v${running} is already running.`);
  } else {
    pageWindow[RUNNING_KEY] = version;
    whenRootReady(() => document.documentElement.setAttribute(RUNNING, version));
    boot({ win: pageWindow, doc: document, access: pageAccess });
  }
}
