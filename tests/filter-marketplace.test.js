// Filter Marketplace listings against the scrubbed captures of 2026-11-03: a search answer
// (marketplace-search.jsonl, three listings marked SHIPPING_ONSITE, two ads), Marketplace home's
// inline Today's picks (marketplace-picks.jsonl, one of twenty marked SHIPPING_ONSITE) and the
// streamed home feed (MarketplaceCometBrowseFeedLightPaginationQuery.jsonl).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import feature, { decimalMark, edgeListing, MAX_OPENED, OPENED_KEY, priceLimit } from '../src/features/marketplace/filter-marketplace.js';
import { LISTING_CSS, LISTING_MARK, listingPage, watchListingCards } from '../src/features/marketplace/listing-cards.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import { parseRoute } from '../src/core/route.js';
import { createMemoryStorage } from '../src/core/storage.js';

const SEARCH = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'MarketplaceSearchQuery' };
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// The feature's rule with these settings (keys without the feature's prefix are other features').
// With a page, doc and router are its document and router, and subscribe hears settings changes.
function setup(values = {}, { doc, router, subscribe, storage } = {}) {
  const store = new Map(Object.entries(values));
  const settings = { get: (key) => store.get(key), subscribe };
  const option = (key) => store.get(`filterMarketplace.${key}`);
  const rules = [];
  const diagnostics = createDiagnostics();
  const actions = new Map();
  const toasts = [];
  feature.setup({
    doc, router, net: { transformResponses: (rule) => rules.push(rule) }, settings, storage, diagnostics, enabled: () => true, option,
    toast: (message) => toasts.push(message), actions: { add: (label, run) => actions.set(label, run) },
  });
  assert.equal(rules.length, 1);
  const row = (label) => diagnostics.rows().find((r) => r.label === label)?.value;
  return { rule: rules[0], store, diagnostics, row, actions, toasts, filtered: () => row('Marketplace listings filtered out') };
}

// A Marketplace page whose router tells listeners about every move, and the results grid of the
// search capture's listings.
function marketplacePage(href, listings) {
  const win = testWindow(href);
  windows.push(win);
  const doc = win.document;
  doc.body.innerHTML = `<div role="main"><div class="grid">${listings.map((listing) => `<div class="cell" data-id="${listing.id}">
    <a href="/marketplace/item/${listing.id}/?ref=search"><span>${listing.marketplace_listing_title}</span></a></div>`).join('')}</div></div>`;
  let at = href;
  const listeners = [];
  const router = { current: () => parseRoute(at), subscribe: (fn) => listeners.push(fn) };
  const go = (to) => {
    at = to;
    for (const fn of listeners) fn();
  };
  const marked = () => [...doc.querySelectorAll(`[${LISTING_MARK}]`)].map((el) => el.dataset.id);
  return { doc, router, go, marked };
}

const SEARCH_PAGE = 'https://www.facebook.com/marketplace/search/?query=case';
const itemPage = (id) => `https://www.facebook.com/marketplace/item/${id}/?ref=search`;

const searchEdges = (doc) => doc.data.marketplace_search.feed_units.edges;
const listingOf = (edge) => edge.node?.listing;
const shipsOnsite = (listing) => listing.delivery_types.includes('SHIPPING_ONSITE');

test('the search answer loses exactly its Ships to you listings, and its ads and cursors stay', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const before = searchEdges(parseLine(line));
  const listings = before.filter((edge) => edge.node?.__typename === 'MarketplaceFeedListingStoryObject');
  const shipped = listings.filter((edge) => shipsOnsite(listingOf(edge))).map((edge) => listingOf(edge).id);
  assert.equal(shipped.length, 3, 'the capture has three');
  const { rule, filtered, diagnostics } = setup({ 'filterMarketplace.shipped': true });
  const doc = parseLine(line);
  assert.equal(rule.transform(doc, SEARCH), true);
  const after = searchEdges(doc);
  assert.equal(after.length, before.length, 'every edge keeps its place');
  const left = after.filter((edge) => edge.node).map((edge) => edge.node.listing?.id ?? edge.node.__typename);
  for (const id of shipped) assert.ok(!left.includes(id), 'a shipped listing went');
  assert.equal(after.filter((edge) => !edge.node).length, 3, 'nothing else went');
  assert.equal(after.filter((edge) => edge.node?.__typename === 'MarketplaceFeedAdStory').length, 2, 'ads are left to Hide sponsored Marketplace listings');
  assert.ok(after.every((edge, i) => edge.cursor === before[i].cursor), 'cursors stay');
  assert.equal(filtered(), '3 ships to you');
  assert.deepEqual(diagnostics.decisions().map((d) => [d.signal, d.layer]), Array(3).fill(['shipped', 'data']));
});

