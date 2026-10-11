// Scrubs captured Facebook JSON so it can be committed as a test fixture. Structure, field
// names, typenames and enum values stay; anything that could point at a person goes: ids,
// names, post text, tokens, cursors, hashes, CDN and profile URLs. Every stand-in is a keyed
// hash of the original, so the same id maps to the same stand-in everywhere in a fixture and
// references between documents still line up. Stand-ins never contain ten digits in a row,
// which is what the fixture test looks for.

import { createHash } from 'node:crypto';

const SALT = 'hushfacebook-web-fixture';
const GUARD = 'for (;;);';

// Keys whose values are prose or a person's details. Scrubbed whatever they contain.
const TEXT_KEYS = new Set([
  'text', 'title', 'message', 'headline', 'description', 'caption', 'accessibility_caption', 'alt_text', 'body',
  'subtitle', 'summary', 'snippet', 'footer_body', 'seo_title', 'link_title', 'link_description', 'comment',
  'username', 'vanity', 'email', 'phone', 'address', 'bio', 'about', 'placeholder', 'link_display',
]);
// Keys whose values are tokens however short they look.
const TOKEN_KEYS = new Set(['fbclid', 'h', 'oh', 'oe', 'eid', 'ccb', '_nc_ohc', '_nc_sid', '_nc_cat', '__tn__', 'access_token', 'token', 'fb_dtsg', 'jazoest', 'lsd', 'client_token', 'cursor', 'end_cursor', 'start_cursor', 'enc', 'nonce', 'hsi']);
// *name keys hold people and Pages, except the ones Facebook uses for code identifiers.
const CODE_NAME_KEYS = new Set(['__typename', 'friendly_name', 'fb_api_req_friendly_name', 'queue_name', 'icon_name', 'field_name', 'module_name', 'class_name', 'font_name', 'typename', 'experiment_name', 'event_name', 'surface_name', 'query_name', 'operation_name']);

// Path segments that are part of facebook.com's URL grammar, not someone's name.
export const STATIC_SEGMENTS = new Set([
  'groups', 'posts', 'permalink', 'permalink.php', 'story.php', 'photo', 'photo.php', 'photos', 'video', 'videos', 'watch',
  'reel', 'reels', 'stories', 'create', 'marketplace', 'item', 'search', 'top', 'people', 'pages', 'events', 'hashtag',
  'profile.php', 'l.php', 'share', 'p', 'r', 'v', 'ajax', 'api', 'graphql', 'login', 'checkpoint', 'notifications',
  'messages', 't', 'friends', 'gaming', 'saved', 'bookmarks', 'feeds', 'settings', 'help', 'policies', 'privacy', 'terms',
  'ads', 'library', 'set', 'media', 'a', 'pcb', 'rsrc.php', 'images', 'emoji.php', 'business', 'dialog', 'plugins',
  'sharer', 'sharer.php', 'story', 'live', 'memories', 'me', 'profile', 'tr', 'intern', 'about', 'comment_id',
]);

const FACEBOOK_HOST = /(^|\.)(facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com|instagram\.com|meta\.ai|threads\.com|whatsapp\.com)$/i;
const CDN_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com)$|^scontent/i;

const VOCAB = [
  'apple', 'river', 'maple', 'stone', 'harbor', 'meadow', 'copper', 'willow', 'summit', 'garden', 'lantern', 'orchard',
  'pebble', 'canyon', 'cedar', 'violet', 'marble', 'thistle', 'ember', 'falcon', 'timber', 'quartz', 'saddle', 'breeze',
  'anchor', 'cobalt', 'dune', 'fern', 'glacier', 'hazel', 'island', 'juniper', 'kettle', 'lagoon', 'mossy', 'north',
  'otter', 'prairie', 'quiet', 'ridge', 'sparrow', 'tundra', 'umber', 'valley', 'walnut', 'yarrow', 'zephyr', 'bramble',
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PFBID = /pfbid0[A-Za-z0-9]+/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const LONG_DIGITS = /\d{10,}/g;
const HAS_LONG_DIGITS = /\d{10,}/;
const EMBEDDED_URL = /https?:\/\/[^\s"'<>\\]+/g;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const WORDY = /^[A-Za-z_][A-Za-z_$.:-]{0,119}$/;
const SHORT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$.:-]{0,47}$/;
const LOWERCASE_IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
const TOKEN = /^[A-Za-z0-9_\-+/=@.:~%]{12,}$/;

const digest = (kind, value) => createHash('sha256').update(`${SALT}\0${kind}\0${value}`).digest();

// At most nine digits: long enough to look like an id, short enough never to read as one.
export function fakeDigits(value, length = 9) {
  const bytes = digest('digits', value);
  let out = String(1 + (bytes[0] % 9));
  for (let i = 1; i < Math.min(length, 9); i++) out += String(bytes[i % bytes.length] % 10);
  return out;
}

// Hex of the same length. Every eighth character is a letter, so no ten digits line up.
export function fakeHex(value, length) {
  const bytes = digest('hex', value);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i % bytes.length] ^ (i >> 5);
    out += i % 8 === 7 ? 'abcdef'[byte % 6] : (byte % 16).toString(16);
  }
  return out;
}

