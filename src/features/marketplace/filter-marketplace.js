// Takes Marketplace listings you don't want out of Facebook's data before it draws them, the way
// Hide sponsored Marketplace listings takes out ads: listings that ship to you from somewhere
// else, listings on your Hide posts by words lists, and listings outside a price range.
//
// Live 2026-11-03 (signed in, script off), listings come in three shapes:
// - Marketplace's home starts with Today's picks, an inline MarketplaceFeedTopPicksUnit whose
//   marketplace_listings is a plain list of listings (GroupCommerceProductItem).
// - Its feed after that streams MarketplaceFeedGeneralListingObject edges, one per chunk, with the
//   title and price under data (amount_with_offset, in cents for dollars) and only the listing's
//   type and id under listing. They carry no seller and no delivery types.
// - Search results and categories send MarketplaceFeedListingStory(Object) edges whose listing
//   has its title, listing_price.amount, delivery_types and marketplace_listing_seller.
// A card says "Ships to you" in place of a town when its listing's delivery_types hold
// SHIPPING_ONSITE. A ProductItem is a store's listing (is_partner_listing), sold through the
// store's own site (SHIPPING_OFFSITE), so it counts as shipped too. "Just listed" is drawn by the
// page from the listing's age.
//
// Search results that Facebook drew on the server (the inline answer's own edges) can't leave
// the data: React hydrates them from it and throws #418 when one is missing, as on the groups
// feed. They stay, and listing-cards.js hides their cards on the page. Today's picks isn't drawn
// on the server and leaves the data with no error.
//
// The word list matches a listing's title and seller, the people list only its seller, and a
// seller on the always-show people list keeps their listings from both, as in Hide posts by
// words. A listing with no price that can be read stays, whatever the range.

import { walk, SKIP } from '../../core/json-walk.js';
import { filterCache, firstMatch } from '../../core/filters/engine.js';
import { compileNames, matchingNames } from '../../core/filters/lists.js';
import { later } from '../../core/net/payload.js';
import { drawnEdges } from '../feed/ad-markers.js';
import { LISTING_CSS, watchListingCards } from './listing-cards.js';

const STORIES = new Set(['MarketplaceFeedListingStory', 'MarketplaceFeedListingStoryObject']);
const GENERAL = 'MarketplaceFeedGeneralListingObject';
const PICKS = 'MarketplaceFeedTopPicksUnit';
const SHIPPING = new Set(['SHIPPING_ONSITE', 'SHIPPING_OFFSITE']);
// Facebook writes amount_with_offset in hundredths, apart from these currencies
// (developers.facebook.com/docs/marketing-api/currencies).
const WHOLE_UNITS = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
const DRAWN_KEPT = 500;

// How Diagnostics names each reason, in the order they're checked.
export const REASONS = { shipped: 'ships to you', price: 'outside the price range', words: 'on the word list', people: 'seller on the people list' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');
const number = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
};
const ships = (listing) => isObject(listing) && (
  (Array.isArray(listing.delivery_types) && listing.delivery_types.some((type) => SHIPPING.has(type)))
  || listing.__typename === 'ProductItem'
  || listing.is_partner_listing === true
);

// What a listing (GroupCommerceProductItem or ProductItem) says about itself.
export function fromListing(listing) {
  return {
    id: text(listing.id),
    title: text(listing.marketplace_listing_title),
    seller: text(listing.marketplace_listing_seller?.name),
    price: number(listing.listing_price?.amount),
    shipped: ships(listing),
  };
}

function fromGeneral(node) {
  const price = node.data?.price;
  const amount = number(price?.amount_with_offset);
  return {
    id: text(node.listing?.id) || text(node.entity_id),
    title: text(node.data?.title),
    seller: '',
    price: amount === null ? null : amount / (WHOLE_UNITS.has(price.currency) ? 1 : 100),
    shipped: node.is_partner_listing === true || ships(node.listing),
  };
}

// The listing a Marketplace feed edge draws, or null for anything else, ads included.
export function edgeListing(edge) {
  const node = edge?.node;
  if (!isObject(node)) return null;
  if (STORIES.has(node.__typename) && isObject(node.listing)) return fromListing(node.listing);
  if (node.__typename === GENERAL) return fromGeneral(node);
  return null;
}

// A price box's number: null when it's empty, NaN when it isn't a price. Spaces, thousands
// commas and a currency sign are fine.
export function priceLimit(value) {
  const clean = String(value ?? '').replace(/[\s,\p{Sc}]/gu, '');
  if (!clean) return null;
  return /^\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}

// The reason a listing goes, one of REASONS' keys, or null. filter holds shipped (boolean), min
// and max (numbers or null), and words, people and showPeople (compiled lists, or null when the
// lists are off).
export function reasonFor(listing, filter) {
  if (filter.shipped && listing.shipped) return 'shipped';
  if (listing.price !== null && ((filter.min !== null && listing.price < filter.min) || (filter.max !== null && listing.price > filter.max))) return 'price';
  if (!filter.words || (listing.seller && matchingNames(filter.showPeople, [listing.seller]).length)) return null;
  if (firstMatch(filter.words, [listing.title, listing.seller])) return 'words';
  if (listing.seller && matchingNames(filter.people, [listing.seller]).length) return 'people';
  return null;
}

