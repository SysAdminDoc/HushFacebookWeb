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
// When Facebook picks dark itself while the script holds it dark, the page stays dark after
// the switch goes off.
//
// Facebook also inverts on purpose: on its own dark areas a selected chip is white, with its
// words in a __fb-light-mode island so they come out dark (live 2026-10-12, Reels' library page,
// Saved: a dark div around the tab list, a white tab, a light div around the word). Swapping that
// island left white words on white. So a light element stays light when the nearest dark element
// above it is one Facebook made dark itself, and turns dark when there's none below <html> or the
// nearest is a layer the script darkened.

import { whenRootReady } from '../../core/env.js';

export const LIGHT = '__fb-light-mode';
export const DARK = '__fb-dark-mode';
// Facebook only sets the class when its theme changes. If something keeps setting it back
// faster than this, the script stops rather than fight over it.
const MAX_SWAPS = 20;
const MAX_LAYER_SWAPS = 200;
const SWAP_WINDOW = 5000;

// Which theme Facebook writes on <html>, from the classList calls it makes: remove the old class,
// then add the new one (live 2026-10-11, captures/2026-10-11-run32, at load). Facebook picking dark
// while the script already holds the page dark changes nothing on the page, so no mutation shows
// it, and without this, switching Force dark off would put light back against Facebook's choice.
// Only calls in the page's own world are seen. In content mode nothing is, and the script works
// as it did before.
const WATCHERS = Symbol.for('hushfacebook-web.theme-watchers');
const METHODS = ['add', 'replace', 'toggle'];

function themeWritten(method, args, result) {
  if (method === 'add') return args.includes(DARK) ? DARK : args.includes(LIGHT) ? LIGHT : null;
  if (method === 'replace') return result && (args[1] === DARK || args[1] === LIGHT) ? args[1] : null;
  return result === true && (args[0] === DARK || args[0] === LIGHT) ? args[0] : null;
}

function watchThemeWrites(doc, watcher) {
  const list = doc.documentElement?.classList;
  const proto = list ? Object.getPrototypeOf(list) : null;
  if (!proto || typeof proto.add !== 'function') return;
  if (!Object.hasOwn(proto, WATCHERS)) {
    const watchers = new Set();
    Object.defineProperty(proto, WATCHERS, { value: watchers });
    for (const method of METHODS) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (...args) {
        const result = original.apply(this, args);
        if (watchers.size) {
          const theme = themeWritten(method, args, result);
          // A watcher's failure never reaches the page's own call.
          if (theme) {
            for (const watch of watchers) {
              try {
                watch(this, theme);
              } catch {
                // Nothing to undo: the page's call already went through.
              }
            }
          }
        }
        return result;
      };
    }
  }
  proto[WATCHERS].add(watcher);
  return () => proto[WATCHERS].delete(watcher);
}

// isRootList: whether a list a classList method ran on is <html>'s. In a browser that's the
// list itself. Tests pass their own, since happy-dom runs the methods on a list behind a Proxy.
export function createDarkKeeper({ doc, enabled, log, now = () => Date.now(), isRootList = (list) => list === doc.documentElement?.classList }) {
  let swapped = false;
  // Set while the script writes the class itself, so its own swaps aren't taken for Facebook's.
  let writing = false;
  let unwatch = null;
  let observer = null;
  const swaps = [];
  const layerSwaps = [];
  // Layers this keeper turned dark, so switching off leaves Facebook's own dark ones alone.
  const layers = new WeakSet();
  let layerCount = 0;
  let gaveUp = false;

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

  // The light layers among what changed: elements that got the class, and new elements with it
  // on them or inside them. Reading only those keeps each change cheap on a large page.
  function changedLights(records) {
    const found = new Set();
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.classList?.contains(LIGHT)) found.add(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList.contains(LIGHT)) found.add(node);
        for (const inner of node.getElementsByClassName(LIGHT)) found.add(inner);
      }
    }
    return found;
  }

  // Whether a light element only follows the page's theme, rather than Facebook inverting it.
  // A light element above it goes the same way it does, so only a dark one decides.
  const followsPage = (element, root) => {
    for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
      if (node.classList.contains(DARK)) return layers.has(node);
    }
    return true;
  };

  const swapRoot = (root, from, to) => {
    writing = true;
    try {
      root.classList.replace(from, to);
    } finally {
      writing = false;
    }
  };

  // Facebook choosing dark itself means there's no light to put back.
  const facebookWrote = (list, theme) => {
    if (writing || theme !== DARK || !isRootList(list)) return;
    swapped = false;
  };

  // records: what the observer saw, or nothing to look over the whole page.
  function apply(records) {
    const root = doc.documentElement;
    if (!root) return;
    const want = enabled() && !gaveUp;
    if (want) {
      unwatch ??= watchThemeWrites(doc, facebookWrote) ?? (() => {});
      if (root.classList.contains(LIGHT)) {
        if (tooMany(swaps, MAX_SWAPS)) return giveUp();
        swapRoot(root, LIGHT, DARK);
        swapped = true;
      }
      const lights = records ? changedLights(records) : [...doc.getElementsByClassName(LIGHT)];
      for (const layer of lights) {
        if (layer === root || !layer.classList.contains(LIGHT) || !followsPage(layer, root)) continue;
        // Only a layer turned light again after the script darkened it counts toward giving up,
        // so a page with many layers isn't mistaken for a fight.
        if (layers.has(layer)) {
          if (tooMany(layerSwaps, MAX_LAYER_SWAPS)) return giveUp();
        } else {
          layerCount += 1;
          layers.add(layer);
        }
        layer.classList.replace(LIGHT, DARK);
      }
      return undefined;
    }
    if (swapped && root.classList.contains(DARK)) {
      swapRoot(root, DARK, LIGHT);
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
    observer = new Observer((records) => apply(records));
    // New layers come in as nodes, and a layer can get its class back later.
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    apply();
  }

  return {
    start: () => whenRootReady(start, doc),
    apply: () => apply(),
    state: () => ({ swapped, gaveUp, layers: layerCount }),
    stop: () => {
      observer?.disconnect();
      unwatch?.();
      unwatch = null;
    },
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
