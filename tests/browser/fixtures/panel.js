import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider } from '../../../src/core/dom/hide.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { features } from '../../../src/features/index.js';
import { keepKeysInPanel } from '../../../src/ui/keys.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { check } from './helpers.js';

let state;

export function preparePanel() {
  const errors = [];
  const log = createLog({ sink: { info() {}, warn() {}, error: (message) => errors.push(message) } });
  const storage = createMemoryStorage();
  const settings = createSettings({ storage, features, log });
  settings.set('noWatchHistory', false);
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const opener = document.createElement('button');
  opener.textContent = 'Local page settings';
  document.body.append(opener);
  keepKeysInPanel(window);
  const panel = mountPanel({
    settings, features, log, hider: createHider({ doc: document, log }), diagnostics: createDiagnostics(),
    actions: null, unavailable: new Map(),
    environment: { version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage },
  });
  HTMLElement.prototype.attachShadow = attach;
  opener.focus();
  panel.open('general');
  state = { panel, settings, shadow, opener, errors };
  const focus = shadow.activeElement;
  check(shadow.querySelector('dialog').matches(':modal'), 'The native dialog is not modal');
  check(focus?.dataset.key === 'close', 'Opening settings did not focus Close');
  return panelState();
}

export function panelState() {
  const { settings, shadow, opener, errors } = state;
  const active = shadow.activeElement;
  return {
    focused: active?.dataset.key ?? null,
    focusInside: shadow.querySelector('dialog').contains(active),
    openerFocused: document.activeElement === opener,
    open: shadow.querySelector('dialog').open,
    results: shadow.querySelectorAll('.result').length,
    undo: Boolean(shadow.querySelector('[data-key="reset:undo"]')),
    watchHistory: settings.get('noWatchHistory'),
    query: shadow.querySelector('.search').value,
    overflow: shadow.querySelector('main').scrollWidth - shadow.querySelector('main').clientWidth,
    errors,
  };
}

export function focusPanelControl(key) {
  const control = state.shadow.querySelector(`[data-key="${CSS.escape(key)}"]`);
  check(Boolean(control), `Missing panel control ${key}`);
  control.focus();
}

export function finishPanel() {
  state.panel.close();
}