test("Today's picks loses its Ships to you listing in the page's own data, and the rest keep their order", async () => {
  const [line] = await fixtureLines('marketplace-picks.jsonl');
  const picks = (doc) => {
    let found = null;
    JSON.stringify(doc, (key, value) => {
      if (value?.__typename === 'MarketplaceFeedTopPicksUnit') found = value.marketplace_listings;
      return value;
    });
    return found;
  };
  const before = picks(parseLine(line));
  assert.equal(before.length, 20);
  const kept = before.filter((listing) => !shipsOnsite(listing)).map((listing) => listing.id);
  assert.equal(kept.length, 19, 'the capture has one');
  const win = { JSON: { parse: JSON.parse }, location: { href: 'https://www.facebook.com/marketplace/' } };
  const net = installNetworkHooks({ win, log: quiet });
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': true });
  net.transformResponses(rule);
  assert.deepEqual(picks(win.JSON.parse(line)).map((listing) => listing.id), kept);
  assert.equal(filtered(), '1 ships to you');
});

test("the streamed home feed's prices are in cents, and a price range takes out what's outside it", async () => {
  const lines = await fixtureLines('MarketplaceCometBrowseFeedLightPaginationQuery.jsonl');
  const generals = [];
  for (const line of lines) {
    JSON.stringify(parseLine(line), (key, value) => {
      if (value?.__typename === 'MarketplaceFeedGeneralListingObject') generals.push(value);
      return value;
    });
  }
  assert.equal(generals.length, 3);
  const dollars = generals.map((node) => Number(node.data.price.amount_with_offset) / 100);
  assert.deepEqual(generals.map((node) => edgeListing({ node }).price), dollars);
  const cheapest = Math.min(...dollars);
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.minPrice': String(cheapest + 0.01) });
  let gone = 0;
  for (const line of lines) {
    const doc = parseLine(line);
    const had = JSON.stringify(doc).includes('"MarketplaceFeedGeneralListingObject"');
    rule.transform(doc, SEARCH);
    if (had && !JSON.stringify(doc).includes('"MarketplaceFeedGeneralListingObject"')) {
      gone++;
      // A streamed chunk is the edge itself ({data: {node, cursor}, path}).
      if (doc.path) assert.ok('cursor' in doc.data && !('node' in doc.data), 'the chunk keeps its cursor');
    }
  }
  assert.equal(gone, dollars.filter((price) => price === cheapest).length);
  assert.match(filtered(), /^\d+ outside the price range$/);
});

test('a currency Facebook counts in whole units is read as it is', () => {
  const node = { __typename: 'MarketplaceFeedGeneralListingObject', data: { title: 't', price: { amount_with_offset: '5000', currency: 'JPY' } }, listing: { __typename: 'GroupCommerceProductItem', id: '1' } };
  assert.equal(edgeListing({ node }).price, 5000);
  node.data.price.currency = 'USD';
  assert.equal(edgeListing({ node }).price, 50);
});