// Takes every listing in doc that reasonOf(listing) names a reason for: the edge loses its node,
// and a Today's picks listing leaves the list. Returns the reasons, one per listing taken.
// report(listing, reason) hears each one before it goes. An edge keep(edge, listing) says yes
// to stays whole, whatever its reason.
export function filterListings(doc, reasonOf, report, keep) {
  const taken = [];
  const take = (listing) => {
    const reason = reasonOf(listing);
    if (!reason) return false;
    report?.(listing, reason);
    taken.push(reason);
    return true;
  };
  walk(doc, (value) => {
    if (value.__typename === PICKS && Array.isArray(value.marketplace_listings)) {
      value.marketplace_listings = value.marketplace_listings.filter((item) => !isObject(item) || !take(fromListing(item)));
      return SKIP;
    }
    if (!('node' in value)) return undefined;
    const listing = edgeListing(value);
    if (!listing) return undefined;
    if (keep?.(value, listing)) return SKIP;
    if (take(listing)) {
      delete value.node;
      delete value.rendering_strategy;
    }
    return SKIP;
  });
  return taken;
}

const limitText = (value) => {
  const limit = priceLimit(value);
  if (limit === null) return 'none';
  return Number.isNaN(limit) ? `"${String(value).trim()}" isn't a price, so it's left out` : String(limit);
};

export default {
  id: 'filterMarketplace',
  section: 'marketplace',
  webOnly: true,
  title: 'Filter Marketplace listings',
  description: 'Takes the listings you pick below out of Marketplace before Facebook draws them. The listings around them stay where they are.',
  default: false,
  needsPage: true,
  options: [
    { key: 'shipped', type: 'toggle', label: 'Hide listings marked Ships to you and listings sold through a store', default: true },
    { key: 'words', type: 'toggle', label: 'Hide listings whose title or seller is on your Hide posts by words lists', default: false },
    { key: 'minPrice', type: 'text', lines: 1, label: 'Lowest price to show. Leave it empty for no limit', default: '', maxLength: 16 },
    { key: 'maxPrice', type: 'text', lines: 1, label: 'Highest price to show. Leave it empty for no limit', default: '', maxLength: 16 },
  ],

  css: LISTING_CSS,

  setup({ doc, net, router, settings, diagnostics, enabled, option }) {
    const words = filterCache();
    const names = new Map();
    const compiledNames = (key) => {
      const value = settings.get(`hidePostsByWords.${key}`) ?? '';
      if (names.get(key)?.text !== value) names.set(key, { text: value, list: compileNames(value) });
      return names.get(key).list;
    };
    const limits = () => {
      let min = priceLimit(option('minPrice'));
      let max = priceLimit(option('maxPrice'));
      if (Number.isNaN(min)) min = null;
      if (Number.isNaN(max)) max = null;
      return min !== null && max !== null && min > max ? [max, min] : [min, max];
    };
    const filter = () => {
      const [min, max] = limits();
      const lists = option('words') === true;
      return {
        shipped: option('shipped') === true,
        min,
        max,
        words: lists ? words(settings.get('hidePostsByWords.words') ?? '').rules : null,
        people: lists ? compiledNames('people') : [],
        showPeople: lists ? compiledNames('showPeople') : [],
      };
    };
    const filtering = (current) => current.shipped || Boolean(current.words) || current.min !== null || current.max !== null;
    const counts = new Map();
    const count = (reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
    // The listings Facebook drew on the server, by id, kept whatever the options say now so a
    // change to them shows on the page. Each is counted once when its card first goes.
    const drawn = new Map();
    const remember = (listing) => {
      if (!listing.id) return;
      const known = drawn.get(listing.id);
      drawn.delete(listing.id);
      drawn.set(listing.id, { listing, counted: known?.counted ?? false });
      if (drawn.size > DRAWN_KEPT) drawn.delete(drawn.keys().next().value);
    };
    let cards = null;
    if (doc && router) {
      cards = watchListingCards({
        doc,
        route: () => router.current(),
        active: () => enabled() && drawn.size > 0 && filtering(filter()),
        reasonOf: (id) => {
          const known = drawn.get(id);
          return known ? reasonFor(known.listing, filter()) : null;
        },
        onHidden: (id, reason) => {
          const known = drawn.get(id);
          if (!known || known.counted) return;
          known.counted = true;
          count(reason);
          diagnostics?.decide({ post: id, rule: 'Filtered listing', signal: reason, layer: 'page' });
          diagnostics?.changed();
        },
      });
      settings.subscribe?.(() => cards.check());
      router.subscribe?.(() => cards.check());
    }

    net.transformResponses({
      id: 'filterMarketplace',
      enabled,
      markers: [...STORIES, GENERAL, PICKS].map((typename) => `"${typename}"`),
      match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
      transform(answer, ctx, stage) {
        const current = filter();
        const edges = ctx.transport === 'json-parse' ? drawnEdges(answer) : null;
        if (!filtering(current) && !edges?.size) return false;
        const kept = [];
        const keep = edges?.size ? (edge, listing) => {
          if (!edges.has(edge)) return false;
          kept.push(listing);
          return true;
        } : undefined;
        const decisions = [];
        const taken = filterListings(answer, (listing) => reasonFor(listing, current), (listing, reason) => {
          decisions.push({ post: listing.id || null, rule: 'Filtered listing', signal: reason, layer: 'data' });
        }, keep);
        if (!taken.length && !kept.length) return false;
        later(stage, () => {
          for (const listing of kept) remember(listing);
          for (const reason of taken) count(reason);
          for (const decision of decisions) diagnostics?.decide(decision);
          if (taken.length) diagnostics?.changed();
          if (kept.length) cards?.check();
        });
        return taken.length > 0;
      },
    });

    diagnostics?.add('Marketplace listings filtered out', () => (counts.size
      ? Object.keys(REASONS).filter((reason) => counts.has(reason)).map((reason) => `${counts.get(reason)} ${REASONS[reason]}`).join(', ')
      : 'None yet'), { shareable: true });
    diagnostics?.add('Marketplace price range', () => `lowest ${limitText(option('minPrice'))}, highest ${limitText(option('maxPrice'))}`);
  },
};
