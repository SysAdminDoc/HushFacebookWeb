// Hide posts by words, people, Pages or sites you list, and by kind of post, as Hushfacebook's
// "Hide posts by words" does on Android.
//
// Two layers again. In page mode the data rule reads each feed story's own fields (text,
// authors, alt text, linked sites, kind; see core/filters/story.js) and drops the matches
// before Facebook draws them. The page check reads the same fields from the markup (see
// core/filters/page.js) for posts that got drawn anyway, and in content mode. Both run on
// Home, the groups feed and group pages, never on a post you opened by its link.

import { walk, SKIP } from '../../core/json-walk.js';
import { filterCache, firstMatch } from '../../core/filters/engine.js';
import { postFields } from '../../core/filters/page.js';
import { storyFields } from '../../core/filters/story.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { inScope } from './ad-markers.js';
import { looksLikeCss } from '../../core/css-text.js';
import { later } from '../../core/net/payload.js';

export const CSS_WARNING = "Those filter lines look like CSS. Hide posts by words matches words in posts, so put CSS in Custom CSS under Appearance instead.";
const CSS_WARNED_KEY = 'hidePostsByWords.cssWarned';

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
];

export const FILTERED = {
  queries: /^(?:CometNewsFeedPaginationQuery|GroupsCometCrossGroupFeedPaginationQuery|GroupsCometFeedRegularStoriesPaginationQuery)$/,
  routes: (route) => Boolean(route) && !route.permalink && (route.type === 'home' || route.type === 'groups'),
};

// What hides this post, as the text after "Filter: ", or null.
export function filterVerdict({ rules, kinds }, fields) {
  for (const { kind, label } of KINDS) if (kinds.has(kind) && fields.kinds.has(kind)) return label;
  return firstMatch(rules, [...fields.text, ...fields.authors, ...fields.alt, ...fields.sites])?.phrase ?? null;
}

// Drops every feed story in doc that the filter hides. Returns the reasons, one per story.
// report(story, reason) hears each one before it goes.
export function pruneFiltered(doc, filter, report) {
  const hits = [];
  walk(doc, (value) => {
    if (Array.isArray(value) || !('cursor' in value) || !value.node || typeof value.node !== 'object') return undefined;
    if (value.node.__typename !== 'Story' && !value.node.__isFeedUnit) return undefined;
    const reason = filterVerdict(filter, storyFields(value.node));
    if (reason === null) return SKIP;
    report?.(value.node, reason);
    delete value.node;
    delete value.rendering_strategy;
    hits.push(reason);
    return SKIP;
  });
  return hits;
}

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const summary = (map) => (map.size ? [...map].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => `${name} ${n}`).join(', ') : 'None yet');

export default {
  id: 'hidePostsByWords',
  section: 'feed',
  android: 'Hide posts by words',
  title: 'Hide posts by words',
  description: 'Hides posts that mention the words, people, Pages or sites you list, on Home and in groups. Posts you open by their link always show.',
  default: false,
  options: [
    { key: 'words', type: 'text', label: 'One word, name or site per line. Start a line with re: to use a regular expression.', default: '', maxLength: 20000 },
    ...KINDS.map(({ key, label }) => ({ key, type: 'toggle', label: `Hide all ${label}`, default: false })),
  ],

  setup({ net, router, posts, hider, log, toast, storage, settings, diagnostics, enabled, option }) {
    const compile = filterCache();
    const warned = new Set();
    // CSS pasted here would only ever match posts that quote it. Said once per list, and
    // remembered across page loads. Pattern and note lines are left out of the check, since
    // "re:not( ?sponsored)" is a fine pattern.
    let checked = null;
    const warnIfCss = () => {
      if (!enabled()) return;
      const words = option('words') ?? '';
      if (words === checked) return;
      checked = words;
      if (!looksLikeCss(plainLines(words))) return;
      const print = fingerprint(words);
      if (storage?.get(CSS_WARNED_KEY, null) === print) return;
      storage?.set(CSS_WARNED_KEY, print);
      log?.warn(CSS_WARNING);
      toast?.(CSS_WARNING, { tone: 'error' });
    };
    const hits = new Map();
    const route = () => router?.current();
    const changed = () => diagnostics?.changed();

    function current() {
      const { rules, errors } = compile(option('words') ?? '');
      for (const error of errors) {
        if (warned.has(error.phrase)) continue;
        warned.add(error.phrase);
        log?.warn(`Filter line ${error.line} isn't a pattern the browser understands, so it's skipped`, error.message);
      }
      const kinds = new Set(KINDS.filter(({ key }) => option(key) === true).map(({ kind }) => kind));
      return { rules, kinds, errors };
    }
    const active = (filter) => filter.rules.length > 0 || filter.kinds.size > 0;

    if (net) {
      const scope = { scope: FILTERED };
      net.transformResponses({
        id: 'hidePostsByWords',
        enabled,
        markers: ['"__isFeedUnit"'],
        match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
        transform(doc, ctx, stage) {
          if (!inScope(scope, ctx, route)) return false;
          const filter = current();
          if (!active(filter)) return false;
          const decisions = [];
          const reasons = pruneFiltered(doc, filter, (story, reason) => decisions.push({ post: story.post_id ?? story.id, rule: 'Filter', detail: reason, layer: 'data' }));
          if (!reasons.length) return false;
          later(stage, () => {
            for (const decision of decisions) diagnostics?.decide(decision);
            for (const reason of reasons) tally(hits, reason);
            changed();
          });
          return true;
        },
      });
    }
    warnIfCss();
    settings?.subscribe(warnIfCss);
    diagnostics?.add('Posts hidden by your filters', () => summary(hits));
    diagnostics?.add("Filter lines that aren't valid", () => {
      const { errors } = current();
      return errors.length ? errors.map((error) => `line ${error.line}`).join(', ') : 'None';
    });
    if (!posts || !hider) return;

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        if (!FILTERED.routes(route())) return true;
        const filter = current();
        if (!active(filter)) return true;
        const reason = filterVerdict(filter, postFields(element));
        if (reason === null) return false;
        if (hider.hide(element, 'Filter', reason)) {
          tally(hits, reason);
          changed();
        }
        return true;
      },
    });

    // Any change to the list or the switches takes a fresh look at the posts on the page.
    const state = () => JSON.stringify([enabled(), option('words'), ...KINDS.map(({ key }) => option(key))]);
    let last = state();
    settings.subscribe(() => {
      const next = state();
      if (next === last) return;
      last = next;
      hider.showAll('Filter');
      if (enabled()) watcher.recheckAll();
    });
  },
};
