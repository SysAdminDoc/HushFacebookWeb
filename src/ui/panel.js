// The settings panel lives in a closed shadow root so Facebook's CSS and scripts can't
// reach it. Changes apply at once with a toast; there are no confirmation dialogs, and
// Reset offers Undo instead of asking first.
//
// Words come in English and go through t() where they're drawn (core/i18n.js): feature titles,
// descriptions, labels and choices, action and Diagnostics row labels, and the label of a
// toast's button. A toast's message comes already in the language shown.

import { decisionLine } from '../core/diagnostics.js';
import { language, LANGUAGES, plural, setLanguage, t } from '../core/i18n.js';
import { MAX_BACKUP_BYTES } from '../core/settings.js';
import { TARGET } from '../core/target.js';
import { SECTIONS } from '../features/sections.js';
import { h, icon } from './h.js';
import { SLIDERS_ICON } from './icons.js';
import { navigationIcon } from './navigation-icons.js';
import { createNewDots } from './new-dots.js';
import { buildDiagnosticReport } from './diagnostic-report.js';
import { buildProblemReport } from './problem-report.js';
import { applyQuickSetup, QUICK_SETUPS } from './quick-setups.js';
import { findFeatures, matchingAction } from './search.js';
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
  network: "Network protection couldn't start, so this one is off. The log in Diagnostics says why.",
  api: "Your browser or userscript manager doesn't offer what this one needs.",
  failed: "This one couldn't start on this page, or stopped working. The log in Diagnostics says why.",
};
const UNAVAILABLE_SHORT = { page: 'needs page access', network: 'network protection unavailable', api: 'missing from this browser or manager', failed: 'see the log' };
const searchCount = (count) => (count === 0 ? t('No setting matches.') : plural(count, '{count} setting matches.', '{count} settings match.'));
const LANGUAGE_NOTE = "The language for these settings and the script's notices. Facebook's own language doesn't change it, and Reset to defaults keeps it. The two tests stretch every phrase or mirror the panel, to show how a translation will fit.";
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
  let renderedDirection = null;
  let opener = null;
  const newDots = createNewDots({ storage: environment.storage, features, log });
  const newDot = () => h('span', { class: 'new-dot' }, h('span', { class: 'visually-hidden', text: t('New') }));
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
  const launcher = h('button', { class: 'launcher', type: 'button', onclick: () => open() }, icon(SLIDERS_ICON));
  const nav = h('nav');
  const main = h('main', { 'aria-labelledby': 'hfw-section-title' });
  // One element for the life of the panel, so typing keeps its place across redraws.
  const search = h('input', {
    class: 'search', type: 'search', autocomplete: 'off', spellcheck: 'false', dataset: { key: 'search' },
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
    class: 'switch', type: 'checkbox', role: 'switch', dataset: { key: 'power' },
    // A pause for this tab ends with a reload, since the page started without the script's hooks.
    onchange: (event) => (settings.tabPaused && event.target.checked ? environment.resumeTab?.() : apply('paused', !event.target.checked)),
  });
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
      h('div', { class: 'header-actions' },
        h('span', { class: 'chip', text: `v${environment.version}` }), pauseState, power, closeButton)),
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
    newDots.finish();
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

  // The language chosen under General, for the panel and every toast after it. The parts drawn
  // once get their words again here; render() redraws the rest.
  function syncLanguage() {
    setLanguage(settingValue('ui.language'));
    const shown = language();
    root.setAttribute('lang', shown.lang);
    root.setAttribute('dir', shown.dir);
    launcher.setAttribute('aria-label', t('Open HushFacebook Web settings'));
    launcher.title = t('HushFacebook Web settings');
    nav.setAttribute('aria-label', t('Settings sections'));
    search.placeholder = t('Find a setting');
    search.setAttribute('aria-label', t('Find a setting'));
    power.setAttribute('aria-label', t('HushFacebook Web on'));
    closeButton.setAttribute('aria-label', t('Close settings'));
    subtitle.textContent = t('Settings');
  }
  syncLanguage();

  async function apply(key, value, control) {
    if (quickSetupPending()) return;
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
      if (!(control && error instanceof TypeError)) log.error("Couldn't save your change. Try again", error);
      refreshChrome();
      if (dialog.open) render();
    }
  }

  // duration Infinity keeps the notice until dismiss() on what this returns, or its action.
  // message can be a function, read as the notice goes up, so one that waited for the panel
  // comes in the language chosen by then.
  // actions: buttons in order. One with keep: true leaves the notice up after its click. The
  // buttons share one box, so a narrow window wraps them together under the message.
  function toast(message, { tone = 'info', action, actions = action ? [action] : [], duration } = {}) {
    const el = h('div', { class: `toast ${tone}`, role: tone === 'error' ? 'alert' : null },
      h('span', { text: typeof message === 'function' ? message() : message }),
      actions.length ? h('div', { class: 'actions' },
        ...actions.map((entry) => h('button', { type: 'button', text: t(entry.label), onclick: () => { if (!entry.keep) el.remove(); entry.run(); } }))) : null);
    toasts.append(el);
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
      checked: on, disabled: quickSetupPending(), dataset: { key },
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
      disabled: quickSetupPending(),
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
  function featureLinks(feature) {
    const found = actions?.links?.(feature.id);
    if (!found) return null;
    if (!found.items.length) return h('div', { class: 'links-empty', dataset: { linksFor: feature.id }, text: t(found.empty) });
    return h('ol', { class: 'links', dataset: { linksFor: feature.id } }, found.items.map(({ label, detail, href }) => h('li', {},
      h('a', { href, text: label, dir: 'auto' }),
      detail ? h('span', { class: 'detail', text: detail }) : null)));
  }

  // Buttons the feature added for itself (ctx.actions).
  function featureActions(feature) {
    const list = actions?.list(feature.id) ?? [];
    if (!list.length) return null;
    return h('div', { class: 'actions' }, list.map(({ label, run, index }) => actionButton(`action:${feature.id}:${index}`, label, run)));
  }

  // label and busyLabel in English: the log keeps the English, the button shows t().
  function actionButton(key, label, run, { primary = false, busyLabel = 'Working...' } = {}) {
    const locked = quickSetupPending() && !pending.has(key) && key !== 'storage:retry';
    return h('button', {
      class: `button${primary ? ' primary' : ''}`, type: 'button', text: t(pending.has(key) ? busyLabel : label),
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
          h('div', { class: 'desc', id: ids.desc, text: t(feature.description) }),
          blocked ? h('div', { class: 'note', id: ids.note, text: `${t(UNAVAILABLE_NOTES[reason] ?? UNAVAILABLE_NOTES.failed)}${on ? ` ${t('You can still turn it off.')}` : ''}` }) : null,
          feature.reload ? h('div', { class: 'note', id: ids.reload, text: t('Applies after Facebook reloads.') }) : null,
          status === undefined ? null : h('div', { class: 'note', 'data-status-for': feature.id, role: 'status', hidden: status === null, text: t(status ?? '') })),
        toggle(feature.id, feature.title, { locked: blocked, describedBy })),
      (on || showOptions) && feature.options?.length ? h('div', { class: 'options' }, feature.options.map((option) => optionControl(feature, option, dots))) : null,
      on ? featureLinks(feature) : null,
      on ? featureActions(feature) : null);
  }

  function sectionView(section) {
    return features.filter((feature) => feature.section === section.id).map((feature) => featureCard(feature, { dots: true }));
  }

  function clearSearch() {
    query = '';
    search.value = '';
  }

  // A search result's section link: opens the section with that row's control focused, or the
  // row's button the words typed name (Reset, Restore).
  function showSetting(setting) {
    const focusKey = matchingAction(setting, query) ?? setting.focusKey ?? setting.id;
    clearSearch();
    current = setting.section;
    main.scrollTop = 0;
    render();
    const control = main.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    control?.scrollIntoView?.({ block: 'center' });
    control?.focus({ preventScroll: true });
  }

  function resultsView(found) {
    if (!found.length) return [h('p', { class: 'empty', text: t('No setting matches "{query}". Try a shorter word, or pick a section.', { query: query.trim() }) })];
    return [h('div', { class: 'settings-group results' }, found.map((setting) => {
      const section = sections.find((entry) => entry.id === setting.section);
      return h('div', { class: 'result' },
        h('button', { class: 'result-section', type: 'button', text: t('In {section}', { section: t(section.title) }), dataset: { key: `show:${setting.id}` }, onclick: () => showSetting(setting) }),
        setting.render ? setting.render() : featureCard(setting, { showOptions: true }));
    }))];
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
        toast(plural(changed, 'Changed {count} setting', 'Changed {count} settings'));
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
      h('div', { class: 'title', text: t('Quick setups') }),
      h('div', { class: 'desc', text: t('Turn on a tested group of cleanup or privacy switches, or put every setting back to its default.') }),
      h('div', { class: 'actions' }, QUICK_SETUPS.map((setup) => {
        const key = `quick:${setup.id}`;
        return h('button', {
          class: 'button', type: 'button', text: t(pending.has(key) ? 'Waiting...' : setup.label), dataset: { key },
          disabled: quickSetupPending(), 'aria-busy': pending.has(key) ? 'true' : null,
          onclick: () => applySetup(setup.id),
        });
      })));
  }

  function launcherCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Show the settings button') }),
            h('div', { class: 'desc', id: 'hfw-ui.launcher-desc', text: t("The sliders button in Facebook's bottom-left corner. {opener} always opens settings too, and so does the row in your account menu while Settings in your account menu is on.", { opener: t(ALWAYS_OPENS) }) })),
          toggle('ui.launcher', 'Show the settings button', { describedBy: 'hfw-ui.launcher-desc' })));
  }

  function hiddenNoteCard() {
    return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: t('Leave a note where a post was hidden') }),
            h('div', { class: 'desc', id: 'hfw-ui.hiddenNote-desc', text: t('A short line that says why a post was hidden. Click it to see the post.') })),
          toggle('ui.hiddenNote', 'Leave a note where a post was hidden', { describedBy: 'hfw-ui.hiddenNote-desc' })));
  }

  // Each language keeps its own name, never translated, so English can always be found again,
  // and the title keeps the English word beside the translated one.
  function languageCard() {
    const value = settingValue('ui.language');
    const title = t('Language');
    return h('div', { class: 'card', dataset: { key: 'language' } },
      h('div', { class: 'title', text: title === 'Language' ? title : `${title} (Language)` }),
      h('div', { class: 'desc', id: 'hfw-ui.language-desc', text: t(LANGUAGE_NOTE) }),
      h('div', { class: 'options' },
        h('div', { class: 'field' },
          h('label', null, title,
            h('select', {
              dataset: { key: 'ui.language' }, 'aria-describedby': 'hfw-ui.language-desc', disabled: quickSetupPending(),
              onchange: (event) => apply('ui.language', event.target.value, event.target),
            }, LANGUAGES.map((entry) => h('option', { value: entry.value, lang: entry.lang, selected: entry.value === value, text: entry.label })))))));
  }

  function backupCard() {
    return h('div', { class: 'card', dataset: { key: 'backup-restore' } },
        h('div', { class: 'title', text: t('Back up and restore') }),
        h('div', { class: 'desc', text: t('Save your choices to a file and load them in another browser, or move them between the userscript and the extension. Seen posts, video spots, speed and volume stay behind.') }),
        h('div', { class: 'actions' },
          h('button', { class: 'button primary', type: 'button', text: t('Back up settings'), dataset: { key: 'backup' }, disabled: quickSetupPending(), onclick: exportSettings }),
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
      h('div', { class: 'desc', text: t('Opens a GitHub report with your versions and settings filled in. Add what happened.') }));
  }

  function kofiCard() {
    return h('a', { class: 'card link-card', href: KOFI_URL, target: '_blank', rel: 'noopener', dataset: { key: 'kofi' } },
      h('div', { class: 'title', text: t('Buy me a coffee') }),
      h('div', { class: 'desc', text: t('Hush is free. A coffee on Ko-fi helps me keep testing patches.') }));
  }

  function storageRecoveryCard(state) {
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
    return h('div', { class: 'card reset-undo', dataset: { key: 'reset-undo' } },
      h('div', { class: 'title', text: t('Settings were reset') }),
      h('div', { class: 'desc', text: t("Undo puts back the choices you had before the reset. It stays here until you dismiss it or change a setting, and it's gone once you leave or reload this page.") }),
      h('div', { class: 'actions' },
        actionButton('reset:undo', 'Undo reset', undoReset, { primary: true, busyLabel: 'Undoing...' }),
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
        actionButton('legacy:add', activity.perAccount ? 'Add to this account' : 'Use while signed out', () => {
          activity.addLegacy();
          toast(activity.perAccount
            ? t("Added to the account you're signed in to. The shared copy stays until you delete it.")
            : t('Added to signed-out browsing. The shared copy stays until you delete it.'));
        }, { primary: true, busyLabel: 'Adding...' }),
        actionButton('legacy:delete', 'Delete them', () => {
          const undo = activity.clearLegacy();
          toast(t('Deleted the activity from before accounts were kept apart.'), { action: { label: 'Undo', run: () => {
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
      // Titles, descriptions and labels in English, as in a feature (see updateRow).
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
        options: [{ label: 'Undo reset', focusKey: 'reset:undo' }, { label: 'Dismiss', focusKey: 'reset:dismiss' }], focusKey: 'reset:undo', render: resetUndoCard,
      }] : []),
      ...(update?.update ? [updateRow(update)] : []),
      ...(legacy ? [{
        id: 'legacy-activity', section: 'general', title: 'Activity from before accounts were kept apart',
        description: environment.activity.perAccount
          ? 'Seen posts and video spots shared by everyone on this browser. Add them to this account or delete them.'
          : 'Seen posts and video spots shared by everyone on this browser. Use them while signed out or delete them.',
        options: [{ label: environment.activity.perAccount ? 'Add to this account' : 'Use while signed out', focusKey: 'legacy:add' }, { label: 'Delete them', focusKey: 'legacy:delete' }], focusKey: 'legacy:add', render: () => legacyActivityCard(legacy),
      }] : []),
      { id: 'quick-setups', section: 'general', title: 'Quick setups', description: 'Turn on a tested group of cleanup or privacy switches, or put every setting back to its default.', options: QUICK_SETUPS.map((setup) => ({ label: setup.label, focusKey: `quick:${setup.id}`, keywords: setup.reset ? ['reset'] : [] })), focusKey: 'quick:quiet', render: quickSetupsCard },
      { id: 'ui.launcher', section: 'general', title: 'Show the settings button', description: "The sliders button in Facebook's bottom-left corner. {opener} always opens settings too.", vars: { opener: t(ALWAYS_OPENS) }, render: launcherCard },
      { id: 'ui.hiddenNote', section: 'general', title: 'Leave a note where a post was hidden', description: 'A short line that says why a post was hidden. Click it to see the post.', render: hiddenNoteCard },
      { id: 'ui.language', section: 'general', title: 'Language', description: LANGUAGE_NOTE, options: LANGUAGES.map((entry) => ({ label: entry.label })), keywords: ['translation', 'locale', 'right to left'], focusKey: 'ui.language', render: languageCard },
      { id: 'backup-restore', section: 'general', title: 'Back up and restore', description: 'Save your choices to a file, restore them, or reset every setting.',
        options: [
          { label: 'Back up settings', focusKey: 'backup', keywords: ['backup', 'export'] },
          { label: 'Restore from a file', focusKey: 'restore', keywords: ['import', 'load'] },
          { label: 'Reset to defaults', focusKey: 'reset' },
        ], focusKey: 'backup', render: backupCard },
      ...(update && !update.update ? [updateRow(update)] : []),
      { id: 'report-problem', section: 'general', title: 'Report a problem', description: 'Opens a GitHub report with your versions and settings filled in. Add what happened.', keywords: ['bug', 'issue'], render: reportProblemCard },
      { id: 'kofi', section: 'general', title: 'Buy me a coffee', description: 'Hush is free. A coffee on Ko-fi helps me keep testing patches.', keywords: ['donate'], render: kofiCard },
    ];
  }

  function generalView() {
    return generalRows().map((row) => row.render());
  }

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

  function pageHeading(id, title, description, count = 0) {
    return h('div', { class: 'page-heading' },
      h('span', { class: 'page-icon', 'aria-hidden': 'true' }, navigationIcon(id)),
      h('div', { class: 'page-copy' },
        h('h3', { id: 'hfw-section-title', text: title }),
        h('p', { text: description })),
      count ? h('span', { class: 'setting-count', text: plural(count, '{count} setting', '{count} settings') }) : null);
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
    power.disabled = quickSetupPending();
    nav.replaceChildren(h('div', { class: 'nav-label', text: t('Settings') }), ...sections.flatMap((section) => [
      section.divider ? h('hr') : null,
      h('button', {
        type: 'button', dataset: { key: `nav:${section.id}` },
        'aria-current': !searching && section.id === current ? 'page' : null,
        onclick: () => { clearSearch(); current = section.id; main.scrollTop = 0; render(); },
      }, navigationIcon(section.id), h('span', { text: t(section.title) }), newDots.sectionIsNew(section.id) ? newDot() : null),
    ]).filter(Boolean));
    if (searching) {
      const found = findFeatures([...features, ...generalRows()], sections, query);
      main.replaceChildren(
        pageHeading('search', t('Search'), searchCount(found.length)),
        ...(reloadPending ? [reloadCard()] : []),
        ...resultsView(found));
      announceSearch(searchCount(found.length));
    } else {
      announceSearch('');
      newDots.visit(current);
      const section = sections.find((entry) => entry.id === current);
      const count = current === 'general' ? generalRows().length : features.filter((feature) => feature.section === current).length;
      main.replaceChildren(
        pageHeading(current, t(section.title), t(SECTION_DESCRIPTIONS[current] ?? ''), count),
        ...(reloadPending ? [reloadCard()] : []),
        ...(current === 'diagnostics' ? diagnosticsView() : [h('div', { class: 'settings-group' }, ...(current === 'general' ? generalView() : sectionView(section)))]));
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
    // Settings in your account menu can stand in for the button, unless it couldn't start or
    // stopped working.
    const inMenu = hasMenuEntry && settings.enabled('menuEntry') && settings.get('menuEntry.hideButton') === true && !unavailable.has('menuEntry');
    launcher.hidden = settings.get('ui.launcher') !== true || inMenu;
  }

  function refreshSaveState() {
    saveState.dataset.state = preferenceSave.state;
    saveState.textContent = t(preferenceSave.state === 'saving'
      ? 'Saving changes...'
      : preferenceSave.state === 'error'
        ? "Changes couldn't be saved. Open General to retry."
        : 'Changes apply as you go.');
  }

  // ---- actions ----

  function exportSettings() {
    const url = URL.createObjectURL(new Blob([settings.exportJson()], { type: 'application/json' }));
    const link = h('a', { href: url, download: `hushfacebook-web-settings-${new Date().toISOString().slice(0, 10)}.json` });
    root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(t('Settings saved to a file.'));
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
      toast(skipped.length
        ? plural(applied.length, "Restored {count} setting, and skipped {skipped} this version can't use.", "Restored {count} settings, and skipped {skipped} this version can't use.", { skipped: skipped.length })
        : plural(applied.length, 'Restored {count} setting.', 'Restored {count} settings.'));
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
        toast(t('Settings are back to their defaults. Undo stays in General until you change a setting or leave this page.'), { action: { label: 'Undo', run: startUndo } });
      } else toast(t('Settings are back to their defaults.'));
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
        if (resetUndo === undo) resetUndo = null;
        toast(t('Your settings from before the reset are back.'));
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
      toast(t('Report copied. Paste it into a GitHub issue.'));
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
    if (!dialog.open) {
      opener = shadow.activeElement ?? document.activeElement;
      newDots.start();
    }
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
  const announceError = (entry) => {
    if (Date.now() - lastErrorToast < ERROR_TOAST_GAP_MS) return;
    lastErrorToast = Date.now();
    // The log keeps the English. The notice shows it translated where the catalog has it.
    toast(t('{message}. Details are in Diagnostics.', { message: t(entry.message) }), { tone: 'error', action: { label: 'Open', run: () => open('diagnostics') } });
  };
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
  return { open, close, toast, refresh, copyReport };
}
