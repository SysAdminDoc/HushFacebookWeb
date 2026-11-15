// Hide parts of the page: the rule a pick is saved as, the CSS it becomes, and a matcher in
// JavaScript that finds the same elements the CSS hides. The picker uses the matcher to check a
// rule hides what was picked and nothing else on the page (happy-dom also gets :has(> ...)
// wrong, so the tests check the matcher, and the browser fixture checks the two agree).
//
// One rule per line, in one of two shapes:
//   main link /marketplace/ up 2   the element two levels above a link to Marketplace, in the main column
//   complementary at 1 3 2         the right column's 1st child, then that one's 3rd, then its 2nd
//
// A rule names a landmark (the top bar, a side column, the main column, a dialog) or the whole
// page, then a link to one of Facebook's own sections or a place inside that landmark. It never
// holds a class name, which Facebook changes with every build, or words from the page, which
// carry people's names. Links to people, groups, Pages and places are never used either. Every
// token is checked against a strict pattern, so a line from a backup can't carry CSS of its own.

import { t } from '../../core/i18n.js';
import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { HOSTS } from './declutter-table.js';

export const LANDMARKS = Object.freeze(['banner', 'navigation', 'complementary', 'main', 'contentinfo', 'dialog']);

// Facebook's own sections, the first part of a link's path. Anything else could be a person's
// or a Page's name.
const SECTIONS = new Set([
  'ad_center', 'ads', 'bookmarks', 'business', 'dating', 'events', 'feeds', 'friends', 'fundraisers', 'games', 'gaming',
  'groups', 'help', 'jobs', 'lists', 'live', 'marketplace', 'memories', 'messages', 'messenger_kids', 'news', 'notifications',
  'offers', 'orders', 'pages', 'privacy', 'reel', 'reels', 'saved', 'settings', 'shops', 'stories', 'watch', 'weather',
]);
// Second parts that name a place inside a section and never a person, group, city or item.
const SUBSECTIONS = new Set([
  'birthdays', 'browse', 'buying', 'calendar', 'create', 'discover', 'feed', 'going', 'hosting', 'inbox', 'joins', 'latest',
  'list', 'live', 'manage', 'notifications', 'requests', 'saved', 'search', 'selling', 'suggestions', 'you',
]);

const MAX_UP = 12;
const MAX_DEPTH = 40;
const MAX_LINKS = 40;
const OURS = '[data-hushfacebook-web]';
const POSTS = `[role="feed"], ${CANDIDATE_SELECTOR}`;

const LINE = /^(banner|navigation|complementary|main|contentinfo|dialog|page) (?:link (\/(?:[a-z_]+\/){0,2}) up (\d{1,2})|at ((?:[1-9]\d{0,2} ){0,39}[1-9]\d{0,2}))$/;

const validPath = (path) => {
  const [first, second, extra] = path.split('/').filter(Boolean);
  if (extra !== undefined) return false;
  if (first === undefined) return path === '/';
  return SECTIONS.has(first) && (second === undefined || SUBSECTIONS.has(second));
};

// The exact href texts a section's links are written with: relative or on either host, with or
// without the last slash, and with anything after a ?.
function hrefForms(path) {
  const forms = [];
  for (const prefix of ['', ...HOSTS]) {
    for (const form of [`${prefix}${path}`, `${prefix}${path.slice(0, -1)}`]) {
      if (form && !forms.includes(form)) forms.push(form);
    }
  }
  return forms;
}

export const hrefMatches = (href, path) => typeof href === 'string' && hrefForms(path).some((form) => href === form || href.startsWith(`${form}?`));

const linkSelectors = (path) => hrefForms(path).flatMap((form) => [`a[href="${form}"]`, `a[href^="${form}?"]`]);

// The section a link points at, as a rule keeps it ('/friends/requests/'), or null for a link
// that isn't one of Facebook's own sections.
export function sectionPath(href) {
  if (typeof href !== 'string' || !href) return null;
  let url;
  try {
    url = new URL(href, 'https://www.facebook.com/');
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 2 || segments.some((segment) => !/^[a-z_]+$/.test(segment))) return null;
  const path = segments.length ? `/${segments.join('/')}/` : '/';
  return validPath(path) && hrefMatches(href, path) ? path : null;
}

export function parseRule(line) {
  const match = LINE.exec(typeof line === 'string' ? line.trim() : '');
  if (!match) return null;
  const [, landmark, path, up, at] = match;
  if (path !== undefined) {
    if (!validPath(path) || Number(up) > MAX_UP) return null;
    return { landmark, kind: 'link', path, up: Number(up) };
  }
  return { landmark, kind: 'at', steps: at.split(' ').map(Number) };
}

export const ruleLines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => parseRule(line));

const scopeSelector = (landmark) => (landmark === 'page' ? 'body' : `[role="${landmark}"]`);

