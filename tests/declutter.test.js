// The Declutter switches against Home's furniture as drawn live on 2026-10-11 (structure and
// addresses from captures/2026-10-11-declutter*, names made up): the top bar's tab list and
// buttons, the left column with "See more" open, Facebook's menu, and a post opened in a
// dialog that must stay untouched. Badges aren't from a capture (the account had none), they
// follow Facebook's usual floating red count.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import hideTabs, { tabsCss } from '../src/features/appearance/hide-tabs.js';
import hideTabBadges, { BADGE_MARK, badgeBox, cleanTitle, createBadgeHider, markBadges } from '../src/features/appearance/hide-tab-badges.js';
import hideMenuPromotions, { promotionsCss } from '../src/features/menu/hide-menu-promotions.js';
import hideMetaUpsells, { UPSELLS_CSS } from '../src/features/meta/hide-meta-upsells.js';
import { LEFT, section } from '../src/features/appearance/declutter-table.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FB = 'https://www.facebook.com';
const out = (target) => `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0`;
const tab = (label, href, extra = '') => `<li data-row="tab:${label}"><span><div><a aria-label="${label}" href="${href}"><svg></svg>${extra}</a></div></span></li>`;
const left = (name, href, extra = '') => `<li data-row="left:${name}"><div><div><div><a href="${href}"><span>${name}</span>${extra}</a></div></div></div></li>`;
const item = (name, href) => `<div role="listitem" data-row="menu:${name}"><div><div><a href="${href}"><span>${name}</span></a></div></div></div>`;

const HOME = `
<div role="banner">
  <a aria-label="Facebook" href="/">f</a>
  <div role="navigation" aria-label="Facebook"><ul>
    ${tab('Home', '/')}${tab('Friends', '/friends/', '<span class="tab-badge" style="position:absolute"><span>3</span></span>')}
    ${tab('Groups', '/groups/')}${tab('Video', '/watch/?ref=tab')}${tab('Marketplace', '/marketplace/')}${tab('Gaming', '/gaming/')}
  </ul></div>
  <div role="navigation" aria-label="Account Controls and Settings">
    <div data-row="find-friends"><a href="/friends/">Find friends</a></div>
    <div><div role="button" aria-label="Facebook menu"></div></div>
    <div><span><span><div role="button" aria-label="Notifications"></div><div class="bell-badge" style="position:absolute;background-color:rgb(228, 30, 63)"><span><span>9+</span></span></div></span></span></div>
  </div>
</div>
<div role="navigation" aria-label="Shortcuts"><ul>
  ${left('Pat Example', `${FB}/profile.php?id=615000000000001`)}
  ${left('Meta AI', out('https://www.meta.ai/'))}
  ${left('Friends', `${FB}/friends/?ref=bookmarks`)}
  ${left('Marketplace', `${FB}/marketplace/?ref=bookmark`)}
  ${left('Groups', `${FB}/groups/?ref=bookmarks`)}
  ${left('Messenger', `${FB}/messages/t/`)}
  ${left('Ads Manager', `${FB}/ad_campaign/landing.php?campaign_id=1&ref=bookmarks`)}
  ${left('Gaming Video', `${FB}/gaming/?ref=bookmarks`)}
  ${left('Play games', `${FB}/gaming/play/?ref=bookmarks`)}
  ${left('Messenger Kids', `${FB}/messenger_kids/?ref=bookmarks`)}
  ${left('Meta Quest 3S', out('https://www.meta.com/quest/quest-3s/'))}
  ${left('Ray-Ban Meta', 'https://www.meta.com/ai-glasses/')}
  ${left('Memories', `${FB}/onthisday/?ref=bookmarks`)}
  ${left('42', `${FB}/groups/615000000000042/`)}
  ${left('Gaming Club', `${FB}/groups/gamingclub/`, '<span class="row-badge" style="background-color:rgb(228, 30, 63)">12</span>')}
  ${left('Privacy', '/privacy/policy/')}
</ul></div>
<div role="main"><div aria-posinset="1"><a href="${FB}/gaming/">a post linking to gaming</a></div></div>
<div role="dialog" aria-label="Menu">
  <div role="list">
    ${item('Events', `${FB}/events?ref=x`)}${item('Play games', `${FB}/gaming/play/?ref=x`)}${item('Ads Manager', `${FB}/ad_campaign/landing.php?ref=x`)}
    ${item('Your Ad Activity', `${FB}/ads/activity/?ref=x`)}${item('Meta AI', out('https://www.meta.ai/'))}${item('WhatsApp', out('https://www.whatsapp.com/'))}
    ${item('Instagram', out('https://www.instagram.com/'))}${item('Messenger Kids', `${FB}/messenger_kids/?ref=x`)}${item('Saved', `${FB}/saved/?ref=x`)}
  </div>
  <div role="list">${item('Page', '/pages/creation/')}${item('Ad', '/ads/create_ad/')}${item('Event', '/events/create/')}${item('Fundraiser', '/fundraiser/with_presence/create_dialog/')}</div>
</div>
<div role="dialog" aria-label="Pat Example's post">
  <div role="list">${item('a shared link', out('https://example.com/story'))}${item('an Instagram link', out('https://www.instagram.com/p/1/'))}</div>
</div>`;

