// Hide posts by words, people, Pages or sites you list, and by kind of post, as Hushfacebook's
// "Hide posts by words" does on Android.
//
// Two layers again. In page mode the data rule reads each feed story's own fields (text,
// authors, alt text, linked sites, kind; see core/filters/story.js) and drops the matches
// before Facebook draws them. The page check reads the same fields from the markup (see
// core/filters/page.js) for posts that got drawn anyway, and in content mode. Both run on
// Home, the groups feed and group pages, never on a post you opened by its link.
//
// Preview runs the same checks and hides nothing. A read-only rule looks at the stories the
// page gets and the page check looks at each post as it fills in, and each one counts the
// posts it saw and which lines and kinds match them. Story ids in the data and post links on
// the page aren't the same ids, so the two layers are counted apart rather than guessed
// together. The counts stay in memory, at most PREVIEW_LIMIT posts a layer, start over when
// the list changes, and hold no post text. The card shows them with the lines they belong to,
// and Copy report gets only line numbers and counts.

import { walk, SKIP } from '../../core/json-walk.js';
import { filterCache, firstMatch, matchingRules } from '../../core/filters/engine.js';
import { postFields } from '../../core/filters/page.js';
import { storyFields } from '../../core/filters/story.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { inScope } from './ad-markers.js';
import { looksLikeCss } from '../../core/css-text.js';
import { later } from '../../core/net/payload.js';

export const CSS_WARNING = "Those filter lines look like CSS. Hide posts by words matches words in posts, so put CSS in Custom CSS under Appearance instead.";
const CSS_WARNED_KEY = 'hidePostsByWords.cssWarned';
const SKIP_WARNED_KEY = 'hidePostsByWords.skipWarned';

// The toast for pattern lines the filter skips (engine.js says why for each).
export function skipNotice(errors) {
  if (errors.length === 1) return `Filter line ${errors[0].line} is skipped because it ${errors[0].reason}.`;
  const lines = errors.map((error) => error.line);
  const named = lines.length > 4 ? [...lines.slice(0, 3), `${lines.length - 3} more`] : lines;
  return `Filter lines ${named.slice(0, -1).join(', ')} and ${named.at(-1)} are skipped. Diagnostics says why.`;
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
];

export const FILTERED = {
  queries: /^(?:CometNewsFeedPaginationQuery|GroupsCometCrossGroupFeedPaginationQuery|GroupsCometFeedRegularStoriesPaginationQuery)$/,
  routes: (route) => Boolean(route) && !route.permalink && (route.type === 'home' || route.type === 'groups'),
};

const valuesOf = (fields) => [...fields.text, ...fields.authors, ...fields.alt, ...fields.sites];

// What hides this post, as the text after "Filter: ", or null.
export function filterVerdict({ rules, kinds }, fields) {
  for (const { kind, label } of KINDS) if (kinds.has(kind) && fields.kinds.has(kind)) return label;
  return firstMatch(rules, valuesOf(fields))?.phrase ?? null;
}

// Every kind and line that matches this post, by id ('photo posts', 'line 3'), for the preview.
// It's empty exactly when filterVerdict is null.
export function filterMatches({ rules, kinds }, fields) {
  const kindIds = KINDS.filter(({ kind }) => kinds.has(kind) && fields.kinds.has(kind)).map(({ label }) => label);
  return [...kindIds, ...matchingRules(rules, valuesOf(fields)).map((rule) => `line ${rule.line}`)];
}

// Calls visit(edge) for each feed story edge in doc: an object with a cursor and a story node.
function eachStory(doc, visit) {
  walk(doc, (value) => {
    if (Array.isArray(value) || !('cursor' in value) || !value.node || typeof value.node !== 'object') return undefined;
    if (value.node.__typename !== 'Story' && !value.node.__isFeedUnit) return undefined;
    visit(value);
    return SKIP;
  });
}

// Drops every feed story in doc that the filter hides. Returns the reasons, one per story.
// report(story, reason) hears each one before it goes.
export function pruneFiltered(doc, filter, report) {
  const hits = [];
  eachStory(doc, (edge) => {
    const reason = filterVerdict(filter, storyFields(edge.node));
    if (reason === null) return;
    report?.(edge.node, reason);
    delete edge.node;
    delete edge.rendering_strategy;
    hits.push(reason);
  });
  return hits;
}

