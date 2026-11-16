import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider } from '../../../src/core/dom/hide.js';
import { LOAD_WAIT_MS } from '../../../src/core/load-watchdog.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { features } from '../../../src/features/index.js';
import { featureKeys, SEEN_SETTINGS_KEY } from '../../../src/ui/new-dots.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { check } from './helpers.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
// A notice fades in, and the screenshot can't fast-forward that inside the panel's shadow root.
const settled = (el) => Promise.all(el.getAnimations().map((animation) => animation.finished));
const within = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
  && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const seenBox = (el) => {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};

// The panel on a page of its own, with `unseen` left off the list of settings already shown, so
// it gets a new-dot. Returns the panel and its shadow root.
function mount(unseen) {
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  const storage = createMemoryStorage();
  storage.set(SEEN_SETTINGS_KEY, features.flatMap(featureKeys).filter((key) => key !== unseen));
  const settings = createSettings({ storage, features, log });
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const now = Date.now();
  const panel = mountPanel({
    settings, features, log, hider: createHider({ doc: document, log }), diagnostics: createDiagnostics(), actions: null, unavailable: new Map(),
    environment: {
      version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage,
      update: () => ({ state: 'current', update: null, checking: false, checkedAt: now, triedAt: now, nextAt: now + 86400000 }),
    },
  });
  HTMLElement.prototype.attachShadow = attach;
  return { panel, shadow };
}

// The notice a stuck feed gets (boot.js), with its three buttons, on a phone-sized window: its
// words and every button stay on the screen, wrapping instead of running off the side.
export async function stuckNotice() {
  const { panel, shadow } = mount();
  const run = () => {};
  panel.toast(`Facebook's feed is still loading after ${LOAD_WAIT_MS / 1000} seconds. If HushFacebook Web is getting in the way, pause it for this tab.`, {
    duration: 60000,
    actions: [{ label: 'Pause for this tab', run }, { label: 'Stop these warnings', run }, { label: 'Copy report', run, keep: true }],
  });
  await frame();
  const toast = shadow.querySelector('.toast');
  check(toast !== null, 'No notice showed');
  await settled(toast);
  const box = toast.getBoundingClientRect();
  const screen = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  check(within(box, screen), `The notice runs off the screen: ${Math.round(box.left)} to ${Math.round(box.right)} of ${window.innerWidth}`);
  const buttons = [...toast.querySelectorAll('button')];
  check(buttons.length === 3, `${buttons.length} buttons`);
  for (const button of buttons) {
    check(within(button.getBoundingClientRect(), box), `"${button.textContent}" sits outside the notice`);
    check(button.scrollWidth <= button.clientWidth + 1, `"${button.textContent}" is cut off`);
    check(button.getBoundingClientRect().height >= 32, `"${button.textContent}" is under 32 px tall`);
  }
  const words = toast.querySelector('span');
  check(words.scrollWidth <= words.clientWidth + 1, 'The words are cut off');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'The page scrolls sideways');
  return { width: Math.round(box.width), rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size };
}

// The panel with Windows' high contrast on (forced colors): switches, the page you're on, the
// new-dots and a notice still show, in the system's colors.
export async function panelForced() {
  check(matchMedia('(forced-colors: active)').matches, 'Forced colors are off');
  const { panel, shadow } = mount('hideFriendRequestsColumn');
  panel.open('feed');
  panel.toast('Saved.');
  await frame();
  const view = shadow.host.ownerDocument.defaultView;
  const switches = [...shadow.querySelectorAll('.switch')].filter(seenBox);
  check(switches.length > 0, 'No switch shows');
  for (const input of switches) check(view.getComputedStyle(input).appearance === 'auto', 'A switch kept its drawn look, which forced colors blank out');
  const current = shadow.querySelector('nav button[aria-current="page"]');
  check(current !== null && view.getComputedStyle(current).borderTopStyle === 'solid', 'The page you are on has no outline');
  const dots = [...shadow.querySelectorAll('.new-dot')].filter(seenBox);
  check(dots.length >= 2, `${dots.length} new-dots show, not the page's and the setting's`);
  const canvas = view.getComputedStyle(shadow.querySelector('.dialog')).backgroundColor;
  for (const dot of dots) {
    const color = view.getComputedStyle(dot).backgroundColor;
    check(color !== 'rgba(0, 0, 0, 0)' && color !== canvas, `A new-dot is ${color} on ${canvas}`);
  }
  const toast = shadow.querySelector('.toast');
  check(toast !== null && view.getComputedStyle(toast).borderTopStyle === 'solid', 'The notice has no edge');
  await settled(toast);
  return { switches: switches.length, dots: dots.length };
}