export function fakeUuid(value) {
  const hex = fakeHex(value, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Letters and digits from the hash of value. Every sixth character is a letter.
function hashToken(value, length, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
  const bytes = digest('token', value);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i % bytes.length] ^ (i >> 5);
    out += i % 6 === 5 ? alphabet[byte % 52] : alphabet[byte % alphabet.length];
  }
  return out;
}

// A token of the same length and alphabet (base64 or base64url), keeping any "=" padding
// and a lowercase "kind:" prefix such as browse_rl:.
export function fakeToken(value) {
  const prefix = value.match(/^[a-z_]+:(?!\/\/)/)?.[0] ?? '';
  const padding = value.match(/=+$/)?.[0] ?? '';
  const core = value.slice(prefix.length, value.length - padding.length);
  const standard = /[+/]/.test(core);
  const alphabet = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789${standard ? '+/' : '-_'}`;
  return prefix + hashToken(value, core.length, alphabet) + padding;
}

export function fakeWords(value, count = Math.min(24, Math.max(1, value.trim().split(/\s+/).length))) {
  const bytes = digest('words', value);
  const words = [];
  for (let i = 0; i < count; i++) words.push(VOCAB[(bytes[i % bytes.length] ^ (i >> 5)) % VOCAB.length]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

const fakeSlug = (value) => `u${hashToken(value, 7).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;

export function fakeDomain(value) {
  return `${fakeSlug(value).slice(1)}.example.invalid`;
}

// Substrings that identify something wherever they appear, including a URL inside markup
// such as a DASH manifest's <BaseURL>.
function scrubSubstrings(value) {
  return value
    .replace(EMBEDDED_URL, (match) => scrubUrl(match))
    .replace(UUID, (match) => fakeUuid(match))
    .replace(PFBID, (match) => fakeDigits(match))
    .replace(LONG_HEX, (match) => fakeHex(match, match.length))
    .replace(LONG_DIGITS, (match) => fakeDigits(match));
}

function scrubSegment(segment) {
  if (segment === '' || STATIC_SEGMENTS.has(segment)) return segment;
  if (/^\d+$/.test(segment)) return fakeDigits(segment);
  if (/^pfbid0/.test(segment)) return fakeDigits(segment);
  return fakeSlug(segment);
}

function scrubQuery(query) {
  if (!query) return '';
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      let raw = pair.slice(eq + 1);
      try {
        raw = decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        // Not percent-encoded; scrub the text as it is.
      }
      if (raw === '') return `${key}=`;
      return `${key}=${encodeURIComponent(scrubString(raw, key))}`;
    })
    .join('&');
}

export function scrubPath(path) {
  const [beforeHash, hash] = path.split('#', 2);
  const [pathname, query] = beforeHash.split('?', 2);
  const segments = pathname.split('/').map(scrubSegment).join('/');
  const scrubbedQuery = query === undefined ? '' : `?${scrubQuery(query)}`;
  return `${segments}${scrubbedQuery}${hash === undefined ? '' : `#${fakeToken(hash)}`}`;
}

export function scrubUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return fakeToken(value);
  }
  const host = url.hostname;
  if (CDN_HOST.test(host)) {
    const extension = url.pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '';
    return `https://cdn.example.invalid/${hashToken(value, 12)}${extension}`;
  }
  if (FACEBOOK_HOST.test(host)) return `${url.protocol}//${host}${scrubPath(url.pathname + url.search + url.hash)}`;
  const query = url.search ? `?${scrubQuery(url.search.slice(1))}` : '';
  return `https://example.invalid/${fakeSlug(url.origin + url.pathname)}${query}`;
}

function isTextKey(key) {
  if (key === undefined) return false;
  if (TEXT_KEYS.has(key)) return true;
  return false;
}

function isNameKey(key) {
  return typeof key === 'string' && /name$/i.test(key) && !CODE_NAME_KEYS.has(key);
}

