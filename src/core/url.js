// Facebook link cleaning: unwraps the l.facebook.com redirect and strips tracking tags.
//
// The key lists are Hushfacebook's reviewed LinkCleaner list (Android research of
// 2026-09-25): exact decoded names only, never patterns like ClearURLs' [a-z]*ref[a-z]*.
// Keys a review proved functional stay: ref (except ref=share), eid, aref, tracking,
// referral_code, referrer. The query is edited as text, so every key that stays keeps its
// exact bytes, and l.php keeps u and h together (a lone u or h trips Facebook's warning).

const SHIM_HOSTS = new Set(['l.facebook.com', 'lm.facebook.com', 'l.messenger.com']);

const ANY_HOST = new Set([
  'fbclid', 'mibextid',
  'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
  'action_object_map', 'action_type_map', 'action_ref_map',
]);

const FACEBOOK_ONLY = new Set([
  'sfnsn', 'extid', 'rdid', 'share_url', '__tn__', '__so__', '__rv__', '_ft_',
  'refsrc', 'fref', 'refid', 'pnref', 'ls_ref', 'hc_ref', 'hc_location', 'dti', 'acontext',
  'action_history', 'video_source', 'comment_tracking', 'm_entstream_source', 'idorvanity',
  'paipv', 'wtsid', '_rdr', '_rdc', 'rdr', 'rdc', 'referral_story_type', 'gd_impression_id',
  'external_ref', 'store_visit_source',
]);

const FACEBOOK_INDEXED = /^__(?:cft|xts)__\[\d+\]$/;

export function isFacebookHost(host) {
  return /(^|\.)(facebook\.com|fb\.com|messenger\.com)$/i.test(host) || /^(fb\.watch|fb\.me)$/i.test(host);
}

// fbcdn URLs are signed; changing any parameter breaks them.
function isCdnHost(host) {
  return /(^|\.)fbcdn\.net$/i.test(host);
}

function parse(href, base) {
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function isTracking(key, value, facebook) {
  if (ANY_HOST.has(key)) return true;
  if (!facebook) return false;
  return FACEBOOK_ONLY.has(key) || FACEBOOK_INDEXED.test(key) || (key === 'ref' && value === 'share');
}

// True for http(s) links that leave Facebook (its CDN counts as Facebook).
export function isOutbound(href) {
  const url = parse(href);
  return Boolean(url) && !isFacebookHost(url.hostname) && !isCdnHost(url.hostname);
}

// Returns the real destination of a link-shim URL, or null when href isn't one.
export function unshim(href, base) {
  const url = parse(href, base);
  if (!url) return null;
  const isShim = SHIM_HOSTS.has(url.hostname) || (isFacebookHost(url.hostname) && url.pathname === '/l.php');
  if (!isShim) return null;
  const target = parse(url.searchParams.get('u') ?? '');
  return target ? target.href : null;
}

// Drops tracking keys from the query of href as text. Unchanged input comes back as the
// same string; a relative href stays relative.
export function stripTracking(href, facebook) {
  const hashAt = href.indexOf('#');
  const head = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const queryAt = head.indexOf('?');
  if (queryAt === -1) return href;

  let removed = false;
  const kept = head.slice(queryAt + 1).split('&').filter((part) => {
    if (!part) return false;
    const eq = part.indexOf('=');
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decode(part.slice(eq + 1));
    if (!isTracking(key, value, facebook)) return true;
    removed = true;
    return false;
  });
  if (!removed) return href;
  return head.slice(0, queryAt) + (kept.length ? `?${kept.join('&')}` : '') + hash;
}

// Returns href without tracking tags (and without the redirect when unwrap is true).
// An href that needs no change comes back as the exact same string.
export function cleanUrl(href, { unwrap = true, base } = {}) {
  const current = (unwrap && unshim(href, base)) || href;
  const url = parse(current, base);
  if (!url || isCdnHost(url.hostname)) return current;
  return stripTracking(current, isFacebookHost(url.hostname));
}

// For clipboard text: cleans it only when the whole text is one http(s) URL.
export function cleanCopiedText(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return text;
  const cleaned = cleanUrl(trimmed);
  return cleaned === trimmed ? text : cleaned;
}
