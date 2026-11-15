// The settings panel lives in a closed shadow root to keep page CSS out. Its MAIN-world code
// still shares the page's trust boundary. Changes apply at once with a toast, and
// Reset offers Undo instead of asking first.
//
// Words come in English and go through t() where they're drawn (core/i18n.js): feature titles,
// descriptions, labels and choices, action and Diagnostics row labels, and the label of a
// toast's button. A toast's message comes already in the language shown.

import { EXTENSION_RELOADED, extensionReloaded } from '../core/bridge.js';
import { decisionLine } from '../core/diagnostics.js';
import { saveThroughLink } from '../core/download.js';
import { english, language, LANGUAGES, plural, setLanguage, stretched, t } from '../core/i18n.js';
import { KEPT_ON_RESET, MAX_BACKUP_BYTES } from '../core/settings.js';
import { TARGET } from '../core/target.js';
import { PAGES, SECTIONS } from '../features/sections.js';
import { h, icon } from './h.js';
import { GEAR_ICON, SLIDERS_ICON } from './icons.js';
import { trackLauncherSpot } from './launcher-place.js';
import { navigationIcon } from './navigation-icons.js';
import { createNewDots } from './new-dots.js';
import { watchPageTheme } from './page-theme.js';
import { buildDiagnosticReport } from './diagnostic-report.js';
import { buildProblemReport } from './problem-report.js';
import { applyQuickSetup, QUICK_SETUPS } from './quick-setups.js';
import { findFeatures, matchesHiddenHelp, matchingAction } from './search.js';
import { firstSentence } from './sentences.js';
import { panelCss } from './styles.js';

const ALWAYS_OPENS = TARGET === 'extension' ? "The extension's toolbar button" : "Your userscript manager's menu";
const ERROR_TOAST_GAP_MS = 15000;
// How long a toast live region sits in the page, after it goes in or moves, before it is heard.
export const REGION_SETTLE_MS = 500;
const KOFI_URL = 'https://ko-fi.com/X8K126YVER';
const RELOAD_MARKER_KEY = 'hfw:settings-reload';
const RELOAD_MARKER_MAX_AGE_MS = 90_000;
// The pages around the feature pages (features/sections.js has those): Overview first, where
// settings open, then General and Diagnostics under a line at the end.
const OVERVIEW = { id: 'overview', title: 'Overview' };
const GENERAL = { id: 'general', title: 'General', divider: true };
const DIAGNOSTICS = { id: 'diagnostics', title: 'Diagnostics' };
// General's rows by group, in this order. The first has no heading: it's for rows that need you
// now (a failed save, an Undo, a newer release), so they head the page.
const GENERAL_GROUPS = [
  { id: 'attention', title: null },
  { id: 'facebook', title: 'On Facebook' },
  { id: 'yours', title: 'Language and backups' },
  { id: 'about', title: 'About' },
];
// The rows of that first group that also lead Overview: a Quick setup's Undo, saving or loading
// trouble, and a newer release.
const OVERVIEW_ATTENTION = ['storage-recovery', 'save-recovery', 'reset-undo', 'update'];
// Plain words for the reasons the hider counts (src/core/dom/hide.js), on Overview. A reason
// missing here shows as the hider names it.
const REASON_WORDS = {
  Filter: 'Your filters',
  Repeat: 'Shown again',
  Seen: 'Already seen',
  Dismissed: 'Hidden by you before',
  People: 'People you may know',
  Promotion: 'Promotions',
  Suggested: 'Suggested for you',
  Sponsored: 'Ads',
  Reels: 'Reels',
  'AI-labeled': 'Labeled as AI',
};
const reasonWords = (reason) => (Object.hasOwn(REASON_WORDS, reason) ? t(REASON_WORDS[reason]) : reason);
// How many reasons Overview names under its hidden count, the most common first.
const TOP_REASONS = 3;
// An error's code, or undefined. What the page throws can have a code that throws when read.
const codeIn = (detail) => {
  try {
    return detail !== null && typeof detail === 'object' ? detail.code : undefined;
  } catch {
    return undefined;
  }
};
// Why a feature isn't running, by the reason startFeatures recorded: on its card, then
// shorter in Diagnostics.
const UNAVAILABLE_NOTES = {
  page: "This one has to run in Facebook's page, and your userscript manager runs the script outside it. Diagnostics says how to change that.",
  network: "Network protection couldn't start, so this one is off. The log in Diagnostics says why.",
  api: "Your browser or userscript manager doesn't offer what this one needs.",
  failed: "This one couldn't start on this page, or stopped working. The log in Diagnostics says why.",
};
const UNAVAILABLE_SHORT = { page: 'needs page access', network: 'network protection unavailable', api: 'missing from this browser or manager', failed: 'see the log' };
const searchCount = (count) => (count === 0 ? t('No setting matches.') : plural(count, '{count} setting matches.', '{count} settings match.'));
// The extension's toolbar button. The userscript has no button of its own to put it on.
const TOOLBAR_COUNT_NOTE = "How many posts were hidden in this tab, on the extension's button in the browser toolbar. NEW there instead means a newer release is out.";
const LOAD_WARNING_NOTE = "A notice when Home or a group's feed still shows Facebook's loading cards 20 seconds after it opened. It offers a way to pause the script for that tab. Diagnostics keeps the result either way.";
const LAUNCHER_NOTE = "The gear in Facebook's top bar, next to Messenger and Notifications. A page without that bar shows it in the bottom-left corner. {opener} always opens settings too, and so does the row in your account menu while Settings in your account menu is on.";
const HIDDEN_NOTE_NOTE = 'A short line that says why a post was hidden. Click it to see the post, or Show hidden at its end to see every post hidden on the page.';
const BACKUP_NOTE = 'Save your choices to a file and load them in another browser, or move them between the userscript and the extension. Seen posts, video spots, speed and volume stay behind. Reset to defaults puts every setting but the language back the way it came, with Undo right after.';
const REPORT_NOTE = 'Opens a GitHub report with your versions and settings filled in, for you to add what happened.';
const LANGUAGE_NOTE = "The language for these settings and the script's notices. Facebook's own language doesn't change it, and Reset to defaults keeps it. The two tests stretch every phrase or mirror the panel, to show how a translation will fit.";
const QUICK_SETUPS_NOTE = 'Turn on a tested group of cleanup or privacy switches, or put every setting back to its default.';
const SEARCH_SETTLE_MS = 600;
const ACTIVITY_CONTEXT_NOTES = {
  managed: "In a private window, or when the extension can't tell what kind of window it is, your activity, like seen posts and video spots, stays in this tab only.",
  private: 'Activity stays in this private tab and disappears when you close it. Saved settings still apply, but your userscript manager may forget changes you make here once the private window closes.',
  unknown: "Your userscript manager doesn't say whether this is a private window, so your activity, like seen posts and video spots, stays in this tab only. Saved settings still apply.",
  loading: 'Checking where this tab keeps activity.',
};

