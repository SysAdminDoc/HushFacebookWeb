// Takes Marketplace listings you don't want out of Facebook's data before it draws them, the way
// Hide sponsored Marketplace listings takes out ads: listings that ship to you from somewhere
// else, listings on your Hide posts by words lists, listings outside a price range, and listings
// from places you didn't name.
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
// Listings that Facebook drew on the server (the inline answer's own edges) can't leave the
// data: React hydrates them from it and throws #418 when one is missing, as on the groups feed.
// They stay, and listing-cards.js hides their cards on the page. That's search results (live
// 2026-11-03) and, since 2026-11-05, Today's picks too: it sits in the home's inline answer, and
// taking its one Ships to you listing out threw #418 with only this switch on.
//
// The word list matches a listing's title and seller, the people list only its seller, and a
// seller on the always-show people list keeps their listings from both, as in Hide posts by
// words. A listing with no price that can be read stays, whatever the range.
//
// Every listing shape carries its place as location.reverse_geocode {city, state}: on the listing
// for stories and Today's picks, on the node's entity for the streamed feed (47 of 47 fixture
// listings). The card shows it as "Austin, TX", and a state is matched by its letters or its name
// either way round. A listing that doesn't say both its city and its state stays, since it can't
// be told apart from one inside.
//
// A page that loses every listing leaves nothing on screen, so the end of the list stays in view
// and Facebook asks for the next one straight away (live 2026-11-15, a places list nothing
// matched: 5 pages in 12 idle seconds). After EMPTY_PAGES of those in a row the list ends.
//
// Hide listings you've opened keeps the ids of the listing pages you open while it's on, for each
// account (src/core/activity.js). A listing's opened state is read when Facebook's data for it
// arrives, so the one you just opened is still there when you go back to the results, and goes
// the next time they load.

import { walk, SKIP } from '../../core/json-walk.js';
import { filterCache, firstMatch } from '../../core/filters/engine.js';
import { compileNames, matchingNames } from '../../core/filters/lists.js';
import { later } from '../../core/net/payload.js';
import { t } from '../../core/i18n.js';
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
// Facebook asks for the next page while the end of the list is in view, so pages that lose every
// listing would keep it asking for good. After this many in a row, the list ends there.
export const EMPTY_PAGES = 10;
// The listings you opened, by id, with when you last opened each (extension/isolated.js checks
// the shape).
export const OPENED_KEY = 'filterMarketplace.opened';
export const MAX_OPENED = 1000;
// As long an id as extension/isolated.js lets the opened list keep.
const ITEM_PAGE = /^\/marketplace\/item\/(\d{1,32})(?!\d)/;

// How Diagnostics names each reason, in the order they're checked.
export const REASONS = { shipped: 'ships to you', opened: 'opened before', price: 'outside the price range', places: 'outside your places', words: 'on the word list', people: 'seller on the people list' };

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