// The selector list for one rule. Never our own elements: a place in the page can come to be the
// settings button's.
export function selectorFor(rule) {
  const scope = scopeSelector(rule.landmark);
  if (rule.kind === 'at') return `${scope} > ${rule.steps.map((step) => `:nth-child(${step})`).join(' > ')}:not(${OURS})`;
  return linkSelectors(rule.path)
    .map((link) => (rule.up === 0 ? `${scope} ${link}` : `${scope} :has(> ${'* > '.repeat(rule.up - 1)}${link})`))
    .join(', ');
}

// One CSS rule per line, so a line no browser can read takes nothing else down with it.
export function partsCss(text) {
  return ruleLines(text).map((line) => `${selectorFor(parseRule(line))} { display: none !important; }`).join('\n');
}

// Every element the rule's CSS hides, found the way the CSS finds them.
export function matchRule(rule, doc) {
  const found = new Set();
  if (!rule || !doc?.body) return [];
  if (rule.kind === 'at') {
    const scopes = rule.landmark === 'page' ? [doc.body] : doc.querySelectorAll(scopeSelector(rule.landmark));
    for (const scope of scopes) {
      let node = scope;
      for (const step of rule.steps) node = node?.children[step - 1];
      if (node && !node.matches(OURS)) found.add(node);
    }
    return [...found];
  }
  const inScope = (node) => (rule.landmark === 'page'
    ? node !== doc.body && doc.body.contains(node)
    : Boolean(node.parentElement?.closest(scopeSelector(rule.landmark))));
  for (const link of doc.querySelectorAll('a[href]')) {
    if (!hrefMatches(link.getAttribute('href'), rule.path)) continue;
    let node = link;
    for (let index = 0; index < rule.up && node; index++) node = node.parentElement;
    if (node && inScope(node)) found.add(node);
  }
  return [...found];
}

// The outermost landmark around a node, or the page when it's in none.
export function landmarkOf(node, doc = node.ownerDocument) {
  let found = null;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (LANDMARKS.includes(parent.getAttribute('role'))) found = parent;
  }
  return found ? { name: found.getAttribute('role'), element: found } : { name: 'page', element: doc.body };
}

// Why a node can't be hidden: 'ours' (the script's own), 'feed' (a post, the feed or anything
// holding them), 'big' (the page itself or its main column), or null when it can.
export function refusalFor(node, doc = node?.ownerDocument) {
  if (!node || !doc?.body || node === doc.body || node === doc.documentElement || !doc.body.contains(node)) return 'big';
  if (node.closest(OURS)) return 'ours';
  if (node.closest(POSTS) || node.querySelector(POSTS)) return 'feed';
  if (node.matches('[role="main"]') || node.querySelector('[role="main"]')) return 'big';
  return null;
}

// The rule hides the node, and nothing on the page outside it.
const hidesOnly = (rule, node, doc) => {
  const matched = matchRule(rule, doc);
  return matched.some((match) => match === node) && matched.every((match) => node.contains(match));
};

const depthOf = (node, inside) => {
  let depth = 0;
  for (let at = node; at && at !== inside; at = at.parentElement) depth++;
  return depth;
};

function stepsTo(node, top) {
  const steps = [];
  for (let at = node; at !== top; at = at.parentElement) {
    if (!at?.parentElement) return null;
    steps.unshift([...at.parentElement.children].indexOf(at) + 1);
  }
  return steps;
}

// The rule for a picked node: { line } or { refused }. A link to one of Facebook's sections
// comes first, since it survives Facebook moving things around. A place in the landmark is the
// fallback. 'unclear' means neither picks out this node alone.
export function ruleFor(node, doc = node?.ownerDocument) {
  const refused = refusalFor(node, doc);
  if (refused) return { refused };
  const landmark = landmarkOf(node, doc);
  const tried = new Set();
  const links = [...(node.matches('a[href]') ? [node] : []), ...node.querySelectorAll('a[href]')].slice(0, MAX_LINKS);
  for (const link of links) {
    const path = sectionPath(link.getAttribute('href'));
    const up = depthOf(link, node);
    if (!path || up > MAX_UP) continue;
    const line = `${landmark.name} link ${path} up ${up}`;
    if (tried.has(line)) continue;
    tried.add(line);
    if (hidesOnly(parseRule(line), node, doc)) return { line };
  }
  const steps = stepsTo(node, landmark.element);
  if (steps?.length && steps.length <= MAX_DEPTH && steps.every((step) => step < 1000)) {
    const line = `${landmark.name} at ${steps.join(' ')}`;
    if (hidesOnly(parseRule(line), node, doc)) return { line };
  }
  return { refused: 'unclear' };
}

function whereName(landmark) {
  switch (landmark) {
    case 'banner': return t('the top bar');
    case 'navigation': return t('the left column');
    case 'complementary': return t('the right column');
    case 'main': return t('the main column');
    case 'contentinfo': return t('the footer');
    case 'dialog': return t('a dialog or menu');
    default: return t('the page');
  }
}

// What a saved line hides, in words for the list of parts.
export function describeRule(line) {
  const rule = parseRule(line);
  if (!rule) return line;
  const where = whereName(rule.landmark);
  if (rule.kind === 'link') return t('The part with a link to {path} in {where}', { path: rule.path, where });
  return t('A part of {where}, found by its place in it', { where });
}
