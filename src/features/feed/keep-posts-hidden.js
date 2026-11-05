// Keep posts you hide hidden: the X at the top of a post on Home or in your groups feed ("Hide
// post by ...") hides the post here and remembers it, so it stays away when the feed loads
// again. The post is remembered the way Hide seen posts does it, by its photo or video or by its
// first words (core/seen-keys.js), for the account on the page (core/activity.js). From the next
// load on it's taken out of Facebook's data before it's drawn in page mode, and hidden on the
// page otherwise.
//
// Facebook isn't told: the press stops before any of Facebook's handlers hear it. Tell Facebook
// too (off to start) lets it go on to Facebook after the post is hidden here. Facebook sends a
// post again on the next load until it hears the X: live 2026-11-04 a post whose X reached
// Facebook (CometFeedStoryExecuteNFXActionMutation, type 4) wasn't sent in three reloads, while
// 7 to 9 of the other 15 from that visit were each time. Kept from Facebook, the same posts come
// back and are hidden again, and with five posts to a feed page Home can sit on its loading
// cards. Told, Facebook draws its "Why aren't you interested?" card in the post's place, which
// stays hidden with the post.
//
// A post with no photo, video or 24 letters of text (live 2026-11-04: a link shared with a few
// words on top) is remembered by who posted it, its words and its link's title instead, and
// one with none of that is hidden for this visit only unless Facebook was told.

import { watchPostChecks } from '../../core/dom/post-checks.js';
import { posterOf } from '../../core/filters/page.js';
import { pageKeys, wordsKey } from '../../core/seen-keys.js';
import { later } from '../../core/net/payload.js';
import { t } from '../../core/i18n.js';
import { drawnEdges, inScope } from './ad-markers.js';
import { FILTERED } from './filters.js';
import { pruneSeen } from './hide-seen-posts.js';

export const HIDDEN_KEY = 'keepPostsHidden.list';
// Keys, not posts: a post with a photo and words is two. The oldest go first.
export const MAX_HIDDEN = 3000;
const REASON = 'Dismissed';
const PRESSED = 'you pressed its X';
// The note after an X: small, in the corner, and gone in a couple of seconds.
const NOTE = { small: true, duration: 2500 };

// Facebook's X, by its English label, and in other languages by its icon and a label that names
// who posted (live 2026-11-04: <a role="link" href="#" aria-label="Hide post by ...">).
const LABEL = /^Hide post\b/i;
const X_ICON = 'M15.543 3.043';
const CONTROL = 'a[href], [role="button"], [role="link"]';
// What a press is made of before its click. Facebook's handlers don't hear these either.
const PRESSES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'];
const ACTIVATE = new Set(['Enter', ' ']);
// What the extension keeps (hiddenRecord in extension/isolated.js). One key it would refuse
// would lose the whole save.
const KEEPABLE = /^(?:m:\d{6,32}|t:[0-9a-z]{2,14})$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const MATCHED_BY = { m: 'same photo or video', t: 'same text', w: 'same poster and words' };
const matchedBy = (key) => MATCHED_BY[key[0]];

// What a post is remembered by: its photo or video and its first words (core/seen-keys.js), or
// for a post with none of those, who posted it with its words and its link's title.
function keysOf(post) {
  const keys = pageKeys(post).filter((key) => KEEPABLE.test(key));
  if (keys.length) return keys;
  const words = wordsKey(post, posterOf(post));
  return words ? [words] : [];
}

const labelOf = (control) => control.getAttribute('aria-label') ?? '';
const crossed = (control) => (control.querySelector('path')?.getAttribute('d') ?? '').startsWith(X_ICON);
// A quick look, before finding the post: anything else on the page passes straight through.
const maybeX = (control) => LABEL.test(labelOf(control)) || crossed(control);

// Whether control is the X that hides post.
export function isHideControl(control, post) {
  if (!post.contains(control)) return false;
  if (LABEL.test(labelOf(control))) return true;
  if (!crossed(control)) return false;
  const poster = posterOf(post);
  return Boolean(poster) && labelOf(control).includes(poster);
}

