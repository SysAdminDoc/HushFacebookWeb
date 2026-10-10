// Facebook link cleaning: unwraps the l.facebook.com redirect and strips tracking tags.

const SHIM_HOSTS = new Set(['l.facebook.com', 'lm.facebook.com', 'l.messenger.com']);

// Tags Facebook adds to its own URLs. Context a link needs (set=, comment_id=,
// story_fbid=, id=) is never listed here.
const FACEBOOK_TRACKING = [
  /^__cft__\[\d+\]$/,
  /^__xts__\[\d+\]$/,
  /^__tn__$/,
  /^__eep__$/,
  /^_rdc$/,
  /^_rdr$/,
  /^acontext$/,
  /^comment_tracking$/,
  /^dti$/,
  /^eid$/,
  /^extid$/,
  /^fbclid$/,
  /^fref$/,
  /^hc_location$/,
  /^hc_ref$/,
  /^mibextid$/,
  /^notif_id$/,
  /^notif_t$/,
  /^paipv$/,
  /^rdid$/,
  /^ref$/,
  /^refid$/,
  /^refsrc$/,
  /^sfnsn$/,
  /^share_url$/,
  /^tracking$/,
];

// Facebook appends fbclid to every outbound link.
const OUTBOUND_TRACKING = [/^fbclid$/];

export function isFacebookHost(host) {
  return /(^|\.)(facebook\.com|fb\.com|messenger\.com)$/i.test(host) || /^(fb\.watch|fb\.me)$/i.test(host);
}

// fbcdn URLs are signed; changing any parameter breaks them.
function isCdnHost(host) {
  return /(^|\.)fbcdn\.net$/i.test(host);
}

// True for http(s) links that leave Facebook (its CDN counts as Facebook).
export function isOutbound(href) {
  const url = parse(href);
  return Boolean(url) && !isFacebookHost(url.hostname) && !isCdnHost(url.hostname);
}

function parse(href, base) {
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
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

// Returns href without tracking tags (and without the redirect when unwrap is true).
// An href that needs no change comes back as the exact same string.
export function cleanUrl(href, { unwrap = true, base } = {}) {
  let current = href;
  if (unwrap) current = unshim(current, base) ?? current;
  const url = parse(current, base);
  if (!url || isCdnHost(url.hostname)) return current;

  const patterns = isFacebookHost(url.hostname) ? FACEBOOK_TRACKING : OUTBOUND_TRACKING;
  const doomed = [...url.searchParams.keys()].filter((key) => patterns.some((pattern) => pattern.test(key)));
  if (!doomed.length) return current;
  for (const key of new Set(doomed)) url.searchParams.delete(key);
  if (!url.search || url.search === '?') url.search = '';
  return url.href;
}

// For clipboard text: cleans it only when the whole text is one http(s) URL.
export function cleanCopiedText(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return text;
  const cleaned = cleanUrl(trimmed);
  return cleaned === trimmed ? text : cleaned;
}