export function mountPanel({ settings, features, log, hider, diagnostics, actions, unavailable, environment }) {
  // Inline and important, so no page rule (Custom CSS included, say div:empty) can hide the
  // panel and with it the only way to undo that rule.
  const host = h('div', { dataset: { hushfacebookWeb: 'ui' }, style: 'all: initial !important' });
  const shadow = host.attachShadow({ mode: 'closed' });
  const root = h('div', { class: 'root' });
  shadow.append(h('style', { text: panelCss }), root);
  // Light or dark with Facebook, switching while open too. Toasts and the gear live in root, so they follow.
  watchPageTheme(document, (theme) => {
    if (theme === 'light') root.dataset.theme = 'light';
    else delete root.dataset.theme;
  });

  // Groups with something in them, and the pages that have such a group. A feature's section is
  // its group; Overview and General rows name their page instead.
  const groups = SECTIONS.filter((group) => features.some((feature) => feature.section === group.id));
  const groupPage = new Map(groups.map((group) => [group.id, group.page]));
  const featurePages = PAGES.filter((page) => groups.some((group) => group.page === page.id));
  const pages = [OVERVIEW, ...featurePages, GENERAL, DIAGNOSTICS];
  // Search reads a row's group and page names from these.
  const places = [...groups, { id: OVERVIEW.id, title: OVERVIEW.title }, { id: GENERAL.id, title: GENERAL.title }];
  // A page id, or a group's page, as long as that page is shown.
  const pageOf = (id) => {
    const page = pages.some((entry) => entry.id === id) ? id : SECTIONS.find((group) => group.id === id)?.page;
    return pages.some((entry) => entry.id === page) ? page : null;
  };
  const pageFeatures = (pageId) => features.filter((feature) => groupPage.get(feature.section) === pageId);
  const pageIsNew = (pageId) => groups.some((group) => group.page === pageId && newDots.sectionIsNew(group.id));
  let current = OVERVIEW.id;
  let query = '';
  let renderedDirection = null;
  let opener = null;
  const newDots = createNewDots({ storage: environment.storage, features, log });
  const newDot = () => h('span', { class: 'new-dot' }, h('span', { class: 'visually-hidden', text: t('New') }));
  const drafts = new Map();
  const openHelp = new Set(); // Rows whose More was clicked open, kept across redraws.
  // Rows a search opened and Less closed again. A redraw keeps them closed until the search
  // words change or the panel opens again, so a new search (the same words typed again
  // included) opens them again.
  const closedHelp = new Set();
  const fieldErrors = new Map();
  const pending = new Set();
  const actionNotices = new Map();
  let preferenceSave = settings.saveStatus?.() ?? { state: 'idle', error: null, pending: [] };
  const bulkChangePending = () => pending.has('reset') || pending.has('import') || [...pending].some((key) => key.startsWith('quick:'));
  const settingValue = (key) => settings.display?.(key) ?? settings.get(key);
  const hasMenuEntry = features.some((feature) => feature.id === 'menuEntry');
  const reloadFeatureIds = new Set(features.filter((feature) => feature.reload).map((feature) => feature.id));
  const reloadKeys = [...settings.schema].filter(([, spec]) => reloadFeatureIds.has(spec.featureId)).map(([key]) => key);
  let reloadStorage = null;
  try {
    reloadStorage = environment.sessionStorage ?? globalThis.sessionStorage;
  } catch (error) {
    log.warn("Couldn't access reload recovery storage", error);
  }
  const now = environment.now ?? Date.now;
  const reloadPage = environment.reload ?? (() => globalThis.location.reload());
  const reloadValueAtLoad = (key) => settings.pageLoadValue?.(key) ?? settings.get(key);
  let reloadBaseline = new Map(reloadKeys.map((key) => [key, reloadValueAtLoad(key)]));
  let reloadPending = reloadKeys.some((key) => settings.get(key) !== reloadBaseline.get(key));

  // The choices from before the last reset, held in memory for this page and account until
  // Undo puts them back, the person dismisses it, or a later change here or in another tab
  // supersedes the reset. after is the committed reset record it undoes.
  let resetUndo = null;
  // The notice offering Undo for resetUndo, if it's still up.
  let undoNotice = null;
  const accountMatches = () => environment.accountMatches?.() ?? true;
  const recordValue = (record, key) => (Object.hasOwn(record, key) ? record[key] : settings.schema.get(key).default);
  const sameAs = (read, record) => [...settings.schema.keys()].every((key) => JSON.stringify(read(key)) === JSON.stringify(recordValue(record, key)));
  const currentUndo = () => {
    if (resetUndo && !resetUndo.restoring && !accountMatches()) resetUndo = null;
    return resetUndo;
  };
  // A failed Undo leaves its choices waiting to save, so showing them still counts as the reset's.
  // Once they're saved (a Retry got them through) the Undo is done.
  const supersedeUndo = () => {
    if (!resetUndo || resetUndo.restoring) return;
    const { previous, after } = resetUndo;
    if (sameAs(settings.get, previous) || (!sameAs(settingValue, after) && !sameAs(settingValue, previous))) resetUndo = null;
  };

  // Each stack holds two live regions that are there from the start, since a region made with its
  // first notice may not be heard. Errors go to the assertive one. A role=alert inside a polite
  // region is two regions in one, which some screen readers speak twice. The third box is silent:
  // see settle() below.
  const liveRegions = (box) => {
    const polite = h('div', { class: 'toast-live', 'aria-live': 'polite' });
    const assertive = h('div', { class: 'toast-live', 'aria-live': 'assertive' });
    const waiting = h('div', { class: 'toast-wait' });
    box.append(polite, assertive, waiting);
    return { box, polite, assertive, waiting };
  };
  const toasts = liveRegions(h('div', { class: 'toasts' }));
  // Small notices, about something just done on the page, sit in the bottom-left corner, off the
  // feed.
  const corner = liveRegions(h('div', { class: 'toasts corner' }));
  // A region is heard only for what's added once it has settled in the page, and moving it (into
  // the dialog and back) can start it over. A notice that comes right then, like the startup error
  // or the ones waiting for the page's body, shows at once in the silent box and goes into its
  // region a moment later, which is a change the screen reader hears.
  let settled = false;
  let settleTimer = null;
  const held = new Map();
  const settle = () => {
    settled = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settled = true;
      for (const [el, region] of held) if (el.isConnected) region.append(el);
      held.clear();
    }, REGION_SETTLE_MS);
  };
  const moveStacks = (parent) => {
    if (toasts.box.parentNode === parent && corner.box.parentNode === parent) return;
    parent.append(toasts.box, corner.box);
    settle();
  };
  // The gear in Facebook's top bar (launcher-place.js says where).
  const launcher = h('button', { class: 'launcher', type: 'button', onclick: () => open() }, icon(GEAR_ICON));
  const nav = h('nav');
  const main = h('main', { 'aria-labelledby': 'hfw-section-title' });
  // One element for the life of the panel, so typing keeps its place across redraws.
  const search = h('input', {
    class: 'search', type: 'search', autocomplete: 'off', spellcheck: 'false', dataset: { key: 'search' },
    oninput: (event) => { setQuery(event.target.value); main.scrollTop = 0; render(); },
  });
  const searchField = h('div', { class: 'search-field' }, navigationIcon('search'), search);
  const pauseState = h('span', { class: 'power-state', id: 'hfw-power-state' });
  const saveState = h('span', { class: 'save-state', role: 'status', dataset: { key: 'save-state', state: preferenceSave.state } });
  // One live region for the life of the panel. The visible count is redrawn on every key, so
  // only this one speaks, and only once the count has held still for a moment.
  const searchStatus = h('p', { class: 'visually-hidden', role: 'status', dataset: { key: 'search-status' } });
  let searchStatusTimer = null;
  // Checked means running, so the switch agrees with the "On" beside it. Its name is the script
  // alone, since a screen reader says on or off after it, and the word beside it says why.
  const power = h('input', {
    class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': 'HushFacebook Web', 'aria-describedby': 'hfw-power-state', dataset: { key: 'power' },
    // A pause for this tab ends with a reload, since the page started without the script's hooks.
    onchange: (event) => (settings.tabPaused && event.target.checked ? environment.resumeTab?.() : apply('paused', !event.target.checked)),
  });
  // The switch and the word beside it share one pill, so On or Paused reads as the switch's state.
  const powerControl = h('label', { class: 'power' }, h('span', { class: 'power-dot', 'aria-hidden': 'true' }), pauseState, power);
  const closeButton = h('button', { class: 'icon-button', type: 'button', dataset: { key: 'close' }, onclick: () => close() }, navigationIcon('close'));
  const subtitle = h('span', { class: 'brand-subtitle' });
  const dialog = h(
    'dialog',
    { class: 'dialog', 'aria-labelledby': 'hfw-title' },
    h('header', null,
      h('div', { class: 'brand' },
        h('span', { class: 'brand-icon' }, icon(SLIDERS_ICON)),
        h('div', { class: 'brand-copy' },
          h('h2', { id: 'hfw-title', text: 'HushFacebook Web' }),
          subtitle)),
      searchField,
      h('div', { class: 'header-actions' }, powerControl, closeButton)),
    h('div', { class: 'body' }, nav, main),
    h('footer', null,
      saveState,
      h('span', { class: 'footer-version', text: `HushFacebook Web v${environment.version}` })),
    searchStatus,
  );
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.addEventListener('close', () => {
    newDots.finish();
    announceSearch('');
    moveStacks(root);
    if (opener?.isConnected && !opener.hidden && opener !== document.body && opener !== document.documentElement) opener.focus({ preventScroll: true });
    else if (!launcher.hidden) launcher.focus({ preventScroll: true });
    opener = null;
  });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importSettings });
  dialog.append(fileInput);
  root.append(launcher, dialog, toasts.box, corner.box);
  document.body.append(host);
  settle();
  const launcherSpot = trackLauncherSpot({ button: launcher, host, doc: document, router: environment.router });

  // The language chosen under General, for the panel and every toast after it. The parts drawn
  // once get their words again here; render() redraws the rest.
  function syncLanguage() {
    setLanguage(settingValue('ui.language'));
    const shown = language();
    root.setAttribute('lang', shown.lang);
    root.setAttribute('dir', shown.dir);
    launcher.setAttribute('aria-label', t('Open HushFacebook Web settings'));
    launcher.title = t('HushFacebook Web settings');
    nav.setAttribute('aria-label', t('Settings pages'));
    search.placeholder = t('Find a setting');
    search.setAttribute('aria-label', t('Find a setting'));
    closeButton.setAttribute('aria-label', t('Close settings'));
    subtitle.textContent = t('Settings');
  }
  syncLanguage();

  async function apply(key, value, control) {
    if (bulkChangePending()) return;
    const draft = control?.value;
    try {
      if (control && !control.validity.valid) {
        const spec = settings.schema.get(key);
        throw new TypeError(spec.type === 'number' ? t('Enter a number from {min} to {max}.', { min: spec.min, max: spec.max }) : t('Check this value and try again.'));
      }
      drafts.delete(key);
      fieldErrors.delete(key);
      await settings.set(key, value);
    } catch (error) {
      if (control && error instanceof TypeError) {
        drafts.set(key, draft);
        fieldErrors.set(key, error.message);
      }
      if (!(control && error instanceof TypeError)) actionError("Couldn't save your change. Try again", error);
      refreshChrome();
      if (dialog.open) render();
    }
  }

  // duration Infinity keeps the notice until dismiss() on what this returns, or its action.
  // message can be a function, read as the notice goes up, so one that waited for the panel
  // comes in the language chosen by then.
  // actions: buttons in order. One with keep: true leaves the notice up after its click. The
  // buttons share one box, so a narrow window wraps them together under the message.
  // small: a one-line notice in the bottom corner, for something just done on the page.
  function toast(message, { tone = 'info', action, actions = action ? [action] : [], duration, small = false } = {}) {
    const el = h('div', { class: `toast ${tone}${small ? ' small' : ''}` },
      h('span', { text: typeof message === 'function' ? message() : message }),
      actions.length ? h('div', { class: 'actions' },
        ...actions.map((entry) => h('button', { type: 'button', text: t(entry.label), onclick: () => { if (!entry.keep) el.remove(); entry.run(); } }))) : null);
    const stack = small ? corner : toasts;
    const region = stack[tone === 'error' ? 'assertive' : 'polite'];
    if (settled) region.append(el);
    else {
      stack.waiting.append(el);
      held.set(el, region);
    }
    // A notice the pointer is over, or that holds focus, stays until both move off it, then
    // gets its full time again.
    let hovered = false;
    let focused = false;
    let timer = null;
    const wait = duration ?? (actions.length ? 7000 : 4000);
    const schedule = () => {
      clearTimeout(timer);
      if (Number.isFinite(wait)) timer = setTimeout(() => { if (!hovered && !focused) el.remove(); }, wait);
    };
    el.addEventListener('pointerenter', () => { hovered = true; });
    el.addEventListener('pointerleave', () => { hovered = false; schedule(); });
    el.addEventListener('focusin', () => { focused = true; });
    el.addEventListener('focusout', (event) => {
      if (el.contains(event.relatedTarget)) return;
      focused = false;
      schedule();
    });
    schedule();
    return {
      dismiss() {
        clearTimeout(timer);
        el.remove();
      },
    };
  }

  // ---- views ----

  // A locked switch can't be turned on, but one that's on still turns off, so a feature that
  // failed partway can stop what did start. Locked and off, it stays focusable (aria-disabled
  // rather than disabled) so the note on why is still read with it.
  function toggle(key, label, { locked = false, describedBy } = {}) {
    const on = settingValue(key) === true;
    const stuck = locked && !on;
    return h('input', {
      class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': t(label),
      'aria-describedby': describedBy, 'aria-disabled': stuck ? 'true' : null,
      checked: on, disabled: bulkChangePending(), dataset: { key },
      onclick: stuck ? (event) => event.preventDefault() : undefined,
      onchange: (event) => apply(key, event.target.checked),
    });
  }

  function optionControl(feature, option, dots) {
    const key = `${feature.id}.${option.key}`;
    const value = drafts.get(key) ?? settingValue(key);
    const errorId = `hfw-error-${key}`;
    const dot = dots && newDots.isNew(key) ? newDot() : null;
    const props = {
      dataset: { key }, 'aria-invalid': fieldErrors.has(key) ? 'true' : null,
      'aria-describedby': fieldErrors.has(key) ? errorId : null,
      disabled: bulkChangePending(),
      oninput: (event) => drafts.set(key, event.target.value),
    };
    const field = (control) => h('div', { class: 'field' }, h('label', null, dot ? h('span', null, t(option.label), dot) : t(option.label), control),
      fieldErrors.has(key) ? h('p', { class: 'field-error', id: errorId, role: 'alert', text: fieldErrors.get(key) }) : null);
    switch (option.type) {
      case 'toggle':
        return h('label', { class: 'option-toggle' }, toggle(key, option.label), h('span', null, t(option.label), dot));
      case 'select':
        return field(h('select', { ...props, onchange: (event) => apply(key, option.choices.find((choice) => String(choice.value) === event.target.value)?.value, event.target) },
            option.choices.map((choice) => h('option', { value: String(choice.value), selected: choice.value === value, text: t(choice.label) }))));
      case 'number':
        return field(h('input', { ...props, type: 'number', value: String(value), required: true, min: option.min, max: option.max, onchange: (event) => apply(key, Number(event.target.value), event.target) }));
      default:
        // A short value, like a font name or a color, gets one line.
        if (option.lines === 1) {
          return field(h('input', { ...props, type: 'text', value, maxLength: option.maxLength, spellcheck: 'false', onchange: (event) => apply(key, event.target.value.trim(), event.target) }));
        }
        return field(
          h('textarea', {
            ...props,
            // Code reads left to right in every language.
            rows: option.rows ?? 3, class: option.code ? 'code' : undefined, spellcheck: option.code ? 'false' : undefined, dir: option.code ? 'ltr' : undefined,
            // The browser stops a paste at the setting's limit, rather than the save failing
            // and the text being lost on the next redraw.
            maxLength: option.maxLength,
            onchange: (event) => apply(key, event.target.value, event.target),
          }, value));
    }
  }

  // The links a feature lists on its card (ctx.actions.links), opened in this tab.
  const linkSignatures = new WeakMap();
  function featureLinks(feature) {
    const found = actions?.links?.(feature.id);
    if (!found) return null;
    const node = !found.items.length ? h('div', { class: 'links-empty', dataset: { linksFor: feature.id }, text: t(found.empty) })
      : h('ol', { class: 'links', dataset: { linksFor: feature.id } }, found.items.map(({ label, detail, href }) => h('li', {},
      h('a', { href, text: label, dir: 'auto' }),
      detail ? h('span', { class: 'detail', text: detail }) : null)));
    linkSignatures.set(node, JSON.stringify(found));
    return node;
  }

  // Buttons the feature added for itself (ctx.actions).
  function featureActions(feature) {
    const list = actions?.list(feature.id) ?? [];
    return h('div', { dataset: { actionsFor: feature.id, actionSignature: JSON.stringify(list.map(({ label, index }) => [label, index])) } },
      list.length ? h('div', { class: 'actions' }, list.map(({ label, run, index }) => actionButton(`action:${feature.id}:${index}`, label, run))) : null);
  }

  // label and busyLabel in English: the log keeps the English, the button shows t().
  function actionButton(key, label, run, { primary = false, busyLabel = 'Working...' } = {}) {
    const locked = bulkChangePending() && !pending.has(key) && key !== 'storage:retry';
    return h('button', {
      class: `button${primary ? ' primary' : ''}`, type: 'button', text: t(pending.has(key) ? busyLabel : label),
      dataset: { key }, disabled: locked, 'aria-disabled': pending.has(key) ? 'true' : null, 'aria-busy': pending.has(key) ? 'true' : null,
      onclick: () => {
        if (pending.has(key)) return;
        pending.add(key);
        render();
        const finish = () => {
          pending.delete(key);
          if (dialog.open) render();
        };
        const succeeded = () => { actionNotices.get(key)?.dismiss(); actionNotices.delete(key); };
        const failed = (error) => actionNotices.set(key, actionError('{action} failed. Try again', error, { action: t(label) }));
        try {
          const result = run();
          if (result && typeof result.then === 'function') Promise.resolve(result).then(succeeded, failed).finally(finish);
          else { succeeded(); finish(); }
        } catch (error) {
          failed(error);
          finish();
        }
      },
    });
  }

  // A row's help: its first sentence, with the rest behind More, shown in place. A search that
  // finds the row by words in the rest opens it. id goes on a hidden copy of the whole text for
  // the row's control to read, since a screen reader leaves out the hidden part of a shown one.
  // shownTitle: the row's title as it shows, when that isn't just t(title).
  function help(key, title, description, { vars, id, shownTitle } = {}) {
    const text = t(description, vars);
    const [first, rest] = helpParts(description, vars, text);
    if (!rest) return h('div', { class: 'desc', id, text });
    const [plainFirst, plainRest] = firstSentence(english(description, vars), 'en');
    const found = query.trim() !== '' && matchesHiddenHelp(query, [rest, plainRest], [t(title), english(title), first, plainFirst]);
    const open = openHelp.has(key) || (found && !closedHelp.has(key));
    const restId = `hfw-${key}-more`;
    const more = h('span', { id: restId, hidden: !open, text: ` ${rest}` });
    // Named by its own word and then its row's title, since a screen reader's list of buttons
    // shows only names. The word it shows comes first in every language, so saying it works.
    const buttonId = `hfw-${key}-more-button`;
    const titleId = `hfw-${key}-more-title`;
    const toggleMore = (event) => {
      const opening = more.hidden;
      more.hidden = !opening;
      const button = event.currentTarget;
      button.setAttribute('aria-expanded', String(opening));
      button.textContent = opening ? t('Less') : t('More');
      if (opening) {
        openHelp.add(key);
        closedHelp.delete(key);
      } else {
        openHelp.delete(key);
        if (query.trim()) closedHelp.add(key);
      }
    };
    return [
      h('div', { class: 'desc' }, first, more, ' ',
        h('button', { class: 'more', type: 'button', id: buttonId, 'aria-expanded': String(open), 'aria-controls': restId, 'aria-labelledby': `${buttonId} ${titleId}`, dataset: { key: `more:${key}` }, text: open ? t('Less') : t('More'), onclick: toggleMore })),
      h('span', { id: titleId, hidden: true, text: shownTitle ?? t(title) }),
      id ? h('div', { id, hidden: true, text }) : null,
    ];
  }

  // Where a row's help splits. The long text layout stretches each part in its own [ ], so the
  // sentence shown grows the way a longer translation would and still reads as whole.
  function helpParts(description, vars, text) {
    if (!language().transform) return firstSentence(text, language().lang);
    const [first, rest] = firstSentence(description, 'en');
    return rest ? [stretched(first, vars), stretched(rest, vars)] : [text, ''];
  }

  // dots: marks what an update added (new-dots.js), in a section's own view only.
  function featureCard(feature, { showOptions = false, dots = false } = {}) {
    const reason = unavailable.get(feature.id);
    const blocked = reason !== undefined;
    const on = settingValue(feature.id) === true;
    // Stable ids, so the switch reads its help, why it's unavailable and the reload note.
    const ids = { desc: `hfw-${feature.id}-desc`, note: `hfw-${feature.id}-note`, reload: `hfw-${feature.id}-reload` };
    const describedBy = [ids.desc, blocked ? ids.note : null, feature.reload ? ids.reload : null].filter(Boolean).join(' ');
    const status = on && diagnostics?.hasStatus?.(feature.id) ? diagnostics.statusOf(feature.id) : undefined;
    return h('div', { class: `card${blocked ? ' unavailable' : ''}` },
      h('div', { class: 'row' },
        h('div', { class: 'text' },
          h('div', { class: 'title' }, t(feature.title), dots && newDots.featureIsNew(feature) ? newDot() : null),
          help(feature.id, feature.title, feature.description, { id: ids.desc }),
          blocked ? h('div', { class: 'note', id: ids.note, text: `${t(UNAVAILABLE_NOTES[reason] ?? UNAVAILABLE_NOTES.failed)}${on ? ` ${t('You can still turn it off.')}` : ''}` }) : null,
          feature.reload ? h('div', { class: 'note', id: ids.reload, text: t('Applies after Facebook reloads.') }) : null,
          status === undefined ? null : h('div', { class: 'note', 'data-status-for': feature.id, role: 'status', hidden: status === null, text: t(status ?? '') })),
        toggle(feature.id, feature.title, { locked: blocked, describedBy })),
      (on || showOptions) && feature.options?.length ? h('div', { class: 'options' }, feature.options.map((option) => optionControl(feature, option, dots))) : null,
      on ? featureLinks(feature) : null,
      on ? featureActions(feature) : null);
  }

  // A heading over a box of rows. tiles: a grid of tiles instead of the box.
  function groupBlock(id, title, children, { description, tiles = false } = {}) {
    const headingId = `hfw-group-${id}`;
    return h('div', { class: 'group', role: title ? 'group' : null, 'aria-labelledby': title ? headingId : null, dataset: { group: id } },
      title ? h('h4', { class: 'group-title', id: headingId, text: title }) : null,
      description ? h('p', { class: 'group-desc', text: description }) : null,
      h('div', { class: tiles ? 'tiles' : 'settings-group' }, ...children));
  }

  // A feature page's groups. A page with one group needs no heading over it.
  function pageView(pageId) {
    const shown = groups.filter((group) => group.page === pageId);
    return shown.map((group) => groupBlock(group.id, shown.length > 1 ? t(group.title) : null,
      features.filter((feature) => feature.section === group.id).map((feature) => featureCard(feature, { dots: true }))));
  }

  function showPage(pageId) {
    clearSearch();
    current = pageId;
    main.scrollTop = 0;
    render();
    revealCurrentPage();
  }

  // Pages have no heading on screen, so the sideways page row of a narrow panel keeps the
  // current page in view. The upright sidebar already shows it, so nothing moves there.
  function revealCurrentPage() {
    nav.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function clearSearch() {
    setQuery('');
    search.value = '';
  }

  // Spaces and capitals don't make a new search.
  function setQuery(value) {
    const words = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (words(value) !== words(query)) closedHelp.clear();
    query = value;
  }

  // A search result's link: opens its page with that row's control focused, or the row's button
  // the words typed name (Reset, Restore). Help the result showed open stays open there.
  function showSetting(setting, result) {
    for (const button of result?.querySelectorAll('.more[aria-expanded="true"]') ?? []) openHelp.add(button.dataset.key.slice('more:'.length));
    const focusKey = matchingAction(setting, query) ?? setting.focusKey ?? setting.id;
    clearSearch();
    current = pageOf(setting.section) ?? current;
    main.scrollTop = 0;
    render();
    const control = main.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    control?.scrollIntoView?.({ block: 'center' });
    control?.focus({ preventScroll: true });
  }

  // Where a row lives, as its result link names it: the page, and the group on a page with more
  // than one. The angle mirrors itself in right to left text.
  function placeName(sectionId) {
    const group = groups.find((entry) => entry.id === sectionId);
    const page = t(pages.find((entry) => entry.id === (group?.page ?? sectionId)).title);
    return group && groups.filter((entry) => entry.page === group.page).length > 1 ? `${page} › ${t(group.title)}` : page;
  }

  function resultsView(found) {
    if (!found.length) return [h('p', { class: 'empty', text: t('No setting matches "{query}". Try a shorter word, or pick a page.', { query: query.trim() }) })];
    return [h('div', { class: 'settings-group results' }, found.map((setting) => h('div', { class: 'result' },
      h('button', { class: 'result-section', type: 'button', text: t('In {section}', { section: placeName(setting.section) }), dataset: { key: `show:${setting.id}` }, onclick: (event) => showSetting(setting, event.currentTarget.closest('.result')) }),
      setting.render ? setting.render() : featureCard(setting, { showOptions: true }))))];
  }

  // How the extension's release check went (environment.update, extension only, from
  // src/core/extension.js updateStatus), with the newer release when there is one.
  // English keeps the browser's own date format, a translation its language's.
  const dateLocale = () => (language().value === 'en' || language().test ? undefined : language().lang);
  const when = (time) => new Date(time).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  function updateLine(status) {
    if (status.checking) return t('Checking GitHub now.');
    const checked = status.checkedAt === null ? '' : t('Checked {time}.', { time: when(status.checkedAt) });
    const lastWorked = status.checkedAt === null ? t('No check has worked yet.') : t('The last one that worked was {time}.', { time: when(status.checkedAt) });
    const tried = status.triedAt === null ? null : { time: when(status.triedAt) };
    const again = t('It tries again on its own.');
    if (status.state === 'current') return `${t('You have the newest release.')} ${checked}`.trim();
    if (status.state === 'newer') return checked;
    if (status.state === 'offline') return `${tried ? t("The check on {time} couldn't reach GitHub.", tried) : t("The last check couldn't reach GitHub.")} ${lastWorked} ${again}`;
    if (status.state === 'failed') return `${tried ? t("GitHub's answer to the check on {time} didn't make sense.", tried) : t("GitHub's answer to the last check didn't make sense.")} ${lastWorked} ${again}`;
    if (status.state === 'rate-limited') {
      const until = status.nextAt === null ? t('GitHub asked for a pause before the next check.') : t('GitHub asked for a pause, so the next check waits until {time}.', { time: when(status.nextAt) });
      return `${until} ${lastWorked}`;
    }
    return t('No check has finished for this version yet. It checks GitHub once a day.');
  }

  async function checkForUpdateNow() {
    const answer = await environment.checkForUpdate();
    if (answer?.asked !== false) return;
    const status = environment.update?.();
    toast(status?.state === 'rate-limited' && status.nextAt > Date.now()
      ? t('GitHub asked for a pause. The next check is after {time}.', { time: when(status.nextAt) })
      : t('It checked a moment ago. Try again in a couple of minutes.'));
  }

  function updateCard(status = environment.update?.()) {
    if (!status) return null;
    const { update } = status;
    const line = updateLine(status);
    return h('div', { class: 'card', dataset: { key: 'update' } },
      h('div', { class: 'title', text: update ? t('HushFacebook Web {version} is out', { version: update.version }) : t('Updates') }),
      update ? h('div', { class: 'desc', text: t("You have {version}. Download hushfacebook-web-extension.zip from the release and unzip it over the folder you loaded. Then click Reload on HushFacebook Web in your browser's extensions page. Your settings stay.", { version: environment.version }) }) : null,
      line ? h('div', { class: 'desc', text: line, dataset: { key: 'update:status' } }) : null,
      h('div', { class: 'actions' },
        update ? h('a', { class: 'button primary', href: update.url, target: '_blank', rel: 'noopener noreferrer', text: t('Open the release') }) : null,
        environment.checkForUpdate ? actionButton('update:check', 'Check now', checkForUpdateNow, { primary: !update, busyLabel: 'Checking...' }) : null));
  }

  // A General row's title and description are English, with {name} words from vars, so search
  // can match them as shown and in English.
  function updateRow(status) {
    const check = environment.checkForUpdate ? [{ label: 'Check now', focusKey: 'update:check' }] : [];
    if (status.update) {
      return {
        id: 'update', section: 'general', title: 'HushFacebook Web {version} is out',
        description: 'You have {current}. Download the new extension files, then reload HushFacebook Web in your browser.',
        vars: { version: status.update.version, current: environment.version },
        options: [{ label: 'Open the release' }, ...check], focusKey: 'update', render: () => updateCard(status),
      };
    }
    return {
      id: 'update', section: 'general', title: 'Updates',
      description: 'The extension checks GitHub for a newer release once a day. Check now asks right away.',
      options: check, focusKey: check.length ? 'update:check' : 'update', render: () => updateCard(status),
    };
  }

  function reloadCard() {
    return h('div', { class: 'reload-card', dataset: { key: 'reload-facebook' } },
      h('div', { class: 'text' },
        h('div', { class: 'title', text: t('Reload Facebook to apply this change') })),
      h('button', { class: 'button primary', type: 'button', text: t('Reload'), onclick: reloadFacebook }));
  }

  function applySetup(id) {
    const key = `quick:${id}`;
    if (bulkChangePending()) return;
    pending.add(key);
    render();
    settings.whenLoaded(() => {
      const previous = settings.snapshot({ displayed: true });
      const finish = () => {
        pending.delete(key);
        if (dialog.open) render();
      };
      const succeeded = (changed) => {
        // Typed values Back to defaults throws away are a change the person can see.
        const clearedDrafts = id === 'defaults' && drafts.size > 0;
        if (id === 'defaults') {
          drafts.clear();
          fieldErrors.clear();
          render();
        }
        // A Quick setup that found its switches already on wrote nothing, so it has nothing to undo,
        // even while a failed save leaves another choice showing that isn't saved yet.
        const undo = (changed || id === 'defaults') && rememberUndo(previous, { kind: 'quick', focusKey: key });
        if (dialog.open) render();
        let message;
        if (changed) message = plural(changed, 'Changed {count} setting.', 'Changed {count} settings.');
        else if (undo || clearedDrafts) message = t('Settings are back to their defaults.');
        else message = t(id === 'defaults' ? 'Nothing to change. Your settings were already at their defaults.' : 'Nothing to change. Those settings were already on.');
        if (undo) offerUndo(message);
        else toast(message);
      };
      const failed = (error) => actionError("Couldn't apply the Quick setup. Try again", error);
      try {
        const result = applyQuickSetup(settings, id);
        if (result && typeof result.then === 'function') {
          result.then(succeeded, failed).finally(finish);
        } else {
          succeeded(result);
          finish();
        }
      } catch (error) {
        failed(error);
        finish();
      }
    });
  }

  // How much of a Quick setup is already on, or for Back to defaults how much it would change.
  function setupStatus(setup) {
    if (setup.reset) {
      const changed = [...settings.schema].filter(([key, spec]) => !KEPT_ON_RESET.includes(key) && JSON.stringify(settingValue(key)) !== JSON.stringify(spec.default)).length;
      return changed ? plural(changed, '{count} setting changed', '{count} settings changed') : t('Nothing changed yet');
    }
    const keys = setup.keys.filter((key) => settings.schema.has(key));
    const on = keys.filter((key) => settingValue(key) === true).length;
    return on === keys.length ? t('All on') : t('{on} of {total} on', { on, total: keys.length });
  }

  // One tile per Quick setup. The button reads with its tile's name: Turn on, Quiet.
  function setupTiles() {
    return h('div', { class: 'setup-tiles', dataset: { key: 'quick-setups' } }, QUICK_SETUPS.map((setup) => {
      const key = `quick:${setup.id}`;
      const ids = { title: `hfw-setup-${setup.id}`, button: `hfw-setup-${setup.id}-button` };
      return h('div', { class: `tile setup-tile${setup.reset ? ' reset' : ''}` },
        h('div', { class: 'tile-title', id: ids.title, text: t(setup.label) }),
        h('div', { class: 'tile-desc', text: t(setup.description) }),
        h('div', { class: 'tile-foot' },
          h('span', { class: 'tile-count', text: setupStatus(setup) }),
          h('button', {
            class: `button${setup.reset ? '' : ' primary'}`, type: 'button', id: ids.button, 'aria-labelledby': `${ids.button} ${ids.title}`,
            text: t(pending.has(key) ? 'Waiting...' : setup.reset ? 'Reset' : 'Turn on'), dataset: { key },
            disabled: bulkChangePending(), 'aria-busy': pending.has(key) ? 'true' : null,
            onclick: () => applySetup(setup.id),
          })));
    }));
  }

  // The same tiles as a search result, with the heading Overview gives them.
  function quickSetupsCard() {
    return h('div', { class: 'card' },
      h('div', { class: 'title', text: t('Quick setups') }),
      h('div', { class: 'desc', text: t(QUICK_SETUPS_NOTE) }),
      setupTiles());
  }

  // A tile for each feature page: what it's for, and how many of its switches are on.
  function pageTile(page) {
    const list = pageFeatures(page.id);
    const on = list.filter((feature) => settingValue(feature.id) === true).length;
    return h('button', { class: 'tile page-tile', type: 'button', dataset: { key: `go:${page.id}` }, onclick: () => showPage(page.id) },
      h('span', { class: 'tile-icon' }, navigationIcon(page.id)),
      h('span', { class: 'tile-copy' },
        h('span', { class: 'tile-title' }, t(page.title), pageIsNew(page.id) ? newDot() : null),
        h('span', { class: 'tile-desc', text: t(page.description) }),
        h('span', { class: `tile-count${on ? ' some' : ''}`, text: t('{on} of {total} on', { on, total: list.length }) })));
  }

  // What the script hid on this page since it loaded, so its work shows without a note on every
  // post. Show them shows every post still hidden, notes on or off, as a note's Show hidden does.
  function hiddenCard() {
    const counts = Object.entries(hider?.counts() ?? {}).sort((a, b) => b[1] - a[1]);
    const total = counts.reduce((sum, [, count]) => sum + count, 0);
    const dropped = diagnostics?.dropped?.() ?? 0;
    const showing = hider?.hiddenNow?.() ?? 0;
    return h('div', { class: 'card hidden-count', tabindex: '-1', dataset: { key: 'overview-hidden' } },
      // With nothing hidden on the page, the drops are the whole story, so they make the title.
      h('div', { class: 'title', text: total ? t('Hidden on this page: {count}', { count: total }) : dropped ? t('Removed before they showed: {count}', { count: dropped }) : t('Nothing hidden on this page yet') }),
      counts.length ? h('div', { class: 'desc', text: counts.slice(0, TOP_REASONS).map(([reason, count]) => t('{reason}: {count}', { reason: reasonWords(reason), count })).join(', ') }) : null,
      total && dropped ? h('div', { class: 'desc', text: t('Removed before they showed: {count}', { count: dropped }) }) : null,
      showing ? h('div', { class: 'actions' },
        h('button', { class: 'button', type: 'button', text: t('Show them'), dataset: { key: 'overview-hidden:show' }, onclick: showHidden })) : null);
  }

  // The card redraws even when nothing came back, so a button left from before goes away.
  function showHidden() {
    const { posts = 0, comments = 0 } = hider?.revealEvery?.() ?? {};
    refreshHiddenCard();
    if (posts && comments) toast(plural(posts + comments, 'Showing {count} hidden posts and comments again', 'Showing {count} hidden posts and comments again'));
    else if (posts) toast(plural(posts, 'Showing {count} hidden post again', 'Showing {count} hidden posts again'));
    else if (comments) toast(plural(comments, 'Showing {count} hidden comment again', 'Showing {count} hidden comments again'));
    else toast(t('Nothing is hidden on the page right now'));
  }

  // The hidden count keeps up while Overview is open, redrawn in place so focus stays put.
  let hiddenQueued = false;
  const refreshHiddenCard = () => {
    if (!dialog.open || current !== 'overview' || hiddenQueued) return;
    hiddenQueued = true;
    requestAnimationFrame(() => {
      hiddenQueued = false;
      const node = root.querySelector('[data-key="overview-hidden"]');
      if (!node || !dialog.open) return;
      const active = shadow.activeElement;
      const focusedKey = node.contains(active) ? active.dataset.key : null;
      const next = hiddenCard();
      node.replaceWith(next);
      if (focusedKey) (next.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`) ?? next).focus({ preventScroll: true });
    });
  };

  function overviewView() {
    const attention = generalRows().filter((row) => row.group === 'attention' && OVERVIEW_ATTENTION.includes(row.id));
    return [
      attention.length ? groupBlock('overview-attention', null, attention.map((row) => row.render())) : null,
      groupBlock('overview-hidden', null, [hiddenCard()]),
      groupBlock('quick-setups', t('Quick setups'), [setupTiles()], { description: t(QUICK_SETUPS_NOTE), tiles: true }),
      groupBlock('pages', t('Pages'), featurePages.map(pageTile), { tiles: true }),
    ].filter(Boolean);
  }

  function launcherCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Show the settings button') }),
            help('ui.launcher', 'Show the settings button', LAUNCHER_NOTE, { vars: { opener: t(ALWAYS_OPENS) }, id: 'hfw-ui.launcher-desc' })),
          toggle('ui.launcher', 'Show the settings button', { describedBy: 'hfw-ui.launcher-desc' })));
  }

  function hiddenNoteCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Leave a note where a post was hidden') }),
            help('ui.hiddenNote', 'Leave a note where a post was hidden', HIDDEN_NOTE_NOTE, { id: 'hfw-ui.hiddenNote-desc' })),
          toggle('ui.hiddenNote', 'Leave a note where a post was hidden', { describedBy: 'hfw-ui.hiddenNote-desc' })));
  }

  function toolbarCountCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Show the hidden count on the toolbar button') }),
            help('ui.toolbarCount', 'Show the hidden count on the toolbar button', TOOLBAR_COUNT_NOTE, { id: 'hfw-ui.toolbarCount-desc' })),
          toggle('ui.toolbarCount', 'Show the hidden count on the toolbar button', { describedBy: 'hfw-ui.toolbarCount-desc' })));
  }

  function loadWarningCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Warn when the feed seems stuck') }),
            help('ui.loadWarning', 'Warn when the feed seems stuck', LOAD_WARNING_NOTE, { id: 'hfw-ui.loadWarning-desc' })),
          toggle('ui.loadWarning', 'Warn when the feed seems stuck', { describedBy: 'hfw-ui.loadWarning-desc' })));
  }

  // Each language keeps its own name, never translated, so English can always be found again,
  // and the title keeps the English word beside the translated one.
  function languageCard() {
    const value = settingValue('ui.language');
    const title = t('Language');
    const shownTitle = title === 'Language' ? title : `${title} (Language)`;
    return h('div', { class: 'card', dataset: { key: 'language' } },
      h('div', { class: 'title', text: shownTitle }),
      help('ui.language', 'Language', LANGUAGE_NOTE, { id: 'hfw-ui.language-desc', shownTitle }),
      h('div', { class: 'options' },
        h('div', { class: 'field' },
          h('label', null, title,
            h('select', {
              dataset: { key: 'ui.language' }, 'aria-describedby': 'hfw-ui.language-desc', disabled: bulkChangePending(),
              onchange: (event) => apply('ui.language', event.target.value, event.target),
            }, LANGUAGES.map((entry) => h('option', { value: entry.value, lang: entry.lang, selected: entry.value === value, text: entry.label })))))));
  }

  function backupCard() {
    return h('div', { class: 'card', dataset: { key: 'backup-restore' } },
        h('div', { class: 'title', text: t('Back up and restore') }),
        help('backup-restore', 'Back up and restore', BACKUP_NOTE),
        h('div', { class: 'actions' },
          h('button', { class: 'button primary', type: 'button', text: t('Back up settings'), dataset: { key: 'backup' }, disabled: bulkChangePending(), onclick: exportSettings }),
          actionButton('restore', 'Restore from a file', () => fileInput.click(), { busyLabel: 'Restoring...' }),
          actionButton('reset', 'Reset to defaults', resetSettings, { busyLabel: 'Resetting...' })));
  }

  function reportProblemCard() {
    const report = buildProblemReport({
      version: environment.version,
      browser: document.defaultView?.navigator?.userAgent ?? navigator.userAgent,
      manager: environment.manager,
      managerVersion: environment.managerVersion,
      features,
      settings,
    });
    return h('a', { class: 'card link-card', href: report.url, target: '_blank', rel: 'noopener noreferrer', dataset: { key: 'report-problem' } },
      h('div', { class: 'title', text: t('Report a problem') }),
      h('div', { class: 'desc', text: t(REPORT_NOTE) }));
  }

  function kofiCard() {
    return h('a', { class: 'card link-card', href: KOFI_URL, target: '_blank', rel: 'noopener', dataset: { key: 'kofi' } },
      h('div', { class: 'title', text: t('Buy me a coffee') }));
  }

  function storageRecoveryCard(state) {
    if (extensionReloaded(environment.storage)) {
      return h('div', { class: 'card', dataset: { key: 'storage-recovery' } },
        h('div', { class: 'title', text: t('HushFacebook Web was updated') }),
        h('div', { class: 'desc', text: t("This page still runs the copy from before the update, which can't save anything. Reload the page to pick up the new one. Changes made here since the update weren't saved.") }),
        h('div', { class: 'actions' },
          h('button', { class: 'button primary', type: 'button', text: t('Reload page'), dataset: { key: 'storage:reload' }, onclick: reloadFacebook })));
    }
    const loading = state === 'loading';
    return h('div', { class: 'card', dataset: { key: 'storage-recovery' } },
      h('div', { class: 'title', text: t(loading ? 'Loading saved settings' : "Saved settings aren't available") }),
      h('div', { class: 'desc', text: t(loading
        ? 'Recognized privacy requests wait while the extension confirms your saved choices.'
        : "Privacy choices aren't confirmed. Recognized requests are held back until you retry the connection.") }),
      loading ? null : h('div', { class: 'actions' }, actionButton('storage:retry', 'Retry', async () => {
        const loaded = await environment.storage.retry();
        if (!loaded) throw environment.storage.status().error ?? new Error("Saved settings still aren't available");
        toast(t('Saved settings loaded.'));
      }, { primary: true, busyLabel: 'Retrying...' })));
  }

  function saveRecoveryCard() {
    return h('div', { class: 'card save-recovery', dataset: { key: 'save-recovery' } },
      h('div', { class: 'title', text: t("Changes couldn't be saved") }),
      h('div', { class: 'desc', text: t('Your latest choices are still shown here. Retry to save them without losing the draft.') }),
      h('div', { class: 'actions' }, actionButton('settings:retry', 'Retry', async () => {
        await settings.retry();
        toast(t('Changes saved.'));
      }, { primary: true, busyLabel: 'Retrying...' })));
  }

  function resetUndoCard() {
    const reset = resetUndo.kind === 'reset';
    return h('div', { class: 'card reset-undo', dataset: { key: 'reset-undo' } },
      h('div', { class: 'title', text: t(reset ? 'Settings were reset' : resetUndo.kind === 'restore' ? 'Settings were restored' : 'Quick setup applied') }),
      h('div', { class: 'desc', text: t(reset
        ? "Undo puts back the choices you had before the reset. It stays here until you dismiss it or change a setting, and it's gone once you leave or reload this page."
        : "Undo puts back the choices you had before this change. It stays here until you dismiss it or change a setting, and it's gone once you leave or reload this page.") }),
      h('div', { class: 'actions' },
        actionButton('reset:undo', reset ? 'Undo reset' : 'Undo changes', undoReset, { primary: true, busyLabel: 'Undoing...' }),
        h('button', { class: 'button', type: 'button', text: t('Dismiss'), dataset: { key: 'reset:dismiss' }, disabled: pending.has('reset:undo'), onclick: dismissUndo })));
  }

  // Seen posts and playback state from before each account kept its own (core/activity.js).
  // They're only added to an account or deleted when you say so here.
  function legacyActivityCard(found) {
    const activity = environment.activity;
    const parts = [
      found.seen ? plural(found.seen, '{count} seen post', '{count} seen posts') : null,
      found.spots ? plural(found.spots, '{count} video spot', '{count} video spots') : null,
      found.speed ? t('a kept video speed') : null,
      found.volume ? t('a kept volume') : null,
    ].filter(Boolean);
    const list = parts.length > 1 ? t('{list} and {last}', { list: parts.slice(0, -1).join(', '), last: parts.at(-1) }) : parts[0];
    return h('div', { class: 'card', dataset: { key: 'legacy-activity' } },
      h('div', { class: 'title', text: t('Activity from before accounts were kept apart') }),
      h('div', { class: 'desc', text: activity.perAccount
        ? t("This browser still has {list} from before each Facebook account kept its own. They aren't tied to any account. Add them to the account you're signed in to, or delete them.", { list })
        : t("This browser still has {list} from before each Facebook account kept its own. They aren't tied to any account. Add them to signed-out browsing, or delete them.", { list }) }),
      h('div', { class: 'actions' },
        actionButton('legacy:add', activity.perAccount ? 'Add to this account' : 'Use while signed out', async () => {
          await activity.addLegacy();
          toast(activity.perAccount
            ? t("Added to the account you're signed in to. The shared copy stays until you delete it.")
            : t('Added to signed-out browsing. The shared copy stays until you delete it.'));
        }, { primary: true, busyLabel: 'Adding...' }),
        actionButton('legacy:delete', 'Delete them', async () => {
          const undo = await activity.clearLegacy();
          let failureNotice = null;
          const notice = toast(t('Deleted the activity from before accounts were kept apart.'), { action: { label: 'Undo', keep: true, run: async () => {
            try {
              await undo();
              failureNotice?.dismiss();
              notice.dismiss();
              if (dialog.open) render();
            } catch (error) {
              failureNotice = actionError("Couldn't restore the deleted activity. Try Undo again", error);
            }
          } } });
        }, { busyLabel: 'Deleting...' })));
  }

  function generalRows() {
    const update = environment.update?.();
    const storageState = environment.storage?.status?.().state;
    const reloaded = extensionReloaded(environment.storage);
    // Once the account changed, here or in another tab, nothing goes to any account until a reload.
    const legacy = environment.activity?.check() ? environment.activity.legacy() : null;
    const activityContext = environment.activity?.context?.();
    // Only a private window can lose changes made here, so only that note asks for attention.
    const activityNote = ACTIVITY_CONTEXT_NOTES[activityContext];
    // Titles, descriptions and labels in English, as in a feature (see updateRow). group is one
    // of GENERAL_GROUPS.
    return [
      ...(reloaded ? [{
        id: 'storage-recovery', section: 'general', group: 'attention', title: 'HushFacebook Web was updated',
        description: 'Reload the page so it can save your changes again.', options: [{ label: 'Reload page' }], focusKey: 'storage:reload',
        render: () => storageRecoveryCard(environment.storage.status().state),
      }] : storageState && storageState !== 'ready' ? [{
        id: 'storage-recovery', section: 'general', group: 'attention', title: storageState === 'loading' ? 'Loading saved settings' : "Saved settings aren't available",
        description: 'Retry extension storage without treating defaults as loaded choices.', options: [{ label: 'Retry' }], focusKey: 'storage:retry',
        render: () => storageRecoveryCard(environment.storage.status().state),
      }] : []),
      // Retrying a save can't work while the page runs the old copy. The card above says to reload.
      ...(preferenceSave.state === 'error' && !reloaded ? [{
        id: 'save-recovery', section: 'general', group: 'attention', title: "Changes couldn't be saved",
        description: 'Retry unsaved choices without losing the draft.', options: [{ label: 'Retry' }], focusKey: 'settings:retry',
        render: saveRecoveryCard,
      }] : []),
      ...(currentUndo() ? [{
        id: 'reset-undo', section: 'general', group: 'attention', title: resetUndo.kind === 'reset' ? 'Undo the settings reset' : 'Undo the settings change',
        description: 'Put back your earlier choices, until you change a setting or leave this page.',
        options: [{ label: resetUndo.kind === 'reset' ? 'Undo reset' : 'Undo changes', focusKey: 'reset:undo' }, { label: 'Dismiss', focusKey: 'reset:dismiss' }], focusKey: 'reset:undo', render: resetUndoCard,
      }] : []),
      ...(update?.update ? [{ ...updateRow(update), group: 'attention' }] : []),
      ...(activityNote ? [{
        id: 'activity-context', section: 'general', group: activityContext === 'private' ? 'attention' : 'about', title: 'Activity in this tab', description: activityNote,
        render: () => h('div', { class: 'card', dataset: { key: 'activity-context' } },
          h('div', { class: 'title', text: t('Activity in this tab') }), h('div', { class: 'desc', text: t(activityNote) })),
      }] : []),
      ...(legacy ? [{
        id: 'legacy-activity', section: 'general', group: 'attention', title: 'Activity from before accounts were kept apart',
        description: environment.activity.perAccount
          ? 'Seen posts and video spots shared by everyone on this browser. Add them to this account or delete them.'
          : 'Seen posts and video spots shared by everyone on this browser. Use them while signed out or delete them.',
        options: [{ label: environment.activity.perAccount ? 'Add to this account' : 'Use while signed out', focusKey: 'legacy:add' }, { label: 'Delete them', focusKey: 'legacy:delete' }], focusKey: 'legacy:add', render: () => legacyActivityCard(legacy),
      }] : []),
      { id: 'ui.launcher', section: 'general', group: 'facebook', title: 'Show the settings button', description: LAUNCHER_NOTE, vars: { opener: t(ALWAYS_OPENS) }, render: launcherCard },
      // environment.update is there only in the extension, the build with a toolbar button.
      ...(environment.update ? [{ id: 'ui.toolbarCount', section: 'general', group: 'facebook', title: 'Show the hidden count on the toolbar button', description: TOOLBAR_COUNT_NOTE, keywords: ['badge', 'icon'], render: toolbarCountCard }] : []),
      { id: 'ui.hiddenNote', section: 'general', group: 'facebook', title: 'Leave a note where a post was hidden', description: HIDDEN_NOTE_NOTE, render: hiddenNoteCard },
      { id: 'ui.loadWarning', section: 'general', group: 'facebook', title: 'Warn when the feed seems stuck', description: LOAD_WARNING_NOTE, keywords: ['loading', 'popup'], render: loadWarningCard },
      { id: 'ui.language', section: 'general', group: 'yours', title: 'Language', description: LANGUAGE_NOTE, options: LANGUAGES.map((entry) => ({ label: entry.label })), keywords: ['translation', 'locale', 'right to left'], focusKey: 'ui.language', render: languageCard },
      { id: 'backup-restore', section: 'general', group: 'yours', title: 'Back up and restore', description: BACKUP_NOTE,
        options: [
          { label: 'Back up settings', focusKey: 'backup', keywords: ['backup', 'export'] },
          { label: 'Restore from a file', focusKey: 'restore', keywords: ['import', 'load'] },
          { label: 'Reset to defaults', focusKey: 'reset' },
        ], focusKey: 'backup', render: backupCard },
      ...(update && !update.update ? [{ ...updateRow(update), group: 'about' }] : []),
      { id: 'report-problem', section: 'general', group: 'about', title: 'Report a problem', description: REPORT_NOTE, keywords: ['bug', 'issue'], render: reportProblemCard },
      { id: 'kofi', section: 'general', group: 'about', title: 'Buy me a coffee', keywords: ['donate', 'kofi'], render: kofiCard },
    ];
  }

  function generalView() {
    const rows = generalRows();
    return GENERAL_GROUPS.map((group) => {
      const shown = rows.filter((row) => row.group === group.id);
      return shown.length ? groupBlock(`general-${group.id}`, group.title && t(group.title), shown.map((row) => row.render())) : null;
    }).filter(Boolean);
  }

  // Overview's own row for search, as a General row is.
  const overviewRows = () => [{
    id: 'quick-setups', section: 'overview', title: 'Quick setups', description: QUICK_SETUPS_NOTE,
    options: QUICK_SETUPS.map((setup) => ({ label: setup.label, focusKey: `quick:${setup.id}`, keywords: setup.reset ? ['reset'] : [] })),
    focusKey: 'quick:quiet', render: quickSetupsCard,
  }];

  function hiddenSummary() {
    const counts = Object.entries(hider?.counts() ?? {});
    return counts.length ? counts.map(([reason, count]) => `${reason} ${count}`).join(', ') : t('None yet');
  }

  const featureRows = () => diagnostics?.rows() ?? [];
  const decisions = () => diagnostics?.decisions?.() ?? [];

  // The values, the hide decisions and the log stay in English, as Copy report has them.
  function diagnosticsView() {
    const entries = log.entries().slice(-150);
    const blocked = features.filter((feature) => unavailable.has(feature.id))
      .map((feature) => `${t(feature.title)} (${t(UNAVAILABLE_SHORT[unavailable.get(feature.id)] ?? UNAVAILABLE_SHORT.failed)})`);
    return [
      h('div', { class: 'diagnostic-summary' },
        h('h3', { class: 'summary-title', text: t('Environment') }),
        h('dl', null,
        h('dt', { text: t('Version') }), h('dd', { text: environment.version }),
        h('dt', { text: t('Userscript manager') }), h('dd', { text: `${environment.manager} ${environment.managerVersion}` }),
        h('dt', { text: t('Injection mode') }), h('dd', { text: environment.mode }),
        h('dt', { text: t('Page access') }), h('dd', { text: t(environment.pageAccess === 'page' ? 'Yes' : 'No. Network and playback features are off. In Violentmonkey, set this script to inject into the page.') }),
        h('dt', { text: t("Features that didn't start") }), h('dd', { text: blocked.length ? blocked.join(', ') : t('None') }),
        h('dt', { text: t('Posts hidden since the page loaded') }), h('dd', { text: hiddenSummary() }),
        ...featureRows().flatMap(({ label, value }) => [h('dt', { text: t(label) }), h('dd', { text: value })])),
      h('div', { class: 'actions' }, actionButton('copy-report', 'Copy report', copyReport, { primary: true, busyLabel: 'Copying...' }))),
      h('section', { class: 'diagnostic-group' },
      h('h3', { class: 'subheading', text: t('Why posts were hidden') }),
      h('p', { class: 'desc', text: t("The last 50, newest first. data means it came out of Facebook's data before it was drawn, page means it was hidden on the page. Each post has a short tag instead of its id.") }),
      decisions().length
        ? h('div', { class: 'log', dir: 'ltr' }, decisions().slice().reverse().map((decision) => h('div', { text: decisionLine(decision) })))
        : h('p', { class: 'empty', text: t('Nothing hidden yet.') })),
      h('section', { class: 'diagnostic-group' },
      h('h3', { class: 'subheading', text: t('Recent log') }),
      entries.length
        ? h('div', { class: 'log', dir: 'ltr' }, entries.map((entry) => h('div', { class: entry.level, text: `${entry.time.slice(11, 19)} ${entry.level.padEnd(5)} ${entry.message}${entry.detail ? `\n    ${entry.detail}` : ''}` })))
        : h('p', { class: 'empty', text: t('Nothing logged yet.') })),
    ];
  }

  // The page's name labels the main region for screen readers. On screen the sidebar already
  // says where you are, so the options start right under the top bar.
  function pageTitle(title) {
    return h('h3', { class: 'visually-hidden', id: 'hfw-section-title', text: title });
  }

  function navButton(page, searching) {
    const list = pageFeatures(page.id);
    const on = list.filter((feature) => settingValue(feature.id) === true).length;
    return h('button', {
      type: 'button', dataset: { key: `nav:${page.id}` },
      'aria-current': !searching && page.id === current ? 'page' : null,
      onclick: () => showPage(page.id),
    },
    navigationIcon(page.id),
    h('span', { class: 'nav-title', text: t(page.title) }),
    pageIsNew(page.id) ? newDot() : null,
    on ? h('span', { class: 'nav-count' }, h('span', { 'aria-hidden': 'true', text: String(on) }), h('span', { class: 'visually-hidden', text: t('{count} on', { count: on }) })) : null);
  }

  function render() {
    const direction = root.getAttribute('dir');
    const directionChanged = renderedDirection !== null && renderedDirection !== direction;
    renderedDirection = direction;
    const focused = shadow.activeElement;
    const focusedKey = focused?.dataset?.key;
    const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const scrollTop = main.scrollTop;
    const navScroll = [nav.scrollLeft, nav.scrollTop];
    const searching = query.trim() !== '';
    power.disabled = bulkChangePending();
    nav.replaceChildren(h('div', { class: 'nav-label', text: t('Settings') }), ...pages.flatMap((page) => [
      page.divider ? h('hr') : null,
      navButton(page, searching),
    ]).filter(Boolean));
    if (searching) {
      const found = findFeatures([...features, ...overviewRows(), ...generalRows()], places, query);
      main.replaceChildren(
        pageTitle(t('Search')),
        ...(reloadPending ? [reloadCard()] : []),
        // No results have their own message, so the count shows only over a list.
        ...(found.length ? [h('p', { class: 'search-count', text: searchCount(found.length) })] : []),
        ...resultsView(found));
      announceSearch(searchCount(found.length));
    } else {
      announceSearch('');
      for (const group of groups) if (group.page === current) newDots.visit(group.id);
      const page = pages.find((entry) => entry.id === current);
      const views = { overview: overviewView, general: generalView, diagnostics: diagnosticsView };
      main.replaceChildren(
        pageTitle(t(page.title)),
        ...(reloadPending ? [reloadCard()] : []),
        ...(views[current] ?? (() => pageView(current)))());
    }
    main.scrollTop = scrollTop;
    nav.scrollLeft = navScroll[0];
    nav.scrollTop = navScroll[1];
    // Horizontal scroll offsets change sign in RTL. Keep the selected section in view
    // when a language change mirrors the panel, while preserving normal redraw scroll.
    if (directionChanged) nav.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focusedKey) {
      const replacement = root.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      replacement?.focus({ preventScroll: true });
      if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
    }
  }

  // Speaks the count once typing has settled, and not again while it stays the same. Leaving
  // the search clears it without a word.
  function announceSearch(text) {
    clearTimeout(searchStatusTimer);
    if (!text) {
      searchStatus.textContent = '';
      return;
    }
    searchStatusTimer = setTimeout(() => {
      if (dialog.open && searchStatus.textContent !== text) searchStatus.textContent = text;
    }, SEARCH_SETTLE_MS);
  }

  function refreshChrome() {
    const paused = settingValue('paused') === true;
    power.checked = !paused;
    pauseState.textContent = t(settings.tabPaused ? 'Paused in this tab' : paused ? 'Paused' : 'On');
    powerControl.dataset.state = settings.tabPaused || paused ? 'paused' : 'on';
    // Settings in your account menu can stand in for the button, unless it couldn't start or
    // stopped working.
    const inMenu = hasMenuEntry && settings.enabled('menuEntry') && settings.get('menuEntry.hideButton') === true && !unavailable.has('menuEntry');
    launcher.hidden = settings.get('ui.launcher') !== true || inMenu;
    launcherSpot.update();
  }

  function refreshSaveState() {
    if (extensionReloaded(environment.storage)) {
      saveState.dataset.state = 'error';
      saveState.textContent = t('Extension updated. Reload the page to save.');
      return;
    }
    saveState.dataset.state = preferenceSave.state;
    saveState.textContent = t(preferenceSave.state === 'saving'
      ? 'Saving changes...'
      : preferenceSave.state === 'error'
        ? "Changes couldn't be saved. Open General to retry."
        : 'Changes apply as you go.');
  }

  // ---- actions ----

  function exportSettings() {
    try {
      saveThroughLink(new Blob([settings.exportJson()], { type: 'application/json' }),
        `hushfacebook-web-settings-${new Date().toISOString().slice(0, 10)}.json`, document, root);
      toast(t(preferenceSave.pending.length ? 'Settings saved to a file, including choices waiting to save.' : 'Settings saved to a file.'));
    } catch (error) {
      actionError("Couldn't back up settings. Try again", error);
    }
  }

  async function importSettings() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (bulkChangePending()) return;
    pending.add('import');
    pending.add('restore');
    render();
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new TypeError('Choose a settings file smaller than 1 MB');
      const text = await file.text();
      await new Promise((resolve) => settings.whenLoaded(resolve));
      const { applied, skipped, previous } = await settings.importJson(text, { withPrevious: true });
      drafts.clear();
      fieldErrors.clear();
      const undo = previous && rememberUndo(previous, { kind: 'restore', focusKey: 'restore' });
      const message = skipped.length
        ? plural(applied.length, "Restored {count} setting, and skipped {skipped} this version can't use.", "Restored {count} settings, and skipped {skipped} this version can't use.", { skipped: skipped.length })
        : plural(applied.length, 'Restored {count} setting.', 'Restored {count} settings.');
      if (undo) offerUndo(message);
      else toast(message);
    } catch (error) {
      actionError(error instanceof TypeError ? error.message : "Couldn't restore settings. Choose a valid backup and try again", error);
    } finally {
      pending.delete('import');
      pending.delete('restore');
      if (dialog.open) render();
    }
  }

  function rememberUndo(previous, { kind, focusKey }) {
    const after = settings.snapshot();
    if (sameAs((key) => recordValue(previous, key), after) || !accountMatches()) return false;
    resetUndo = { previous, after, restoring: false, kind, focusKey };
    return true;
  }

  // Each notice's Undo acts only on the change it announced, and a newer change takes the
  // older notice down, so an Undo left on screen can't put back the wrong change.
  function offerUndo(message) {
    undoNotice?.dismiss();
    const record = resetUndo;
    undoNotice = toast(message, { action: { label: 'Undo', run: () => startUndo(record) } });
  }

  function dropUndoNotice() {
    undoNotice?.dismiss();
    undoNotice = null;
  }

  function resetSettings() {
    const succeeded = (previous) => {
      drafts.clear();
      fieldErrors.clear();
      // Resetting settings that were already at their defaults keeps any earlier Undo.
      rememberUndo(previous, { kind: 'reset', focusKey: 'reset' });
      render();
      if (resetUndo) offerUndo(t('Settings are back to their defaults. Undo stays in General until you change a setting or leave this page.'));
      else toast(t('Settings are back to their defaults.'));
    };
    const saved = settings.reset();
    return saved && typeof saved.then === 'function' ? saved.then(succeeded) : succeeded(saved);
  }

  // Puts back the choices from before the reset once storage has saved them. A failure keeps
  // the Undo in General for another try.
  function undoReset() {
    const undo = currentUndo();
    if (!undo) {
      toast(t("Undo isn't available any more. A setting changed, or another Facebook account signed in."));
      if (dialog.open) render();
      return undefined;
    }
    undo.restoring = true;
    return Promise.resolve().then(() => settings.restore(undo.previous)).then(
      () => {
        undo.restoring = false;
        if (resetUndo === undo) {
          resetUndo = null;
          dropUndoNotice();
        }
        toast(t(undo.kind === 'reset' ? 'Your settings from before the reset are back.' : 'Your settings from before the change are back.'));
        if (dialog.open) {
          render();
          root.querySelector(`[data-key="${CSS.escape(undo.focusKey)}"]`)?.focus({ preventScroll: true });
        }
      },
      (error) => {
        undo.restoring = false;
        actionError(undo.kind === 'reset' ? "Couldn't undo the settings reset. Undo is still in General" : "Couldn't undo those settings changes. Undo is still in General", error);
      },
    );
  }

  // The notice's Undo, sharing the General row's busy state so the two can't both run. expected
  // is the change that notice announced. Once a newer one replaced it, there's nothing to undo.
  function startUndo(expected) {
    if (bulkChangePending() || pending.has('reset:undo')) return;
    if (expected && currentUndo() !== expected) {
      toast(t("Undo isn't available any more. A setting changed, or another Facebook account signed in."));
      return;
    }
    pending.add('reset:undo');
    if (dialog.open) render();
    Promise.resolve(undoReset()).finally(() => {
      pending.delete('reset:undo');
      if (dialog.open) render();
    });
  }

  function dismissUndo() {
    const focusKey = currentUndo()?.focusKey ?? 'reset';
    resetUndo = null;
    dropUndoNotice();
    render();
    root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    toast(t('Undo dismissed.'));
  }

  function reloadFacebook() {
    const timestamp = now();
    const searchQuery = query.trim();
    const marker = searchQuery
      ? { page: 'find', section: current, query, timestamp }
      : { page: current, timestamp };
    try {
      reloadStorage?.setItem(RELOAD_MARKER_KEY, JSON.stringify(marker));
    } catch (error) {
      log.warn("Couldn't remember which settings page to reopen", error);
    }
    reloadPage();
  }

  function reopenAfterReload() {
    if (!reloadStorage) return;
    let marker;
    try {
      const saved = reloadStorage.getItem(RELOAD_MARKER_KEY);
      if (saved === null) return;
      // One shot even when the value is old or malformed, and clear before opening so a
      // failing page can't get stuck reopening the panel on every reload.
      reloadStorage.removeItem(RELOAD_MARKER_KEY);
      marker = JSON.parse(saved);
    } catch (error) {
      log.warn("Couldn't reopen settings after the reload", error);
      return;
    }
    if (typeof marker?.timestamp !== 'number' || !Number.isFinite(marker.timestamp)) return;
    const age = now() - marker.timestamp;
    if (age < 0 || age >= RELOAD_MARKER_MAX_AGE_MS) return;
    if (marker.page === 'find') {
      if (pageOf(marker.section) && typeof marker.query === 'string' && marker.query.trim()) open(marker.section, marker.query);
      return;
    }
    if (pageOf(marker.page)) open(marker.page);
  }

  async function copyReport() {
    const report = buildDiagnosticReport({
      version: environment.version,
      manager: environment.manager,
      managerVersion: environment.managerVersion,
      mode: environment.mode,
      pageAccess: environment.pageAccess,
      browser: navigator.userAgent,
      settings,
      unavailable,
      hidden: hider?.counts() ?? {},
      rows: featureRows(),
      decisions: decisions(),
      log: log.entries(),
    });
    try {
      await navigator.clipboard.writeText(report);
      toast(t('Report copied. Paste it into a GitHub issue.'));
    } catch (error) {
      actionError("Couldn't copy the report", error);
    }
  }

  // ---- open, close, live updates ----

  // sectionId: a page, or a group, which opens its page scrolled to it.
  function open(sectionId, searchQuery) {
    // Every opening is a fresh look, so a Less from before shows its row open again.
    closedHelp.clear();
    const pageId = sectionId ? pageOf(sectionId) : null;
    if (pageId) {
      if (pageId !== current || query) main.scrollTop = 0;
      current = pageId;
      if (typeof searchQuery === 'string' && searchQuery.trim()) {
        setQuery(searchQuery);
        search.value = searchQuery;
      } else {
        clearSearch();
      }
    }
    if (!dialog.open) {
      opener = shadow.activeElement ?? document.activeElement;
      newDots.start();
    }
    render();
    moveStacks(dialog);
    if (!dialog.open) dialog.showModal();
    revealCurrentPage();
    if (pageId && pageId !== sectionId && !query) main.querySelector(`[data-group="${CSS.escape(sectionId)}"]`)?.scrollIntoView?.({ block: 'start' });
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    dialog.close();
  }

  settings.subscribe(() => {
    supersedeUndo();
    syncLanguage();
    refreshSaveState();
    refreshChrome();
    reloadPending = reloadKeys.some((key) => settings.get(key) !== reloadBaseline.get(key));
    if (dialog.open) render();
  });
  settings.whenLoaded(() => {
    syncLanguage();
    refreshSaveState();
    refreshChrome();
    reloadBaseline = new Map(reloadKeys.map((key) => [key, reloadValueAtLoad(key)]));
    reloadPending = reloadKeys.some((key) => settings.get(key) !== reloadBaseline.get(key));
    if (dialog.open) render();
  });
  settings.onSaveStatus?.((status) => {
    preferenceSave = status;
    supersedeUndo();
    refreshSaveState();
    refreshChrome();
    if (dialog.open) render();
  });

  let lastErrorToast = 0;
  let lastErrorNotice = null;
  // Once the extension is gone from this tab every save fails the same way, so one notice with a
  // Reload button stands for all of them. It stays until used or dismissed, and comes back only
  // when something you did needed it (force: a settings action, or a save from the page).
  let reloadNotice = null;
  const announceReload = (force = false) => {
    if (reloadNotice && !force) return reloadNotice;
    reloadNotice?.dismiss();
    lastErrorNotice?.dismiss();
    reloadNotice = toast(t('HushFacebook Web was updated. Reload this page to keep saving your changes.'), {
      tone: 'error',
      duration: Infinity,
      actions: [
        { label: 'Reload', run: () => (dialog.open ? reloadFacebook() : reloadPage()) },
        { label: 'Dismiss', run: () => {} },
      ],
    });
    return reloadNotice;
  };
  // A failure the reload caused goes under the reload notice, even one (a download, say) that
  // found out before the storage did. After a reload, so does one logged before the panel could
  // see why. Anything else, like a copy the clipboard refused, keeps its own.
  const announceError = (entry, force = false, translated = null, detail) => {
    if (codeIn(detail) === EXTENSION_RELOADED || (detail === undefined && extensionReloaded(environment.storage))) {
      announceReload(force);
      return;
    }
    if (!force && Date.now() - lastErrorToast < ERROR_TOAST_GAP_MS) return;
    if (force) lastErrorNotice?.dismiss();
    lastErrorToast = Date.now();
    // The log keeps the English. The notice shows it translated where the catalog has it, and a
    // message that already ends its sentence doesn't get a second period.
    const message = translated ?? t(entry.message);
    const text = /[.!?。！？]$/.test(message) ? t('{message} Details are in Diagnostics.', { message }) : t('{message}. Details are in Diagnostics.', { message });
    lastErrorNotice = toast(text, { tone: 'error', action: { label: 'Open', run: () => open('diagnostics') } });
  };
  function actionError(message, error, vars) {
    log.error('A settings action failed. Try again', error);
    const code = codeIn(error);
    const translated = code === 'ACTIVITY_SAVE_UNCONFIRMED'
      ? t('This activity save is still unconfirmed. Your recovery copy stays here.')
      : code === 'ACTIVITY_REGISTER_CONFLICT'
        ? t('Two tabs saved different activity. Try the action again to use this copy')
      : t(message, vars);
    announceError({ message }, true, translated, error ?? null);
    return lastErrorNotice;
  }
  let renderQueued = false;
  let statusQueued = false;
  // A card's status line is rewritten where it is, so a list being typed into keeps its focus.
  const refreshStatuses = () => {
    if (!dialog.open || statusQueued || !root.querySelector('[data-status-for]')) return;
    statusQueued = true;
    requestAnimationFrame(() => {
      statusQueued = false;
      for (const node of root.querySelectorAll('[data-status-for]')) {
        const text = t(diagnostics.statusOf(node.getAttribute('data-status-for')) ?? '');
        node.hidden = text === '';
        if (node.textContent !== text) node.textContent = text;
      }
      // Status-driven recovery can add a Retry action or acknowledge a watched entry while
      // this page stays open. Replace only those widgets, preserving any input being edited.
      for (const node of root.querySelectorAll('[data-actions-for], [data-links-for]')) {
        const id = node.dataset.actionsFor ?? node.dataset.linksFor;
        const feature = features.find((item) => item.id === id);
        if (!feature) continue;
        const buttons = node.dataset.actionsFor !== undefined;
        const found = buttons ? actions?.list(id) ?? [] : actions?.links?.(id);
        const signature = buttons ? JSON.stringify(found.map(({ label, index }) => [label, index])) : JSON.stringify(found);
        if (signature === (buttons ? node.dataset.actionSignature : linkSignatures.get(node))) continue;
        const active = shadow.activeElement;
        const restore = node.contains(active);
        const replacement = buttons ? featureActions(feature) : featureLinks(feature);
        if (!replacement) continue;
        node.replaceWith(replacement);
        if (restore) {
          const next = buttons ? replacement.querySelector(`[data-key="${CSS.escape(active.dataset.key)}"]`)
            : [...replacement.querySelectorAll('a')].find((link) => link.getAttribute('href') === active.getAttribute('href'));
          (next ?? root.querySelector(`[data-key="${CSS.escape(id)}"]`))?.focus({ preventScroll: true });
        }
      }
    });
  };
  const refreshDiagnostics = () => {
    refreshStatuses();
    if (!dialog.open || current !== 'diagnostics' || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (dialog.open && current === 'diagnostics') render();
    });
  };
  log.subscribe((entry, detail) => {
    if (entry.level === 'error') announceError(entry, false, null, detail ?? null);
    refreshDiagnostics();
  });
  hider?.subscribe(refreshDiagnostics);
  diagnostics?.subscribe(refreshDiagnostics);
  hider?.subscribe(refreshHiddenCard);
  diagnostics?.subscribe(refreshHiddenCard);
  environment.storage?.onStatus?.(() => {
    if (extensionReloaded(environment.storage)) {
      announceReload();
      refreshSaveState();
    }
    if (dialog.open) render();
  });
  const earlier = log.entries().findLast((entry) => entry.level === 'error');
  if (earlier) announceError(earlier);

  refreshSaveState();
  refreshChrome();
  // For changes from outside the settings: a feature that stopped, the extension's update notice.
  const refresh = () => {
    refreshChrome();
    if (dialog.open) render();
  };
  reopenAfterReload();
  // For notices from the page. reload: true is the one reload notice (the message isn't used),
  // put back even after a dismiss, since what the person just did needed it.
  const notice = (message, options) => (options?.reload ? announceReload(true) : toast(message, options));
  return { open, close, toast: notice, refresh, copyReport };
}
