import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider } from '../../../src/core/dom/hide.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { features } from '../../../src/features/index.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { check } from './helpers.js';

// General in the extension at phone width: the toolbar count's switch, on by default, with its
// note inside the card and nothing scrolling sideways.
export async function generalToolbar() {
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  const storage = createMemoryStorage();
  const settings = createSettings({ storage, features, log });
  const hider = createHider({ doc: document, log, notesShown: () => false });
  const now = Date.now();
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const panel = mountPanel({
    settings, features, log, hider, diagnostics: createDiagnostics(), actions: null, unavailable: new Map(),
    environment: {
      version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage,
      update: () => ({ state: 'current', update: null, checking: false, checkedAt: now, triedAt: now, nextAt: now + 86400000 }),
    },
  });
  HTMLElement.prototype.attachShadow = attach;
  panel.open('general');
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

  const toggle = shadow.querySelector('[data-key="ui.toolbarCount"]');
  check(toggle?.checked === true, 'The toolbar count switch is missing or off');
  const card = toggle.closest('.card');
  card.scrollIntoView({ block: 'center' });
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  const cardBox = card.getBoundingClientRect();
  const note = card.querySelector('.desc').getBoundingClientRect();
  const knob = toggle.getBoundingClientRect();
  check(note.right <= cardBox.right + 1 && note.left >= cardBox.left - 1, 'The note runs out of its card');
  check(knob.right <= cardBox.right + 1 && knob.width > 0, 'The switch sits outside its card');
  const main = shadow.querySelector('main');
  check(main.scrollWidth - main.clientWidth <= 1, 'General scrolls sideways');
  return { title: card.querySelector('.title').textContent };
}
