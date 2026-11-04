// Hide sponsored Marketplace listings against the scrubbed search capture of 2026-11-03
// (marketplace-search.jsonl, two MarketplaceFeedAdStory edges among the listings). Live that
// day, a category's inline answer carried drawn ads the same way, and dropping them threw #418.
// The grid below is shaped like the live one: flat, an empty spacer after each cell, and each ad
// a cell with links to l.facebook.com and /ads/about/, no listing link and no Sponsored text.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import feature from '../src/features/marketplace/hide-sponsored-marketplace.js';
import filterMarketplace from '../src/features/marketplace/filter-marketplace.js';
import { AD_CSS, AD_MARK, LISTING_MARK } from '../src/features/marketplace/listing-cards.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { parseRoute } from '../src/core/route.js';

const INLINE = { transport: 'json-parse', path: '/marketplace/search/' };
const SEARCH = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'MarketplaceSearchQuery' };
const AD = 'MarketplaceFeedAdStory';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const searchEdges = (doc) => doc.data.marketplace_search.feed_units.edges;

const listingCell = (id) => `<div class="cell" data-cell="${id}"><div><a href="/marketplace/item/${id}/?ref=search"><div><img alt=""></div><span>A listing</span></a></div></div>`;
const adCell = (n) => `<div class="cell" data-cell="ad${n}"><div><div><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F"><video></video></a></div>
  <div><span>Shop</span><a href="https://www.facebook.com/ads/about/?entry_product=ad_preferences"><svg></svg></a></div></div></div>`;

// A results page drawn from the capture's edges, and the feature set up on it with the switch's
// state in on. Settings listeners are in listeners.
async function resultsPage(href = 'https://www.facebook.com/marketplace/search/?query=case') {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const edges = searchEdges(parseLine(line));
  const win = testWindow(href);
  windows.push(win);
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'marketplace';
  let ads = 0;
  const cells = edges.map((edge) => (edge.node?.__typename === AD ? adCell(++ads) : listingCell(edge.node.listing.id)));
  doc.body.innerHTML = `<div role="navigation"><a href="https://www.facebook.com/ads/about/">About ads</a></div>
    <div role="main"><div><h2>Results</h2><div class="grid">${cells.map((cell) => `${cell}<div class="spacer"></div>`).join('')}</div></div></div>`;
  const listeners = [];
  const routes = [];
  const router = { current: () => parseRoute(win.location.href), subscribe: (fn) => routes.push(fn) };
  const on = { value: true };
  const rules = [];
  const diagnostics = createDiagnostics();
  feature.setup({
    doc, router, net: { transformResponses: (rule) => rules.push(rule) }, settings: { subscribe: (fn) => listeners.push(fn) }, enabled: () => on.value, diagnostics,
  });
  assert.equal(rules.length, 1);
  const marked = () => [...doc.querySelectorAll(`[${AD_MARK}]`)].map((el) => el.dataset.cell);
  const changed = () => {
    for (const fn of listeners) fn();
  };
  return { line, win, doc, router, rule: rules[0], on, diagnostics, marked, changed, routes, ads };
}

test('ads Facebook drew on the server stay in the data and their cells are hidden on the page', async () => {
  const { line, win, doc, rule, on, diagnostics, marked, changed, ads } = await resultsPage();
  assert.equal(ads, 2, 'the capture has two');
  await tick();
  assert.deepEqual(marked(), [], 'nothing goes before an answer brings drawn ads');

  const data = parseLine(line);
  assert.equal(rule.transform(data, INLINE), false, 'nothing leaves the data');
  assert.deepEqual(data, parseLine(line));
  await tick();
  assert.deepEqual(marked(), ['ad1', 'ad2'], 'each ad cell, the whole cell, and nothing else');
  assert.equal(doc.querySelector('[role="navigation"] a').closest(`[${AD_MARK}]`), null, 'a link outside the results stays');
  assert.deepEqual(diagnostics.decisions().map((d) => [d.rule, d.signal, d.layer]), Array(2).fill(['Sponsored listing', AD, 'page']));

  assert.equal(feature.css, AD_CSS);
  const style = doc.createElement('style');
  style.textContent = AD_CSS;
  doc.head.append(style);
  assert.equal(win.getComputedStyle(doc.querySelector(`[${AD_MARK}]`)).display, 'none');
  assert.notEqual(win.getComputedStyle(doc.querySelector('[data-cell]:not([data-cell^="ad"])')).display, 'none');

  on.value = false;
  changed();
  assert.deepEqual(marked(), [], 'switched off, the ads come back');
  on.value = true;
  changed();
  assert.deepEqual(marked(), ['ad1', 'ad2']);
  assert.equal(diagnostics.decisions().length, 2, 'each cell counts once');

  // A cell Facebook reuses for a listing gets the listing's link in place of the ad's.
  await tick();
  doc.querySelector('[data-cell="ad1"]').innerHTML = '<a href="/marketplace/item/42/">A listing</a>';
  await tick();
  assert.deepEqual(marked(), ['ad2'], 'the cell now showing a listing comes back');

  // The same answer by GraphQL, a later page of results, loses its ads as before.
  const fetched = parseLine(line);
  assert.equal(rule.transform(fetched, SEARCH), true);
  assert.deepEqual(searchEdges(fetched).filter((edge) => !edge.node).length, 2);
  assert.ok(searchEdges(fetched).every((edge) => edge.node?.__typename !== AD));
});

