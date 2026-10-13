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
import { findFeatures } from './search.js';
import { panelCss } from './styles.js';

const ALWAYS_OPENS = TARGET === 'extension' ? "The extension's toolbar button" : "Your userscript manager's menu";
const ERROR_TOAST_GAP_MS = 15000;
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
  const hasMenuEntry = features.some((feature) => feature.id === 'menuEntry');

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
      h('span', { text: 'Changes apply as you go.' }),
      h('span', { class: 'footer-brand', text: 'HushFacebook Web' })),
  );
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.addEventListener('close', () => {
    root.append(toasts);
    if (opener?.isConnected && !opener.hidden && opener !== document.body && opener !== document.documentElement) opener.focus({ preventScroll: true });
    else if (!launcher.hidden) launcher.focus({ preventScroll: true });
    opener = null;
  });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importSettings });
  dialog.append(fileInput);
  root.append(launcher, dialog, toasts);
  document.body.append(host);

  function apply(key, value, control) {
    const draft = control?.value;
    try {
      if (control && !control.validity.valid) {
        const spec = settings.schema.get(key);
        throw new TypeError(spec.type === 'number' ? `Enter a number from ${spec.min} to ${spec.max}.` : 'Check this value and try again.');
      }
      drafts.delete(key);
      fieldErrors.delete(key);
      settings.set(key, value);
    } catch (error) {
      if (control) {
        drafts.set(key, draft);
        fieldErrors.set(key, error instanceof TypeError ? error.message : "Couldn't save this change. Try again.");
      }
      if (!(control && error instanceof TypeError)) log.error("Couldn't save your change. Try again", error);
      refreshChrome();
      if (dialog.open) render();
    }
  }

  function toast(message, { tone = 'info', action, duration } = {}) {
    const el = h('div', { class: `toast ${tone}`, role: tone === 'error' ? 'alert' : null },
      h('span', { text: message }),
      action ? h('button', { type: 'button', text: action.label, onclick: () => { el.remove(); action.run(); } }) : null);
    toasts.append(el);
    setTimeout(() => el.remove(), duration ?? (action ? 7000 : 4000));
  }

  // ---- views ----

  function toggle(key, label, { disabled = false } = {}) {
    return h('input', {
      class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': label,
      checked: settings.get(key) === true, disabled, dataset: { key },
      onchange: (event) => apply(key, event.target.checked),
    });
  }

  function optionControl(feature, option) {
    const key = `${feature.id}.${option.key}`;
    const value = drafts.get(key) ?? settings.get(key);
    const errorId = `hfw-error-${key}`;
    const props = {
      dataset: { key }, 'aria-invalid': fieldErrors.has(key) ? 'true' : null,
      'aria-describedby': fieldErrors.has(key) ? errorId : null,
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
    return h('button', {
      class: `button${primary ? ' primary' : ''}`, type: 'button', text: pending.has(key) ? busyLabel : label,
      dataset: { key }, 'aria-busy': pending.has(key) ? 'true' : null, 'aria-disabled': pending.has(key) ? 'true' : null,
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

  function featureCard(feature) {
    const blocked = unavailable.has(feature.id);
    const on = settings.get(feature.id) === true;
    return h('div', { class: `card${blocked ? ' unavailable' : ''}` },
      h('div', { class: 'row' },
        h('div', { class: 'text' },
          h('div', { class: 'title', text: feature.title }),
          h('div', { class: 'desc', text: feature.description }),
          blocked ? h('div', { class: 'note', text: "This one isn't available the way your userscript manager runs the script. Diagnostics explains why." }) : null,
          feature.reload ? h('div', { class: 'note', text: 'Applies after Facebook reloads.' }) : null),
        toggle(feature.id, feature.title, { disabled: blocked })),
      on && feature.options?.length ? h('div', { class: 'options' }, feature.options.map((option) => optionControl(feature, option))) : null,
      on ? featureActions(feature) : null);
  }

  function sectionView(section) {
    return features.filter((feature) => feature.section === section.id).map(featureCard);
  }

  function clearSearch() {
    query = '';
    search.value = '';
  }

  // A search result's section link: opens the section with that feature's switch focused.
  function showFeature(feature) {
    clearSearch();
    current = feature.section;
    main.scrollTop = 0;
    render();
    const control = main.querySelector(`[data-key="${CSS.escape(feature.id)}"]`);
    control?.scrollIntoView?.({ block: 'center' });
    control?.focus({ preventScroll: true });
  }

  function resultsView(found) {
    if (!found.length) return [h('p', { class: 'empty', text: `No setting matches "${query.trim()}". Try a shorter word, or pick a section.` })];
    return [h('div', { class: 'settings-group results' }, found.map((feature) => {
      const section = sections.find((entry) => entry.id === feature.section);
      return h('div', { class: 'result' },
        h('button', { class: 'result-section', type: 'button', text: `In ${section.title}`, dataset: { key: `show:${feature.id}` }, onclick: () => showFeature(feature) }),
        featureCard(feature));
    }))];
  }

  // The extension's notice that a newer release is out (environment.update, extension only).
  function updateCard() {
    const update = environment.update?.();
    if (!update) return null;
    return h('div', { class: 'card', dataset: { key: 'update' } },
      h('div', { class: 'title', text: `HushFacebook Web ${update.version} is out` }),
      h('div', { class: 'desc', text: `You have ${environment.version}. Download hushfacebook-web-extension.zip from the release and unzip it over the folder you loaded. Then click Reload on HushFacebook Web in your browser's extensions page. Your settings stay.` }),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: update.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the release' })));
  }

  function generalView() {
    return [
      updateCard(),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: 'Show the settings button' }),
            h('div', { class: 'desc', text: `The sliders button in Facebook's bottom-left corner. ${ALWAYS_OPENS} always opens settings too, and so does the row in your account menu while Settings in your account menu is on.` })),
          toggle('ui.launcher', 'Show the settings button'))),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: 'Leave a note where a post was hidden' }),
            h('div', { class: 'desc', text: 'A short line that says why a post was hidden. Click it to see the post.' })),
          toggle('ui.hiddenNote', 'Leave a note where a post was hidden'))),
      h('div', { class: 'card' },
        h('div', { class: 'title', text: 'Back up and restore' }),
        h('div', { class: 'desc', text: 'Save your choices to a file, or load them from one on another browser.' }),
        h('div', { class: 'actions' },
          h('button', { class: 'button primary', type: 'button', text: 'Back up settings', dataset: { key: 'backup' }, onclick: exportSettings }),
          actionButton('restore', 'Restore from a file', () => fileInput.click(), { busyLabel: 'Restoring...' }),
          h('button', { class: 'button', type: 'button', text: 'Reset to defaults', dataset: { key: 'reset' }, onclick: resetSettings }))),
    ].filter(Boolean);
  }

  function hiddenSummary() {
    const counts = Object.entries(hider?.counts() ?? {});
    return counts.length ? counts.map(([reason, count]) => `${reason} ${count}`).join(', ') : 'None yet';
  }

  const featureRows = () => diagnostics?.rows() ?? [];
  const decisions = () => diagnostics?.decisions?.() ?? [];

  function diagnosticsView() {
    const entries = log.entries().slice(-150);
    const blocked = features.filter((feature) => unavailable.has(feature.id)).map((feature) => feature.title);
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
    nav.replaceChildren(searchField, h('div', { class: 'nav-label', text: 'Settings' }), ...sections.flatMap((section) => [
      section.divider ? h('hr') : null,
      h('button', {
        type: 'button', dataset: { key: `nav:${section.id}` },
        'aria-current': !searching && section.id === current ? 'page' : null,
        onclick: () => { clearSearch(); current = section.id; main.scrollTop = 0; render(); },
      }, navigationIcon(section.id), h('span', { text: section.title })),
    ]).filter(Boolean));
    if (searching) {
      const found = findFeatures(features, sections, query);
      main.replaceChildren(
        h('div', { class: 'page-heading' },
          h('div', { class: 'eyebrow', text: 'Find a setting' }),
          h('h3', { id: 'hfw-section-title', text: 'Search' }),
          h('p', { role: 'status', text: found.length === 1 ? '1 setting matches.' : `${found.length} settings match.` })),
        ...resultsView(found));
    } else {
      const section = sections.find((entry) => entry.id === current);
      const count = features.filter((feature) => feature.section === current).length;
      main.replaceChildren(
        h('div', { class: 'page-heading' },
          h('div', { class: 'eyebrow', text: 'Settings' }),
          h('h3', { id: 'hfw-section-title', text: section.title }),
          h('p', { text: SECTION_DESCRIPTIONS[current] ?? '' }),
          count ? h('span', { class: 'setting-count', text: `${count} ${count === 1 ? 'setting' : 'settings'}` }) : null),
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

  function refreshChrome() {
    const paused = settings.get('paused') === true;
    power.checked = !paused;
    pauseState.textContent = paused ? 'Paused' : 'On';
    // Settings in your account menu can stand in for the button, unless it couldn't start or
    // stopped working.
    const inMenu = hasMenuEntry && settings.enabled('menuEntry') && settings.get('menuEntry.hideButton') === true && !unavailable.has('menuEntry');
    launcher.hidden = settings.get('ui.launcher') !== true || inMenu;
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
      const { applied, skipped } = settings.importJson(await file.text());
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
    let previous;
    try {
      previous = settings.reset();
      drafts.clear();
      fieldErrors.clear();
      render();
    } catch (error) {
      log.error("Couldn't reset settings. Try again", error);
      return;
    }
    toast('Settings are back to their defaults.', { action: { label: 'Undo', run: () => {
      settings.restore(previous);
      if (dialog.open) root.querySelector('[data-key="reset"]')?.focus({ preventScroll: true });
    } } });
  }

  async function copyReport() {
    const report = [
      `HushFacebook Web ${environment.version}`,
      `Manager: ${environment.manager} ${environment.managerVersion}, mode ${environment.mode}, page access ${environment.pageAccess}`,
      `Browser: ${navigator.userAgent}`,
      `Changed settings: ${JSON.stringify(settings.snapshot())}`,
      `Unavailable: ${[...unavailable].join(', ') || 'none'}`,
      `Hidden since the page loaded: ${hiddenSummary()}`,
      ...featureRows().map(({ label, value }) => `${label}: ${value}`),
      '',
      'Why posts were hidden, oldest first:',
      ...(decisions().length ? decisions().map(decisionLine) : ['nothing yet']),
      '',
      ...log.entries().slice(-150).map((entry) => `${entry.time} ${entry.level} ${entry.message}${entry.detail ? ` | ${entry.detail}` : ''}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      toast('Report copied. Paste it into a GitHub issue.');
    } catch (error) {
      log.error("Couldn't copy the report", error);
    }
  }

  // ---- open, close, live updates ----

  function open(sectionId) {
    if (sectionId && sections.some((section) => section.id === sectionId)) {
      if (sectionId !== current || query) main.scrollTop = 0;
      clearSearch();
      current = sectionId;
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
  const earlier = log.entries().findLast((entry) => entry.level === 'error');
  if (earlier) announceError(earlier);

  refreshChrome();
  // For changes from outside the settings: a feature that stopped, the extension's update notice.
  const refresh = () => {
    refreshChrome();
    if (dialog.open) render();
  };
  return { open, close, toast, refresh };
}
