// Boot order matters: settings and network hooks are set up synchronously at
// document-start, before Facebook's first script runs. The settings panel waits for <body>.

import { managerInfo, pageAccess, pageWindow, registerMenuCommand, version, whenBodyReady, whenRootReady } from './core/env.js';
import { createActions } from './core/actions.js';
import { availableUpdate, UPDATE_KEY, UPDATE_TOLD_KEY } from './core/extension.js';
import { createDiagnostics, hideListener } from './core/diagnostics.js';
import { createHider, hideCss } from './core/dom/hide.js';
import { createPostTracker, postIdOf } from './core/dom/posts.js';
import { createLog } from './core/log.js';
import { installNetworkHooks } from './core/net/hooks.js';
import { createRouter } from './core/route.js';
import { accountFromCookie, createSettings } from './core/settings.js';
import { createGmStorage, keepsSettings, UNKEPT_SETTINGS } from './core/storage.js';
import { keepOutOfStorageReport } from './core/storage-report.js';
import { createDailyTasks, pageMirror, scheduleStorageCheck, whenMirrorReady } from './core/tasks.js';
import { mountFeatureStyles } from './core/style.js';
import { features } from './features/index.js';
import { executionTarget, startGameFrame } from './features/games/frame.js';
import { keepKeysInPanel } from './ui/keys.js';
import { installLogoLongPress } from './ui/logo-long-press.js';
import { mountPanel } from './ui/panel.js';

// Which Facebook account is signed in, from its c_user cookie, so each one keeps its own
// settings. null when signed out or when the cookie can't be read.
function signedInAccount() {
  try {
    return accountFromCookie(document.cookie);
  } catch {
    return null;
  }
}

const RUNNING = 'data-hushfacebook-web';
const DUPLICATE = 'data-hushfacebook-web-duplicate';

function boot() {
  // First, so Facebook's keyboard shortcuts never see what's typed in the settings panel.
  keepKeysInPanel(pageWindow);
  const log = createLog();
  const storage = createGmStorage({ log });
  const account = signedInAccount();
  const settings = createSettings({ storage, features, log, version, account });
  const net = pageAccess === 'page' ? installNetworkHooks({
    win: pageWindow,
    log,
    startup: {
      status: settings.startup.status,
      onStatus: settings.startup.onStatus,
      accountMatches: () => settings.startup.matchesAccount(signedInAccount()),
    },
  }) : null;
  const router = createRouter({ win: pageWindow, pageAccess, log });
  const posts = createPostTracker({ doc: document, log });
  const diagnostics = createDiagnostics();
  const hider = createHider({
    doc: document, posts, log,
    notesShown: () => settings.get('paused') !== true && settings.get('ui.hiddenNote') === true,
    onHide: hideListener(diagnostics, postIdOf),
  });
  settings.subscribe(() => hider.refresh());
  // Fixed wording only, so these go in Copy report as they read.
  const shareable = { shareable: true };
  diagnostics.add('Settings kept for', () => (settings.perAccount ? 'This Facebook account' : 'Everyone on this browser (signed out)'), shareable);
  diagnostics.add('Settings kept in', () => ({ gm: 'Your userscript manager', extension: "The extension's own storage" })[storage.kind] ?? "Facebook's page, which clears them", shareable);
  if (storage.status) {
    diagnostics.add('Saved settings', () => ({ loading: 'Loading', ready: 'Loaded', error: 'Unavailable. Open General to retry.' })[storage.status().state] ?? 'Unavailable', shareable);
    diagnostics.add('Startup privacy protection', () => ({
      loading: 'Waiting for saved choices',
      ready: 'Confirmed',
      error: 'Unconfirmed. Recognized requests are held back. Open General to retry.',
    })[net?.startupState?.() ?? settings.startup.status()] ?? 'Unconfirmed', shareable);
    storage.onStatus(() => diagnostics.changed());
  }
  const actions = createActions();
  const unavailable = new Set();
  // Toasts wait for the panel, which mounts once there's a body.
  let panel = null;
  let pendingSettingsOpen = false;
  let pendingSettingsSection;
  const waiting = [];
  const toast = (message, options) => (panel ? panel.toast(message, options) : waiting.push([message, options]));
  const openSettings = (section) => whenBodyReady(() => {
    if (panel) panel.open(section);
    else {
      pendingSettingsOpen = true;
      pendingSettingsSection = section;
    }
  });
  installLogoLongPress({ doc: document, openSettings });

  if (!net) {
    log.warn('Your userscript manager is running HushFacebook Web as a content script, so features that need the page are off. Diagnostics has the details.');
  }
  // The script's marks for the tab stay out of the storage report Facebook's page sends home.
  if (net) keepOutOfStorageReport({ win: pageWindow, log, diagnostics });
  if (!keepsSettings(storage)) {
    log.warn(UNKEPT_SETTINGS);
    toast(UNKEPT_SETTINGS, { tone: 'error' });
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
        actions: actions.for(feature.id),
        storage,
        router,
        posts,
        hider,
        log,
        toast,
        openSettings,
        // A feature that stops working after setup says so, the same as one that couldn't start.
        markUnavailable: () => {
          unavailable.add(feature.id);
          panel?.refresh();
        },
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

  // Daily jobs wait until the page has settled and the page's copy of the check is read.
  const tasks = createDailyTasks({ storage, log });
  const mirror = pageMirror(globalThis);
  scheduleStorageCheck({ tasks, storage, mirror, log, toast, diagnostics });
  setTimeout(() => whenMirrorReady(mirror, () => tasks.runDue()), 8000);

  // The extension can't update itself, so a newer release gets one toast and a card in General.
  const update = storage.kind === 'extension' ? () => availableUpdate(storage) : null;
  if (update) {
    storage.onChange(UPDATE_KEY, () => panel?.refresh());
    storage.whenReady(() => {
      const found = update();
      if (!found || storage.get(UPDATE_TOLD_KEY, null) === found.version) return;
      storage.set(UPDATE_TOLD_KEY, found.version);
      toast(`HushFacebook Web ${found.version} is out.`, { action: { label: 'How to update', run: () => whenBodyReady(() => panel?.open('general')) } });
    });
  }

  whenBodyReady(() => {
    panel = mountPanel({
      settings, features, log, hider, diagnostics, actions, unavailable,
      environment: { version, ...managerInfo(), update, storage, accountMatches: () => settings.startup.matchesAccount(signedInAccount()) },
    });
    for (const [message, options] of waiting.splice(0)) panel.toast(message, options);
    if (pendingSettingsOpen) {
      panel.open(pendingSettingsSection);
      pendingSettingsOpen = false;
    }
    // Any script on the page can write the mark, so only a version number goes in the message.
    const other = document.documentElement.getAttribute(DUPLICATE);
    const otherVersion = /^\d+(?:\.\d+){0,3}$/.test(other ?? '') ? ` (v${other})` : '';
    if (other) log.warn(`A second copy of HushFacebook Web${otherVersion} is installed. Turn one off in your userscript manager or on the browser's extensions page.`);
  });
  registerMenuCommand('HushFacebook Web settings', () => openSettings());

  log.info(`v${version} started (${pageAccess} mode)`);
}

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
    boot();
  }
}
