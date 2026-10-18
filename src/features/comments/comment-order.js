// Default comment order, as Hushfacebook's patch does on Android. Facebook opens comments as
// Most relevant, and only its order menu asks for another order (see orders.js). So when a
// comment section shows Facebook's default order, the script opens that menu once and picks
// yours. The button is found by its title, learned from Facebook's data in the page's
// language, and the menu item by its title too, or by its place when the titles aren't known.
//
// Only a post's own page, a photo's page and a post opened over the feed are touched, each
// once, so changing the order by hand afterwards sticks.

import { normalizeText } from '../../core/dom/visible-text.js';
import { whenBodyReady } from '../../core/env.js';
import { createOrderTitles, DEFAULT_ORDER, ORDER_MARKERS, ORDERS } from './orders.js';
import { dialogOpen } from './post-dialog.js';

const MENU_WAIT = 2000;
const STEP = 100;
const SCAN_DELAY = 300;

export function createOrderDriver({ doc, win = globalThis, titles, wanted, pageKey, log, onDone, menuWait = MENU_WAIT }) {
  // A dialog is done for the address it showed, so one Facebook reuses for the next post or
  // photo gets that one put in order too.
  const doneDialogs = new WeakMap();
  const donePages = new Set();
  let busy = false;
  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
  const here = () => doc.location?.href ?? '';

  // The comment section a button belongs to, or null when it's out of reach (the feed).
  function sectionOf(button) {
    const dialog = button.closest('[role="dialog"]');
    if (dialog) return doneDialogs.get(dialog) === here() ? null : { dialog };
    const page = pageKey();
    return page && !dialogOpen(doc) && !donePages.has(page) ? { page } : null;
  }

  // The menu this click opened: one that wasn't there before it.
  async function menuAfter(before) {
    for (let waited = 0; waited <= menuWait; waited += STEP) {
      const menu = [...doc.querySelectorAll('[role="menu"]')].find((m) => !before.has(m) && m.querySelector('[role="menuitem"]'));
      if (menu) return menu;
      await sleep(STEP);
    }
    return null;
  }

  async function drive(button, section, order) {
    busy = true;
    if (section.dialog) doneDialogs.set(section.dialog, here());
    else donePages.add(section.page);
    try {
      const before = new Set(doc.querySelectorAll('[role="menu"]'));
      button.click();
      const menu = await menuAfter(before);
      const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
      const title = titles.title(order);
      const item = items.find((entry) => normalizeText(entry.textContent).startsWith(title))
        ?? (items.length === ORDERS.length ? items[ORDERS.indexOf(order)] : null);
      if (!item) {
        if (menu) button.click();
        // The title is Facebook's text in the page's language, so it goes in the detail.
        log?.warn(`Couldn't find "${order.english}" in Facebook's comment order menu`, title);
        return false;
      }
      item.click();
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

  return { scan };
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

  setup({ doc, win, net, router, diagnostics, enabled, option, log }) {
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
