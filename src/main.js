// Boot order matters: settings and network hooks are set up synchronously at
// document-start, before Facebook's first script runs. The settings panel waits for <body>.

import { managerInfo, pageAccess, pageWindow, registerMenuCommand, version, whenBodyReady, whenRootReady } from './core/env.js';
import { createDiagnostics } from './core/diagnostics.js';
import { createHider, hideCss } from './core/dom/hide.js';
import { createPostTracker } from './core/dom/posts.js';
import { createLog } from './core/log.js';
import { installNetworkHooks } from './core/net/hooks.js';
import { createRouter } from './core/route.js';
import { createSettings } from './core/settings.js';
import { createGmStorage } from './core/storage.js';
import { mountFeatureStyles } from './core/style.js';
import { features } from './features/index.js';
import { mountPanel } from './ui/panel.js';

const RUNNING = 'data-hushfacebook-web';
const DUPLICATE = 'data-hushfacebook-web-duplicate';

function boot() {
  const log = createLog();
  const settings = createSettings({ storage: createGmStorage(), features, log, version });
  const net = pageAccess === 'page' ? installNetworkHooks({ win: pageWindow, log }) : null;
  const router = createRouter({ win: pageWindow, pageAccess, log });
  const posts = createPostTracker({ doc: document, log });
  const hider = createHider({
    doc: document, posts, log,
    notesShown: () => settings.get('paused') !== true && settings.get('ui.hiddenNote') === true,
  });
  const diagnostics = createDiagnostics();
  const unavailable = new Set();

  if (!net) {
    log.warn('Your userscript manager is running HushFacebook Web as a content script, so features that need the page are off. Diagnostics has the details.');
  }

  for (const feature of features) {
    if (feature.needsPage && !net) {
      unavailable.add(feature.id);
      continue;
    }
    if (!feature.setup) continue;
    try {
      feature.setup({
        win: pageWindow,
        doc: document,
        net,
        diagnostics,
        router,
        posts,
        hider,
        log,
        settings,
        enabled: () => settings.enabled(feature.id),
        option: (key) => settings.get(`${feature.id}.${key}`),
      });
    } catch (error) {
      unavailable.add(feature.id);
      log.error(`${feature.title} couldn't start`, error);
    }
  }

  mountFeatureStyles({ features, settings, log, base: [{ id: 'hidden posts', css: (get) => hideCss({ notes: get('ui.hiddenNote') === true }) }] });

  let panel = null;
  whenBodyReady(() => {
    panel = mountPanel({ settings, features, log, hider, diagnostics, unavailable, environment: { version, ...managerInfo() } });
    const other = document.documentElement.getAttribute(DUPLICATE);
    if (other) log.warn(`A second copy of HushFacebook Web (v${other}) is installed. Turn one off in your userscript manager.`);
  });
  registerMenuCommand('HushFacebook Web settings', () => whenBodyReady(() => panel?.open()));

  log.info(`v${version} started (${pageAccess} mode)`);
}

// Two copies would wrap fetch twice and draw two panels. The second one stays out of the
// way and leaves a note the first one reports. The mark goes on the page window, which
// exists before <html> does, and on <html>, which copies in other worlds can see.
const RUNNING_KEY = Symbol.for('hushfacebook-web.running');
const running = pageWindow[RUNNING_KEY] ?? document.documentElement?.getAttribute(RUNNING);
if (running) {
  whenRootReady(() => document.documentElement.setAttribute(DUPLICATE, version));
  console.warn(`[HushFacebook Web] v${version} didn't start because v${running} is already running.`);
} else {
  pageWindow[RUNNING_KEY] = version;
  whenRootReady(() => document.documentElement.setAttribute(RUNNING, version));
  boot();
}