// Live 2026-11-03, a listing's own page draws one ad on the server, in a box under the listing's
// details. The column around it holds the listing's title (h1), and the seller's other listings
// sit below.
test("a listing's own page loses the ad box under its details and keeps the details", async () => {
  const item = await resultsPage('https://www.facebook.com/marketplace/item/1/');
  item.doc.querySelector('[role="main"]').innerHTML = `<div class="page"><div class="detail" data-cell="detail">
    <div class="photos"><img alt=""></div>
    <div class="column" data-cell="column"><h1><span>A listing</span></h1><div><span>$50</span></div><div><a href="/marketplace/profile/5/">Seller</a></div>
      <span data-cell="ad"><div><h2><span><a href="https://www.facebook.com/ads/about/?entry_product=ad_preferences"><svg></svg></a></span></h2></div>
      <div><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F"><img alt=""><video></video></a></div></span>
    </div></div>
    <div class="grid">${listingCell('2')}${listingCell('3')}</div></div>`;
  item.rule.transform(parseLine(item.line), { transport: 'json-parse', path: '/marketplace/item/1/' });
  await tick();
  assert.deepEqual(item.marked(), ['ad'], 'the ad box and nothing else');
  assert.equal(item.doc.querySelector('h1').closest(`[${AD_MARK}]`), null, "the listing's details stay");
});

test('an ad with no listing and no title around it is left alone', async () => {
  const lone = await resultsPage();
  lone.doc.querySelector('[role="main"]').innerHTML = adCell(1);
  lone.rule.transform(parseLine(lone.line), INLINE);
  await tick();
  assert.deepEqual(lone.marked(), [], 'nothing tells the ad from the page around it, so it stays');
});

test('Filter Marketplace listings on the same page keeps its own cards and leaves the ad cells alone', async () => {
  const page = await resultsPage();
  const rules = [];
  filterMarketplace.setup({
    doc: page.doc, router: page.router, net: { transformResponses: (rule) => rules.push(rule) }, settings: { get: () => undefined, subscribe() {} },
    diagnostics: createDiagnostics(), enabled: () => true, option: (key) => key === 'shipped',
  });
  page.rule.transform(parseLine(page.line), INLINE);
  rules[0].transform(parseLine(page.line), INLINE);
  await tick();
  assert.deepEqual(page.marked(), ['ad1', 'ad2']);
  const shipped = [...page.doc.querySelectorAll(`[${LISTING_MARK}]`)];
  assert.equal(shipped.length, 3, "the capture's three Ships to you listings");
  assert.ok(shipped.every((cell) => !cell.dataset.cell.startsWith('ad')));
});

test('moving from a listing page back to the results hides the ads Facebook draws again there', async () => {
  const page = await resultsPage();
  page.rule.transform(parseLine(page.line), INLINE);
  await tick();
  assert.deepEqual(page.marked(), ['ad1', 'ad2']);
  // Back on the results, Facebook draws the cells again from its store, with no new answer.
  page.win.happyDOM.setURL('https://www.facebook.com/marketplace/item/1/');
  for (const fn of page.routes) fn();
  page.win.happyDOM.setURL('https://www.facebook.com/marketplace/search/?query=case');
  const grid = page.doc.querySelector('.grid');
  grid.innerHTML = grid.innerHTML.replaceAll(` ${AD_MARK}="sponsored"`, '');
  for (const fn of page.routes) fn();
  await tick();
  assert.deepEqual(page.marked(), ['ad1', 'ad2']);

  // Off Marketplace, a box with an /ads/about/ link is another switch's business.
  page.win.happyDOM.setURL('https://www.facebook.com/groups/feed/');
  page.doc.querySelector('[role="main"]').innerHTML = `<div><h1>Your feed</h1><div data-cell="post">
    <a href="https://www.facebook.com/ads/about/">About</a><a href="/marketplace/item/7/">A listing in a post</a></div><div data-cell="other"><a href="https://www.facebook.com/ads/about/">About</a></div></div>`;
  for (const fn of page.routes) fn();
  await tick();
  assert.deepEqual(page.marked(), []);
});
