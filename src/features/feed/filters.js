// Hide posts by words, people, Pages or sites you list, and by kind of post, as Hushfacebook's
// "Hide posts by words" does on Android.
//
// Two layers again. In page mode the data rule reads each feed story's own fields (text,
// authors, alt text, linked sites, kind; see core/filters/story.js) and drops the matches
// before Facebook draws them. The page check reads the same fields from the markup (see
// core/filters/page.js) for posts that got drawn anyway, and in content mode. Both run on
// Home, the groups feed and group pages, and on search results with the search option, never
// on a post you opened by its link.
//
// The word list matches all of a post's fields at once, as it always has. The people and site
// lists (core/filters/lists.js) each match only their own field, and the two always-show lists
// win over everything this feature hides by. They never reach the other features, so a sponsored
// post by someone on an always-show list still goes.
//
// Preview runs the same checks and hides nothing. A read-only rule looks at the stories the
// page gets and the page check looks at each post as it fills in, and each one counts the
// posts it saw and which lines and kinds match them. Story ids in the data and post links on
// the page aren't the same ids, so the two layers are counted apart rather than guessed
// together. The counts stay in memory, at most PREVIEW_LIMIT posts a layer, start over when
// the list changes, and hold no post text. The card shows them with the lines they belong to,
// and Copy report gets only line numbers and counts.
//
// The fuse counts the same way while hiding. A word or site line that matches nearly every post
// on a page is far more likely a slip (re:. or a site line like com) than a wish to see nothing,
// and in page mode it leaves Facebook nothing to draw. Once one layer has checked FUSE_MIN posts
// on this page and a line matched FUSE_SHARE of them, that line is paused until the page or the
// list changes, and a notice names it. Keep hiding on the notice puts it back and remembers the
// line (by fingerprint) so it's never paused again. People lines and kinds of post aren't
// fused: they only match what they name. Live 2026-10-22 with re:. on Home, page mode dropped
// every story from ten feed pages in 24 s of scrolling and content mode hid 41 of 42 units.

import { walk, SKIP } from '../../core/json-walk.js';
import { whenBodyReady } from '../../core/env.js';
import { filterCache, firstMatch, matchingRules } from '../../core/filters/engine.js';
import { compileNames, compileSites, matchingNames, matchingSites } from '../../core/filters/lists.js';
import { commentFields, postFields, posterOf } from '../../core/filters/page.js';
import { storyFields } from '../../core/filters/story.js';
import { watchCommentChecks } from '../../core/dom/comment-checks.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { createPostMenuRow, menuPost } from '../../core/dom/post-menu.js';
import { drawnEdges, inScope } from './ad-markers.js';
import { drawnHere } from './drawn-posts.js';
import { createReelSkipper, eachReel, reelFields, REELS } from './reel-skips.js';
import { looksLikeCss } from '../../core/css-text.js';
import { t } from '../../core/i18n.js';
import { later } from '../../core/net/payload.js';

export const CSS_WARNING = "Those filter lines look like CSS. Hide posts by words matches words in posts, so put CSS in Custom CSS under Appearance instead.";
const PEOPLE_KEY = 'hidePostsByWords.people';
// A person with a line through them, drawn like Download's picture in the same menu.
const HIDE_PERSON_ICON = 'M12 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM4 21a8 8 0 0 1 16 0M3 3l18 18';
const CSS_WARNED_KEY = 'hidePostsByWords.cssWarned';
const SKIP_WARNED_KEY = 'hidePostsByWords.skipWarned';
const SITES_WARNED_KEY = 'hidePostsByWords.sitesWarned';

// The toast for pattern lines the filter skips (engine.js says why for each).
export function skipNotice(errors) {
  if (errors.length === 1) return t('Filter line {line} is skipped because it {reason}.', { line: errors[0].line, reason: t(errors[0].reason) });
  const lines = errors.map((error) => error.line);
  const named = lines.length > 4 ? [...lines.slice(0, 3), t('{count} more', { count: lines.length - 3 })] : lines;
  return t('Filter lines {lines} and {last} are skipped. Diagnostics says why.', { lines: named.slice(0, -1).join(', '), last: named.at(-1) });
}

// The toast for site list lines that aren't site names.
export function siteNotice(errors) {
  if (errors.length === 1) return t("Line {line} of the {list} list isn't a site name, so it's skipped.", { line: errors[0].line, list: t(errors[0].list) });
  return t("{count} lines in your site lists aren't site names, so they're skipped. Diagnostics names them.", { count: errors.length });
}

