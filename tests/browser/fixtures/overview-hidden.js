import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider, hideCss } from '../../../src/core/dom/hide.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { features } from '../../../src/features/index.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { check } from './helpers.js';

// Overview's hidden count in real layout at phone width: three posts hidden for two reasons with
// notes off, one taken out of the data, and Show them bringing the three back.
export async function overviewHidden() {
  const rules = document.createElement('style');
  rules.textContent = hideCss({ notes: false });
  document.head.append(rules);
  const feed = document.createElement('main');
  feed.innerHTML = [1, 2, 3].map((n) => `<div aria-posinset="${n}"><div><a href="/someone/posts/pfbid0Fixture${n}">Post ${n}</a></div></div>`).join('');
  document.body.append(feed);
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  const storage = createMemoryStorage();
  const settings = createSettings({ storage, features, log });
  const hider = createHider({ doc: document, log, notesShown: () => false });
  const diagnostics = createDiagnostics();
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const panel = mountPanel({
    settings, features, log, hider, diagnostics, actions: null, unavailable: new Map(),
    environment: { version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage },
  });
  HTMLElement.prototype.attachShadow = attach;
  const posts = [...feed.children];
  posts.forEach((post, i) => check(hider.hide(post, i < 2 ? 'Filter' : 'Sponsored', i < 2 ? 'cats' : undefined), `Post ${i + 1} was not hidden`));
  diagnostics.decide({ post: 'fixture-ad', rule: 'Sponsored', signal: 'th_dat_spo', layer: 'data' });
  panel.open('overview');
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

  const card = () => shadow.querySelector('[data-key="overview-hidden"]');
  const lines = () => [...card().querySelectorAll('.title, .desc')].map((line) => line.textContent);
  check(JSON.stringify(lines()) === JSON.stringify(['Hidden on this page: 3', 'Your filters: 2, Ads: 1', 'Removed before they showed: 1']), `Overview reads ${JSON.stringify(lines())}`);
  check(posts.every((post) => !post.firstElementChild.checkVisibility()), 'A hidden post still shows');
  const button = card().querySelector('[data-key="overview-hidden:show"]');
  const box = button.getBoundingClientRect();
  check(box.width > 40 && box.height >= 24, `Show them has no box of its own (${box.width}x${box.height})`);
  const main = shadow.querySelector('main');
  check(main.scrollWidth - main.clientWidth <= 1, 'Overview scrolls sideways');
  const before = lines();

  button.focus();
  button.click();
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  check(posts.every((post) => post.firstElementChild.checkVisibility()), 'Show them left a post hidden');
  check(shadow.activeElement === card(), 'Focus did not stay on the card');
  check(!card().querySelector('[data-key="overview-hidden:show"]'), 'Show them is still there with nothing left to show');
  // A post hidden after that brings Show them back, which the screenshot shows.
  feed.insertAdjacentHTML('beforeend', '<div aria-posinset="4"><div><a href="/someone/posts/pfbid0Fixture4">Post 4</a></div></div>');
  check(hider.hide(feed.lastElementChild, 'Seen'), 'Post 4 was not hidden');
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  check(Boolean(card().querySelector('[data-key="overview-hidden:show"]')), 'Show them did not come back for a newly hidden post');
  return { before, after: lines() };
}