export default {
  id: 'keepPostsHidden',
  section: 'filters',
  webOnly: true,
  title: 'Keep posts you hide hidden',
  description: "The X at the top of a post on Home or in your groups feed hides it for good, not just until the feed loads again. The post is recognized by its photo or video, or by its first words. Facebook isn't told. Turn on Tell Facebook too if you'd rather it stop sending that post, which leaves room for new ones.",
  default: true,
  options: [
    { key: 'tellFacebook', type: 'toggle', label: 'Tell Facebook too, so it stops sending the post', default: false },
  ],

  setup({ win, net, router, posts, hider, storage, actions, diagnostics, settings, toast, log, enabled, option, now = Date.now }) {
    if (!win || !posts || !hider) return;
    const route = () => router?.current();
    const changed = () => diagnostics?.changed();
    const read = () => {
      const all = storage?.get(HIDDEN_KEY, {});
      return isRecord(all) ? all : {};
    };
    // The extension's saved copy fills in a moment after the page starts (whenReady), and a
    // write before then would replace it, so changes made before then wait and go on top of it.
    let loaded = !storage?.whenReady;
    const waiting = [];
    let known = new Set();
    const refresh = () => {
      const all = { ...read() };
      for (const change of waiting) change(all);
      known = new Set(Object.keys(all));
    };
    const save = (change) => {
      if (!loaded) {
        waiting.push(change);
        refresh();
        return;
      }
      const all = { ...read() };
      change(all);
      const keys = Object.keys(all);
      if (keys.length > MAX_HIDDEN) {
        for (const old of keys.sort((a, b) => all[a] - all[b]).slice(0, keys.length - MAX_HIDDEN)) delete all[old];
      }
      known = new Set(Object.keys(all));
      try {
        Promise.resolve(storage?.set(HIDDEN_KEY, all)).catch((error) => log?.error("Couldn't save the posts you hid", error));
      } catch (error) {
        log?.error("Couldn't save the posts you hid", error);
      }
    };
    refresh();
    const isKept = (key) => known.has(key);
    const telling = () => option?.('tellFacebook') === true;
    const hiding = () => enabled() && known.size > 0;
    let dropped = 0;
    let hidden = 0;
    // Posts hidden with their X during this visit, so a held key or a second press does nothing.
    const dismissed = new WeakSet();
    // Kept hidden while they're on the page: the ones with nothing to remember them by, and the
    // ones whose X went on to Facebook, which draws its own card in them.
    const held = new Set();
    const watching = () => hiding() || (enabled() && held.size > 0);
    // The page signed in as someone else. The list can't be read or saved for them.
    let gone = false;

    if (net) {
      const scope = { scope: FILTERED };
      net.transformResponses({
        id: 'keepPostsHidden',
        enabled: hiding,
        markers: ['"__isFeedUnit"'],
        match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
        transform(doc, ctx, stage) {
          if (!inScope(scope, ctx, route)) return false;
          const decisions = [];
          // The stories Facebook drew on the server stay, or React throws #418 and draws Home
          // again (see hide-seen-posts.js). The page check hides those.
          const drawn = ctx.transport === 'json-parse' ? drawnEdges(doc) : null;
          const keep = drawn?.size ? (edge) => drawn.has(edge) : undefined;
          const count = pruneSeen(doc, isKept, (story, key) => decisions.push({ post: story.post_id ?? story.id, rule: REASON, signal: matchedBy(key), layer: 'data' }), keep);
          if (!count) return false;
          later(stage, () => {
            for (const decision of decisions) diagnostics?.decide(decision);
            dropped += count;
            changed();
          });
          return true;
        },
      });
    }

    const watcher = watchPostChecks({
      posts,
      enabled: watching,
      check(element) {
        if (!FILTERED.routes(route())) return true;
        if (held.has(element)) {
          hider.hide(element, REASON, undefined, PRESSED);
          return true;
        }
        // Not one you hid, or not filled in yet: look again on the next retry.
        const key = keysOf(element).find(isKept);
        if (key === undefined) return false;
        if (hider.hide(element, REASON, undefined, matchedBy(key)) && !dismissed.has(element)) {
          hidden++;
          changed();
        }
        return true;
      },
    });
    const recheck = () => {
      if (watching()) watcher.recheckAll();
    };
    posts.on('post/remove', ({ element }) => {
      dismissed.delete(element);
      held.delete(element);
    });

    // The post whose X the event is on, with what it's remembered by, or null to leave the
    // event to Facebook.
    const pick = (event) => {
      const control = event.target?.closest?.(CONTROL);
      if (!control || !maybeX(control) || gone || !enabled() || !FILTERED.routes(route())) return null;
      const post = posts.current().find(({ element }) => element.contains(control));
      // A post you chose to show from its note stays shown, so Facebook's X has it, and so does
      // one hide() would leave (open in a dialog, say), with every part of the press.
      if (!post || !hider.canHide(post.element) || !isHideControl(control, post.element)) return null;
      // Reading the list is what notices another account (core/activity.js), which sets gone.
      read();
      return gone ? null : { element: post.element, keys: keysOf(post.element) };
    };

    // The press stops here unless Facebook is told, and then all of it goes on to Facebook (a
    // held key or the click Enter makes included).
    const stop = (event) => {
      if (telling()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const dismiss = (event, { element, keys }) => {
      if (dismissed.has(element) && hider.isHidden(element)) {
        stop(event);
        return;
      }
      // Nowhere on the post to put the note, so Facebook's X has it.
      if (!hider.hide(element, REASON, undefined, PRESSED)) return;
      const told = telling();
      stop(event);
      dismissed.add(element);
      if (told) held.add(element);
      if (!keys.length && !told) {
        held.add(element);
        changed();
        toast?.(t('Post hidden until you reload'), {
          ...NOTE,
          action: {
            label: 'Undo',
            run: () => {
              held.delete(element);
              hider.show(element, REASON);
              changed();
            },
          },
        });
        return;
      }
      const added = keys.filter((key) => !known.has(key));
      const at = now();
      if (keys.length) {
        save((all) => {
          for (const key of keys) all[key] = at;
        });
      }
      changed();
      toast?.(t('Post hidden'), {
        ...NOTE,
        action: {
          label: 'Undo',
          // Other posts the same keys hid come back too. One still matching an older key stays.
          // A post Facebook was told about comes back as Facebook's card, with its Unhide post.
          run: () => {
            dismissed.delete(element);
            held.delete(element);
            save((all) => {
              for (const key of added) delete all[key];
            });
            hider.showAll(REASON);
            recheck();
            changed();
          },
        },
      });
    };

    const onPress = (event) => {
      if (!telling() && pick(event)) event.stopImmediatePropagation();
    };
    const onClick = (event) => {
      const picked = pick(event);
      if (picked) dismiss(event, picked);
    };
    const onKey = (event) => {
      if (!ACTIVATE.has(event.key)) return;
      const picked = pick(event);
      if (!picked) return;
      if (event.type === 'keydown') dismiss(event, picked);
      else stop(event);
    };
    // On the window, capturing, so this hears the press before the page does.
    for (const type of PRESSES) win.addEventListener(type, onPress, true);
    win.addEventListener('click', onClick, true);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('keyup', onKey, true);

    diagnostics?.add('Hidden posts remembered', () => String(known.size));
    diagnostics?.add('Hidden posts kept away', () => (net ? `${dropped} taken out of the data, ${hidden} hidden on the page` : `${hidden} hidden on the page`));
    actions?.add('Forget posts you hid', () => {
      save((all) => {
        for (const key of Object.keys(all)) delete all[key];
      });
      held.clear();
      hider.showAll(REASON);
      changed();
      toast?.(t('Forgot every post you hid'));
    });

    let on = enabled();
    settings?.subscribe(() => {
      if (enabled() === on) return;
      on = enabled();
      if (on) watcher.recheckAll();
      else hider.showAll(REASON);
    });
    // Another tab hid a post or forgot them all.
    storage?.onChange?.(HIDDEN_KEY, () => {
      if (!loaded) return;
      refresh();
      hider.showAll(REASON);
      recheck();
      changed();
    });
    if (!loaded) {
      storage.whenReady(() => {
        const pending = waiting.splice(0);
        loaded = true;
        if (pending.length) save((all) => pending.forEach((change) => change(all)));
        else refresh();
        recheck();
        changed();
      });
    }
    // The page is someone else's now. Their posts aren't this list's.
    storage?.onAccountChange?.(() => {
      gone = true;
      waiting.splice(0);
      held.clear();
      refresh();
      hider.showAll(REASON);
    });
  },
};