test("a store's listings count as shipped, by type, by flag or by offsite shipping", () => {
  const story = (listing) => ({ node: { __typename: 'MarketplaceFeedListingStory', listing: { id: '1', ...listing } } });
  assert.equal(edgeListing(story({ __typename: 'ProductItem', delivery_types: [] })).shipped, true);
  assert.equal(edgeListing(story({ __typename: 'GroupCommerceProductItem', delivery_types: ['SHIPPING_OFFSITE'] })).shipped, true);
  assert.equal(edgeListing(story({ __typename: 'GroupCommerceProductItem', delivery_types: ['IN_PERSON', 'DOOR_PICKUP', 'DOOR_DROPOFF', 'PUBLIC_MEETUP'] })).shipped, false);
  const general = (extra) => ({ node: { __typename: 'MarketplaceFeedGeneralListingObject', data: { title: 't' }, listing: { __typename: 'GroupCommerceProductItem', id: '1' }, ...extra } });
  assert.equal(edgeListing(general({ is_partner_listing: true })).shipped, true);
  assert.equal(edgeListing(general({ is_partner_listing: false })).shipped, false);
  assert.equal(edgeListing({ node: { __typename: 'MarketplaceFeedAdStory', id: 'ad' } }), null, 'ads are not listings here');
});

test('the word list matches titles and sellers, the people list sellers only, and always-show sellers stay', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const [first] = listings;
  const word = first.marketplace_listing_title.split(' ')[0];
  const seller = first.marketplace_listing_seller.name;
  const ids = (doc) => searchEdges(doc).map(listingOf).filter(Boolean).map((listing) => listing.id);
  const run = (values) => {
    const { rule, filtered } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.words': true, ...values });
    const doc = parseLine(line);
    rule.transform(doc, SEARCH);
    return { left: ids(doc), filtered: filtered() };
  };
  const byWord = listings.filter((listing) => new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, 'iu').test(`${listing.marketplace_listing_title}\n${listing.marketplace_listing_seller.name}`));
  const words = run({ 'hidePostsByWords.words': word });
  assert.ok(byWord.length >= 1);
  assert.deepEqual(words.left, listings.filter((listing) => !byWord.includes(listing)).map((listing) => listing.id));
  assert.equal(words.filtered, `${byWord.length} on the word list`);

  const bySeller = listings.filter((listing) => listing.marketplace_listing_seller.name === seller);
  const people = run({ 'hidePostsByWords.people': seller });
  assert.deepEqual(people.left, listings.filter((listing) => !bySeller.includes(listing)).map((listing) => listing.id));
  assert.equal(people.filtered, `${bySeller.length} seller on the people list`);

  const shown = run({ 'hidePostsByWords.people': seller, 'hidePostsByWords.words': word, 'hidePostsByWords.showPeople': seller.toUpperCase() });
  for (const listing of bySeller) assert.ok(shown.left.includes(listing.id), 'an always-show seller keeps their listings');

  const off = run({ 'filterMarketplace.words': false, 'hidePostsByWords.people': seller, 'hidePostsByWords.words': word });
  assert.equal(off.left.length, listings.length, 'the lists only count with the option on');
});

test('price boxes take spaces, commas and a currency sign, and a range typed backwards still works', () => {
  assert.equal(priceLimit(''), null);
  assert.equal(priceLimit('   '), null);
  assert.equal(priceLimit(' 1,200 ', '.'), 1200);
  assert.equal(priceLimit('$50'), 50);
  assert.equal(priceLimit('€12.50'), 12.5);
  assert.ok(Number.isNaN(priceLimit('cheap')));
  assert.ok(Number.isNaN(priceLimit('1.2.3')));
  const story = (id, amount) => ({ cursor: id, node: { __typename: 'MarketplaceFeedListingStoryObject', listing: { __typename: 'GroupCommerceProductItem', id, marketplace_listing_title: 't', listing_price: { amount }, delivery_types: ['IN_PERSON'] } } });
  const doc = () => ({ data: { marketplace_search: { feed_units: { edges: [story('a', '5.00'), story('b', '50.00'), story('c', '500.00'), story('d', null)] } } } });
  const left = (values) => {
    const { rule } = setup({ 'filterMarketplace.shipped': false, ...values });
    const d = doc();
    rule.transform(d, SEARCH);
    return searchEdges(d).filter((edge) => edge.node).map((edge) => edge.cursor);
  };
  assert.deepEqual(left({ 'filterMarketplace.minPrice': '10', 'filterMarketplace.maxPrice': '100' }), ['b', 'd'], 'a listing with no price stays');
  assert.deepEqual(left({ 'filterMarketplace.minPrice': '100', 'filterMarketplace.maxPrice': '10' }), ['b', 'd']);
  assert.deepEqual(left({ 'filterMarketplace.maxPrice': 'cheap' }), ['a', 'b', 'c', 'd'], "a box that isn't a price is no limit");
  assert.deepEqual(left({ 'filterMarketplace.minPrice': '0', 'filterMarketplace.maxPrice': '0' }), ['d'], 'free only');
  assert.deepEqual(left({ 'filterMarketplace.minPrice': '50', 'filterMarketplace.maxPrice': '50' }), ['b', 'd'], 'a price right on a limit stays');
});

