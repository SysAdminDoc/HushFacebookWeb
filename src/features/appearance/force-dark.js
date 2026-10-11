// Force dark mode, as on Android. Facebook's theme is one class on <html>, __fb-light-mode or
// __fb-dark-mode, and every color is a CSS variable defined under each (579 of them, read live
// 2026-10-11). Swapping the class is how Facebook switches itself, so the script does the
// same, keeps it swapped when Facebook sets it back, and puts Facebook's own choice back when
// the switch goes off. Works in content mode.
//
// Facebook's popup layers carry the class too (live 2026-10-11, captures/2026-10-11-run3): a
// handful of plain divs in the top bar and at the end of <body> hold the account, Notifications
// and Messenger menus and a post's menu, and they keep __fb-light-mode whatever <html> says. So
// every element with the light class is swapped, and only the ones the script swapped go back.

import { whenRootReady } from '../../core/env.js';

export const LIGHT = '__fb-light-mode';
export const DARK = '__fb-dark-mode';
// Facebook only sets the class when its theme changes. If something keeps setting it back
// faster than this, the script stops rather than fight over it.
const MAX_SWAPS = 20;
const MAX_LAYER_SWAPS = 200;
const SWAP_WINDOW = 5000;

export function createDarkKeeper({ doc, enabled, log, now = () => Date.now() }) {
  let swapped = false;
  let observer = null;
  const swaps = [];
  const layerSwaps = [];
  // Layers this keeper turned dark, so switching off leaves Facebook's own dark ones alone.
  const layers = new WeakSet();
  let layerCount = 0;
  let gaveUp = false;
  let lights = null;

  // Records a swap; true when there have been too many lately.
  const tooMany = (list, max) => {
    const time = now();
    while (list.length && time - list[0] > SWAP_WINDOW) list.shift();
    list.push(time);
    return list.length > max;
  };

  const giveUp = () => {
    gaveUp = true;
    log?.warn("Force dark mode stopped: something on the page keeps switching Facebook back to light");
  };

  function apply() {
    const root = doc.documentElement;
    if (!root) return;
    lights ??= doc.getElementsByClassName(LIGHT);
    const want = enabled() && !gaveUp;
    if (want) {
      if (root.classList.contains(LIGHT)) {
        if (tooMany(swaps, MAX_SWAPS)) return giveUp();
        root.classList.replace(LIGHT, DARK);
        swapped = true;
      }
      // A live list, so most calls only read its length.
      if (!lights.length) return undefined;
      for (const layer of [...lights]) {
        if (tooMany(layerSwaps, MAX_LAYER_SWAPS)) return giveUp();
        layer.classList.replace(LIGHT, DARK);
        if (!layers.has(layer)) layerCount += 1;
        layers.add(layer);
      }
      return undefined;
    }
    if (swapped && root.classList.contains(DARK)) {
      root.classList.replace(DARK, LIGHT);
      swapped = false;
    }
    if (layerCount) {
      for (const layer of [...doc.getElementsByClassName(DARK)]) {
        if (!layers.has(layer)) continue;
        layer.classList.replace(DARK, LIGHT);
        layers.delete(layer);
      }
      layerCount = 0;
    }
    return undefined;
  }

  function start() {
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer(apply);
    // New layers come in as nodes, and a layer can get its class back later.
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    apply();
  }

  return {
    start: () => whenRootReady(start, doc),
    apply,
    state: () => ({ swapped, gaveUp, layers: layerCount }),
    stop: () => observer?.disconnect(),
  };
}

export default {
  id: 'forceDarkMode',
  section: 'appearance',
  android: 'Force dark mode',
  title: 'Force dark mode',
  description: "Keeps Facebook in its dark theme, whatever Facebook's own setting says. Switch it off and Facebook's choice comes back.",
  default: false,

  setup({ doc, settings, enabled, log }) {
    const keeper = createDarkKeeper({ doc, enabled, log });
    keeper.start();
    settings?.subscribe(() => keeper.apply());
  },
};
