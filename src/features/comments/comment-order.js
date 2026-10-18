// Default comment order, as Hushfacebook's patch does on Android. Facebook opens comments as
// Most relevant, and only its order menu asks for another order (see orders.js). So when a
// comment section shows Facebook's default order, the script opens that menu once and picks
// yours. The button is found by its title, learned from Facebook's data in the page's
// language, and the menu item by its title too, or by its place when the titles aren't known.
//
// Only a post's own page, a photo's page and a post opened over the feed are touched, each
// once, so changing the order by hand afterwards sticks. Waiting for the menu, the script
// stops and clicks nothing more once the feature is switched off or paused, another order is
// picked or the page moves on. A stopped attempt can start over later.

import { normalizeText } from '../../core/dom/visible-text.js';
import { whenBodyReady } from '../../core/env.js';
import { createOrderTitles, DEFAULT_ORDER, ORDER_MARKERS, ORDERS } from './orders.js';
import { dialogOpen } from './post-dialog.js';

const MENU_WAIT = 2000;
const STEP = 100;
const SCAN_DELAY = 300;
// Attempts at one section that found no menu, or no order in it, before it's left alone.
const TRIES = 2;

export function createOrderDriver({ doc, win = globalThis, titles, wanted, pageKey, log, onDone, menuWait = MENU_WAIT }) {
  // A dialog is done for the address it showed, so one Facebook reuses for the next post or
  // photo gets that one put in order too.
  const dialogs = new WeakMap(); // dialog -> { address, done, failed }
  const pages = new Map(); // page -> { done, failed }
  let busy = false;
  let generation = 0;
  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
  const here = () => doc.location?.href ?? '';

  function stateOf(section) {
    if (section.page) return pages.get(section.page) ?? pages.set(section.page, { done: false, failed: 0 }).get(section.page);
    const address = here();
    let state = dialogs.get(section.dialog);
    if (state?.address !== address) dialogs.set(section.dialog, (state = { address, done: false, failed: 0 }));
    return state;
  }
  const finished = (section) => stateOf(section).done || stateOf(section).failed >= TRIES;

  // The comment section a button belongs to, or null when it's out of reach (the feed).
  function sectionOf(button) {
    const dialog = button.closest('[role="dialog"]');
    if (dialog) return finished({ dialog }) ? null : { dialog };
    const page = pageKey();
    return page && !dialogOpen(doc) && !finished({ page }) ? { page } : null;
  }

  // The menu this click opened: one that wasn't there before it. Undefined once the attempt
  // stopped counting, so a menu that turns up later is left as it is.
  async function menuAfter(before, current) {
    for (let waited = 0; waited <= menuWait; waited += STEP) {
      if (!current()) return undefined;
      const menu = [...doc.querySelectorAll('[role="menu"]')].find((m) => !before.has(m) && m.querySelector('[role="menuitem"]'));
      if (menu) return menu;
      await sleep(STEP);
    }
    return current() ? null : undefined;
  }

  async function drive(button, section, order) {
    busy = true;
    const state = stateOf(section);
    const address = here();
    const started = generation;
    // Still the attempt it began as: the same order wanted, the same address, not cancelled,
    // and the button still in its section.
    const current = () => started === generation && wanted()?.value === order.value && here() === address && button.isConnected
      && (section.dialog ? section.dialog.contains(button) : pageKey() === section.page);
    try {
      const before = new Set(doc.querySelectorAll('[role="menu"]'));
      button.click();
      const menu = await menuAfter(before, current);
      if (menu === undefined) return null;
      const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
      const title = titles.title(order);
      const item = items.find((entry) => normalizeText(entry.textContent).startsWith(title))
        ?? (items.length === ORDERS.length ? items[ORDERS.indexOf(order)] : null);
      if (!item) {
        state.failed++;
        // Closed again only while it's the menu this click opened and still open.
        if (menu?.isConnected) button.click();
        // The title is Facebook's text in the page's language, so it goes in the detail.
        log?.warn(`Couldn't find "${order.english}" in Facebook's comment order menu`, title);
        return false;
      }
      item.click();
      state.done = true;
      onDone?.();
      return true;
    } finally {
      busy = false;
    }
  }

  // Looks for a comment section still in Facebook's default order. One at a time.
  function scan() {
    if (busy) return null;
    const order = wanted();
    if (!order || order === DEFAULT_ORDER) return null;
    const current = titles.title(DEFAULT_ORDER);
    for (const button of doc.querySelectorAll('[role="button"]')) {
      if (normalizeText(button.textContent) !== current) continue;
      const section = sectionOf(button);
      if (section) return drive(button, section, order);
    }
    return null;
  }

  // Ends an attempt that's waiting for its menu. It clicks nothing more.
  function cancel() {
    generation++;
  }

  return { scan, cancel };
}

export default {
  id: 'commentOrder',
  section: 'comments',
  android: 'Default comment order',
  title: 'Default comment order',
  description: "Opens comments in the order you pick instead of Most relevant, on a post's own page and when you open a post's comments from the feed. You can still change the order on any post.",
  default: false,
  options: [
    {
      key: 'order', type: 'select', label: 'Order', default: 'newest',
      choices: [{ value: 'newest', label: 'Newest first' }, { value: 'all', label: 'All comments, including ones Facebook filters' }],
    },
  ],

  setup({ doc, win, net, router, settings, diagnostics, enabled, option, log }) {
    const titles = createOrderTitles();
    let changed = 0;
    // The titles in the page's language, read off Facebook's own JSON.parse. Nothing changes.
    net?.transformResponses({
      id: 'commentOrderTitles',
      enabled,
      markers: ORDER_MARKERS,
      match: (ctx) => ctx.transport === 'json-parse',
      observe: true,
      transform(data) {
        titles.learn(data);
        return false;
      },
    });
    const driver = createOrderDriver({
      doc, win, titles, log,
      wanted: () => (enabled() ? ORDERS.find((order) => order.value === option('order')) ?? null : null),
      pageKey: () => {
        const route = router?.current();
        return route && (route.permalink || route.type === 'photo') ? route.href : null;
      },
      onDone: () => {
        changed++;
        diagnostics?.changed();
      },
    });
    diagnostics?.add('Comment sections put in your order', () => String(changed));
    // Switching it off and on again, or pausing and resuming, while a menu is on its way still
    // stops that attempt.
    settings?.subscribe?.(({ keys = [] } = {}) => {
      if (keys.some((key) => key === 'paused' || key === 'commentOrder' || key.startsWith('commentOrder.'))) driver.cancel();
    });

    let queued = false;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer(() => {
      if (queued || !enabled()) return;
      queued = true;
      (win ?? globalThis).setTimeout(() => {
        queued = false;
        driver.scan();
      }, SCAN_DELAY);
    });
    const begin = () => observer.observe(doc.body, { childList: true, subtree: true });
    whenBodyReady(begin, doc);
  },
};