test("price boxes read decimal commas too, and a lone mark before three digits goes by the browser's language", () => {
  assert.equal(priceLimit('12,50'), 12.5);
  assert.equal(priceLimit('1 000,00 €'), 1000);
  assert.equal(priceLimit('1.234,56'), 1234.56);
  assert.equal(priceLimit('1,234.56'), 1234.56);
  assert.equal(priceLimit('1.000.000'), 1000000);
  assert.equal(priceLimit('1,00,000'), 100000, 'lakhs');
  assert.equal(priceLimit("1'000"), 1000);
  assert.equal(priceLimit('.99'), 0.99);
  assert.equal(priceLimit('1.000', ','), 1000);
  assert.equal(priceLimit('1,000', ','), 1);
  assert.equal(priceLimit('1.000', '.'), 1);
  assert.equal(priceLimit('1,000', '.'), 1000);
  assert.equal(priceLimit('1234,567', '.'), 1234.567, 'no thousands mark comes after four digits');
  for (const bad of ['5.', '1,2,3', '1,2,345', '1,2345,678', '1.2,5', '1,234,5', '1,2.345', ',', '-5', '1e5']) assert.ok(Number.isNaN(priceLimit(bad)), bad);
  assert.equal(decimalMark('de-DE'), ',');
  assert.equal(decimalMark('en-US'), '.');
  const own = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const language = (tag) => Object.defineProperty(globalThis, 'navigator', { value: { language: tag }, configurable: true });
  try {
    language('de-DE');
    assert.deepEqual([priceLimit('1.000'), priceLimit('1,000')], [1000, 1]);
    language('en-US');
    assert.deepEqual([priceLimit('1.000'), priceLimit('1,000')], [1, 1000]);
  } finally {
    Object.defineProperty(globalThis, 'navigator', own);
  }
});

test('a listing fetched on its own, with no feed edge around it, stays whole', () => {
  const listing = { __typename: 'GroupCommerceProductItem', id: '1', marketplace_listing_title: 't', delivery_types: ['SHIPPING_ONSITE'] };
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': true });
  const single = { data: { node: { __typename: 'MarketplaceFeedListingStory', listing } } };
  assert.equal(rule.transform(single, SEARCH), false);
  assert.ok(single.data.node, 'node() answers keep their listing');
  const edge = { data: { node: { __typename: 'MarketplaceFeedListingStory', listing }, cursor: 'c' }, path: ['viewer', 'edges', 0] };
  assert.equal(rule.transform(edge, SEARCH), true, 'a streamed edge still goes');
  assert.ok(!('node' in edge.data));
  assert.equal(filtered(), '1 ships to you');
});

