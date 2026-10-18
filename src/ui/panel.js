// The settings panel lives in a closed shadow root so Facebook's CSS and scripts can't
// reach it. Changes apply at once with a toast; there are no confirmation dialogs, and
// Reset offers Undo instead of asking first.

import { decisionLine } from '../core/diagnostics.js';
import { MAX_BACKUP_BYTES } from '../core/settings.js';
import { TARGET } from '../core/target.js';
import { SECTIONS } from '../features/sections.js';
import { h, icon } from './h.js';
import { SLIDERS_ICON } from './icons.js';
import { navigationIcon } from './navigation-icons.js';
import { buildDiagnosticReport } from './diagnostic-report.js';
import { buildProblemReport } from './problem-report.js';
import { applyQuickSetup, QUICK_SETUPS } from './quick-setups.js';
import { findFeatures } from './search.js';
import { panelCss } from './styles.js';

const ALWAYS_OPENS = TARGET === 'extension' ? "The extension's toolbar button" : "Your userscript manager's menu";
const ERROR_TOAST_GAP_MS = 15000;
const KOFI_URL = 'https://ko-fi.com/X8K126YVER';
const RELOAD_MARKER_KEY = 'hfw:settings-reload';
const RELOAD_MARKER_MAX_AGE_MS = 90_000;
const SECTION_DESCRIPTIONS = {
  feed: 'Choose what makes it into your feed.',
  reels: 'Make video time your own.',
  stories: 'Watch stories at your own pace.',
  comments: 'Read the conversation your way.',
  search: 'Keep the results you came for.',
  marketplace: 'A clearer place to buy and sell.',
  chats: 'Choose what your conversations share.',
  notifications: 'Keep the updates that matter to you.',
  privacy: 'Choose what Facebook gets to know.',
  links: 'Cleaner links, fewer detours.',
  downloads: 'Save the moments you want to keep.',
  playback: 'More control over every video.',
  appearance: 'Make Facebook feel like yours.',
  menu: 'Keep your menu focused.',
  meta: 'Less promotion, more room for you.',
  opening: 'Start where you want to be.',
  general: 'Settings for HushFacebook Web.',
  diagnostics: 'See how HushFacebook Web is running.',
};
// Why a feature isn't running, by the reason startFeatures recorded: on its card, then
// shorter in Diagnostics.
const UNAVAILABLE_NOTES = {
  page: "This one has to run in Facebook's page, and your userscript manager runs the script outside it. Diagnostics says how to change that.",
  api: "Your browser or userscript manager doesn't offer what this one needs.",
  failed: "This one couldn't start on this page, or stopped working. The log in Diagnostics says why.",
};
const UNAVAILABLE_SHORT = { page: 'needs page access', api: 'missing from this browser or manager', failed: 'see the log' };
const searchCount = (count) => (count === 0 ? 'No setting matches.' : count === 1 ? '1 setting matches.' : `${count} settings match.`);
const SEARCH_SETTLE_MS = 600;

