// The settings panel lives in a closed shadow root so Facebook's CSS and scripts can't
// reach it. Changes apply at once with a toast; there are no confirmation dialogs, and
// Reset offers Undo instead of asking first.

import { SECTIONS } from '../features/sections.js';
import { h, icon } from './h.js';
import { panelCss } from './styles.js';

const SLIDERS_ICON = [
  'M3 5h10v2H3z', 'M17 5h4v2h-4z', 'M13 3h4v6h-4z',
  'M3 11h4v2H3z', 'M11 11h10v2H11z', 'M7 9h4v6H7z',
  'M3 17h12v2H3z', 'M19 17h2v2h-2z', 'M15 15h4v6h-4z',
];
const CLOSE_ICON = ['M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z'];
const ERROR_TOAST_GAP_MS = 15000;

export function mountPanel({ settings, features, log, hider, diagnostics, actions, unavailable, environment }) {
  const host = h('div', { dataset: { hushfacebookWeb: 'ui' } });
  const shadow = host.attachShadow({ mode: 'closed' });
  const root = h('div', { class: 'root' });
  shadow.append(h('style', { text: panelCss }), root);

  const sections = [
    ...SECTIONS.filter((section) => features.some((feature) => feature.section === section.id)),
    { id: 'general', title: 'General', divider: true },
    { id: 'diagnostics', title: 'Diagnostics' },
  ];
  let current = sections[0].id;

  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const launcher = h(
    'button',
    { class: 'launcher', type: 'button', 'aria-label': 'Open HushFacebook Web settings', title: 'HushFacebook Web settings', onclick: () => open() },
    icon(SLIDERS_ICON),
  );
  const nav = h('nav', { 'aria-label': 'Settings sections' });
  const main = h('main');
  const pauseState = h('span', { class: 'chip' });
  // Checked means running, so the switch agrees with the "On" chip beside it.
  const power = h('input', {
    class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': 'HushFacebook Web on',
    onchange: (event) => apply('paused', !event.target.checked),
  });
  const closeButton = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close settings', onclick: () => close() }, icon(CLOSE_ICON));
  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hfw-title' },
    h('header', null,
      h('h2', { id: 'hfw-title', text: 'HushFacebook Web' }),
      h('span', { class: 'chip', text: `v${environment.version}` }),
      h('span', { class: 'spacer' }),
      pauseState, power, closeButton),
    h('div', { class: 'body' }, nav, main),
  );
  const overlay = h('div', { class: 'overlay', hidden: true, onclick: (event) => event.target === overlay && close() }, dialog);
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importSettings });
  root.append(launcher, overlay, toasts, fileInput);
  document.body.append(host);

  function apply(key, value) {
    try {
      settings.set(key, value);
    } catch (error) {
      log.error(`Couldn't save ${key}`, error);
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
    const value = settings.get(key);
    switch (option.type) {
      case 'toggle':
        return h('label', null, toggle(key, option.label), option.label);
      case 'select':
        return h('label', null, option.label,
          h('select', { dataset: { key }, onchange: (event) => apply(key, option.choices.find((choice) => String(choice.value) === event.target.value)?.value) },
            option.choices.map((choice) => h('option', { value: String(choice.value), selected: choice.value === value, text: choice.label }))));
      case 'number':
        return h('label', null, option.label,
          h('input', { type: 'number', value: String(value), min: option.min, max: option.max, dataset: { key }, onchange: (event) => apply(key, Number(event.target.value)) }));
      default:
        // A short value, like a font name or a color, gets one line.
        if (option.lines === 1) {
          return h('label', null, option.label,
            h('input', { type: 'text', value, maxLength: option.maxLength, spellcheck: 'false', dataset: { key }, onchange: (event) => apply(key, event.target.value.trim()) }));
        }
        return h('label', null, option.label,
          h('textarea', {
            rows: option.rows ?? 3, class: option.code ? 'code' : undefined, spellcheck: option.code ? 'false' : undefined,
            dataset: { key }, onchange: (event) => apply(key, event.target.value),
          }, value));
    }
  }

  // Buttons the feature added for itself (ctx.actions).
  function featureActions(feature) {
    const list = actions?.list(feature.id) ?? [];
    if (!list.length) return null;
    return h('div', { class: 'actions' }, list.map(({ label, run }) => h('button', {
      class: 'button', type: 'button', text: label,
      onclick: () => {
        try {
          run();
        } catch (error) {
          log.error(`${feature.title}: ${label} failed`, error);
        }
        render();
      },
    })));
  }

  function featureCard(feature) {
    const blocked = unavailable.has(feature.id);
    const on = settings.get(feature.id) === true;
    return h('div', { class: 'card' },
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
    return [h('h3', { text: section.title }), ...features.filter((feature) => feature.section === section.id).map(featureCard)];
  }

  function generalView() {
    return [
      h('h3', { text: 'General' }),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'text' },
            h('div', { class: 'title', text: 'Show the settings button' }),
            h('div', { class: 'desc', text: "The round button in Facebook's bottom-left corner. Your userscript manager's menu always opens settings too." })),
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
          h('button', { class: 'button primary', type: 'button', text: 'Back up settings', onclick: exportSettings }),
          h('button', { class: 'button', type: 'button', text: 'Restore from a file', onclick: () => fileInput.click() }),
          h('button', { class: 'button', type: 'button', text: 'Reset to defaults', onclick: resetSettings }))),
    ];
  }

  function hiddenSummary() {
    const counts = Object.entries(hider?.counts() ?? {});
    return counts.length ? counts.map(([reason, count]) => `${reason} ${count}`).join(', ') : 'None yet';
  }

  const featureRows = () => diagnostics?.rows() ?? [];

  function diagnosticsView() {
    const entries = log.entries().slice(-150);
    const blocked = features.filter((feature) => unavailable.has(feature.id)).map((feature) => feature.title);
    return [
      h('h3', { text: 'Diagnostics' }),
      h('dl', null,
        h('dt', { text: 'Version' }), h('dd', { text: environment.version }),
        h('dt', { text: 'Userscript manager' }), h('dd', { text: `${environment.manager} ${environment.managerVersion}` }),
        h('dt', { text: 'Injection mode' }), h('dd', { text: environment.mode }),
        h('dt', { text: 'Page access' }), h('dd', { text: environment.pageAccess === 'page' ? 'Yes' : 'No. Network and playback features are off. In Violentmonkey, set this script to inject into the page.' }),
        h('dt', { text: "Features that didn't start" }), h('dd', { text: blocked.length ? blocked.join(', ') : 'None' }),
        h('dt', { text: 'Posts hidden since the page loaded' }), h('dd', { text: hiddenSummary() }),
        ...featureRows().flatMap(({ label, value }) => [h('dt', { text: label }), h('dd', { text: value })])),
      h('div', { class: 'actions' }, h('button', { class: 'button primary', type: 'button', text: 'Copy report', onclick: copyReport })),
      h('h3', { text: 'Recent log', style: 'margin-top: 18px' }),
      entries.length
        ? h('div', { class: 'log' }, entries.map((entry) => h('div', { class: entry.level, text: `${entry.time.slice(11, 19)} ${entry.level.padEnd(5)} ${entry.message}${entry.detail ? `\n    ${entry.detail}` : ''}` })))
        : h('p', { class: 'empty', text: 'Nothing logged yet.' }),
    ];
  }

  function render() {
    const focusedKey = shadow.activeElement?.dataset?.key;
    nav.replaceChildren(...sections.flatMap((section) => [
      section.divider ? h('hr') : null,
      h('button', {
        type: 'button', text: section.title, dataset: { key: `nav:${section.id}` },
        'aria-current': section.id === current ? 'page' : null,
        onclick: () => { current = section.id; render(); },
      }),
    ]).filter(Boolean));
    const section = sections.find((entry) => entry.id === current);
    main.replaceChildren(...(current === 'general' ? generalView() : current === 'diagnostics' ? diagnosticsView() : sectionView(section)));
    if (focusedKey) root.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }

  function refreshChrome() {
    const paused = settings.get('paused') === true;
    power.checked = !paused;
    pauseState.textContent = paused ? 'Paused' : 'On';
    launcher.hidden = settings.get('ui.launcher') !== true;
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
    try {
      const { applied, skipped } = settings.importJson(await file.text());
      const extra = skipped.length ? `, and skipped ${skipped.length} this version doesn't know` : '';
      toast(`Restored ${applied.length} settings${extra}.`);
    } catch (error) {
      log.error("Couldn't restore settings from that file", error);
    }
  }

  function resetSettings() {
    const previous = settings.reset();
    toast('Settings are back to their defaults.', { action: { label: 'Undo', run: () => settings.restore(previous) } });
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
    if (sectionId) current = sectionId;
    overlay.hidden = false;
    render();
    closeButton.focus();
  }

  function close() {
    overlay.hidden = true;
    if (!launcher.hidden) launcher.focus();
  }

  settings.subscribe(() => {
    refreshChrome();
    if (!overlay.hidden) render();
  });

  let lastErrorToast = 0;
  const announceError = (entry) => {
    if (Date.now() - lastErrorToast < ERROR_TOAST_GAP_MS) return;
    lastErrorToast = Date.now();
    toast(`${entry.message}. Details are in Diagnostics.`, { tone: 'error', action: { label: 'Open', run: () => open('diagnostics') } });
  };
  let renderQueued = false;
  const refreshDiagnostics = () => {
    if (overlay.hidden || current !== 'diagnostics' || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!overlay.hidden && current === 'diagnostics') render();
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
  return { open, close, toast };
}
