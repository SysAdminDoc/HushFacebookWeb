// Force dark mode, as on Android. Facebook's theme is one class on <html>, __fb-light-mode or
// __fb-dark-mode, and every color is a CSS variable defined under each (579 of them, read live
// 2026-10-11). Swapping the class is how Facebook switches itself, so the script does the
// same, keeps it swapped when Facebook sets it back, and puts Facebook's own choice back when
// the switch goes off. Works in content mode.

import { whenRootReady } from '../../core/env.js';

export const LIGHT = '__fb-light-mode';
export const DARK = '__fb-dark-mode';
// Facebook only sets the class when its theme changes. If something keeps setting it back
// faster than this, the script stops rather than fight over it.
const MAX_SWAPS = 20;
const SWAP_WINDOW = 5000;

export function createDarkKeeper({ doc, enabled, log, now = () => Date.now() }) {
  let swapped = false;
  let observer = null;
  const swaps = [];
  let gaveUp = false;

  function apply() {
    const root = doc.documentElement;
    if (!root) return;
    const want = enabled() && !gaveUp;
    if (want && root.classList.contains(LIGHT)) {
      const time = now();
      while (swaps.length && time - swaps[0] > SWAP_WINDOW) swaps.shift();
      swaps.push(time);
      if (swaps.length > MAX_SWAPS) {
        gaveUp = true;
        log?.warn("Force dark mode stopped: something on the page keeps switching Facebook back to light");
        return;
      }
      root.classList.replace(LIGHT, DARK);
      swapped = true;
    } else if (!want && swapped && root.classList.contains(DARK)) {
      root.classList.replace(DARK, LIGHT);
      swapped = false;
    }
  }

  function start() {
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer(apply);
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    apply();
  }

  return {
    start: () => whenRootReady(start, doc),
    apply,
    state: () => ({ swapped, gaveUp }),
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
