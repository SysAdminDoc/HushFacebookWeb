// Filter Marketplace listings against the scrubbed captures of 2026-11-03: a search answer
// (marketplace-search.jsonl, three listings marked SHIPPING_ONSITE, two ads), Marketplace home's
// inline Today's picks (marketplace-picks.jsonl, one of twenty marked SHIPPING_ONSITE) and the
// streamed home feed (MarketplaceCometBrowseFeedLightPaginationQuery.jsonl).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import feature, { compilePlaces, edgeListing, EMPTY_PAGES, MAX_OPENED, OPENED_KEY, priceLimit, reasonFor } from '../src/features/marketplace/filter-marketplace.js';
import { LISTING_CSS, LISTING_MARK, listingPage, watchListingCards } from '../src/features/marketplace/listing-cards.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { installNetworkHooks } from '../src/core/net/hooks.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
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

// Live 2026-11-05, Today's picks comes in the home's inline answer ({data, extensions}) and is
// drawn on the server: taking its Ships to you listing out of the data threw React #418.
test("Today's picks keeps every listing in the page's own data, and its Ships to you card is hidden on the page", async () => {
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
  const shipped = before.filter(shipsOnsite).map((listing) => listing.id);
  assert.equal(shipped.length, 1, 'the capture has one');
  const { doc, router, marked } = marketplacePage('https://www.facebook.com/marketplace/', before);
  doc.documentElement.dataset.hfwRoute = 'marketplace';
  const win = { JSON: { parse: JSON.parse }, location: { href: 'https://www.facebook.com/marketplace/' } };
  const net = installNetworkHooks({ win, log: quiet });
  const { rule, filtered, diagnostics } = setup({ 'filterMarketplace.shipped': true }, { doc, router });
  net.transformResponses(rule);
  assert.deepEqual(win.JSON.parse(line), parseLine(line), 'nothing leaves the data');
  await tick();
  assert.deepEqual(marked(), shipped, 'its card goes instead');
  assert.equal(filtered(), '1 ships to you');
  assert.deepEqual(diagnostics.decisions().map((d) => [d.signal, d.layer]), [['shipped', 'page']]);

  // The same unit fetched over GraphQL isn't drawn on the server, so its listing leaves the data.
  const fetched = parseLine(line);
  const again = setup({ 'filterMarketplace.shipped': true });
  assert.equal(again.rule.transform(fetched, SEARCH), true);
  assert.deepEqual(picks(fetched).map((listing) => listing.id), before.filter((listing) => !shipsOnsite(listing)).map((listing) => listing.id), 'the rest keep their order');
  assert.equal(again.filtered(), '1 ships to you');
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
  assert.equal(priceLimit(' 1,200 '), 1200);
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

test('price boxes read decimal commas too, and a lone mark before three digits is always thousands', () => {
  assert.equal(priceLimit('12,50'), 12.5);
  assert.equal(priceLimit('1 000,00 €'), 1000);
  assert.equal(priceLimit('1.234,56'), 1234.56);
  assert.equal(priceLimit('1,234.56'), 1234.56);
  assert.equal(priceLimit('1.000.000'), 1000000);
  assert.equal(priceLimit('1,00,000'), 100000, 'lakhs');
  assert.equal(priceLimit("1'000"), 1000);
  assert.equal(priceLimit('.99'), 0.99);
  assert.equal(priceLimit('1234,567'), 1234.567, 'no thousands mark comes after four digits');
  assert.equal(priceLimit('0.500'), 0.5, 'nor after a lone 0');
  assert.equal(priceLimit('0,500'), 0.5);
  for (const bad of ['5.', '1,2,3', '1,2,345', '1,2345,678', '1.2,5', '1,234,5', '1,2.345', ',', '-5', '1e5']) assert.ok(Number.isNaN(priceLimit(bad)), bad);
  // Nobody types a price to three decimal places, and plenty of people write 1.000 on an English
  // browser, so the browser's language doesn't come into it.
  const own = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const language = (tag) => Object.defineProperty(globalThis, 'navigator', { value: { language: tag }, configurable: true });
  try {
    for (const tag of ['de-DE', 'en-GB', 'en-US']) {
      language(tag);
      assert.deepEqual([priceLimit('1.000'), priceLimit('1,000'), priceLimit('€ 2.500'), priceLimit('15.000')], [1000, 1000, 2500, 15000], tag);
    }
  } finally {
    Object.defineProperty(globalThis, 'navigator', own);
  }
});

test('price boxes take a currency written in letters on either end', () => {
  const cases = {
    'R$ 1.500': 1500, 'Rp 50.000': 50000, '50 zł': 50, '100 kr': 100, '100 kr.': 100, "CHF 1'000": 1000, RM50: 50, 'Rs. 500': 500, '1.500 Kč': 1500, '$50 USD': 50,
    '50,-': 50, '50,- kr': 50, 'Fr. 50.–': 50, 'US$ 50': 50, 'S/ 80': 80, 'Ksh 1,500': 1500, '500円': 500, '200 euros': 200, '300 лв.': 300,
    // Never the sol's dot as a decimal point (0.8), and never "Dh" with an "s" left over.
    'S/. 80': 80, 'S/.2500': 2500, 'Dhs 500': 500, 'Dhs. 500': 500, 'AU$ 50': 50, 'CA$ 50': 50,
  };
  for (const [typed, number] of Object.entries(cases)) assert.equal(priceLimit(typed), number, typed);
  // Shorthand (2k) and words for a number stay not-a-price: read as a currency they'd leave a
  // limit a thousand times too small, and hide nearly everything.
  const words = ['500rb', '1,5jt', '2 mil', '5 lakh', '2 Tsd.', '3 тыс', '5万円', '5만원', '10万元', '2 mio', '5 grand', '3 crore'];
  for (const bad of ['2k', 'R', 'kr', 'five', '5 x', ...words]) assert.ok(Number.isNaN(priceLimit(bad)), bad);
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

// The listings of the Today's picks unit in doc.
const picksOf = (doc) => {
  let found = null;
  JSON.stringify(doc, (key, value) => {
    if (value?.__typename === 'MarketplaceFeedTopPicksUnit') found = value.marketplace_listings;
    return value;
  });
  return found;
};
const geocode = (listing) => listing.location.reverse_geocode;

test('the places list keeps a city and state, or a whole state, however it is written', () => {
  const at = (city, state) => edgeListing({ node: { __typename: 'MarketplaceFeedListingStoryObject', listing: { id: '1', location: { reverse_geocode: { city, state } } } } });
  const goes = (places, listing) => reasonFor(listing, { min: null, max: null, places: compilePlaces(places), words: null }) === 'places';
  const austin = at('Austin', 'TX');
  assert.equal(goes('Austin, TX', austin), false);
  assert.equal(goes('  austin ,   tx  ', austin), false, 'case and spaces');
  assert.equal(goes('Austin, Texas', austin), false, "a state's name");
  assert.equal(goes('TX', austin), false, 'a state alone');
  assert.equal(goes('texas', austin), false);
  assert.equal(goes(', TX', austin), false);
  assert.equal(goes('Austin', austin), false, 'a city alone');
  assert.equal(goes('Austin TX', austin), false, 'no comma');
  assert.equal(goes('Austin Texas', austin), false);
  assert.equal(goes('Austin, TX, USA', austin), false, 'a country after the state');
  assert.equal(goes('Dallas, TX\n\nAustin, TX', austin), false, 'any line of the list');
  assert.equal(goes('Dallas, TX; Austin, TX', austin), false, 'semicolons part places too');
  assert.equal(goes('Dallas, TX', austin), true, 'another city in the same state');
  assert.equal(goes('Austin, MN', austin), true, 'the same name in another state');
  assert.equal(goes('OK', austin), true, 'another state');
  assert.equal(goes('Austin OK', austin), true);
  // A state Facebook spells out matches its letters, and accents, dots and hyphens don't count.
  assert.equal(goes('Montreal, QC', at('Montréal', 'Quebec')), false);
  assert.equal(goes('St Louis, Missouri', at('St. Louis', 'MO')), false);
  assert.equal(goes('Winston Salem, NC', at('Winston-Salem', 'NC')), false);
  assert.equal(goes('St.Louis, MO', at('St. Louis', 'MO')), false, 'a dot with no space');
  assert.equal(goes('Winston–Salem, NC', at('Winston-Salem', 'NC')), false, 'any dash');
  assert.equal(goes('Coeur d‘Alene, ID', at("Coeur d'Alene", 'ID')), false, 'any apostrophe');
  assert.equal(goes(`Austin${String.fromCharCode(0x200b)}, TX`, austin), false, 'a zero-width space');
  assert.equal(goes('Diyarbakır, Diyarbakir', at('Diyarbakir', 'Diyarbakir')), false, 'a dotless i');
  assert.equal(goes('Washington, D.C.', at('Washington', 'DC')), false, 'letters with dots');
  assert.equal(goes('Moncton, NB', at('Moncton', 'Nouveau-Brunswick')), false, "a province's French name");
  assert.equal(goes('PEI', at('Charlottetown', 'PE')), false);
  // With no comma, a city and its state by any of their names, the longest state name first.
  assert.equal(goes('Charlottetown PEI', at('Charlottetown', 'PE')), false);
  assert.equal(goes('Yellowknife NWT', at('Yellowknife', 'NT')), false);
  assert.equal(goes('Moncton Nouveau-Brunswick', at('Moncton', 'NB')), false);
  assert.equal(goes("St. John's Newfoundland", at("St. John's", 'NL')), false);
  assert.equal(goes('Charleston West Virginia', at('Charleston', 'WV')), false);
  assert.equal(goes('Charleston West Virginia', at('Charleston', 'VA')), true, 'West Virginia is not Virginia');
  assert.equal(goes('Kansas City', at('Wichita', 'KS')), true, 'a city named after a state');
  assert.equal(goes('Hagatna Guam', at('Hagatna', 'Guam')), false, 'a place outside the US and Canada');
  assert.equal(goes('Hagatna Guam', at('Dededo', 'Guam')), true);
  // Every other apostrophe Facebook or a keyboard writes.
  for (const mark of [0x60, 0xb4, 0x2bc]) {
    assert.equal(goes(`Coeur d${String.fromCharCode(mark)}Alene, ID`, at("Coeur d'Alene", 'ID')), false, `apostrophe ${mark}`);
  }
  assert.equal(goes(`Honolulu, Hawai${String.fromCharCode(0x2bb)}i`, at('Honolulu', 'HI')), false, 'an okina');
  // A country or a ZIP code after the place is left out, and CA is still California.
  for (const places of ['Texas, USA', 'TX, US', 'Austin TX, USA', 'Austin, TX 78701', 'Austin, TX 78701-1234', 'Austin, TX USA', 'Austin, TX, United States', 'Austin TX 78701']) {
    assert.equal(goes(places, austin), false, places);
  }
  assert.equal(goes('Ontario, Canada', at('Toronto', 'ON')), false);
  assert.equal(goes('Toronto, ON M5V 2T6', at('Toronto', 'ON')), false, 'a postal code');
  assert.equal(goes('Toronto, ON, CA', at('Toronto', 'ON')), false);
  assert.equal(goes('Ontario, CA', at('Toronto', 'ON')), true, 'Ontario, California');
  assert.equal(goes('Ontario, CA', at('Ontario', 'CA')), false);
  assert.equal(goes('Canada, KY', at('Canada', 'KY')), false, 'a town named like a country');
  assert.equal(goes('USA', austin), false, 'a country alone names nothing');
  // A country goes only after a state or province of its own, so La Cañada isn't Louisiana.
  for (const places of ['La Canada', 'La Cañada', 'La Canada, USA']) {
    assert.equal(goes(places, at('Baton Rouge', 'LA')), true, places);
    assert.equal(goes(places, at('La Cañada', 'CA')), false, places);
  }
  assert.equal(goes('Quebec Canada', at('Montreal', 'QC')), false);
  assert.equal(goes('Toronto Canada', at('Toronto', 'ON')), false);
  // A city named like the other country's state or province, and endings that don't agree.
  for (const places of ['Ontario USA', 'Ontario 91761']) assert.equal(goes(places, at('Ontario', 'CA')), false, places);
  assert.equal(goes('New Brunswick 08901', at('New Brunswick', 'NJ')), false);
  assert.equal(goes('Delaware Canada', at('Delaware', 'ON')), false);
  assert.equal(goes('Toronto ON USA', at('Toronto', 'ON')), false);
  assert.equal(goes('Austin TX Canada', austin), false);
  assert.equal(goes('Toronto, ON 78701', at('Toronto', 'ON')), false, 'a ZIP code always goes');
  // An empty list changes nothing, and a listing that doesn't say both its city and its state stays.
  assert.equal(goes('', austin), false);
  assert.equal(goes(' \n ; ', austin), false);
  assert.equal(goes('Dallas, TX', at('Austin', '')), false);
  assert.equal(goes('Dallas, TX', at('', 'TX')), false);
  assert.equal(goes('Dallas, TX', edgeListing({ node: { __typename: 'MarketplaceFeedListingStoryObject', listing: { id: '2' } } })), false);
});

test('the search answer loses the listings outside your places, and keeps its cursors and its next page', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const before = parseLine(line);
  const edges = searchEdges(before);
  const outside = edges.filter((edge) => edge.node?.__typename === 'MarketplaceFeedListingStoryObject' && geocode(listingOf(edge)).city !== 'Kettle').map((edge) => listingOf(edge).id);
  assert.equal(outside.length, 12, 'the capture has 12 listings outside Kettle');
  const { rule, filtered, diagnostics } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': 'kettle,  PEBBLE' });
  const doc = parseLine(line);
  assert.equal(rule.transform(doc, SEARCH), true);
  const after = searchEdges(doc);
  assert.deepEqual(edges.filter((edge, i) => !after[i].node).map((edge) => listingOf(edge).id), outside);
  assert.ok(after.every((edge, i) => edge.cursor === edges[i].cursor), 'cursors stay');
  assert.deepEqual(doc.data.marketplace_search.feed_units.page_info, before.data.marketplace_search.feed_units.page_info, 'the next page loads as before');
  assert.equal(filtered(), '12 outside your places');
  assert.deepEqual(diagnostics.decisions().map((d) => d.signal), Array(12).fill('places'));

  // A list every listing is inside, or an empty one, changes nothing.
  for (const places of ['Pebble', ' \n ']) {
    const untouched = parseLine(line);
    assert.equal(setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': places }).rule.transform(untouched, SEARCH), false, JSON.stringify(places));
    assert.deepEqual(untouched, before);
  }
});

test("Today's picks hides the cards outside your places, and the streamed home feed takes them out of the data", async () => {
  const [line] = await fixtureLines('marketplace-picks.jsonl');
  const listings = picksOf(parseLine(line));
  const places = 'Kettle, Pebble\nGarden';
  const inside = (listing) => (geocode(listing).city === 'Kettle' && geocode(listing).state === 'Pebble') || geocode(listing).state === 'Garden';
  const outside = listings.filter((listing) => !inside(listing)).map((listing) => listing.id);
  assert.equal(outside.length, 14);
  // Drawn on the server: nothing leaves the page's own data, and the cards go instead.
  const { doc, router, marked } = marketplacePage('https://www.facebook.com/marketplace/', listings);
  doc.documentElement.dataset.hfwRoute = 'marketplace';
  const win = { JSON: { parse: JSON.parse }, location: { href: 'https://www.facebook.com/marketplace/' } };
  const net = installNetworkHooks({ win, log: quiet });
  const page = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': places }, { doc, router });
  net.transformResponses(page.rule);
  assert.deepEqual(win.JSON.parse(line), parseLine(line), 'nothing leaves the data');
  await tick();
  assert.deepEqual(marked(), outside);
  assert.equal(page.filtered(), '14 outside your places');
  // Fetched over GraphQL, the same unit loses them from its list.
  const fetched = parseLine(line);
  assert.equal(setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': places }).rule.transform(fetched, SEARCH), true);
  assert.deepEqual(picksOf(fetched).map((listing) => listing.id), listings.filter(inside).map((listing) => listing.id));

  // The home feed's streamed listings keep their place on the node's entity. The two that go come
  // in chunks of their own, which keep their cursors, and the last chunk's next page stays.
  const lines = await fixtureLines('MarketplaceCometBrowseFeedLightPaginationQuery.jsonl');
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': 'River falcon, Pebble' });
  const gone = [];
  let cursors = 0;
  for (const chunk of lines) {
    const answer = parseLine(chunk);
    const nodes = [];
    JSON.stringify(answer, (key, value) => {
      if (value?.__typename === 'MarketplaceFeedGeneralListingObject') nodes.push(value);
      return value;
    });
    rule.transform(answer, SEARCH);
    if (nodes.length && !JSON.stringify(answer).includes('"MarketplaceFeedGeneralListingObject"')) {
      gone.push(...nodes.map((node) => edgeListing({ node }).place));
      assert.ok(answer.data.cursor === parseLine(chunk).data.cursor && !('node' in answer.data), 'the chunk keeps its cursor');
      cursors += 1;
    }
    if (answer.data?.page_info) assert.equal(answer.data.page_info.has_next_page, true, 'the next page still loads');
  }
  assert.deepEqual(gone, [{ city: 'island', state: 'pebble' }, { city: 'island', state: 'pebble' }]);
  assert.equal(cursors, 2);
  assert.equal(filtered(), '2 outside your places');
});

test('pages that lose every listing end the list after EMPTY_PAGES in a row, and a page that keeps one starts the count again', async () => {
  const lines = await fixtureLines('MarketplaceCometBrowseFeedLightPaginationQuery.jsonl');
  const heard = [];
  const { rule, store, diagnostics } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': 'Nowhere, ZZ' }, { subscribe: (fn) => heard.push(fn) });
  // One streamed answer, each its own request, and whether its last line still offers more. The
  // lines go through the rule's markers as they do on the page: the page_info line has none of
  // the listing names.
  const fetched = () => ({ ...SEARCH, friendlyName: 'MarketplaceCometBrowseFeedLightPaginationQuery' });
  const answer = (ctx = fetched()) => {
    let more;
    for (const chunk of lines) {
      const out = transformDocumentLine(chunk, [rule], ctx);
      const doc = parseLine(out);
      if (doc.data?.page_info) {
        more = doc.data.page_info.has_next_page;
        assert.equal(out !== chunk, !more, 'the page_info line changes only when the list ends there');
      }
    }
    return more;
  };
  const run = (count, ctx) => Array.from({ length: count }, () => answer(ctx?.()));
  // What the page parses on its own (drawn on the server) neither counts nor ends the list.
  const inline = Object.freeze({ transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' });
  assert.deepEqual(run(EMPTY_PAGES + 1, () => inline), Array(EMPTY_PAGES + 1).fill(true));
  assert.deepEqual(run(EMPTY_PAGES - 1), Array(EMPTY_PAGES - 1).fill(true));
  // Changing a setting starts the count again.
  for (const fn of heard) fn();
  assert.deepEqual(run(EMPTY_PAGES - 1), Array(EMPTY_PAGES - 1).fill(true), 'after a settings change');
  store.set('filterMarketplace.places', 'Island, Pebble');
  assert.equal(answer(), true, 'a page that keeps a listing');
  store.set('filterMarketplace.places', 'Nowhere, ZZ');
  assert.deepEqual(run(EMPTY_PAGES - 1), Array(EMPTY_PAGES - 1).fill(true), 'the count started again');
  assert.equal(answer(), false, 'the tenth empty page in a row is the last');
  assert.equal(diagnostics.decisions().filter((d) => d.signal === 'no more pages').length, 1);
  assert.equal(answer(), true, 'and the count starts again after it');

  // A search answer carries its page_info with its listings.
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const search = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': 'Nowhere, ZZ' });
  const ends = Array.from({ length: EMPTY_PAGES }, () => {
    const doc = parseLine(line);
    search.rule.transform(doc, { ...SEARCH });
    return doc.data.marketplace_search.feed_units.page_info.has_next_page;
  });
  assert.deepEqual(ends, [...Array(EMPTY_PAGES - 1).fill(true), false]);
  // Leaving the page starts the count again.
  const listeners = [];
  const moved = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.places': 'Nowhere, ZZ' }, { router: { current: () => parseRoute(SEARCH_PAGE), subscribe: (fn) => listeners.push(fn) } });
  const searchOnce = () => {
    const doc = parseLine(line);
    moved.rule.transform(doc, { ...SEARCH });
    return doc.data.marketplace_search.feed_units.page_info.has_next_page;
  };
  for (let i = 1; i < EMPTY_PAGES; i++) searchOnce();
  for (const fn of listeners) fn();
  assert.equal(searchOnce(), true);
});

test('with every option off the rule leaves the answer alone', async () => {
  const [line] = await fixtureLines('marketplace-search.jsonl');
  const { rule, filtered } = setup({ 'filterMarketplace.shipped': false, 'filterMarketplace.words': false, 'hidePostsByWords.words': 'a' });
  const doc = parseLine(line);
  assert.equal(rule.transform(doc, SEARCH), false);
  assert.deepEqual(doc, parseLine(line));
  assert.equal(filtered(), 'None yet');
});