function page(html = HOME) {
  const win = new Window({ url: `${FB}/` });
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// The rows a stylesheet's hide rule reaches, by data-row.
function hiddenBy(win, css) {
  if (!css) return [];
  const selectors = css.slice(0, css.lastIndexOf(' { display: none !important; }'));
  return [...win.document.querySelectorAll(selectors)].map((el) => el.dataset.row ?? el.className).sort();
}

const settings = (values) => (key) => values[key];
const tabDefaults = Object.fromEntries(hideTabs.options.map((option) => [`hideTabs.${option.key}`, option.default]));

test('a section link matches with or without its query, relative or absolute, and nothing deeper', () => {
  const win = page(`<a id="a" href="/gaming/"></a><a id="b" href="${FB}/gaming/?ref=x"></a><a id="c" href="/gaming/play/"></a><a id="d" href="/gaming/?x"></a><a id="e" href="/gamingx/"></a>`);
  assert.deepEqual([...win.document.querySelectorAll(section('/gaming/'))].map((a) => a.id), ['a', 'b', 'd']);
});

test('Hide tabs takes the noisy tabs and Find friends by default, and Home never', () => {
  const win = page();
  assert.deepEqual(hiddenBy(win, tabsCss(settings(tabDefaults))), ['find-friends', 'tab:Gaming', 'tab:Marketplace', 'tab:Video']);
  const all = { ...tabDefaults, 'hideTabs.friends': true, 'hideTabs.groups': true };
  assert.deepEqual(hiddenBy(win, hideTabs.css(settings(all))),
    ['find-friends', 'tab:Friends', 'tab:Gaming', 'tab:Groups', 'tab:Marketplace', 'tab:Video']);
  const none = Object.fromEntries(Object.keys(tabDefaults).map((key) => [key, false]));
  assert.equal(tabsCss(settings(none)), '');
  // The left column's own Friends, Groups and Marketplace rows stay.
  assert.ok(!hiddenBy(win, hideTabs.css(settings(all))).some((row) => row.startsWith('left:')));
});

test('Hide Menu promotions takes ad tools and gaming out of the left column and the menu', () => {
  const win = page();
  const both = settings({ 'hideMenuPromotions.ads': true, 'hideMenuPromotions.gaming': true });
  assert.deepEqual(hiddenBy(win, promotionsCss(both)), [
    'left:Ads Manager', 'left:Gaming Video', 'left:Play games',
    'menu:Ad', 'menu:Ads Manager', 'menu:Play games', 'menu:Your Ad Activity',
  ]);
  assert.deepEqual(hiddenBy(win, hideMenuPromotions.css(settings({ 'hideMenuPromotions.ads': false, 'hideMenuPromotions.gaming': true }))),
    ['left:Gaming Video', 'left:Play games', 'menu:Play games']);
  assert.equal(promotionsCss(settings({})), '');
});

test('Hide Meta upsells takes Meta\'s other apps out, never a post\'s links or Messenger', () => {
  const win = page();
  assert.equal(hideMetaUpsells.css, UPSELLS_CSS);
  assert.deepEqual(hiddenBy(win, UPSELLS_CSS), [
    'left:Messenger Kids', 'left:Meta AI', 'left:Meta Quest 3S', 'left:Ray-Ban Meta',
    'menu:Instagram', 'menu:Messenger Kids', 'menu:Meta AI', 'menu:WhatsApp',
  ]);
});

test('the left column is told from the top bar by its absolute addresses', () => {
  // A top bar whose tab list links Friends and Groups and a gaming tab: Hide Menu promotions
  // leaves its tabs alone, that's Hide tabs' job.
  const win = page();
  const hidden = hiddenBy(win, promotionsCss(settings({ 'hideMenuPromotions.gaming': true })));
  assert.ok(!hidden.includes('tab:Gaming'));
  // happy-dom ignores a descendant selector inside :not(), so this part is checked as text.
  // Chrome honors it (live 2026-10-11), which keeps a top bar with absolute links out too.
  assert.ok(LEFT.startsWith('[role="navigation"]:not([role="banner"] *):has('));
});

test('on web.facebook.com the absolute links carry that host, and every switch still finds its rows', () => {
  const win = page(HOME.replaceAll(FB, 'https://web.facebook.com'));
  const both = settings({ 'hideMenuPromotions.ads': true, 'hideMenuPromotions.gaming': true });
  assert.deepEqual(hiddenBy(win, promotionsCss(both)), [
    'left:Ads Manager', 'left:Gaming Video', 'left:Play games',
    'menu:Ad', 'menu:Ads Manager', 'menu:Play games', 'menu:Your Ad Activity',
  ]);
  assert.deepEqual(hiddenBy(win, UPSELLS_CSS), [
    'left:Messenger Kids', 'left:Meta AI', 'left:Meta Quest 3S', 'left:Ray-Ban Meta',
    'menu:Instagram', 'menu:Messenger Kids', 'menu:Meta AI', 'menu:WhatsApp',
  ]);
});

test('a count drawn as a badge is marked, a name that is a number is not', () => {
  const win = page();
  const doc = win.document;
  assert.equal(markBadges(doc), 3);
  const marked = [...doc.querySelectorAll(`[${BADGE_MARK}]`)].map((el) => el.className);
  assert.deepEqual(marked.sort(), ['bell-badge', 'row-badge', 'tab-badge']);
  // The tab and the bell button themselves stay.
  assert.equal(doc.querySelector('[aria-label="Friends"]').hasAttribute(BADGE_MARK), false);
  assert.equal(doc.querySelector('[aria-label="Notifications"]').hasAttribute(BADGE_MARK), false);
  // The group called 42.
  const name = [...doc.querySelectorAll('span')].find((span) => span.textContent === '42');
  assert.equal(badgeBox(name), null);
  assert.equal(markBadges(doc), 0, 'marked once');
});

test('counts outside the top bar and navigation are left alone', () => {
  const win = page('<div role="main"><span style="position:absolute;background-color:red">5</span></div>');
  assert.equal(markBadges(win.document), 0);
});

test('the title loses its count, whatever Facebook puts after it', () => {
  assert.equal(cleanTitle('(3) Facebook'), 'Facebook');
  assert.equal(cleanTitle('(99+) Pat Example | Facebook'), 'Pat Example | Facebook');
  assert.equal(cleanTitle('Facebook'), 'Facebook');
  assert.equal(cleanTitle('(2024) Recap | Facebook'), '(2024) Recap | Facebook', 'four digits is a name, not a count');
  assert.equal(cleanTitle('Pat (3) | Facebook'), 'Pat (3) | Facebook');
});

test('the badge hider fixes the title as Facebook changes it and scans new counts', async () => {
  const win = page();
  const doc = win.document;
  doc.title = '(1) Facebook';
  let on = true;
  const hider = createBadgeHider({ doc, enabled: () => on, delay: 5 });
  hider.apply();
  assert.equal(doc.title, 'Facebook');
  doc.title = '(4) Facebook';
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(doc.title, 'Facebook');
  // A new count on the Groups tab.
  doc.querySelector('[aria-label="Groups"]').insertAdjacentHTML('beforeend', '<span class="new-badge" style="position:absolute"><span>2</span></span>');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(doc.querySelector('.new-badge').hasAttribute(BADGE_MARK));
  assert.equal(hider.state().hidden, 4);
  on = false;
  hider.apply();
  assert.equal(doc.querySelector(`[${BADGE_MARK}]`), null);
  doc.title = '(5) Facebook';
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(doc.title, '(5) Facebook', 'off means Facebook\'s title again');
});

test('the badge switch hides only what it marked', () => {
  assert.equal(hideTabBadges.css, `[${BADGE_MARK}] { display: none !important; }`);
});

test('every Declutter switch is off by default and works in content mode', () => {
  for (const feature of [hideTabs, hideTabBadges, hideMenuPromotions, hideMetaUpsells]) {
    assert.equal(feature.default, false, feature.id);
    assert.ok(!feature.needsPage, feature.id);
  }
});
