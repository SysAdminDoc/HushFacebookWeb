// Hide parts of the page: the rule a pick is saved as, the CSS it becomes, and a matcher in
// JavaScript that finds the same elements the CSS hides. The picker uses the matcher to check a
// rule hides what was picked and nothing else on the page (happy-dom also gets :has(> ...)
// wrong, so the tests check the matcher, and the browser fixture checks the two agree).
//
// One rule per line, in one of two shapes:
//   main link /marketplace/ up 2 on home   the element two levels above a link to Marketplace, in the main column
//   complementary at 1 3 2 on groups       the right column's 1st child, then that one's 3rd, then its 2nd
//
// A rule names a landmark (the top bar, a side column, the main column, a dialog) or the whole
// page, then a link to one of Facebook's own sections or a place inside that landmark, then the
// kind of page it was picked on (data-hfw-route), since the same place on another page holds
// something else. The top bar is the same on every page, so its rules hold no page. A rule never
// holds a class name, which Facebook changes with every build, or words from the page, which
// carry people's names. Links to people, groups, Pages and places are never used either. Every
// token is checked against a strict pattern, so a line from a backup can't carry CSS of its own.
//
// Whatever a rule finds, it never hides a post, the feed, the main column, anything inside or
// holding one of those, or the script's own elements (GUARD), so a part Facebook later fills with
// posts shows again by itself.

import { t } from '../../core/i18n.js';
import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { ROUTE_NAMES } from '../../core/route.js';
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
// The script's own elements. <html> carries the same attribute with the running version (main.js),
// and everything is inside that.
export const OURS = '[data-hushfacebook-web]:not(html)';
const POSTS = `[role="feed"], ${CANDIDATE_SELECTOR}`;
const MAIN = '[role="main"]';
const POSTS_LIST = POSTS.split(', ');
const GUARD = `:not(${[OURS, `${OURS} *`, ...POSTS_LIST, ...POSTS_LIST.map((post) => `${post} *`), MAIN].join(', ')}):not(:has(${POSTS}, ${MAIN}))`;
const ROUTES = new Set(ROUTE_NAMES);

const LINE = /^(banner|navigation|complementary|main|contentinfo|dialog|page) (?:link (\/(?:[a-z_]+\/){0,2}) up (\d{1,2})|at ((?:[1-9]\d{0,2} ){0,39}[1-9]\d{0,2}))(?: on ([a-z]{1,20}))?$/;

// What GUARD lets a rule hide, the way the CSS checks it.
const hideable = (node) => !node.closest(OURS) && !node.closest(POSTS) && !node.matches(MAIN) && !node.querySelector(`${POSTS}, ${MAIN}`);
// Facebook's own children of a node, the ones a place in a rule counts.
const counted = (node) => [...node.children].filter((child) => !child.matches(OURS));

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
  const [, landmark, path, up, at, route] = match;
  if (route !== undefined && !ROUTES.has(route)) return null;
  const on = route === undefined ? {} : { route };
  if (path !== undefined) {
    if (!validPath(path) || Number(up) > MAX_UP) return null;
    return { landmark, kind: 'link', path, up: Number(up), ...on };
  }
  return { landmark, kind: 'at', steps: at.split(' ').map(Number), ...on };
}

export const ruleLines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => parseRule(line));

const scopeSelector = (landmark) => (landmark === 'page' ? 'body' : `[role="${landmark}"]`);