// US states, DC, Puerto Rico and Canada's provinces and territories by name, so a state written
// out in the places list finds a listing placed by its letters, and the other way round.
const REGIONS = new Map(Object.entries({
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de',
  'district of columbia': 'dc', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj',
  'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'puerto rico': 'pr', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn',
  texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
  alberta: 'ab', 'british columbia': 'bc', manitoba: 'mb', 'new brunswick': 'nb', 'newfoundland and labrador': 'nl',
  'nova scotia': 'ns', 'northwest territories': 'nt', nunavut: 'nu', ontario: 'on', 'prince edward island': 'pe', quebec: 'qc',
  saskatchewan: 'sk', yukon: 'yt',
  // The provinces' French names, and short forms people write.
  'colombie britannique': 'bc', 'nouveau brunswick': 'nb', 'terre neuve et labrador': 'nl', newfoundland: 'nl',
  'nouvelle ecosse': 'ns', 'territoires du nord ouest': 'nt', nwt: 'nt', 'ile du prince edouard': 'pe', pei: 'pe',
}));
// Each region's first name above, its English one.
const REGION_NAMES = new Map();
for (const [name, code] of REGIONS) if (!REGION_NAMES.has(code)) REGION_NAMES.set(code, name);
// Letters with no accent to drop that people often write plain.
const FOLDS = { ı: 'i', ł: 'l', ø: 'o', đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe' };
// A place the way the list compares it: no case, accents, apostrophes or quotes, dots between
// single letters dropped ("D.C."), other dots and every dash read as spaces, one space between
// words.
const plain = (value) => text(value).replace(/´/g, "'").normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()
  .replace(/[ıłøđßæœ]/g, (letter) => FOLDS[letter])
  .replace(/(?<!\p{L})\p{L}(?:\.\p{L})+\.?(?!\p{L})/gu, (letters) => letters.replaceAll('.', ''))
  .replace(/[\p{Pi}\p{Pf}'`ʼʻ]/gu, '')
  .replace(/[\s.\p{Pd}]+/gu, ' ')
  .trim();
const region = (value) => REGIONS.get(value) ?? value;
const CANADA = new Set(['ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt']);
// The state or province a place ends with, by its letters or any of its names (the longest
// first, so "West Virginia" isn't Virginia), and the words before it.
function endingRegion(part) {
  const words = part.split(' ');
  for (let count = Math.min(words.length, 4); count > 0; count--) {
    const name = words.slice(-count).join(' ');
    const code = REGIONS.get(name) ?? (REGION_NAMES.has(name) ? name : null);
    if (code) return { before: words.slice(0, -count).join(' '), code };
  }
  return null;
}
// What can follow a place without being part of it: the country (the list only knows US and
// Canadian places) or a ZIP or postal code. A country stays when all that's before it is the
// other country's state letters, so "La Canada" is a city and not Louisiana. CA stays California.
const ENDINGS = [
  [/ ?\b(?:us|usa|united states(?: of america)?|america)$/, 'us'],
  [/ ?\bcanada$/, 'ca'],
  [/ ?\b\d{5}(?: \d{4})?$/],
  [/ ?\b[a-z]\d[a-z] ?\d[a-z]\d$/],
];
const bare = (part) => {
  for (let before = ''; before !== part;) {
    before = part;
    for (const [ending, country] of ENDINGS) {
      const rest = part.replace(ending, '').trim();
      if (rest === part || (country && REGION_NAMES.has(rest) && (CANADA.has(rest) ? 'ca' : 'us') !== country)) continue;
      part = rest;
    }
  }
  return part;
};

// A listing's city and state, compared plain, or null when it doesn't say both.
function placeOf(geocode) {
  const city = plain(geocode?.city);
  const state = region(plain(geocode?.state));
  return city && state ? { city, state } : null;
}

// The places list: one "City, ST" or "ST" per line (or between semicolons). After a comma comes
// the state, as its letters or its name. A country or a ZIP code at the end is left out, after a
// comma or not ("Ontario, Canada", "Austin, TX 78701"), and so is anything after a second comma.
// A line without a comma names a city or a state, or a city and its state, by any of its names,
// with a space between them ("Austin TX", "Yellowknife NWT").
export function compilePlaces(value) {
  const places = [];
  for (const line of text(value).split(/[\n;]/)) {
    const parts = line.split(',').map(plain).filter(Boolean);
    while (parts.length && bare(parts.at(-1)) !== parts.at(-1)) {
      const rest = bare(parts.at(-1));
      if (rest) parts[parts.length - 1] = rest;
      else parts.pop();
    }
    const [first = '', second = ''] = parts;
    if (second) places.push({ city: first, state: region(second) });
    else if (first) {
      places.push({ either: first, state: region(first) });
      const at = endingRegion(first);
      if (at?.before) places.push({ city: at.before, state: at.code });
    }
  }
  return places;
}

const inPlace = (place, at) => (place.either === undefined
  ? (!place.city || place.city === at.city) && place.state === at.state
  : place.either === at.city || place.state === at.state || place.either === `${at.city} ${at.state}`);

// What a listing (GroupCommerceProductItem or ProductItem) says about itself.
export function fromListing(listing) {
  return {
    id: text(listing.id),
    title: text(listing.marketplace_listing_title),
    seller: text(listing.marketplace_listing_seller?.name),
    price: number(listing.listing_price?.amount),
    shipped: ships(listing),
    place: placeOf(listing.location?.reverse_geocode),
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
    place: placeOf(node.entity?.location?.reverse_geocode ?? node.listing?.location?.reverse_geocode),
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

// The page_info of a Marketplace list in doc while it says there's more: the home feed's, inline
// or in a deferred chunk of its own ({path: ['marketplace_home_feed'], data: {page_info}}, the
// stream's last line), or a search's.
function morePages(doc) {
  const data = doc?.data;
  const info = Array.isArray(doc?.path) && doc.path.at(-1) === 'marketplace_home_feed'
    ? data?.page_info
    : data?.marketplace_home_feed?.page_info ?? data?.marketplace_search?.feed_units?.page_info;
  return isObject(info) && info.has_next_page === true ? info : null;
}

// Digits split into groups by sep: 1 to 3 digits (not a lone 0), then groups of 2 or 3 (Indian
// lakhs), the last of 3.
const grouped = (digits, sep) => {
  const groups = digits.split(sep);
  return /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every((group) => /^\d{2,3}$/.test(group)) && groups.at(-1).length === 3;
};

// Currencies people write in letters, as codes or the way prices are marked locally, plus what's
// left of US$, AU$, R$, C$ and the like once the sign goes, and Peru's S/. Only these: a word for
// a number ("500rb", "2 mil", "5 lakh", "3 тыс", "5万円") would leave a limit a thousand times too
// small. Before the number, the currency only goes when the number comes straight after it, so
// "Dhs" isn't read as "Dh" and an "s", and "S/." never leaves ".80".
const CODES = 'usd|cad|aud|nzd|eur|gbp|chf|pln|czk|huf|ron|bgn|rsd|bam|mkd|sek|nok|dkk|isk|try|uah|rub|kzt|gel|amd|azn|inr|pkr|bdt|lkr|npr|idr|myr|php|thb|vnd|sgd|hkd|twd|krw|jpy|cny|rmb|brl|mxn|ars|clp|cop|pen|uyu|zar|ngn|kes|ugx|tzs|ghs|egp|mad|aed|sar|qar|kwd|bhd|omr|jod|ils|tnd';
const LOCAL = 'us|au|ca|nz|hk|nt|mx|rp|rs|rm|kr|kč|kc|zł|zl|ft|lei|lv|лв|грн|руб|tl|dh|dhs|sr|qr|kd|bd|ro|jd|dt|din|km|ksh|ush|tsh|gh|tk|lek|sfr|fr';
const NAMES = 'dollars?|euros?|pesos?|reais|real|rupees?|rand|lira|naira|cedis?|baht|dinars?|dirhams?|riyals?|zlotys?|złotych|forint|leva?|yen|yuan|won|ringgit|rupiah|shillings?|pounds?|francs?|kronor|krona|kroner|krone';
const CURRENCY = `${CODES}|${LOCAL}|${NAMES}`;
const CURRENCY_BEFORE = new RegExp(`^(?:${CURRENCY}|[rcas])(?:\\/\\.?|\\.)?(?=\\d)`, 'iu');
const CURRENCY_AFTER = new RegExp(`(?:${CURRENCY}|р|円|元|원)\\.?$`, 'iu');

// A price box's number: null when it's empty, NaN when it isn't a price. Spaces, a currency's
// sign, code or local abbreviation on either end ("R$ 1.500", "50 zł", "Rs. 500"), a whole-number
// "50,-" and either way of writing thousands and decimals are fine ("1,200.50" or "1.200,50"). One
// mark before exactly three digits ("1,000" or "1.000") groups thousands whatever the browser's
// language: nobody types a price to three decimal places, and plenty of people write 1.000 on an
// English browser. Any other letters ("2k", "500rb") aren't a price.
export function priceLimit(value) {
  const spaced = String(value ?? '').replace(/[\s'’\p{Sc}]/gu, '');
  if (!spaced) return null;
  const clean = spaced.replace(CURRENCY_BEFORE, '').replace(CURRENCY_AFTER, '').replace(/[.,][-–]$/, '');
  if (!/^[\d.,]*\d[\d.,]*$/.test(clean)) return NaN;
  const last = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf(','));
  if (last === -1) return Number(clean);
  const mark = clean[last];
  const whole = clean.slice(0, last);
  const fraction = clean.slice(last + 1);
  const other = mark === '.' ? ',' : '.';
  const asNumber = (digits) => Number(`${digits}.${fraction}`);
  if (whole.includes(other)) {
    // Both marks: the last one is the decimal, and the other groups the thousands.
    return /^\d+$/.test(fraction) && grouped(whole, other) ? asNumber(whole.replaceAll(other, '')) : NaN;
  }
  if (grouped(clean, mark)) return Number(clean.replaceAll(mark, ''));
  return !whole.includes(mark) && /^\d+$/.test(fraction) ? asNumber(whole) : NaN;
}

// The reason a listing goes, one of REASONS' keys, or null. filter holds shipped and opened
// (booleans), min and max (numbers or null), places (compilePlaces' list, empty for anywhere),
// and words, people and showPeople (compiled lists, or null when the lists are off).
export function reasonFor(listing, filter) {
  if (filter.shipped && listing.shipped) return 'shipped';
  if (filter.opened && listing.opened) return 'opened';
  if (listing.price !== null && ((filter.min !== null && listing.price < filter.min) || (filter.max !== null && listing.price > filter.max))) return 'price';
  if (filter.places?.length && listing.place && !filter.places.some((place) => inPlace(place, listing.place))) return 'places';
  if (!filter.words || (listing.seller && matchingNames(filter.showPeople, [listing.seller]).length)) return null;
  if (firstMatch(filter.words, [listing.title, listing.seller])) return 'words';
  if (listing.seller && matchingNames(filter.people, [listing.seller]).length) return 'people';
  return null;
}

// Takes every listing in doc that reasonOf(listing) names a reason for: the edge loses its node,
// and a Today's picks listing leaves the list. Returns the reasons, one per listing taken.
// report(listing, reason) hears each one before it goes. An edge keep(edge, listing) says yes
// to stays whole, whatever its reason, and so does every listing of the Today's picks it holds.
export function filterListings(doc, reasonOf, report, keep) {
  const taken = [];
  const take = (listing) => {
    const reason = reasonOf(listing);
    if (!reason) return false;
    report?.(listing, reason);
    taken.push(reason);
    return true;
  };
  const isPicks = (value) => isObject(value) && value.__typename === PICKS && Array.isArray(value.marketplace_listings);
  const pick = (unit, edge) => {
    const left = unit.marketplace_listings.filter((item) => {
      if (!isObject(item)) return true;
      const listing = fromListing(item);
      return Boolean(edge && keep?.(edge, listing)) || !take(listing);
    });
    if (left.length !== unit.marketplace_listings.length) unit.marketplace_listings = left;
  };
  walk(doc, (value) => {
    if (isPicks(value)) {
      pick(value, null);
      return SKIP;
    }
    if (isPicks(value.node)) {
      pick(value.node, value);
      return SKIP;
    }
    // Every feed edge carries a cursor (344 of 344 live, 2026-11-03), and a lone listing fetched
    // by node() sits as {node} with nothing around it to keep.
    if (!('node' in value) || !('cursor' in value)) return undefined;
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
    { key: 'opened', type: 'toggle', label: "Hide listings you've opened before", default: false },
    { key: 'words', type: 'toggle', label: 'Hide listings whose title or seller is on your Hide posts by words lists', default: false },
    { key: 'minPrice', type: 'text', lines: 1, label: 'Lowest price to show. Leave it empty for no limit', default: '', maxLength: 16 },
    { key: 'maxPrice', type: 'text', lines: 1, label: 'Highest price to show. Leave it empty for no limit', default: '', maxLength: 16 },
    { key: 'places', type: 'text', label: 'Show only listings from these places. One per line, a city and state like Austin, TX or a state like TX. Leave it empty for anywhere', default: '', maxLength: 2000 },
  ],

  css: LISTING_CSS,

  setup({ doc, net, router, settings, storage, diagnostics, enabled, option, toast, actions }) {
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
    let places = { text: '', list: [] };
    const compiledPlaces = () => {
      const value = option('places') ?? '';
      if (places.text !== value) places = { text: value, list: compilePlaces(value) };
      return places.list;
    };
    const filter = () => {
      const [min, max] = limits();
      const lists = option('words') === true;
      return {
        shipped: option('shipped') === true,
        opened: option('opened') === true,
        min,
        max,
        places: compiledPlaces(),
        words: lists ? words(settings.get('hidePostsByWords.words') ?? '').rules : null,
        people: lists ? compiledNames('people') : [],
        showPeople: lists ? compiledNames('showPeople') : [],
      };
    };
    const filtering = (current) => current.shipped || current.opened || Boolean(current.words) || current.min !== null || current.max !== null || current.places.length > 0;
    const opened = () => {
      const all = storage?.get(OPENED_KEY, {});
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    };
    // The extension's saved copy fills in a moment after the page starts (whenReady), and a write
    // before then would replace the saved list, so nothing is kept until it has.
    let loaded = !storage?.whenReady;
    // Keeps the listing whose page is open, while the option is on, as the latest of MAX_OPENED.
    const recordOpened = () => {
      const id = router?.current()?.path?.match(ITEM_PAGE)?.[1];
      if (!id || !storage || !loaded || !enabled() || option('opened') !== true) return;
      const all = { ...opened() };
      delete all[id];
      all[id] = Date.now();
      const ids = Object.keys(all);
      if (ids.length > MAX_OPENED) {
        for (const old of ids.sort((a, b) => all[a] - all[b]).slice(0, ids.length - MAX_OPENED)) delete all[old];
      }
      storage.set(OPENED_KEY, all);
    };
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
    // What each answer brought so far, by request ({seen, taken} listings across its streamed
    // lines), and how many pages in a row lost every listing.
    const pages = new WeakMap();
    let emptyPages = 0;
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
    }
    settings.subscribe?.(() => {
      emptyPages = 0;
      recordOpened();
      cards?.check();
    });
    router?.subscribe?.(() => {
      emptyPages = 0;
      recordOpened();
      cards?.check();
    });
    if (loaded) {
      recordOpened();
    } else {
      // Cards Facebook drew before the saved list came in get their opened state from it now.
      // Listings that only passed through the data before then weren't checked against it.
      storage.whenReady(() => {
        loaded = true;
        const all = opened();
        for (const known of drawn.values()) {
          if (Object.hasOwn(all, known.listing.id)) known.listing.opened = true;
        }
        recordOpened();
        cards?.check();
      });
    }

    net.transformResponses({
      id: 'filterMarketplace',
      enabled,
      markers: [...STORIES, GENERAL, PICKS, 'marketplace_home_feed'].map((name) => `"${name}"`),
      match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
      transform(answer, ctx, stage) {
        const current = filter();
        const edges = ctx.transport === 'json-parse' ? drawnEdges(answer) : null;
        if (!filtering(current) && !edges?.size) return false;
        const before = opened();
        const read = (listing) => {
          listing.opened = Boolean(listing.id) && Object.hasOwn(before, listing.id);
          return listing;
        };
        const kept = [];
        const keep = edges?.size ? (edge, listing) => {
          if (!edges.has(edge)) return false;
          kept.push(read(listing));
          return true;
        } : undefined;
        const decisions = [];
        let seen = 0;
        const taken = filterListings(answer, (listing) => {
          seen += 1;
          return reasonFor(read(listing), current);
        }, (listing, reason) => {
          decisions.push({ post: listing.id || null, rule: 'Filtered listing', signal: reason, layer: 'data' });
        }, keep);
        // A page's listings and its page_info can come on different lines, so the answer's count
        // is kept until its page_info shows up.
        const fetched = ctx.transport !== 'json-parse';
        const info = fetched ? morePages(answer) : null;
        const page = fetched ? pages.get(ctx) ?? { seen: 0, taken: 0 } : null;
        const pageSeen = (page?.seen ?? 0) + seen;
        const pageTaken = (page?.taken ?? 0) + taken.length;
        const empty = Boolean(info) && pageSeen > 0 && pageTaken === pageSeen;
        const stop = empty && emptyPages + 1 >= EMPTY_PAGES;
        if (stop) info.has_next_page = false;
        if (!taken.length && !kept.length && !info && !(fetched && seen)) return false;
        later(stage, () => {
          if (fetched && seen) pages.set(ctx, { seen: pageSeen, taken: pageTaken });
          if (info) emptyPages = stop ? 0 : empty ? emptyPages + 1 : pageTaken < pageSeen ? 0 : emptyPages;
          if (stop) diagnostics?.decide({ post: null, rule: 'Filtered listing', signal: 'no more pages', layer: 'data', drop: false });
          for (const listing of kept) remember(listing);
          for (const reason of taken) count(reason);
          for (const decision of decisions) diagnostics?.decide(decision);
          if (taken.length) diagnostics?.changed();
          if (kept.length) cards?.check();
        });
        return taken.length > 0 || stop;
      },
    });

    diagnostics?.add('Marketplace listings filtered out', () => (counts.size
      ? Object.keys(REASONS).filter((reason) => counts.has(reason)).map((reason) => `${counts.get(reason)} ${REASONS[reason]}`).join(', ')
      : 'None yet'), { shareable: true });
    diagnostics?.add('Marketplace price range', () => `lowest ${limitText(option('minPrice'))}, highest ${limitText(option('maxPrice'))}`);
    diagnostics?.add('Opened listings kept', () => String(Object.keys(opened()).length));
    actions?.add('Forget opened listings', async () => {
      await storage?.remove(OPENED_KEY);
      for (const known of drawn.values()) known.listing.opened = false;
      cards?.check();
      toast?.(t('Forgot every opened listing'));
    });
  },
};