// The preview's look at the same stories, changing nothing. see(id, matches) hears each one.
export function previewFiltered(doc, filter, see) {
  eachStory(doc, (edge) => see(edge.node.post_id ?? edge.node.id ?? null, filterMatches(filter, storyFields(edge.node))));
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
export function previewStatus({ data, page, rules, active }) {
  if (!active) return 'Preview is on. Add a word or turn on a kind of post to see what it would hide.';
  const phraseOf = (id) => rules.find((rule) => `line ${rule.line}` === id)?.phrase ?? null;
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
    { key: 'preview', type: 'toggle', label: 'Preview: count what each line would hide, and hide nothing', default: false },
  ],

  setup({ net, router, posts, hider, log, toast, storage, settings, diagnostics, enabled, option }) {
    const compile = filterCache();
    const warned = new Set();
    // Skipped pattern lines and CSS pasted here (which would only ever match posts that quote
    // it) each get a toast once per list, remembered across page loads. Pattern and note lines
    // are left out of the CSS check, since "re:not( ?sponsored)" is a fine pattern.
    let checked = null;
    const checkList = () => {
      if (!enabled()) return;
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
        log?.warn(`Filter line ${error.line} is skipped because it ${error.reason}. It stays in your list as you wrote it`, error.message);
      }
      const kinds = new Set(KINDS.filter(({ key }) => option(key) === true).map(({ kind }) => kind));
      return { rules, kinds, errors };
    }
    const active = (filter) => filter.rules.length > 0 || filter.kinds.size > 0;
    const previewing = () => option('preview') === true;
    const preview = { data: net ? createPreviewTally() : null, page: posts && hider ? createPreviewTally() : null };
    const summaries = () => ({ data: preview.data?.summary() ?? null, page: preview.page?.summary() ?? null });

    if (net) {
      const scope = { scope: FILTERED };
      const markers = ['"__isFeedUnit"'];
      const match = (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql');
      net.transformResponses({
        id: 'hidePostsByWords',
        enabled,
        markers,
        match,
        transform(doc, ctx, stage) {
          if (previewing() || !inScope(scope, ctx, route)) return false;
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
      // Preview's look at the same stories. It only reads, so nothing it does reaches the page.
      net.transformResponses({
        id: 'hidePostsByWords.preview',
        enabled: () => enabled() && previewing(),
        markers,
        match,
        observe: true,
        transform(doc, ctx) {
          if (!previewing() || !inScope(scope, ctx, route)) return false;
          const filter = current();
          if (!active(filter)) return false;
          previewFiltered(doc, filter, (id, matches) => {
            if (id !== null) preview.data.see(String(id), matches);
          });
          changed();
          return false;
        },
      });
    }
    checkList();
    settings?.subscribe(checkList);
    diagnostics?.add('Posts hidden by your filters', () => summary(hits));
    diagnostics?.add("Filter lines that aren't valid", () => {
      const { errors } = current();
      return errors.length ? errors.map((error) => `line ${error.line} (${error.reason})`).join(', ') : 'None';
    });
    diagnostics?.add('Filter preview', () => (enabled() && previewing() ? previewReport(summaries()) || 'Nothing to count here' : 'Off'), { shareable: true });
    diagnostics?.status?.('hidePostsByWords', () => {
      if (!enabled() || !previewing()) return null;
      const filter = current();
      return previewStatus({ ...summaries(), rules: filter.rules, active: active(filter) });
    });

    // Any change to the list or the switches starts the preview counting again, and takes a
    // fresh look at the posts on the page (recheck, once the page check is set up).
    const state = () => JSON.stringify([enabled(), option('words'), option('preview'), ...KINDS.map(({ key }) => option(key))]);
    let last = state();
    let recheck = null;
    settings?.subscribe(() => {
      const next = state();
      if (next === last) return;
      last = next;
      preview.data?.clear();
      preview.page?.clear();
      recheck?.();
      changed();
    });
    if (!posts || !hider) return;

    // The page check in preview: each post is counted once and keeps every match it showed on
    // any look, since its text can fill in after the first one. It never hides, so it says
    // "not done" and keeps getting the post's later looks.
    const pageKeys = new WeakMap();
    let nextKey = 0;
    const keyOf = (element) => {
      if (!pageKeys.has(element)) pageKeys.set(element, ++nextKey);
      return pageKeys.get(element);
    };

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        if (!FILTERED.routes(route())) return true;
        const filter = current();
        if (!active(filter)) return true;
        if (previewing()) {
          preview.page.see(keyOf(element), filterMatches(filter, postFields(element)));
          changed();
          return false;
        }
        const reason = filterVerdict(filter, postFields(element));
        if (reason === null) return false;
        if (hider.hide(element, 'Filter', reason)) {
          tally(hits, reason);
          changed();
        }
        return true;
      },
    });

    recheck = () => {
      hider.showAll('Filter');
      if (enabled()) watcher.recheckAll();
    };
  },
};