// The selector list for one rule. A place counts only Facebook's elements, so the script adding
// one of its own (the settings button, a download button) doesn't move it.
export function selectorFor(rule) {
  const scope = `${rule.route ? `html[data-hfw-route="${rule.route}"] ` : ''}${scopeSelector(rule.landmark)}`;
  if (rule.kind === 'at') return `${scope} > ${rule.steps.map((step) => `:nth-child(${step} of :not(${OURS}))`).join(' > ')}${GUARD}`;
  return linkSelectors(rule.path)
    .map((link) => (rule.up === 0 ? `${scope} ${link}${GUARD}` : `${scope} :has(> ${'* > '.repeat(rule.up - 1)}${link})${GUARD}`))
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
  if (rule.route && doc.documentElement.dataset.hfwRoute !== rule.route) return [];
  if (rule.kind === 'at') {
    const scopes = rule.landmark === 'page' ? [doc.body] : doc.querySelectorAll(scopeSelector(rule.landmark));
    for (const scope of scopes) {
      let node = scope;
      for (const step of rule.steps) node = node && counted(node)[step - 1];
      if (node && hideable(node)) found.add(node);
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
    if (node && inScope(node) && hideable(node)) found.add(node);
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

// A text or comment node goes by the element it sits in. Anything else that isn't an element
// (a shadow root, the document) is null, which no rule can hide.
const elementOf = (node) => {
  if (node?.nodeType === 1) return node;
  return node?.nodeType === 3 || node?.nodeType === 8 ? node.parentElement : null;
};

// Why a node can't be hidden: 'ours' (the script's own), 'feed' (a post, the feed or anything
// holding them), 'big' (the page itself or its main column), or null when it can.
export function refusalFor(node, doc = node?.ownerDocument) {
  node = elementOf(node);
  if (!node || !doc?.body) return 'big';
  // First, since something of the script's own can sit in a shadow root, which body doesn't contain.
  if (node.closest(OURS)) return 'ours';
  if (node === doc.body || node === doc.documentElement || !doc.body.contains(node)) return 'big';
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
    steps.unshift(counted(at.parentElement).indexOf(at) + 1);
  }
  return steps;
}

// The rule for a picked node: { line } or { refused }. A link to one of Facebook's sections
// comes first, since it survives Facebook moving things around. A place in the landmark is the
// fallback. 'unclear' means neither picks out this node alone.
export function ruleFor(node, doc = node?.ownerDocument) {
  const refused = refusalFor(node, doc);
  if (refused) return { refused };
  node = elementOf(node);
  const landmark = landmarkOf(node, doc);
  const route = doc.documentElement.dataset.hfwRoute;
  const on = landmark.name !== 'banner' && ROUTES.has(route) ? ` on ${route}` : '';
  const tried = new Set();
  const links = [...(node.matches('a[href]') ? [node] : []), ...node.querySelectorAll('a[href]')].slice(0, MAX_LINKS);
  for (const link of links) {
    const path = sectionPath(link.getAttribute('href'));
    const up = depthOf(link, node);
    if (!path || up > MAX_UP) continue;
    const line = `${landmark.name} link ${path} up ${up}${on}`;
    if (tried.has(line)) continue;
    tried.add(line);
    if (hidesOnly(parseRule(line), node, doc)) return { line };
  }
  const steps = stepsTo(node, landmark.element);
  if (steps?.length && steps.length <= MAX_DEPTH && steps.every((step) => step < 1000)) {
    const line = `${landmark.name} at ${steps.join(' ')}${on}`;
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

function pageName(route) {
  switch (route) {
    case 'home': return t('Home');
    case 'marketplace': return t('Marketplace');
    case 'groups': return t('Groups');
    case 'watch': return t('Video');
    case 'reel': return t('Reels');
    case 'stories': return t('Stories');
    case 'messages': return t('Messages');
    case 'notifications': return t('Notifications');
    case 'search': return t('search results');
    case 'friends': return t('Friends');
    case 'gaming': return t('Gaming');
    case 'events': return t('Events');
    case 'photo': return t('photos');
    case 'post': return t('single posts');
    case 'settings': return t('Settings');
    case 'saved': return t('Saved');
    case 'hashtag': return t('hashtag pages');
    case 'feeds': return t('Feeds');
    case 'menu': return t('the Menu page');
    default: return t('profiles and Pages');
  }
}

// What a saved line hides, in words for the list of parts.
export function describeRule(line) {
  const rule = parseRule(line);
  if (!rule) return line;
  const where = whereName(rule.landmark);
  if (rule.route) {
    const page = pageName(rule.route);
    if (rule.kind === 'link') return t('The part with a link to {path} in {where}, on {page}', { path: rule.path, where, page });
    return t('A part of {where} on {page}, found by its place in it', { where, page });
  }
  if (rule.kind === 'link') return t('The part with a link to {path} in {where}', { path: rule.path, where });
  return t('A part of {where}, found by its place in it', { where });
}