// Search results Facebook drew on the server come in the page's inline blob ({data, extensions}),
// and React throws #418 when one is missing from it (live 2026-11-03). They stay in the data and
// their cards are hidden on the page.
test('server-drawn search listings stay in the data and their cards are hidden on the page', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const shipped = listings.filter(shipsOnsite).map((listing) => listing.id);
  const win = testWindow('https://www.facebook.com/marketplace/search/?query=case');
  windows.push(win);
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'marketplace';
  doc.body.innerHTML = `<div role="navigation"><a href="/marketplace/item/${shipped[0]}/">Recently viewed</a></div>
    <div role="main"><div><h2>Results</h2><div class="grid">${listings.map((listing) => `<div class="cell" data-id="${listing.id}"><div>
    <a href="/marketplace/item/${listing.id}/?ref=search"><div><img alt=""></div><span>${listing.marketplace_listing_title}</span></a></div></div>`).join('')}</div></div></div>`;
  const listeners = [];
  const router = { current: () => parseRoute(win.location.href), subscribe: (fn) => listeners.push(fn) };
  const { rule, store, diagnostics, filtered } = setup({ 'filterMarketplace.shipped': true }, { doc, router, subscribe: (fn) => listeners.push(fn) });
  const data = parseLine(line);
  assert.equal(rule.transform(data, { transport: 'json-parse', path: '/marketplace/search/' }), false, 'nothing leaves the data');
  assert.deepEqual(data, parseLine(line));
  await tick();
  const marked = () => [...doc.querySelectorAll(`[${LISTING_MARK}]`)].map((el) => el.dataset.id);
  assert.deepEqual(marked(), shipped, 'each shipped card, the whole cell, and nothing else');
  assert.equal(doc.querySelector('[role="navigation"] a').closest(`[${LISTING_MARK}]`), null, 'links outside the results stay');
  assert.equal(filtered(), '3 ships to you');
  assert.deepEqual(diagnostics.decisions().map((d) => [d.signal, d.layer]), Array(3).fill(['shipped', 'page']));

  const style = doc.createElement('style');
  style.textContent = LISTING_CSS;
  doc.head.append(style);
  assert.equal(win.getComputedStyle(doc.querySelector(`[${LISTING_MARK}]`)).display, 'none');

  store.set('filterMarketplace.shipped', false);
  for (const fn of listeners) fn();
  assert.deepEqual(marked(), [], 'the cards come back when the option goes off');
  store.set('filterMarketplace.shipped', true);
  for (const fn of listeners) fn();
  assert.deepEqual(marked(), shipped);
  assert.equal(filtered(), '3 ships to you', 'each listing counts once');

  // A card reused for another listing keeps its element and gets the other listing's link, with
  // nothing added to the page.
  await tick();
  const local = listings.find((listing) => !shipsOnsite(listing)).id;
  const cell = (id) => doc.querySelector(`.cell[data-id="${id}"]`);
  const [first] = shipped;
  cell(first).querySelector('a').setAttribute('href', `/marketplace/item/${local}/?ref=search`);
  cell(local).querySelector('a').setAttribute('href', `/marketplace/item/${first}/?ref=search`);
  await tick();
  assert.ok(!cell(first).hasAttribute(LISTING_MARK), 'the card now showing a local listing comes back');
  assert.ok(cell(local).hasAttribute(LISTING_MARK), 'the card now showing the shipped one goes');

  // A listing's own page shows its seller's other listings, and the one you opened isn't a card.
  assert.equal(listingPage(parseRoute('https://www.facebook.com/marketplace/item/1/')), false);
  assert.equal(listingPage(parseRoute('https://www.facebook.com/marketplace/category/vehicles')), true);

  // The same answer by GraphQL, a later page of results, leaves the data as before.
  const fetched = parseLine(line);
  assert.equal(rule.transform(fetched, SEARCH), true);
  assert.equal(searchEdges(fetched).filter((edge) => !edge.node).length, 3);

  // A search with one result: nothing tells its card from the page around it, so it stays.
  const [only] = shipped;
  doc.body.innerHTML = `<div role="navigation"><a href="/marketplace/item/${local}/">Recently viewed</a></div>
    <div role="main"><div><h2>Results</h2><div class="grid"><div class="cell" data-id="${only}"><a href="/marketplace/item/${only}/">x</a></div></div></div></div>`;
  await tick();
  assert.deepEqual(marked(), [], 'neither the results nor the page go');
});

