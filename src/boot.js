// The script's start in one Facebook tab: settings, network hooks, features and the settings
// panel. main.js decides whether this tab gets it at all.

import { managerInfo, registerMenuCommand, version, whenBodyReady } from './core/env.js';
import { createActions } from './core/actions.js';
import { ACCOUNT_CHANGED, createActivityStorage } from './core/activity.js';
import { availableUpdate, extensionHost, UPDATE_KEY, UPDATE_TOLD_KEY, updateStatus } from './core/extension.js';
import { createDiagnostics, hideListener } from './core/diagnostics.js';
import { setLanguage, t } from './core/i18n.js';
import { createHider, hideCss } from './core/dom/hide.js';
import { createPostTracker, postIdOf } from './core/dom/posts.js';
import { createLog } from './core/log.js';
import { LOAD_WAIT_MS, readTabPause, setTabPause, watchFeedLoads } from './core/load-watchdog.js';
import { installNetworkHooks } from './core/net/hooks.js';
import { createRouter } from './core/route.js';
import { startFeatures } from './core/start-features.js';
import { accountFromCookie, createSettings } from './core/settings.js';
import { createGmStorage, keepsSettings, UNKEPT_SETTINGS } from './core/storage.js';
import { keepOutOfStorageReport } from './core/storage-report.js';
import { createDailyTasks, pageMirror, scheduleStorageCheck, whenMirrorReady } from './core/tasks.js';
import { mountFeatureStyles } from './core/style.js';
import { features as allFeatures } from './features/index.js';
import { keepKeysInPanel } from './ui/keys.js';
import { installLogoLongPress } from './ui/logo-long-press.js';
import { mountPanel } from './ui/panel.js';

export const DUPLICATE = 'data-hushfacebook-web-duplicate';

// Which Facebook account is signed in, from its c_user cookie, so each one keeps its own
// settings. null when signed out or when the cookie can't be read.
function signedInAccount(doc) {
  try {
    return accountFromCookie(doc.cookie);
  } catch {
    return null;
  }
}

