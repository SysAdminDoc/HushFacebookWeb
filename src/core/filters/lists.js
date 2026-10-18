// The name and site lists of Hide posts by words, kept apart from its word list so a name only
// matches a post's authors and a site only matches the sites it links to.
//
// A name line matches an author whose whole name is the line, ignoring case and odd spaces.
// "Pat" doesn't match "Pat Example". Facebook names aren't unique, so a line matches everyone
// who goes by it, and nothing here guesses who someone is from their name.
//
// A site line is a host name ("news.example"), or a link to one, which is cut down to its host.
// It matches that host and its subdomains on a dot boundary, so "example.com" matches
// "news.example.com" but not "badexample.com" or "example.com.evil.net". Hosts are compared in
// the form the browser's URL parser gives them, punycode for other alphabets, which is also how
// the post readers in story.js and page.js record them.
//
// Blank lines and lines starting with "# " are skipped, as in the word list.

import { normalizeText } from '../dom/visible-text.js';

const nameKey = (value) => normalizeText(value).normalize('NFC').toLowerCase();

// Each line that holds something, with its number counted from 1 in the list as written.
function lines(text) {
  const out = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = normalizeText(raw);
    if (!line || line === '#' || line.startsWith('# ')) return;
    out.push({ line: index + 1, phrase: line });
  });
  return out;
}

// [{ line, phrase, key }]
export const compileNames = (text) => lines(text).map((entry) => ({ ...entry, key: nameKey(entry.phrase) }));

// The host a site line names, or null.
export function siteKey(phrase) {
  const value = phrase.trim().replace(/^\*\./, '');
  if (!value || /\s/.test(value)) return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
  return host;
}

// { sites: [{ line, phrase, key }], errors: [{ line, phrase, reason }] }
export function compileSites(text) {
  const sites = [];
  const errors = [];
  for (const entry of lines(text)) {
    const key = siteKey(entry.phrase);
    if (key) sites.push({ ...entry, key });
    else errors.push({ ...entry, reason: "isn't a site name" });
  }
  return { sites, errors };
}

export const siteMatches = (host, key) => host === key || host.endsWith(`.${key}`);

// The entries that match the post's authors or sites, in list order.
export const matchingNames = (entries, authors) => {
  if (!entries.length) return [];
  const keys = new Set(authors.map(nameKey));
  return entries.filter((entry) => keys.has(entry.key));
};
export const matchingSites = (entries, hosts) => {
  if (!entries.length) return [];
  const clean = hosts.map((host) => String(host).toLowerCase());
  return entries.filter((entry) => clean.some((host) => siteMatches(host, entry.key)));
};