test("a listing's own page keeps the seller's other listings, whatever they are", async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const { doc, router, marked } = marketplacePage(itemPage(listings[0].id), listings);
  const { rule } = setup({ 'filterMarketplace.shipped': true }, { doc, router });
  assert.equal(rule.transform(parseLine(line), { transport: 'json-parse', path: `/marketplace/item/${listings[0].id}/` }), false);
  await tick();
  assert.deepEqual(marked(), []);
});

test('a hidden card reused for another listing hidden for the same reason counts that one too', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const shipped = listings.filter(shipsOnsite).map((listing) => listing.id);
  const last = shipped.at(-1);
  const { doc, router } = marketplacePage(SEARCH_PAGE, listings.filter((listing) => listing.id !== last));
  const { rule, filtered, diagnostics } = setup({ 'filterMarketplace.shipped': true }, { doc, router });
  rule.transform(parseLine(line), { transport: 'json-parse', path: '/marketplace/search/' });
  await tick();
  assert.equal(filtered(), '2 ships to you', 'the third has no card yet');
  doc.querySelector(`[${LISTING_MARK}] a`).setAttribute('href', `/marketplace/item/${last}/?ref=search`);
  await tick();
  assert.equal(filtered(), '3 ships to you');
  assert.equal(new Set(diagnostics.decisions().map((d) => d.post)).size, 3, 'one decision each');
});

test('the card watcher tells about a card once for each listing it hides there', async () => {
  const { doc, router } = marketplacePage(SEARCH_PAGE, ['1', '2', '3'].map((id) => ({ id, marketplace_listing_title: id })));
  const heard = [];
  const cards = watchListingCards({ doc, route: () => router.current(), active: () => true, reasonOf: (id) => (id === '2' ? null : 'shipped'), onHidden: (id, reason) => heard.push(`${id} ${reason}`) });
  cards.check();
  await tick();
  assert.deepEqual(heard, ['1 shipped', '3 shipped']);
  doc.querySelector('[data-id="1"] a').setAttribute('href', '/marketplace/item/4/');
  cards.check();
  await tick();
  assert.deepEqual(heard, ['1 shipped', '3 shipped', '4 shipped']);
  cards.stop();
});

test("a listing id longer than the saved list takes isn't kept, so the list still saves", () => {
  const storage = createMemoryStorage();
  const { router, go } = marketplacePage('https://www.facebook.com/marketplace/', []);
  setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.opened': true }, { router, storage, subscribe: (fn) => router.subscribe(fn) });
  go(itemPage('1'.repeat(33)));
  assert.equal(storage.get(OPENED_KEY), undefined);
  go(itemPage('2'.repeat(32)));
  assert.deepEqual(Object.keys(storage.get(OPENED_KEY)), ['2'.repeat(32)]);
});

test('a listing page you open is kept while the option is on, the latest MAX_OPENED at most', () => {
  const storage = createMemoryStorage();
  const { router, go } = marketplacePage('https://www.facebook.com/marketplace/', []);
  const { store, row } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.opened': true }, { router, storage, subscribe: (fn) => router.subscribe(fn) });
  const kept = () => Object.keys(storage.get(OPENED_KEY) ?? {}).sort();
  go(itemPage('1234567890'));
  assert.deepEqual(kept(), ['1234567890']);
  go('https://www.facebook.com/marketplace/category/vehicles');
  go('https://www.facebook.com/groups/3234567890/posts/4234567890/');
  assert.deepEqual(kept(), ['1234567890'], 'only listing pages count');
  store.set('filterMarketplace.opened', false);
  go(itemPage('2234567890'));
  assert.deepEqual(kept(), ['1234567890'], 'nothing is kept with the option off');
  store.set('filterMarketplace.opened', true);
  go(itemPage('2234567890'));
  assert.deepEqual(kept(), ['1234567890', '2234567890']);
  assert.equal(row('Opened listings kept'), '2');

  storage.set(OPENED_KEY, Object.fromEntries(Array.from({ length: MAX_OPENED }, (_, i) => [String(1000000 + i), i + 1])));
  go(itemPage('1000000'));
  go(itemPage('9999999'));
  const all = storage.get(OPENED_KEY);
  assert.equal(Object.keys(all).length, MAX_OPENED);
  assert.ok(Object.hasOwn(all, '1000000'), 'opening one again makes it the latest');
  assert.ok(!Object.hasOwn(all, '1000001'), 'the one opened longest ago goes');
  assert.ok(Object.hasOwn(all, '9999999'));
});