// Starts the script in one Facebook tab and hands back what it set up. win is Facebook's own
// window, doc its document, access 'page' or 'content' (env.js), own the script's own global.
export function boot({ win, doc, access, own = globalThis, features = allFeatures }) {
  // First, so Facebook's keyboard shortcuts never see what's typed in the settings panel.
  keepKeysInPanel(win);
  const log = createLog();
  const storage = createGmStorage({ log });
  const account = signedInAccount(doc);
  // Paused for this tab after a feed that wouldn't load: only the settings panel and what it
  // needs. No network hooks, no history wrap, no listeners for hidden posts, no feature styles
  // and no features. The storage report guard stays, since it keeps the pause mark itself out
  // of what Facebook's page reports. A game frame in the tab keeps its own setting: it's on its
  // own origin, so it can't see the tab's mark, and it only answers its game's ad calls.
  const tabPaused = readTabPause(win);
  const settings = createSettings({ storage, features, log, version, account, tabPaused });
  // Before any feature's own listeners, so the notices they raise come in the chosen language.
  const followLanguage = () => setLanguage(settings.get('ui.language'));
  settings.whenLoaded(followLanguage);
  settings.subscribe(followLanguage);
  const net = access === 'page' && !tabPaused ? installNetworkHooks({
    win,
    log,
    startup: {
      status: settings.startup.status,
      onStatus: settings.startup.onStatus,
      accountMatches: () => settings.startup.matchesAccount(signedInAccount(doc)),
    },
  }) : null;
  const router = tabPaused ? null : createRouter({ win, pageAccess: access, log });
  const posts = createPostTracker({ doc, log });
  const diagnostics = createDiagnostics();
  const hider = tabPaused ? null : createHider({
    doc, posts, log,
    notesShown: () => settings.get('paused') !== true && settings.get('ui.hiddenNote') === true,
    onHide: hideListener(diagnostics, postIdOf),
  });
  if (hider) settings.subscribe(() => hider.refresh());
  // Fixed wording only, so these go in Copy report as they read.
  const shareable = { shareable: true };
  diagnostics.add('Settings kept for', () => (settings.perAccount ? 'This Facebook account' : 'Everyone on this browser (signed out)'), shareable);
  diagnostics.add('Settings kept in', () => ({ gm: 'Your userscript manager', extension: "The extension's own storage" })[storage.kind] ?? "Facebook's page, which clears them", shareable);
  if (storage.status) {
    diagnostics.add('Saved settings', () => ({ loading: 'Loading', ready: 'Loaded', error: 'Unavailable. Open General to retry.' })[storage.status().state] ?? 'Unavailable', shareable);
    // A tab paused for itself installed no hooks, so there's nothing to confirm.
    diagnostics.add('Startup privacy protection', () => (tabPaused ? 'Paused in this tab' : ({
      loading: 'Waiting for saved choices',
      ready: 'Confirmed',
      error: 'Unconfirmed. Recognized requests are held back. Open General to retry.',
    })[net?.startupState?.() ?? settings.startup.status()] ?? 'Unconfirmed'), shareable);
    storage.onStatus(() => diagnostics.changed());
  }
  // A count only, so it goes in Copy report too. See LINE_LIMIT in payload.js.
  if (net) {
    diagnostics.add('Answers too long to filter', () => {
      const count = net.lineStats.oversized;
      return count ? `${count} passed through as Facebook sent ${count === 1 ? 'it' : 'them'}` : 'None in this tab';
    }, shareable);
  }
  const actions = createActions();
  // Feature id to why it isn't running (see startFeatures).
  const unavailable = new Map();
  // Toasts wait for the panel, which mounts once there's a body.
  let panel = null;
  let pendingSettingsOpen = false;
  let pendingSettingsSection;
  const waiting = [];
  // Hands back { dismiss }, which works on a notice still waiting for the panel too.
  const toast = (message, options) => {
    if (panel) return panel.toast(message, options);
    const entry = { message, options, shown: null, gone: false };
    waiting.push(entry);
    return {
      dismiss() {
        entry.gone = true;
        entry.shown?.dismiss();
      },
    };
  };
  const openSettings = (section) => whenBodyReady(() => {
    if (panel) panel.open(section);
    else {
      pendingSettingsOpen = true;
      pendingSettingsSection = section;
    }
  }, doc);
  installLogoLongPress({ doc, openSettings });

  // Seen posts and playback state are kept for each account too. They stop saving once the
  // page is signed in to someone else, which a page change or coming back to the tab checks.
  const activity = createActivityStorage({
    storage, account, currentAccount: () => signedInAccount(doc), log,
    onSwitch: () => {
      panel?.refresh();
      toast(() => `${t(ACCOUNT_CHANGED)}.`, { action: { label: 'Reload', run: () => win.location.reload() }, duration: 20000 });
    },
  });
  activity.watch({ router, doc });
  diagnostics.add('Activity kept for', () => (activity.switched()
    ? 'Nobody until you reload, since the account changed'
    : activity.perAccount ? 'This Facebook account' : 'This browser while signed out'), shareable);

  if (access !== 'page') {
    log.warn('Your userscript manager is running HushFacebook Web as a content script, so features that need the page are off. Diagnostics has the details.');
  }
  // The script's marks for the tab stay out of the storage report Facebook's page sends home.
  if (access === 'page') keepOutOfStorageReport({ win, log, diagnostics });
  if (!keepsSettings(storage)) {
    log.warn(UNKEPT_SETTINGS);
    toast(() => t(UNKEPT_SETTINGS), { tone: 'error' });
  }

  const resumeTab = () => {
    try {
      setTabPause(win, false);
    } catch (error) {
      log.error("Couldn't clear this tab's pause", error);
      toast(() => t("Couldn't turn it back on in this tab. Facebook opened in a new tab runs it as usual."), { tone: 'error' });
      return;
    }
    win.location.reload();
  };
  const pauseTab = () => {
    try {
      setTabPause(win, true);
    } catch (error) {
      log.error("Couldn't pause HushFacebook Web for this tab", error);
      toast(() => t("Couldn't pause for this tab. The switch at the top of the settings pauses it everywhere."), { tone: 'error' });
      return;
    }
    win.location.reload();
  };
  if (tabPaused) {
    log.info('Paused in this tab, so only the settings panel is running');
    toast(() => t('HushFacebook Web is paused in this tab.'), { action: { label: 'Turn back on', run: resumeTab }, duration: 10000 });
    diagnostics.add('Feed load check', () => 'Paused in this tab', shareable);
  } else {
    const loads = watchFeedLoads({
      win, doc, router, log,
      signedIn: () => signedInAccount(doc) !== null,
      paused: () => settings.get('paused') === true,
      onStuck: () => {
        diagnostics.changed();
        toast(() => t("Facebook's feed is still loading after {seconds} seconds. If HushFacebook Web is getting in the way, pause it for this tab.", { seconds: LOAD_WAIT_MS / 1000 }), {
          duration: 60000,
          actions: [
            { label: 'Pause for this tab', run: pauseTab },
            { label: 'Copy report', run: () => panel?.copyReport(), keep: true },
          ],
        });
      },
    });
    diagnostics.add('Feed load check', loads.status, shareable);
  }

  if (!tabPaused) {
    startFeatures({
      features, net, settings, log, unavailable,
      context: (feature) => ({
        win,
        doc,
        diagnostics,
        actions: actions.for(feature.id),
        storage: activity.storage,
        router,
        posts,
        hider,
        log,
        toast,
        openSettings,
      }),
      changed: () => panel?.refresh(),
    });
  }

  if (!tabPaused) mountFeatureStyles({ features, settings, log, doc, base: [{ id: 'hidden posts', css: (get) => hideCss({ notes: get('ui.hiddenNote') === true }) }] });

  // Daily jobs wait until the page has settled and the page's copy of the check is read.
  const tasks = createDailyTasks({ storage, log });
  const mirror = pageMirror(own);
  scheduleStorageCheck({ tasks, storage, mirror, log, toast, diagnostics });
  setTimeout(() => whenMirrorReady(mirror, () => tasks.runDue()), 8000);

  // The extension can't update itself, so General says how its release check went, and a newer
  // release gets one toast.
  const host = storage.kind === 'extension' ? extensionHost() : null;
  const update = host ? () => updateStatus(storage, version) : null;
  if (update) {
    storage.onChange(UPDATE_KEY, () => panel?.refresh());
    storage.whenReady(() => {
      const found = availableUpdate(storage, version);
      if (!found || storage.get(UPDATE_TOLD_KEY, null) === found.version) return;
      storage.set(UPDATE_TOLD_KEY, found.version);
      toast(() => t('HushFacebook Web {version} is out.', { version: found.version }), { action: { label: 'How to update', run: () => whenBodyReady(() => panel?.open('general'), doc) } });
    });
  }

  whenBodyReady(() => {
    panel = mountPanel({
      settings, features, log, hider, diagnostics, actions, unavailable,
      environment: { version, ...managerInfo(), update, resumeTab, checkForUpdate: host?.checkForUpdate ?? null, storage, activity, accountMatches: () => settings.startup.matchesAccount(signedInAccount(doc)) },
    });
    for (const entry of waiting.splice(0)) {
      if (!entry.gone) entry.shown = panel.toast(entry.message, entry.options);
    }
    if (pendingSettingsOpen) {
      panel.open(pendingSettingsSection);
      pendingSettingsOpen = false;
    }
    // Any script on the page can write the mark, so only a version number goes in the message.
    const other = doc.documentElement.getAttribute(DUPLICATE);
    const otherVersion = /^\d+(?:\.\d+){0,3}$/.test(other ?? '') ? ` (v${other})` : '';
    if (other) log.warn(`A second copy of HushFacebook Web${otherVersion} is installed. Turn one off in your userscript manager or on the browser's extensions page.`);
  }, doc);
  registerMenuCommand('HushFacebook Web settings', () => openSettings());

  log.info(`v${version} started (${access} mode)`);
  return { net, router, hider, settings, pauseTab, resumeTab };
}