// The lines that are words, without the re: patterns and "# " notes (engine.js).
export const plainLines = (text) => String(text ?? '').split(/\r?\n/).filter((line) => !/^\s*(?:re:|#(?:\s|$))/i.test(line)).join('\n');

// A short stand-in for a list, so storage remembers which one was warned about without a copy.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}

const KINDS = [
  { key: 'photos', kind: 'photo', label: 'photo posts' },
  { key: 'videos', kind: 'video', label: 'video posts' },
  { key: 'links', kind: 'link', label: 'link posts' },
  { key: 'colored', kind: 'colored', label: 'colored background posts' },
  { key: 'shared', kind: 'shared', label: 'shared posts' },
  { key: 'live', kind: 'live', label: 'live videos' },
];

export const FILTERED = {
  queries: /^(?:CometNewsFeedPaginationQuery|GroupsCometCrossGroupFeedPaginationQuery|GroupsCometFeedRegularStoriesPaginationQuery)$/,
  routes: (route) => Boolean(route) && !route.permalink && (route.type === 'home' || route.type === 'groups'),
};

// Search results, with the search option. Live 2026-11-04 on /search/top/ and /search/posts/,
// the posts were the only results drawn as div[aria-posinset], never a person or group row, so
// the page check sees posts alone there too.
export const SEARCH = {
  queries: /^SearchCometResultsPaginatedResultsQuery$/,
  routes: (route) => route?.type === 'search',
};

const valuesOf = (fields) => [...fields.text, ...fields.authors, ...fields.alt, ...fields.sites];

// How preview names a line: 'line 3' in the word list, 'people line 2', 'sites line 1'.
const lineId = (list, entry) => `${list === 'words' ? '' : `${list} `}line ${entry.line}`;

// A filter is { rules, kinds } from the word list and switches, plus optional people, sites,
// showPeople and showSites lists (compileNames / compileSites).
const shown = ({ showPeople = [], showSites = [] }, fields) => matchingNames(showPeople, fields.authors).length > 0 || matchingSites(showSites, fields.sites).length > 0;

// What hides this post, as the text after "Filter: ", or null.
export function filterVerdict(filter, fields) {
  if (shown(filter, fields)) return null;
  const { rules, kinds, people = [], sites = [] } = filter;
  for (const { kind, label } of KINDS) if (kinds.has(kind) && fields.kinds.has(kind)) return label;
  const match = matchingNames(people, fields.authors)[0] ?? matchingSites(sites, fields.sites)[0] ?? firstMatch(rules, valuesOf(fields));
  return match?.phrase ?? null;
}

// Every kind and line that matches this post, by id ('photo posts', 'line 3', 'sites line 1'),
// for the preview. It's empty exactly when filterVerdict is null.
export function filterMatches(filter, fields) {
  if (shown(filter, fields)) return [];
  const { rules, kinds, people = [], sites = [] } = filter;
  return [
    ...KINDS.filter(({ kind }) => kinds.has(kind) && fields.kinds.has(kind)).map(({ label }) => label),
    ...matchingNames(people, fields.authors).map((entry) => lineId('people', entry)),
    ...matchingSites(sites, fields.sites).map((entry) => lineId('sites', entry)),
    ...matchingRules(rules, valuesOf(fields)).map((rule) => lineId('words', rule)),
  ];
}

// Each line id with the line as written, for the card.
const phrasesOf = ({ rules, people = [], sites = [] }) => new Map([
  ...rules.map((rule) => [lineId('words', rule), rule.phrase]),
  ...people.map((entry) => [lineId('people', entry), entry.phrase]),
  ...sites.map((entry) => [lineId('sites', entry), entry.phrase]),
]);

// The story an edge with a cursor carries: a feed edge's node or, in a search answer (search
// true), the story a result (a SearchRenderable node) keeps beside its node, in
// rendering_strategy (an ad's under view_model.story). Null for anything else, a person or group
// result included. Feeds read the node alone, so the search option off changes nothing there.
function storyOf(value, search) {
  if (Array.isArray(value) || !('cursor' in value) || !value.node || typeof value.node !== 'object') return null;
  if (value.node.__typename === 'Story' || value.node.__isFeedUnit) return value.node;
  if (!search) return null;
  const model = value.rendering_strategy?.view_model;
  const story = model?.click_model?.story ?? model?.story;
  return story && typeof story === 'object' ? story : null;
}

// Calls visit(edge, story) for each story edge in doc, a search answer's results too when search.
function eachStory(doc, visit, search) {
  walk(doc, (value) => {
    const story = storyOf(value, search);
    if (!story) return undefined;
    visit(value, story);
    return SKIP;
  });
}

// Drops every story in doc that the filter hides, apart from the ones keep(edge) says yes to.
// Taking the node and rendering_strategy leaves the edge and its cursor, so paging goes on.
// Returns the reasons, one per story dropped. report(story, reason) hears each one before it goes.
// search says doc is a search answer.
export function pruneFiltered(doc, filter, report, keep, search = false) {
  const hits = [];
  eachStory(doc, (edge, story) => {
    const reason = filterVerdict(filter, storyFields(story));
    if (reason === null || keep?.(edge)) return;
    report?.(story, reason);
    delete edge.node;
    delete edge.rendering_strategy;
    hits.push(reason);
  }, search);
  return hits;
}

// The preview's look at the same stories, changing nothing. see(id, matches) hears each one.
export function previewFiltered(doc, filter, see, search = false) {
  eachStory(doc, (edge, story) => see(story.post_id ?? story.id ?? null, filterMatches(filter, storyFields(story))), search);
}

export const PREVIEW_LIMIT = 1000;

// One layer's preview counts: each post once, by key, with every id that matched it on any look.
export function createPreviewTally(limit = PREVIEW_LIMIT) {
  const posts = new Map();
  return {
    see(key, matches) {
      let ids = posts.get(key);
      if (!ids) {
        if (posts.size >= limit) return;
        ids = new Set();
        posts.set(key, ids);
      }
      for (const id of matches) ids.add(id);
    },
    clear: () => posts.clear(),
    size: () => posts.size,
    summary() {
      const counts = new Map();
      let matched = 0;
      for (const ids of posts.values()) {
        if (ids.size) matched += 1;
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return { checked: posts.size, full: posts.size >= limit, matched, counts: [...counts].sort((a, b) => b[1] - a[1]) };
    },
  };
}

export const FUSE_MIN = 6;
export const FUSE_SHARE = 0.8;
// A layer stops counting for the fuse after this many posts on one page.
export const FUSE_WINDOW = 200;
const FUSE_KEPT_KEY = 'hidePostsByWords.fuseKept';
const FUSE_KEPT_LIMIT = 50;
const fusible = (id) => /^(?:sites )?line \d+$/.test(id);

// One page's fuse: a tally per layer, the lines paused here and the ones kept for good.
export function createFilterFuse({ min = FUSE_MIN, share = FUSE_SHARE, kept = () => false, window = FUSE_WINDOW } = {}) {
  const layers = { data: createPreviewTally(window), page: createPreviewTally(window) };
  const paused = new Map();
  return {
    paused,
    counting: (layer) => layers[layer].size() < window,
    see(layer, key, matches) {
      layers[layer].see(key, matches.filter(fusible));
    },
    // Pauses each line that now matches too much on one layer, and returns the ids it paused.
    trip() {
      const fresh = [];
      for (const [layer, tally] of Object.entries(layers)) {
        const { checked, counts } = tally.summary();
        if (checked < min) continue;
        for (const [id, matched] of counts) {
          if (matched < checked * share || paused.has(id) || kept(id)) continue;
          paused.set(id, { layer, matched, checked });
          fresh.push(id);
        }
      }
      return fresh;
    },
    clear() {
      layers.data.clear();
      layers.page.clear();
      paused.clear();
    },
  };
}

// The notice for a line the fuse paused.
export function fuseNotice(id, phrase, { matched, checked }) {
  const line = Number(id.match(/\d+$/)[0]);
  const values = { line, phrase: shortPhrase(phrase), matched, checked };
  return id.startsWith('sites ')
    ? t("Line {line} of your site list, \"{phrase}\", matched {matched} of the {checked} posts here, so it's paused on this page.", values)
    : t("Filter line {line}, \"{phrase}\", matched {matched} of the {checked} posts here, so it's paused on this page.", values);
}

// The paused lines for Copy report: line numbers and counts, never the lines.
export function fuseReport(paused) {
  if (!paused.size) return 'None';
  return [...paused].map(([id, { layer, matched, checked }]) => `${id} (${layer}: ${matched} of ${checked})`).join(', ');
}

const MAX_NAMED = 8;
const shortPhrase = (phrase) => (phrase.length > 30 ? `${phrase.slice(0, 29)}...` : phrase);

const STORIES = ['story', 'stories'];
const POSTS = ['post', 'posts'];

// One layer's counts in words. phraseOf(id) gives a line's text for the panel, or null to leave
// it out (Copy report).
function layerText(summary, [one, many], phraseOf) {
  if (!summary.checked) return `no ${many} checked yet`;
  const checked = summary.full ? `${summary.checked}+ ${many}` : `${summary.checked} ${summary.checked === 1 ? one : many}`;
  if (!summary.matched) return `no matches in ${checked}`;
  const named = summary.counts.slice(0, MAX_NAMED).map(([id, n]) => {
    const phrase = phraseOf(id);
    return phrase ? `${id} "${shortPhrase(phrase)}" ${n}` : `${id} ${n}`;
  });
  const more = summary.counts.length > MAX_NAMED ? `, and ${summary.counts.length - MAX_NAMED} more` : '';
  return `${summary.matched} of ${checked} ${summary.matched === 1 ? 'matches' : 'match'} (${named.join(', ')}${more})`;
}

// The card's status line while previewing.
export function previewStatus({ data, page, filter, active }) {
  if (!active) return 'Preview is on. Add a line to a list or turn on a kind of post to see what it would hide.';
  const phrases = phrasesOf(filter);
  const phraseOf = (id) => phrases.get(id) ?? null;
  const parts = [];
  if (data) parts.push(`In Facebook's data, ${layerText(data, STORIES, phraseOf)}.`);
  if (page) parts.push(`On the page, ${layerText(page, POSTS, phraseOf)}.`);
  const seen = (data?.checked ?? 0) + (page?.checked ?? 0);
  const matched = (data?.matched ?? 0) + (page?.matched ?? 0);
  const next = !seen ? 'Open Home or a group and scroll a little.' : matched ? 'Turn Preview off to hide them.' : '';
  return ['Preview is on, so nothing is hidden.', ...parts, next].filter(Boolean).join(' ');
}

// The same counts for Diagnostics and Copy report: line numbers and kinds, never the lines.
export function previewReport({ data, page }) {
  const none = () => null;
  return [data ? `data: ${layerText(data, STORIES, none)}` : null, page ? `page: ${layerText(page, POSTS, none)}` : null].filter(Boolean).join(', ');
}

const OPTIONS = [
  { key: 'words', type: 'text', label: 'One word, name or site per line. Start a line with re: to use a regular expression.', default: '', maxLength: 20000 },
  { key: 'people', type: 'text', label: "Hide posts by these people, Pages or groups. One name per line, written the way Facebook shows it, or choose Hide posts by in a post's three-dot menu. A name only matches who posted, and names aren't unique, so it hides everyone who goes by it.", default: '', maxLength: 20000 },
  { key: 'sites', type: 'text', label: 'Hide posts that link to these sites. One site per line, like news.example. Its subdomains count too.', default: '', maxLength: 20000 },
  { key: 'showPeople', type: 'text', label: 'Always show posts by these people, Pages or groups, even when something here would hide them. One name per line.', default: '', maxLength: 20000 },
  { key: 'showSites', type: 'text', label: 'Always show posts that link to these sites, even when something here would hide them. One site per line.', default: '', maxLength: 20000 },
  ...KINDS.map(({ key, label }) => ({ key, type: 'toggle', label: `Hide all ${label}`, default: false })),
  { key: 'search', type: 'toggle', label: 'Hide them in search results too', default: false },
  { key: 'comments', type: 'toggle', label: 'Hide comments that match your words, people or sites too', default: false },
  { key: 'reels', type: 'toggle', label: 'Skip reels that match your words, people or sites too', default: false },
  { key: 'preview', type: 'toggle', label: 'Preview: count what each line would hide, and hide nothing', default: false },
];

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
// How many reels' fields are kept, the newest.
const REELS_KEPT = 500;
// Builds once per distinct text.
function memo(build) {
  let text = null;
  let value = null;
  return (next) => {
    if (next !== text) {
      text = next;
      value = build(next);
    }
    return value;
  };
}
const summary = (map) => (map.size ? [...map].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => `${name} ${n}`).join(', ') : 'None yet');

export default {
  id: 'hidePostsByWords',
  section: 'feed',
  android: 'Hide posts by words',
  title: 'Hide posts by words',
  description: 'Hides posts that mention the words, people, Pages or sites you list, on Home and in groups, and in search results, comments and Reels if you choose. Posts and reels you open by their link always show.',
  default: false,
  options: OPTIONS,

  setup({ net, doc, router, posts, hider, log, toast, storage, settings, diagnostics, actions, enabled, option }) {
    const compile = filterCache();
    const warned = new Set();
    // Skipped pattern lines and CSS pasted here (which would only ever match posts that quote
    // it) each get a toast once per list, remembered across page loads. Pattern and note lines
    // are left out of the CSS check, since "re:not( ?sponsored)" is a fine pattern.
    let checked = null;
    let checkedSites = null;
    const checkSites = () => {
      const text = JSON.stringify([option('sites') ?? '', option('showSites') ?? '']);
      if (text === checkedSites) return;
      checkedSites = text;
      const { siteErrors } = current();
      const print = fingerprint(text);
      if (!siteErrors.length || storage?.get(SITES_WARNED_KEY, null) === print) return;
      storage?.set(SITES_WARNED_KEY, print);
      toast?.(siteNotice(siteErrors), { tone: 'error' });
    };
    const checkList = () => {
      if (!enabled()) return;
      checkSites();
      const words = option('words') ?? '';
      if (words === checked) return;
      checked = words;
      const print = fingerprint(words);
      const { errors } = current();
      if (errors.length && storage?.get(SKIP_WARNED_KEY, null) !== print) {
        storage?.set(SKIP_WARNED_KEY, print);
        toast?.(skipNotice(errors), { tone: 'error' });
      }
      if (!looksLikeCss(plainLines(words))) return;
      if (storage?.get(CSS_WARNED_KEY, null) === print) return;
      storage?.set(CSS_WARNED_KEY, print);
      log?.warn(CSS_WARNING);
      toast?.(t(CSS_WARNING), { tone: 'error' });
    };
    const hits = new Map();
    const route = () => router?.current();
    const changed = () => diagnostics?.changed();
    const searching = () => option('search') === true;
    const filtersOn = (now) => FILTERED.routes(now) || (searching() && SEARCH.routes(now));
    const searchAnswer = (ctx) => searching() && inScope({ scope: SEARCH }, ctx, route);
    const answerInScope = (ctx) => inScope({ scope: FILTERED }, ctx, route) || searchAnswer(ctx);

    const lists = {
      people: memo(compileNames),
      showPeople: memo(compileNames),
      sites: memo(compileSites),
      showSites: memo(compileSites),
    };
    function current() {
      const { rules, errors } = compile(option('words') ?? '');
      for (const error of errors) {
        if (warned.has(error.phrase)) continue;
        warned.add(error.phrase);
        log?.warn(`Filter line ${error.line} is skipped because it ${error.reason}. It stays in your list as you wrote it`, error.message);
      }
      const sites = lists.sites(option('sites') ?? '');
      const showSites = lists.showSites(option('showSites') ?? '');
      const siteErrors = [...sites.errors.map((error) => ({ ...error, list: 'sites' })), ...showSites.errors.map((error) => ({ ...error, list: 'always-show sites' }))];
      for (const error of siteErrors) {
        const seen = `${error.list}\n${error.phrase}`;
        if (warned.has(seen)) continue;
        warned.add(seen);
        log?.warn(`Line ${error.line} of the ${error.list} list is skipped because it ${error.reason}`);
      }
      const kinds = new Set(KINDS.filter(({ key }) => option(key) === true).map(({ kind }) => kind));
      return {
        rules, kinds, errors, siteErrors,
        people: lists.people(option('people') ?? ''),
        sites: sites.sites,
        showPeople: lists.showPeople(option('showPeople') ?? ''),
        showSites: showSites.sites,
      };
    }
    const active = (filter) => filter.rules.length > 0 || filter.kinds.size > 0 || filter.people.length > 0 || filter.sites.length > 0;
    const previewing = () => option('preview') === true;
    const preview = { data: net ? createPreviewTally() : null, page: posts && hider ? createPreviewTally() : null };
    const summaries = () => ({ data: preview.data?.summary() ?? null, page: preview.page?.summary() ?? null });

    // The fuse (see the top of this file). A kept line is stored as a fingerprint of its list and
    // text, so an edited line is a new line, and storage never holds the line itself.
    const keptHere = new Set();
    const keptPrints = () => {
      const saved = storage?.get(FUSE_KEPT_KEY, []);
      return Array.isArray(saved) ? saved : [];
    };
    const printOf = (id, phrase = phrasesOf(current()).get(id)) => (phrase === undefined
      ? null : fingerprint(`${id.startsWith('sites ') ? 'sites' : 'words'}\n${phrase}`));
    const fuse = createFilterFuse({
      kept: (id) => {
        const print = printOf(id);
        return print !== null && (keptHere.has(print) || keptPrints().includes(print));
      },
    });
    const fusing = (filter) => filter.rules.length > 0 || filter.sites.length > 0;
    const unpaused = (filter) => (fuse.paused.size ? {
      ...filter,
      rules: filter.rules.filter((rule) => !fuse.paused.has(lineId('words', rule))),
      sites: filter.sites.filter((entry) => !fuse.paused.has(lineId('sites', entry))),
    } : filter);
    // The fuse counts one feed at a time, and a different feed starts it over. Only Home, group
    // feeds and search count as a page here: a feed answer can arrive while a post or photo is
    // open on top of the feed, and that leaves the counts alone. Each search is a page of its own.
    const queryOf = (now) => (now.type === 'search' && now.href ? new URL(now.href).searchParams.get('q') ?? '' : '');
    const pageOf = (now = route()) => (now ? `${now.type}:${now.path}:${now.feed}:${queryOf(now)}` : '');
    let fusePage = null;
    const fuseHere = () => {
      const now = route();
      if (!filtersOn(now) || pageOf(now) === fusePage) return;
      fusePage = pageOf(now);
      fuse.clear();
    };
    const pausedHere = () => fuse.paused.size > 0 && pageOf() === fusePage;
    // Trips the fuse and notes each new pause's line as it reads now, for the notice and Keep hiding.
    const tripHere = () => {
      const fresh = fuse.trip();
      const phrases = phrasesOf(current());
      for (const id of fresh) {
        const phrase = phrases.get(id) ?? '';
        Object.assign(fuse.paused.get(id), { phrase, print: printOf(id, phrase) });
      }
      return fresh;
    };
    let recheck = null;
    // Keeps a line for good, with every paused line that reads the same.
    function keep(print) {
      if (print === null) return;
      keptHere.add(print);
      storage?.set(FUSE_KEPT_KEY, [...keptPrints().filter((saved) => saved !== print), print].slice(-FUSE_KEPT_LIMIT));
      for (const [id, entry] of fuse.paused) {
        if (entry.print === print) fuse.paused.delete(id);
      }
      recheck?.();
      changed();
    }
    function tripped(ids) {
      for (const id of ids) {
        const counts = fuse.paused.get(id);
        if (!counts) continue;
        log?.warn(`Filter ${id} matched ${counts.matched} of ${counts.checked} posts on this page (${counts.layer}), so it's paused here`);
        toast?.(fuseNotice(id, counts.phrase, counts), { tone: 'error', duration: 15000, actions: [{ label: 'Keep hiding', run: () => keep(counts.print) }] });
      }
      recheck?.();
      changed();
    }

    // The stories Facebook drew on the server, by their place in the feed (aria-posinset counts
    // from 1, as drawnEdges does), with what their data says. Taking one out of the data makes
    // React throw #418 and draw the page again (live 2026-11-03, Home and the groups feed with
    // re:.), so they stay, and the page check reads these fields for them in place of the
    // markup's. Places only hold on the page that loaded with them, and for the post the data drew
    // there (drawn-posts.js). Until its header is in, the post goes by its markup.
    const drawn = new Map();
    let drawnPath = null;
    const drawnFields = (element) => {
      if (!drawn.size || route()?.path !== drawnPath) return null;
      const fields = drawn.get(Number(element.getAttribute('aria-posinset')));
      return fields && drawnHere(element, fields.posters) ? fields : null;
    };

    // Reels, with the reels option (reel-skips.js): each reel's fields by its video's id, read from
    // the data, and the viewer skips the ones the filter hides. Preview hides nothing, so it skips
    // nothing, and a line the fuse paused stays paused for reels too.
    const reeling = () => enabled() && option('reels') === true && !previewing();
    const reels = new Map();
    const reelHits = new Map();
    const skipper = doc && router ? createReelSkipper({
      doc,
      router,
      verdict(id) {
        const fields = reels.get(id);
        if (!fields || !reeling()) return null;
        const filter = unpaused(current());
        return active(filter) ? filterVerdict(filter, fields) : null;
      },
      skipped(id, reason) {
        diagnostics?.decide({ post: id, rule: 'Filter', detail: reason, layer: 'page' });
        tally(reelHits, reason);
        changed();
      },
    }) : null;
    if (skipper) diagnostics?.add('Reels skipped by your filters', () => summary(reelHits));

    if (net) {
      const markers = ['"__isFeedUnit"'];
      const match = (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql');
      net.transformResponses({
        id: 'hidePostsByWords',
        enabled,
        markers,
        match,
        transform(doc, ctx, stage) {
          if (previewing() || !answerInScope(ctx)) return false;
          const filter = current();
          if (!active(filter)) return false;
          const search = searchAnswer(ctx);
          // Without a page check there's nothing to hide them with, so they go like the rest.
          const places = posts && hider && ctx.transport === 'json-parse' ? drawnEdges(doc) : null;
          const seen = [];
          if (places?.size) {
            for (const [edge, place] of places) {
              const story = storyOf(edge, search);
              if (story) seen.push([place, storyFields(story)]);
            }
          }
          if (seen.length) {
            // The data can come after the post is drawn, and a post its markup hid may stay.
            later(stage, () => {
              drawnPath ??= route()?.path ?? null;
              for (const [place, fields] of seen) drawn.set(place, fields);
              recheck?.();
            });
          }
          // The fuse looks at the whole answer before anything goes, so the answer that trips it
          // still carries the posts the paused line would have taken.
          if (fusing(filter)) {
            fuseHere();
            if (fuse.counting('data')) {
              previewFiltered(doc, filter, (id, matches) => {
                if (id !== null) fuse.see('data', String(id), matches);
              }, search);
              const fresh = tripHere();
              if (fresh.length) {
                stage?.undo(() => {
                  for (const id of fresh) fuse.paused.delete(id);
                });
                later(stage, () => tripped(fresh));
              }
            }
          }
          const live = unpaused(filter);
          if (!active(live)) return false;
          const decisions = [];
          const reasons = pruneFiltered(doc, live, (story, reason) => decisions.push({ post: story.post_id ?? story.id, rule: 'Filter', detail: reason, layer: 'data' }), places?.size ? (edge) => places.has(edge) : undefined, search);
          if (!reasons.length) return false;
          later(stage, () => {
            for (const decision of decisions) diagnostics?.decide(decision);
            for (const reason of reasons) tally(hits, reason);
            changed();
          });
          return true;
        },
      });
      // Preview's look at the same stories. It only reads, so nothing it does reaches the page.
      net.transformResponses({
        id: 'hidePostsByWords.preview',
        enabled: () => enabled() && previewing(),
        markers,
        match,
        observe: true,
        transform(doc, ctx) {
          if (!previewing() || !answerInScope(ctx)) return false;
          const filter = current();
          if (!active(filter)) return false;
          previewFiltered(doc, filter, (id, matches) => {
            if (id !== null) preview.data.see(String(id), matches);
          }, searchAnswer(ctx));
          changed();
          return false;
        },
      });
      // Only reads, since a reel's words come after the reel itself (reel-skips.js).
      net.transformResponses({
        id: 'hidePostsByWords.reels',
        enabled: reeling,
        markers: ['"video_feed_unit_feed"'],
        match,
        observe: true,
        transform(doc, ctx) {
          if (!reeling() || !inScope({ scope: REELS }, ctx, route)) return false;
          eachReel(doc, (id, story) => {
            reels.delete(id);
            reels.set(id, reelFields(story));
            if (reels.size > REELS_KEPT) reels.delete(reels.keys().next().value);
          });
          skipper?.check();
          return false;
        },
      });
    }
    checkList();
    settings?.subscribe(checkList);
    diagnostics?.add('Posts hidden by your filters', () => summary(hits));
    diagnostics?.add("Filter lines that aren't valid", () => {
      const { errors, siteErrors } = current();
      const named = [...errors.map((error) => `line ${error.line} (${error.reason})`), ...siteErrors.map((error) => `${error.list} line ${error.line} (${error.reason})`)];
      return named.length ? named.join(', ') : 'None';
    });
    diagnostics?.add('Filter preview', () => (enabled() && previewing() ? previewReport(summaries()) || 'Nothing to count here' : 'Off'), { shareable: true });
    diagnostics?.add('Filter lines paused on this page', () => (pausedHere() ? fuseReport(fuse.paused) : 'None'), { shareable: true });
    // The notice goes after a while, so the card keeps the same choice while a line is paused here.
    actions?.add(() => (enabled() && pausedHere() ? 'Keep hiding the paused lines' : ''), () => {
      for (const { print } of [...fuse.paused.values()]) keep(print);
    });
    diagnostics?.status?.('hidePostsByWords', () => {
      if (!enabled()) return null;
      if (!previewing()) {
        if (!pausedHere()) return null;
        const named = [...fuse.paused].map(([id, { phrase }]) => `${id} "${shortPhrase(phrase)}"`);
        return `Paused on this page because it matched almost every post: ${named.join(', ')}. Choose Keep hiding to hide by it anyway, or edit the line. Posts it hid before the pause come back on a reload.`;
      }
      const filter = current();
      return previewStatus({ ...summaries(), filter, active: active(filter) });
    });

    // Any change to the lists or the switches starts the preview counting again, and takes a
    // fresh look at the posts on the page (recheck, once the page check is set up).
    const state = () => JSON.stringify([enabled(), ...OPTIONS.map(({ key }) => option(key))]);
    let last = state();
    settings?.subscribe(() => {
      const next = state();
      if (next === last) return;
      last = next;
      preview.data?.clear();
      preview.page?.clear();
      fuse.clear();
      recheck?.();
      changed();
    });

    // "Hide posts by <name>" in a post's three-dot menu adds who posted (posterOf: in a group, the
    // member, never the group) to the people list. The change above then hides their posts on
    // the page and the data rule hides the next ones. Nothing goes to Facebook: no hide, snooze or
    // unfollow. The list is read the way the panel shows it, with a change still being saved in
    // place of the stored one, so two quick clicks both stay. A save that failed keeps its text
    // there too, ready for the panel's Retry, so Undo still finds the name it added.
    if (doc && settings?.set) {
      const people = () => settings.display?.(PEOPLE_KEY) ?? option('people') ?? '';
      const nameKey = (name) => compileNames(name)[0]?.key;
      const listed = (text, name) => compileNames(text).some((entry) => entry.key === nameKey(name));
      let used = 0;
      // Throws before saving anything when settings refuses the text (over its length limit).
      const save = (text) => {
        Promise.resolve(settings.set(PEOPLE_KEY, text)).catch((error) => log?.error("Couldn't save the list of people to hide", error));
      };
      const undo = (name, before, after) => {
        const now = people();
        if (now === after) {
          save(before);
          return;
        }
        // The list changed since, so only the line that was added goes.
        const lines = now.split(/\r?\n/);
        const index = lines.findLastIndex((line) => listed(line, name));
        if (index < 0) return;
        lines.splice(index, 1);
        save(lines.join('\n'));
      };
      const addPerson = ({ post, name }) => {
        const before = people();
        if (listed(before, name)) {
          toast?.(t('{name} is already on your list of people to hide.', { name }));
          return;
        }
        if (listed(option('showPeople') ?? '', name)) {
          toast?.(t('{name} is on your list of people to always show, so their posts keep showing.', { name }), { tone: 'error' });
          return;
        }
        const after = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${name}`;
        try {
          save(after);
        } catch (error) {
          log?.warn('The list of people to hide is full', error);
          toast?.(t("Your list of people to hide is full, so {name} wasn't added.", { name }), { tone: 'error' });
          return;
        }
        used++;
        changed();
        // The always-show lists win over the people list, and they also match the group a post is
        // in, the Page it shares and the sites it links to, so this post can stay while others go.
        const stays = post?.isConnected && shown(current(), postFields(post));
        const message = stays
          ? t('Hiding posts by {name}. This post stays, since your always-show lists cover it.', { name })
          : t('Hiding posts by {name}.', { name });
        toast?.(message, { action: { label: 'Undo', run: () => undo(name, before, after) } });
      };
      const row = createPostMenuRow({
        doc,
        mark: 'data-hfw-menu-hide-person',
        icon: HIDE_PERSON_ICON,
        failed: (error) => log?.error("Couldn't add Hide posts by to the post menu", error),
        enabled: () => enabled() && !previewing() && filtersOn(route()),
        pick() {
          const post = menuPost(doc);
          const name = post && posterOf(post);
          return name && nameKey(name) ? { post, name } : null;
        },
        label: ({ name }) => t('Hide posts by {name}', { name }),
        run: addPerson,
      });
      whenBodyReady(() => row.apply(), doc);
      settings.subscribe(() => row.apply());
      diagnostics?.add('People hidden from post menus', () => `Offered in ${row.added()} ${row.added() === 1 ? 'menu' : 'menus'}, added ${used}`);
    }
    if (!posts || !hider) return;

    // The page check in preview: each post is counted once and keeps every match it showed on
    // any look, since its text can fill in after the first one. It never hides, so it says
    // "not done" and keeps getting the post's later looks. The fuse keys posts the same way.
    const pageKeys = new WeakMap();
    let nextKey = 0;
    const keyOf = (element) => {
      if (!pageKeys.has(element)) pageKeys.set(element, ++nextKey);
      return pageKeys.get(element);
    };
    // A check runs again on a post that's already hidden (the list changed back, or drawn data
    // came in), and hide() says yes again, so each post is counted once for each thing it matched.
    const counted = new WeakMap();
    posts.on('post/remove', ({ element }) => counted.delete(element));

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        if (!filtersOn(route())) return true;
        const filter = current();
        if (!active(filter)) return true;
        const fields = drawnFields(element) ?? postFields(element);
        if (previewing()) {
          preview.page.see(keyOf(element), filterMatches(filter, fields));
          changed();
          return false;
        }
        if (fusing(filter)) {
          fuseHere();
          if (fuse.counting('page')) {
            fuse.see('page', keyOf(element), filterMatches(filter, fields));
            const fresh = tripHere();
            // Once this check is done, so the posts it hid come back through the hider.
            if (fresh.length) queueMicrotask(() => tripped(fresh));
          }
        }
        const reason = filterVerdict(unpaused(filter), fields);
        if (reason === null) return false;
        if (hider.hide(element, 'Filter', reason)) {
          if (!counted.has(element)) counted.set(element, new Set());
          if (!counted.get(element).has(reason)) tally(hits, reason);
          counted.get(element).add(reason);
          changed();
        }
        return true;
      },
    });

    // Comments, with the comments option, wherever they're drawn, a post opened by its link
    // included: by what one says, who wrote it and the sites it links to (commentFields, which
    // has no kinds, since those name kinds of posts). A line the fuse paused stays paused for
    // comments too.
    // Preview hides nothing, so it leaves comments alone.
    const commentHits = new Map();
    const commentsCounted = new WeakMap();
    const comments = doc ? watchCommentChecks({
      doc,
      enabled: () => enabled() && option('comments') === true && !previewing(),
      check(comment) {
        const filter = unpaused(current());
        if (!active(filter)) return false;
        const reason = filterVerdict(filter, commentFields(comment));
        if (reason === null) return false;
        if (hider.hide(comment, 'Filter', reason)) {
          if (!commentsCounted.has(comment)) commentsCounted.set(comment, new Set());
          if (!commentsCounted.get(comment).has(reason)) tally(commentHits, reason);
          commentsCounted.get(comment).add(reason);
          changed();
        }
        return true;
      },
    }) : null;
    if (comments) diagnostics?.add('Comments hidden by your filters', () => summary(commentHits));

    recheck = () => {
      hider.showAll('Filter');
      if (enabled()) watcher.recheckAll();
      comments?.recheckAll();
    };
    comments?.recheckAll();
  },
};