test("a listing you opened goes the next time the results load, and the one you just opened stays put until then", async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const [earlier, now] = listings.filter((listing) => !shipsOnsite(listing));
  const storage = createMemoryStorage({ [OPENED_KEY]: { [earlier.id]: 1 } });
  const values = { 'filterMarketplace.shipped': false, 'filterMarketplace.opened': true };
  const inline = { transport: 'json-parse', path: '/marketplace/search/' };

  const off = parseLine(line);
  setup({ 'filterMarketplace.shipped': true, 'filterMarketplace.opened': false }, { storage }).rule.transform(off, SEARCH);
  assert.ok(searchEdges(off).some((edge) => listingOf(edge)?.id === earlier.id), 'with the option off an opened listing stays');

  const page = marketplacePage(SEARCH_PAGE, listings);
  const { rule, filtered } = setup(values, { doc: page.doc, router: page.router, storage });
  assert.equal(rule.transform(parseLine(line), inline), false, 'drawn on the server, so it stays in the data');
  await tick();
  assert.deepEqual(page.marked(), [earlier.id]);
  assert.equal(filtered(), '1 opened before');
  const fetched = parseLine(line);
  assert.equal(rule.transform(fetched, SEARCH), true);
  assert.equal(searchEdges(fetched).filter((edge) => !edge.node).length, 1, 'a later page leaves it out of the data');

  page.go(itemPage(now.id));
  page.go(SEARCH_PAGE);
  assert.ok(Object.hasOwn(storage.get(OPENED_KEY), now.id));
  assert.deepEqual(page.marked(), [earlier.id], 'the listing you came back from is still there');

  const next = marketplacePage(SEARCH_PAGE, listings);
  const reloaded = setup(values, { doc: next.doc, router: next.router, storage });
  reloaded.rule.transform(parseLine(line), inline);
  await tick();
  assert.deepEqual(next.marked().sort(), [earlier.id, now.id].sort(), 'on the next load both go');

  await reloaded.actions.get('Forget opened listings')();
  assert.equal(storage.get(OPENED_KEY), undefined);
  assert.deepEqual(next.marked(), [], 'forgetting brings them back');
  assert.deepEqual(reloaded.toasts, ['Forgot every opened listing']);
  assert.equal(reloaded.row('Opened listings kept'), '0');
});

test("nothing is kept before the extension's saved list loads, and cards drawn before then follow it once it does", async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const listings = searchEdges(parseLine(line)).map(listingOf).filter(Boolean);
  const [earlier, now] = listings;
  const memory = createMemoryStorage();
  const waiting = [];
  const storage = { ...memory, whenReady: (run) => waiting.push(run) };
  const page = marketplacePage(SEARCH_PAGE, listings);
  const { rule } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.opened': true }, { doc: page.doc, router: page.router, storage });
  rule.transform(parseLine(line), { transport: 'json-parse', path: '/marketplace/search/' });
  await tick();
  assert.deepEqual(page.marked(), []);
  page.go(itemPage(now.id));
  assert.equal(memory.get(OPENED_KEY), undefined, 'a write now would replace the saved list');

  memory.set(OPENED_KEY, { [earlier.id]: 1 });
  for (const run of waiting.splice(0)) run();
  assert.deepEqual(Object.keys(memory.get(OPENED_KEY)).sort(), [earlier.id, now.id].sort(), 'the page you were on is kept with the rest');
  page.go(SEARCH_PAGE);
  assert.deepEqual(page.marked(), [earlier.id]);
});

test('with every option off the rule leaves the answer alone', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.words': false, 'hidePostsByWords.words': 'a' });
  const doc = parseLine(line);
  assert.equal(rule.transform(doc, SEARCH), false);
  assert.deepEqual(doc, parseLine(line));
  assert.equal(filtered(), 'None yet');
});