export function scrubString(value, key) {
  if (value === '') return value;
  const first = value.trimStart()[0];
  if (first === '{' || first === '[') {
    try {
      return JSON.stringify(scrubValue(JSON.parse(value), key));
    } catch {
      // Not JSON after all.
    }
  }
  if (/^https?:\/\//i.test(value)) return scrubUrl(value);
  if (/^\/[^\s]*$/.test(value) && value.length > 1) return scrubPath(value);

  if (EMAIL.test(value)) return `${fakeSlug(value).slice(1)}@example.invalid`;
  if (isTextKey(key)) return fakeWords(value);
  if (isNameKey(key) && !LOWERCASE_IDENTIFIER.test(value)) return fakeWords(value);

  // An id, hash, uuid or URL inside a string: replace it and keep the grammar around it
  // ("browse_rl:<uuid>", "a.<album id>", a DASH manifest). Prose with one inside still
  // goes on to become placeholder words.
  const text = scrubSubstrings(value);
  if (text !== value && (!/\s/.test(text) || text.trimStart().startsWith('<'))) return text;
  if (!/[A-Za-z]/.test(text)) {
    // Numbers and punctuation only. Seven or more digits could be a phone number.
    const digits = text.replace(/\D/g, '').length;
    return digits >= 7 ? text.replace(/\d{3,}/g, (run) => fakeDigits(run, run.length)) : text;
  }
  if (DOMAIN.test(text)) return FACEBOOK_HOST.test(text) ? text : fakeDomain(text);
  if (TOKEN_KEYS.has(key) || /^__cft__/.test(key ?? '')) return fakeToken(text);
  if (WORDY.test(text)) return text;
  if (SHORT_IDENTIFIER.test(text) && text.replace(/\D/g, '').length <= 4) return text;
  if (TOKEN.test(text)) return fakeToken(text);
  if (text.length < 12 && !/\s/.test(text)) return text;
  // CSS values such as "0 -51px": short, lowercase, few digits. Names are capitalized.
  if (text.length < 16 && !/[A-Z]/.test(text) && text.replace(/\D/g, '').length <= 4) return text;
  return fakeWords(text);
}

// Big integers are ids. Long decimals (ranking scores) are rounded until they stop looking
// like one.
export function scrubNumber(value) {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) >= 1e9) return Number(fakeDigits(String(value))) * (value < 0 ? -1 : 1);
  let out = value;
  for (let precision = 9; precision >= 1 && HAS_LONG_DIGITS.test(String(out)); precision--) out = Number(value.toPrecision(precision));
  return out;
}

export function scrubKey(key) {
  return scrubSubstrings(key);
}

export function scrubValue(value, key) {
  if (typeof value === 'string') return scrubString(value, key);
  if (typeof value === 'number') return scrubNumber(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[scrubKey(k)] = scrubValue(v, k);
    return out;
  }
  return value;
}

// trims: [{ path: 'data.results.edges', keep: [0, 2] }]. Shortens arrays in a document
// while keeping its shape, so a fixture can carry four search results instead of forty.
export function trimArrays(doc, trims) {
  for (const { path, keep } of trims) {
    const parts = path.split('.');
    const last = parts.pop();
    let target = doc;
    for (const part of parts) target = target?.[part];
    if (!target || !Array.isArray(target[last])) throw new Error(`${path} is not an array in this document`);
    target[last] = keep.map((index) => {
      if (!(index in target[last])) throw new Error(`${path} has no index ${index}`);
      return target[last][index];
    });
  }
  return doc;
}

// One captured line (a JSON document, possibly behind Facebook's "for (;;);" guard).
export function scrubLine(line, { trims = [] } = {}) {
  const cr = line.endsWith('\r') ? '\r' : '';
  let body = cr ? line.slice(0, -1) : line;
  let prefix = '';
  if (body.startsWith(GUARD)) {
    prefix = GUARD;
    body = body.slice(GUARD.length);
  }
  const doc = JSON.parse(body);
  return prefix + JSON.stringify(scrubValue(trimArrays(doc, trims))) + cr;
}

// The <script type="application/json" data-sjs> blocks of a captured page that mention
// `match`, as raw JSON text.
export function extractDataSjs(html, match) {
  const blocks = [];
  const re = /<script type="application\/json"[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/g;
  for (let found = re.exec(html); found; found = re.exec(html)) {
    if (!match || found[1].includes(match)) blocks.push(found[1]);
  }
  return blocks;
}

// What must never be left in a fixture. The test and the CLI share this list.
export const LEFTOVER_PATTERNS = [
  { name: 'c_user cookie', re: /c_user/ },
  { name: 'fb_dtsg token', re: /fb_dtsg/ },
  { name: 'jazoest token', re: /jazoest/ },
  { name: 'CDN host', re: /scontent|fbcdn\.net|fbsbx\.com/ },
  { name: 'pfbid permalink token', re: /pfbid/ },
  { name: 'ten or more digits in a row', re: /\d{10,}/ },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9-]+\.[A-Za-z]{2,}/ },
];

export function findLeftovers(text) {
  return LEFTOVER_PATTERNS.filter(({ re }) => re.test(text)).map(({ name, re }) => `${name} (${re.exec(text)[0].slice(0, 40)})`);
}