export function mountPanel({ settings, features, log, hider, diagnostics, actions, unavailable, environment }) {
  // Inline and important, so no page rule (Custom CSS included, say div:empty) can hide the
  // panel and with it the only way to undo that rule.
  const host = h('div', { dataset: { hushfacebookWeb: 'ui' }, style: 'all: initial !important' });
  const shadow = host.attachShadow({ mode: 'closed' });
  const root = h('div', { class: 'root' });
  shadow.append(h('style', { text: panelCss }), root);

  const sections = [
    ...SECTIONS.filter((section) => features.some((feature) => feature.section === section.id)),
    { id: 'general', title: 'General', divider: true },
    { id: 'diagnostics', title: 'Diagnostics' },
  ];
  let current = sections[0].id;
  let query = '';
  let opener = null;
  const drafts = new Map();
  const fieldErrors = new Map();
  const pending = new Set();
  let preferenceSave = settings.saveStatus?.() ?? { state: 'idle', error: null, pending: [] };
  const quickSetupPending = () => [...pending].some((key) => key.startsWith('quick:'));
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

  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const launcher = h(
    'button',
    { class: 'launcher', type: 'button', 'aria-label': 'Open HushFacebook Web settings', title: 'HushFacebook Web settings', onclick: () => open() },
    icon(SLIDERS_ICON),
  );
  const nav = h('nav', { 'aria-label': 'Settings sections' });
  const main = h('main', { 'aria-labelledby': 'hfw-section-title' });
  // One element for the life of the panel, so typing keeps its place across redraws.
  const search = h('input', {
    class: 'search', type: 'search', placeholder: 'Find a setting', 'aria-label': 'Find a setting',
    autocomplete: 'off', spellcheck: 'false', dataset: { key: 'search' },
    oninput: (event) => { query = event.target.value; main.scrollTop = 0; render(); },
  });
  const searchField = h('div', { class: 'search-field' }, navigationIcon('search'), search);
  const pauseState = h('span', { class: 'power-state' });
  const saveState = h('span', { class: 'save-state', role: 'status', dataset: { key: 'save-state', state: preferenceSave.state } });
  // One live region for the life of the panel. The visible count is redrawn on every key, so
  // only this one speaks, and only once the count has held still for a moment.
  const searchStatus = h('p', { class: 'visually-hidden', role: 'status', dataset: { key: 'search-status' } });
  let searchStatusTimer = null;
  // Checked means running, so the switch agrees with the "On" chip beside it.
  const power = h('input', {
    class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': 'HushFacebook Web on', dataset: { key: 'power' },
    onchange: (event) => apply('paused', !event.target.checked),
  });
  const closeButton = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close settings', dataset: { key: 'close' }, onclick: () => close() }, navigationIcon('close'));
  const dialog = h(
    'dialog',
    { class: 'dialog', 'aria-labelledby': 'hfw-title' },
    h('header', null,
      h('div', { class: 'brand' },
        h('span', { class: 'brand-icon' }, icon(SLIDERS_ICON)),
        h('div', { class: 'brand-copy' },
          h('h2', { id: 'hfw-title', text: 'HushFacebook Web' }),
          h('span', { class: 'brand-subtitle', text: 'Settings' })),
        h('span', { class: 'chip', text: `v${environment.version}` })),
      h('div', { class: 'header-actions' }, pauseState, power, closeButton)),
    h('div', { class: 'body' }, nav, main),
    h('footer', null,
      saveState,
      h('span', { class: 'footer-brand', text: 'HushFacebook Web' })),
    searchStatus,
  );
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.addEventListener('close', () => {
    announceSearch('');
    root.append(toasts);
    if (opener?.isConnected && !opener.hidden && opener !== document.body && opener !== document.documentElement) opener.focus({ preventScroll: true });
    else if (!launcher.hidden) launcher.focus({ preventScroll: true });
    opener = null;
  });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importSettings });
  dialog.append(fileInput);
  root.append(launcher, dialog, toasts);
  document.body.append(host);

  async function apply(key, value, control) {
    if (quickSetupPending()) return;
    const draft = control?.value;
    try {
      if (control && !control.validity.valid) {
        const spec = settings.schema.get(key);
        throw new TypeError(spec.type === 'number' ? `Enter a number from ${spec.min} to ${spec.max}.` : 'Check this value and try again.');
      }
      drafts.delete(key);
      fieldErrors.delete(key);
      await settings.set(key, value);
    } catch (error) {
      if (control && error instanceof TypeError) {
        drafts.set(key, draft);
        fieldErrors.set(key, error.message);
      }
      if (!(control && error instanceof TypeError)) log.error("Couldn't save your change. Try again", error);
      refreshChrome();
      if (dialog.open) render();
    }
  }

  // duration Infinity keeps the notice until dismiss() on what this returns, or its action.
  function toast(message, { tone = 'info', action, duration } = {}) {
    const el = h('div', { class: `toast ${tone}`, role: tone === 'error' ? 'alert' : null },
      h('span', { text: message }),
      action ? h('button', { type: 'button', text: action.label, onclick: () => { el.remove(); action.run(); } }) : null);
    toasts.append(el);
    // A notice the pointer is over, or that holds focus, stays until both move off it, then
    // gets its full time again.
    let hovered = false;
    let focused = false;
    let timer = null;
    const wait = duration ?? (action ? 7000 : 4000);
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
      class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': label,
      'aria-describedby': describedBy, 'aria-disabled': stuck ? 'true' : null,
      checked: on, disabled: quickSetupPending(), dataset: { key },
      onclick: stuck ? (event) => event.preventDefault() : undefined,
      onchange: (event) => apply(key, event.target.checked),
    });
  }

  function optionControl(feature, option) {
    const key = `${feature.id}.${option.key}`;
    const value = drafts.get(key) ?? settingValue(key);
    const errorId = `hfw-error-${key}`;
    const props = {
      dataset: { key }, 'aria-invalid': fieldErrors.has(key) ? 'true' : null,
      'aria-describedby': fieldErrors.has(key) ? errorId : null,
      disabled: quickSetupPending(),
      oninput: (event) => drafts.set(key, event.target.value),
    };
    const field = (control) => h('div', { class: 'field' }, h('label', null, option.label, control),
      fieldErrors.has(key) ? h('p', { class: 'field-error', id: errorId, role: 'alert', text: fieldErrors.get(key) }) : null);
    switch (option.type) {
      case 'toggle':
        return h('label', { class: 'option-toggle' }, toggle(key, option.label), h('span', { text: option.label }));
      case 'select':
        return field(h('select', { ...props, onchange: (event) => apply(key, option.choices.find((choice) => String(choice.value) === event.target.value)?.value, event.target) },
            option.choices.map((choice) => h('option', { value: String(choice.value), selected: choice.value === value, text: choice.label }))));
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
            rows: option.rows ?? 3, class: option.code ? 'code' : undefined, spellcheck: option.code ? 'false' : undefined,
            // The browser stops a paste at the setting's limit, rather than the save failing
            // and the text being lost on the next redraw.
            maxLength: option.maxLength,
            onchange: (event) => apply(key, event.target.value, event.target),
          }, value));
    }
  }

  // Buttons the feature added for itself (ctx.actions).
  function featureActions(feature) {
    const list = actions?.list(feature.id) ?? [];
    if (!list.length) return null;
    return h('div', { class: 'actions' }, list.map(({ label, run }, index) => actionButton(`action:${feature.id}:${index}`, label, run)));
  }

  function actionButton(key, label, run, { primary = false, busyLabel = 'Working...' } = {}) {
    const locked = quickSetupPending() && !pending.has(key) && key !== 'storage:retry';
    return h('button', {
      class: `button${primary ? ' primary' : ''}`, type: 'button', text: pending.has(key) ? busyLabel : label,
      dataset: { key }, disabled: locked, 'aria-disabled': pending.has(key) ? 'true' : null, 'aria-busy': pending.has(key) ? 'true' : null,
      onclick: async () => {
        if (pending.has(key)) return;
        pending.add(key);
        render();
        try {
          await run();
        } catch (error) {
          log.error(`${label} failed. Try again`, error);
        } finally {
          pending.delete(key);
          if (dialog.open) render();
        }
      },
    });
  }

  function featureCard(feature, { showOptions = false } = {}) {
    const reason = unavailable.get(feature.id);
    const blocked = reason !== undefined;
    const on = settingValue(feature.id) === true;
    // Stable ids, so the switch reads its help, why it's unavailable and the reload note.
    const ids = { desc: `hfw-${feature.id}-desc`, note: `hfw-${feature.id}-note`, reload: `hfw-${feature.id}-reload` };
    const describedBy = [ids.desc, blocked ? ids.note : null, feature.reload ? ids.reload : null].filter(Boolean).join(' ');
    return h('div', { class: `card${blocked ? ' unavailable' : ''}` },
      h('div', { class: 'row' },
        h('div', { class: 'text' },
          h('div', { class: 'title', text: feature.title }),
          h('div', { class: 'desc', id: ids.desc, text: feature.description }),
          blocked ? h('div', { class: 'note', id: ids.note, text: `${UNAVAILABLE_NOTES[reason] ?? UNAVAILABLE_NOTES.failed}${on ? ' You can still turn it off.' : ''}` }) : null,
          feature.reload ? h('div', { class: 'note', id: ids.reload, text: 'Applies after Facebook reloads.' }) : null),
        toggle(feature.id, feature.title, { locked: blocked, describedBy })),
      (on || showOptions) && feature.options?.length ? h('div', { class: 'options' }, feature.options.map((option) => optionControl(feature, option))) : null,
      on ? featureActions(feature) : null);
  }

  function sectionView(section) {
    return features.filter((feature) => feature.section === section.id).map(featureCard);
  }

  function clearSearch() {
    query = '';
    search.value = '';
  }

  // A search result's section link: opens the section with that row's control focused.
  function showSetting(setting) {
    clearSearch();
    current = setting.section;
    main.scrollTop = 0;
    render();
    const control = main.querySelector(`[data-key="${CSS.escape(setting.focusKey ?? setting.id)}"]`);
    control?.scrollIntoView?.({ block: 'center' });
    control?.focus({ preventScroll: true });
  }

  function resultsView(found) {
    if (!found.length) return [h('p', { class: 'empty', text: `No setting matches "${query.trim()}". Try a shorter word, or pick a section.` })];
    return [h('div', { class: 'settings-group results' }, found.map((setting) => {
      const section = sections.find((entry) => entry.id === setting.section);
      return h('div', { class: 'result' },
        h('button', { class: 'result-section', type: 'button', text: `In ${section.title}`, dataset: { key: `show:${setting.id}` }, onclick: () => showSetting(setting) }),
        setting.render ? setting.render() : featureCard(setting, { showOptions: true }));
    }))];
  }

  // How the extension's release check went (environment.update, extension only, from
  // src/core/extension.js updateStatus), with the newer release when there is one.
  const when = (time) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function updateLine(status) {
    if (status.checking) return 'Checking GitHub now.';
    const checked = status.checkedAt === null ? '' : `Checked ${when(status.checkedAt)}.`;
    const lastWorked = status.checkedAt === null ? 'No check has worked yet.' : `The last one that worked was ${when(status.checkedAt)}.`;
    const tried = status.triedAt === null ? 'The last check' : `The check on ${when(status.triedAt)}`;
    if (status.state === 'current') return `You have the newest release. ${checked}`.trim();
    if (status.state === 'newer') return checked;
    if (status.state === 'offline') return `${tried} couldn't reach GitHub. ${lastWorked} It tries again on its own.`;
    if (status.state === 'failed') return `GitHub's answer to ${tried.toLowerCase()} didn't make sense. ${lastWorked} It tries again on its own.`;
    if (status.state === 'rate-limited') {
      const until = status.nextAt === null ? 'GitHub asked for a pause before the next check.' : `GitHub asked for a pause, so the next check waits until ${when(status.nextAt)}.`;
      return `${until} ${lastWorked}`;
    }
    return 'No check has finished for this version yet. It checks GitHub once a day.';
  }

  async function checkForUpdateNow() {
    const answer = await environment.checkForUpdate();
    if (answer?.asked !== false) return;
    const status = environment.update?.();
    toast(status?.state === 'rate-limited' && status.nextAt > Date.now()
      ? `GitHub asked for a pause. The next check is after ${when(status.nextAt)}.`
      : 'It checked a moment ago. Try again in a couple of minutes.');
  }

  function updateCard(status = environment.update?.()) {
    if (!status) return null;
    const { update } = status;
    const line = updateLine(status);
    return h('div', { class: 'card', dataset: { key: 'update' } },
      h('div', { class: 'title', text: update ? `HushFacebook Web ${update.version} is out` : 'Updates' }),
      update ? h('div', { class: 'desc', text: `You have ${environment.version}. Download hushfacebook-web-extension.zip from the release and unzip it over the folder you loaded. Then click Reload on HushFacebook Web in your browser's extensions page. Your settings stay.` }) : null,
      line ? h('div', { class: 'desc', text: line, dataset: { key: 'update:status' } }) : null,
      h('div', { class: 'actions' },
        update ? h('a', { class: 'button primary', href: update.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the release' }) : null,
        environment.checkForUpdate ? actionButton('update:check', 'Check now', checkForUpdateNow, { primary: !update, busyLabel: 'Checking...' }) : null));
  }

  function updateRow(status) {
    const check = environment.checkForUpdate ? [{ label: 'Check now' }] : [];
    if (status.update) {
      return {
        id: 'update', section: 'general', title: `HushFacebook Web ${status.update.version} is out`,
        description: `You have ${environment.version}. Download the new extension files, then reload HushFacebook Web in your browser.`,
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
        h('div', { class: 'title', text: 'Reload Facebook to apply this change' })),
      h('button', { class: 'button primary', type: 'button', text: 'Reload', onclick: reloadFacebook }));
  }

  function applySetup(id) {
    const key = `quick:${id}`;
    if (quickSetupPending()) return;
    pending.add(key);
    render();
    settings.whenLoaded(() => {
      const finish = () => {
        pending.delete(key);
        if (dialog.open) render();
      };
      const succeeded = (changed) => {
        if (id === 'defaults') {
          drafts.clear();
          fieldErrors.clear();
          render();
        }
        toast(`Changed ${changed} settings`);
      };
      const failed = (error) => log.error("Couldn't apply the Quick setup. Try again", error);
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

  function quickSetupsCard() {
    return h('div', { class: 'card', dataset: { key: 'quick-setups' } },
      h('div', { class: 'title', text: 'Quick setups' }),
      h('div', { class: 'desc', text: 'Turn on a tested group of cleanup or privacy switches, or put every setting back to its default.' }),
      h('div', { class: 'actions' }, QUICK_SETUPS.map((setup) => {
        const key = `quick:${setup.id}`;
        return h('button', {
          class: 'button', type: 'button', text: pending.has(key) ? 'Waiting...' : setup.label, dataset: { key },
          disabled: quickSetupPending(), 'aria-busy': pending.has(key) ? 'true' : null,
          onclick: () => applySetup(setup.id),
        });
      })));
  }

  function launcherCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: 'Show the settings button' }),
            h('div', { class: 'desc', id: 'hfw-ui.launcher-desc', text: `The sliders button in Facebook's bottom-left corner. ${ALWAYS_OPENS} always opens settings too, and so does the row in your account menu while Settings in your account menu is on.` })),
          toggle('ui.launcher', 'Show the settings button', { describedBy: 'hfw-ui.launcher-desc' })));
  }

  function hiddenNoteCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: 'Leave a note where a post was hidden' }),
            h('div', { class: 'desc', id: 'hfw-ui.hiddenNote-desc', text: 'A short line that says why a post was hidden. Click it to see the post.' })),
          toggle('ui.hiddenNote', 'Leave a note where a post was hidden', { describedBy: 'hfw-ui.hiddenNote-desc' })));
  }

  function backupCard() {
    return h('div', { class: 'card', dataset: { key: 'backup-restore' } },
        h('div', { class: 'title', text: 'Back up and restore' }),
        h('div', { class: 'desc', text: 'Save your choices to a file and load them in another browser, or move them between the userscript and the extension. Seen posts, video spots, speed and volume stay behind.' }),
        h('div', { class: 'actions' },
          h('button', { class: 'button primary', type: 'button', text: 'Back up settings', dataset: { key: 'backup' }, disabled: quickSetupPending(), onclick: exportSettings }),
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
      h('div', { class: 'title', text: 'Report a problem' }),
      h('div', { class: 'desc', text: 'Opens a GitHub report with your versions and settings filled in. Add what happened.' }));
  }

  function kofiCard() {
    return h('a', { class: 'card link-card', href: KOFI_URL, target: '_blank', rel: 'noopener', dataset: { key: 'kofi' } },
      h('div', { class: 'title', text: 'Buy me a coffee' }),
      h('div', { class: 'desc', text: 'Hush is free. A coffee on Ko-fi helps me keep testing patches.' }));
  }

  function storageRecoveryCard(state) {
    const loading = state === 'loading';
    return h('div', { class: 'card', dataset: { key: 'storage-recovery' } },
      h('div', { class: 'title', text: loading ? 'Loading saved settings' : "Saved settings aren't available" }),
      h('div', { class: 'desc', text: loading
        ? 'Recognized privacy requests wait while the extension confirms your saved choices.'
        : "Privacy choices aren't confirmed. Recognized requests are held back until you retry the connection." }),
      loading ? null : h('div', { class: 'actions' }, actionButton('storage:retry', 'Retry', async () => {
        const loaded = await environment.storage.retry();
        if (!loaded) throw environment.storage.status().error ?? new Error("Saved settings still aren't available");
        toast('Saved settings loaded.');
      }, { primary: true, busyLabel: 'Retrying...' })));
  }

  function saveRecoveryCard() {
    return h('div', { class: 'card save-recovery', dataset: { key: 'save-recovery' } },
      h('div', { class: 'title', text: "Changes couldn't be saved" }),
      h('div', { class: 'desc', text: 'Your latest choices are still shown here. Retry to save them without losing the draft.' }),
      h('div', { class: 'actions' }, actionButton('settings:retry', 'Retry', async () => {
        await settings.retry();
        toast('Changes saved.');
      }, { primary: true, busyLabel: 'Retrying...' })));
  }

  function resetUndoCard() {
    return h('div', { class: 'card reset-undo', dataset: { key: 'reset-undo' } },
      h('div', { class: 'title', text: 'Settings were reset' }),
      h('div', { class: 'desc', text: "Undo puts back the choices you had before the reset. It stays here until you dismiss it or change a setting, and it's gone once you leave or reload this page." }),
      h('div', { class: 'actions' },
        actionButton('reset:undo', 'Undo reset', undoReset, { primary: true, busyLabel: 'Undoing...' }),
        h('button', { class: 'button', type: 'button', text: 'Dismiss', dataset: { key: 'reset:dismiss' }, disabled: pending.has('reset:undo'), onclick: dismissUndo })));
  }

  // Seen posts and playback state from before each account kept its own (core/activity.js).
  // They're only added to an account or deleted when you say so here.
  function legacyActivityCard(found) {
    const activity = environment.activity;
    const parts = [
      found.seen ? `${found.seen} seen ${found.seen === 1 ? 'post' : 'posts'}` : null,
      found.spots ? `${found.spots} video ${found.spots === 1 ? 'spot' : 'spots'}` : null,
      found.speed ? 'a kept video speed' : null,
      found.volume ? 'a kept volume' : null,
    ].filter(Boolean);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
    const target = activity.perAccount ? "the account you're signed in to" : 'signed-out browsing';
    return h('div', { class: 'card', dataset: { key: 'legacy-activity' } },
      h('div', { class: 'title', text: 'Activity from before accounts were kept apart' }),
      h('div', { class: 'desc', text: `This browser still has ${list} from before each Facebook account kept its own. They aren't tied to any account. Add them to ${target}, or delete them.` }),
      h('div', { class: 'actions' },
        actionButton('legacy:add', activity.perAccount ? 'Add to this account' : 'Use while signed out', () => {
          activity.addLegacy();
          toast(`Added to ${target}. The shared copy stays until you delete it.`);
        }, { primary: true, busyLabel: 'Adding...' }),
        actionButton('legacy:delete', 'Delete them', () => {
          const undo = activity.clearLegacy();
          toast('Deleted the activity from before accounts were kept apart.', { action: { label: 'Undo', run: () => {
            undo();
            if (dialog.open) render();
          } } });
        }, { busyLabel: 'Deleting...' })));
  }

  function generalRows() {
    const update = environment.update?.();
    const storageState = environment.storage?.status?.().state;
    // Once the account changed, here or in another tab, nothing goes to any account until a reload.
    const legacy = environment.activity?.check() ? environment.activity.legacy() : null;
    return [
      ...(storageState && storageState !== 'ready' ? [{
        id: 'storage-recovery', section: 'general', title: storageState === 'loading' ? 'Loading saved settings' : "Saved settings aren't available",
        description: 'Retry extension storage without treating defaults as loaded choices.', options: [{ label: 'Retry' }], focusKey: 'storage:retry',
        render: () => storageRecoveryCard(environment.storage.status().state),
      }] : []),
      ...(preferenceSave.state === 'error' ? [{
        id: 'save-recovery', section: 'general', title: "Changes couldn't be saved",
        description: 'Retry unsaved choices without losing the draft.', options: [{ label: 'Retry' }], focusKey: 'settings:retry',
        render: saveRecoveryCard,
      }] : []),
      ...(currentUndo() ? [{
        id: 'reset-undo', section: 'general', title: 'Undo the settings reset',
        description: 'Put back the choices you had before the reset, until you change a setting or leave this page.',
        options: [{ label: 'Undo reset' }, { label: 'Dismiss' }], focusKey: 'reset:undo', render: resetUndoCard,
      }] : []),
      ...(update?.update ? [updateRow(update)] : []),
      ...(legacy ? [{
        id: 'legacy-activity', section: 'general', title: 'Activity from before accounts were kept apart',
        description: `Seen posts and video spots shared by everyone on this browser. ${environment.activity.perAccount ? 'Add them to this account' : 'Use them while signed out'} or delete them.`,
        options: [{ label: environment.activity.perAccount ? 'Add to this account' : 'Use while signed out' }, { label: 'Delete them' }], focusKey: 'legacy:add', render: () => legacyActivityCard(legacy),
      }] : []),
      { id: 'quick-setups', section: 'general', title: 'Quick setups', description: 'Turn on a tested group of cleanup or privacy switches, or put every setting back to its default.', options: QUICK_SETUPS.map((setup) => ({ label: setup.label })), focusKey: 'quick:quiet', render: quickSetupsCard },
      { id: 'ui.launcher', section: 'general', title: 'Show the settings button', description: `The sliders button in Facebook's bottom-left corner. ${ALWAYS_OPENS} always opens settings too.`, render: launcherCard },
      { id: 'ui.hiddenNote', section: 'general', title: 'Leave a note where a post was hidden', description: 'A short line that says why a post was hidden. Click it to see the post.', render: hiddenNoteCard },
      { id: 'backup-restore', section: 'general', title: 'Back up and restore', description: 'Save your choices to a file, restore them, or reset every setting.', focusKey: 'backup', render: backupCard },
      ...(update && !update.update ? [updateRow(update)] : []),
      { id: 'report-problem', section: 'general', title: 'Report a problem', description: 'Opens a GitHub report with your versions and settings filled in. Add what happened.', render: reportProblemCard },
      { id: 'kofi', section: 'general', title: 'Buy me a coffee', description: 'Hush is free. A coffee on Ko-fi helps me keep testing patches.', render: kofiCard },
    ];
  }

  function generalView() {
    return generalRows().map((row) => row.render());
  }

  function hiddenSummary() {
    const counts = Object.entries(hider?.counts() ?? {});
    return counts.length ? counts.map(([reason, count]) => `${reason} ${count}`).join(', ') : 'None yet';
  }

  const featureRows = () => diagnostics?.rows() ?? [];
  const decisions = () => diagnostics?.decisions?.() ?? [];

  function diagnosticsView() {
    const entries = log.entries().slice(-150);
    const blocked = features.filter((feature) => unavailable.has(feature.id))
      .map((feature) => `${feature.title} (${UNAVAILABLE_SHORT[unavailable.get(feature.id)] ?? UNAVAILABLE_SHORT.failed})`);
    return [
      h('div', { class: 'diagnostic-summary' },
        h('h3', { class: 'summary-title', text: 'Environment' }),
        h('dl', null,
        h('dt', { text: 'Version' }), h('dd', { text: environment.version }),
        h('dt', { text: 'Userscript manager' }), h('dd', { text: `${environment.manager} ${environment.managerVersion}` }),
        h('dt', { text: 'Injection mode' }), h('dd', { text: environment.mode }),
        h('dt', { text: 'Page access' }), h('dd', { text: environment.pageAccess === 'page' ? 'Yes' : 'No. Network and playback features are off. In Violentmonkey, set this script to inject into the page.' }),
        h('dt', { text: "Features that didn't start" }), h('dd', { text: blocked.length ? blocked.join(', ') : 'None' }),
        h('dt', { text: 'Posts hidden since the page loaded' }), h('dd', { text: hiddenSummary() }),
        ...featureRows().flatMap(({ label, value }) => [h('dt', { text: label }), h('dd', { text: value })])),
      h('div', { class: 'actions' }, actionButton('copy-report', 'Copy report', copyReport, { primary: true, busyLabel: 'Copying...' }))),
      h('section', { class: 'diagnostic-group' },
      h('h3', { class: 'subheading', text: 'Why posts were hidden' }),
      h('p', { class: 'desc', text: "The last 50, newest first. data means it came out of Facebook's data before it was drawn, page means it was hidden on the page. Each post has a short tag instead of its id." }),
      decisions().length
        ? h('div', { class: 'log' }, decisions().slice().reverse().map((decision) => h('div', { text: decisionLine(decision) })))
        : h('p', { class: 'empty', text: 'Nothing hidden yet.' })),
      h('section', { class: 'diagnostic-group' },
      h('h3', { class: 'subheading', text: 'Recent log' }),
      entries.length
        ? h('div', { class: 'log' }, entries.map((entry) => h('div', { class: entry.level, text: `${entry.time.slice(11, 19)} ${entry.level.padEnd(5)} ${entry.message}${entry.detail ? `\n    ${entry.detail}` : ''}` })))
        : h('p', { class: 'empty', text: 'Nothing logged yet.' })),
    ];
  }

  function render() {
    const focused = shadow.activeElement;
    const focusedKey = focused?.dataset?.key;
    const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const scrollTop = main.scrollTop;
    const navScroll = [nav.scrollLeft, nav.scrollTop];
    const searching = query.trim() !== '';
    power.disabled = quickSetupPending();
    nav.replaceChildren(searchField, h('div', { class: 'nav-label', text: 'Settings' }), ...sections.flatMap((section) => [
      section.divider ? h('hr') : null,
      h('button', {
        type: 'button', dataset: { key: `nav:${section.id}` },
        'aria-current': !searching && section.id === current ? 'page' : null,
        onclick: () => { clearSearch(); current = section.id; main.scrollTop = 0; render(); },
      }, navigationIcon(section.id), h('span', { text: section.title })),
    ]).filter(Boolean));
    if (searching) {
      const found = findFeatures([...features, ...generalRows()], sections, query);
      main.replaceChildren(
        h('div', { class: 'page-heading' },
          h('div', { class: 'eyebrow', text: 'Find a setting' }),
          h('h3', { id: 'hfw-section-title', text: 'Search' }),
          h('p', { text: searchCount(found.length) })),
        ...(reloadPending ? [reloadCard()] : []),
        ...resultsView(found));
      announceSearch(searchCount(found.length));
    } else {
      announceSearch('');
      const section = sections.find((entry) => entry.id === current);
      const count = current === 'general' ? generalRows().length : features.filter((feature) => feature.section === current).length;
      main.replaceChildren(
        h('div', { class: 'page-heading' },
          h('div', { class: 'eyebrow', text: 'Settings' }),
          h('h3', { id: 'hfw-section-title', text: section.title }),
          h('p', { text: SECTION_DESCRIPTIONS[current] ?? '' }),
          count ? h('span', { class: 'setting-count', text: `${count} ${count === 1 ? 'setting' : 'settings'}` }) : null),
        ...(reloadPending ? [reloadCard()] : []),
        ...(current === 'diagnostics' ? diagnosticsView() : [h('div', { class: 'settings-group' }, ...(current === 'general' ? generalView() : sectionView(section)))]));
    }
    main.scrollTop = scrollTop;
    nav.scrollLeft = navScroll[0];
    nav.scrollTop = navScroll[1];
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
    pauseState.textContent = paused ? 'Paused' : 'On';
    // Settings in your account menu can stand in for the button, unless it couldn't start or
    // stopped working.
    const inMenu = hasMenuEntry && settings.enabled('menuEntry') && settings.get('menuEntry.hideButton') === true && !unavailable.has('menuEntry');
    launcher.hidden = settings.get('ui.launcher') !== true || inMenu;
  }

  function refreshSaveState() {
    saveState.dataset.state = preferenceSave.state;
    saveState.textContent = preferenceSave.state === 'saving'
      ? 'Saving changes...'
      : preferenceSave.state === 'error'
        ? "Changes couldn't be saved. Open General to retry."
        : 'Changes apply as you go.';
  }

  // ---- actions ----

  function exportSettings() {
    const url = URL.createObjectURL(new Blob([settings.exportJson()], { type: 'application/json' }));
    const link = h('a', { href: url, download: `hushfacebook-web-settings-${new Date().toISOString().slice(0, 10)}.json` });
    root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Settings saved to a file.');
  }

  async function importSettings() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (pending.has('import')) return;
    pending.add('import');
    pending.add('restore');
    render();
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new TypeError('Choose a settings file smaller than 1 MB');
      const { applied, skipped } = await settings.importJson(await file.text());
      drafts.clear();
      fieldErrors.clear();
      const extra = skipped.length ? `, and skipped ${skipped.length} this version doesn't know` : '';
      toast(`Restored ${applied.length} settings${extra}.`);
    } catch (error) {
      log.error(error instanceof TypeError ? error.message : "Couldn't restore settings. Choose a valid backup and try again", error);
    } finally {
      pending.delete('import');
      pending.delete('restore');
      if (dialog.open) render();
    }
  }

  function resetSettings() {
    const succeeded = (previous) => {
      drafts.clear();
      fieldErrors.clear();
      const after = settings.snapshot();
      // Resetting settings that were already at their defaults keeps any earlier Undo.
      if (!sameAs((key) => recordValue(previous, key), after)) resetUndo = { previous, after, restoring: false };
      render();
      if (resetUndo) {
        toast('Settings are back to their defaults. Undo stays in General until you change a setting or leave this page.', { action: { label: 'Undo', run: startUndo } });
      } else toast('Settings are back to their defaults.');
    };
    const saved = settings.reset();
    return saved && typeof saved.then === 'function' ? saved.then(succeeded) : succeeded(saved);
  }

  // Puts back the choices from before the reset once storage has saved them. A failure keeps
  // the Undo in General for another try.
  function undoReset() {
    const undo = currentUndo();
    if (!undo) {
      toast("Undo isn't available any more. A setting changed, or another Facebook account signed in.");
      if (dialog.open) render();
      return undefined;
    }
    undo.restoring = true;
    return Promise.resolve().then(() => settings.restore(undo.previous)).then(
      () => {
        undo.restoring = false;
        if (resetUndo === undo) resetUndo = null;
        toast('Your settings from before the reset are back.');
        if (dialog.open) {
          render();
          root.querySelector('[data-key="reset"]')?.focus({ preventScroll: true });
        }
      },
      (error) => {
        undo.restoring = false;
        log.error("Couldn't undo the settings reset. Undo is still in General", error);
      },
    );
  }

  // The notice's Undo, sharing the General row's busy state so the two can't both run.
  function startUndo() {
    if (pending.has('reset:undo')) return;
    pending.add('reset:undo');
    if (dialog.open) render();
    Promise.resolve(undoReset()).finally(() => {
      pending.delete('reset:undo');
      if (dialog.open) render();
    });
  }

  function dismissUndo() {
    resetUndo = null;
    render();
    root.querySelector('[data-key="reset"]')?.focus({ preventScroll: true });
    toast('Undo dismissed.');
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
      const validSection = sections.some((section) => section.id === marker.section);
      if (validSection && typeof marker.query === 'string' && marker.query.trim()) open(marker.section, marker.query);
      return;
    }
    if (sections.some((section) => section.id === marker.page)) open(marker.page);
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
      toast('Report copied. Paste it into a GitHub issue.');
    } catch (error) {
      log.error("Couldn't copy the report", error);
    }
  }

  // ---- open, close, live updates ----

  function open(sectionId, searchQuery) {
    if (sectionId && sections.some((section) => section.id === sectionId)) {
      if (sectionId !== current || query) main.scrollTop = 0;
      current = sectionId;
      if (typeof searchQuery === 'string' && searchQuery.trim()) {
        query = searchQuery;
        search.value = searchQuery;
      } else {
        clearSearch();
      }
    }
    if (!dialog.open) opener = shadow.activeElement ?? document.activeElement;
    render();
    dialog.append(toasts);
    if (!dialog.open) dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    dialog.close();
  }

  settings.subscribe(() => {
    supersedeUndo();
    refreshChrome();
    reloadPending = reloadKeys.some((key) => settings.get(key) !== reloadBaseline.get(key));
    if (dialog.open) render();
  });
  settings.whenLoaded(() => {
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
  const announceError = (entry) => {
    if (Date.now() - lastErrorToast < ERROR_TOAST_GAP_MS) return;
    lastErrorToast = Date.now();
    toast(`${entry.message}. Details are in Diagnostics.`, { tone: 'error', action: { label: 'Open', run: () => open('diagnostics') } });
  };
  let renderQueued = false;
  const refreshDiagnostics = () => {
    if (!dialog.open || current !== 'diagnostics' || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (dialog.open && current === 'diagnostics') render();
    });
  };
  log.subscribe((entry) => {
    if (entry.level === 'error') announceError(entry);
    refreshDiagnostics();
  });
  hider?.subscribe(refreshDiagnostics);
  diagnostics?.subscribe(refreshDiagnostics);
  environment.storage?.onStatus?.(() => {
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
  return { open, close, toast, refresh };
}
