// Turn off auto-translation, as Hushfacebook does on Android. An account with Facebook's
// automatic translation on gets posts and comments in other languages already translated, with a
// "See original" link under each (live 2026-10-11, captures/2026-10-11-run30: 10 "See original
// (French)" on Le Monde's Page, 14 "See original (Spanish)" on El País's).
//
// A comment comes translated in Facebook's own data, beside what the person wrote: body is what
// they wrote, preferred_body has the translation with translation_type MACHINE_TRANSLATION
// (ORIGINAL when Facebook didn't translate it), and body_renderer is the text the page draws,
// the translation again. The comment's "See original" link (XFBCommentTranslationActionLink)
// carries a second, partial copy of the same comment, { id, preferred_body: { translation_type } },
// and Relay merges the two, so that copy has to say ORIGINAL too or the page keeps the translated
// look (live 2026-10-11, run 32: El País comments stayed in English with only the first copy
// changed). The script gives preferred_body and body_renderer the person's own words back, marked
// ORIGINAL, which is what Facebook sends for a comment it left alone. The See translation link
// comes from translatability_for_viewer, which stays.
//
// A post's words sit in a message container whose __typename and module references pick the
// layout (runs 36 to 40). The auto-translated layout throws without its translation, and
// Facebook's error boundary reports that with the post's tracking data. Switching the container
// to the plain translatable layout or the default one left posts as loading placeholders (runs 37
// and 40), since an answer only lists the code its own layouts need and Facebook never loaded the
// other one. So the layout stays, and the translation it draws gets the post's own words, which
// sit beside it in the post's plain message section (comet_sections.message.story.message, the
// same story). Its answer has no MACHINE_TRANSLATION in it, so posts have their own rule, found
// by the layout's name. Needs the script running in the page.

import { walk } from '../../core/json-walk.js';

export const MARKERS = ['"MACHINE_TRANSLATION"'];
// Highlights over the shown text, by offset into it. None were seen on a translated comment, and
// any there would point into the translation's words, so they go.
const OTHER_RANGES = ['delight_ranges', 'image_ranges', 'inline_style_ranges', 'aggregated_ranges', 'color_ranges'];

const entityId = (range) => range?.entity?.id ?? null;

// The translation's mention ranges carry what the page needs to draw a link (url, short_name and
// more), and the original's carry where the name sits in the person's words. Each mention keeps
// the first and gets the second, matched by who it is, in order. A mention only the original has
// stays as plain text.
export function originalRanges(shown, own) {
  if (!Array.isArray(own) || !own.length) return [];
  const rich = new Map();
  for (const range of Array.isArray(shown) ? shown : []) {
    const id = entityId(range);
    if (id === null) continue;
    if (!rich.has(id)) rich.set(id, []);
    rich.get(id).push(range);
  }
  const out = [];
  for (const range of own) {
    const match = rich.get(entityId(range))?.shift();
    if (match && Number.isFinite(range?.offset) && Number.isFinite(range?.length)) out.push({ ...match, offset: range.offset, length: range.length });
  }
  return out;
}

// A text block (TextWithEntities) given the person's own words and mentions.
function putBack(block, own) {
  block.text = own.text;
  block.ranges = originalRanges(block.ranges, own.ranges);
  for (const key of OTHER_RANGES) {
    if (Array.isArray(block[key]) && block[key].length) block[key] = [];
  }
}

// One comment's own words put back where the page reads them. True when it changed.
export function restoreComment(comment) {
  const shown = comment?.preferred_body;
  const own = comment?.body;
  if (!shown || typeof shown !== 'object' || shown.translation_type !== 'MACHINE_TRANSLATION') return false;
  if (!own || typeof own.text !== 'string' || typeof shown.text !== 'string') return false;
  putBack(shown, own);
  shown.translation_type = 'ORIGINAL';
  const drawn = comment.body_renderer;
  if (drawn && typeof drawn === 'object' && typeof drawn.text === 'string' && drawn.text !== own.text) putBack(drawn, own);
  return true;
}


const MAX_REMEMBERED = 5000;
export const RESTORED = 'restored';
export const ASKED = 'asked';

function remember(seen, id, kind) {
  seen.delete(id);
  if (seen.size >= MAX_REMEMBERED) seen.delete(seen.keys().next().value);
  seen.set(id, kind);
}

// The comment ids untranslate keeps, counting the ASKED ones as they come and go, so the rule
// that waits for See original only runs while there's one to wait for.
export class CommentBook extends Map {
  asked = 0;

  set(id, kind) {
    if (super.get(id) === ASKED) this.asked--;
    if (kind === ASKED) this.asked++;
    return super.set(id, kind);
  }

  delete(id) {
    if (super.get(id) === ASKED) this.asked--;
    return super.delete(id);
  }
}

// See original answers with the comment again, still without its own words, marked ORIGINAL
// and with no MACHINE_TRANSLATION anywhere (live 2026-10-11, run 47), so the main rule's marker
// never lets it through. A comment that answer names is no longer one the reader asked for.
export const ORIGINAL_MARKERS = ['"ORIGINAL"'];

export function forgetAsked(data, seen) {
  let forgotten = 0;
  walk(data, (value) => {
    if (Array.isArray(value)) return;
    const shown = value.preferred_body;
    if (!shown || typeof shown !== 'object' || typeof shown.text !== 'string' || shown.translation_type !== 'ORIGINAL') return;
    if (typeof value.id === 'string' && seen.get(value.id) === ASKED) {
      seen.delete(value.id);
      forgotten++;
    }
  });
  return forgotten;
}

// Every translated comment in an answer, as written. How many comments and link copies changed.
// seen: comment ids kept across answers. RESTORED ones were put back, so a partial copy of one
// in a later answer is marked ORIGINAL too. ASKED ones the reader translated with See
// translation, which Facebook answers with the comment again, translated and without its own
// words (live 2026-10-11, run 34, CometUFICommentRefetchQuery). Those are left translated, and
// so is their link's copy, so the link offers See original.
export function untranslate(data, seen = new Map()) {
  const count = { comments: 0, copies: 0 };
  const partial = [];
  walk(data, (value) => {
    if (Array.isArray(value)) return;
    const shown = value.preferred_body;
    if (!shown || typeof shown !== 'object') return;
    const id = typeof value.id === 'string' ? value.id : null;
    if (typeof shown.text === 'string' && !('body' in value)) {
      // The answer to a See translation or See original click.
      if (id && shown.translation_type === 'MACHINE_TRANSLATION') remember(seen, id, ASKED);
      else if (id && seen.get(id) === ASKED) seen.delete(id);
      return;
    }
    if (id && seen.get(id) === ASKED) return;
    if (restoreComment(value)) {
      count.comments++;
      if (id) remember(seen, id, RESTORED);
    } else if (shown.translation_type === 'MACHINE_TRANSLATION' && typeof shown.text !== 'string') {
      partial.push(value);
    }
  });
  // Copies are matched after the walk, since one can come before the full comment.
  for (const copy of partial) {
    if (seen.get(copy.id) !== RESTORED) continue;
    copy.preferred_body.translation_type = 'ORIGINAL';
    count.copies++;
  }
  return count;
}

export const AUTO_TRANSLATED = 'CometFeedStoryAutoTranslatedMessageContainerRenderingStrategy';
export const POST_MARKERS = [`"${AUTO_TRANSLATED}"`];

// One post's own words put into its auto-translated container. sections is the post's
// comet_sections. True when it changed.
export function restorePost(sections) {
  const container = sections?.message_container;
  if (!container || container.__typename !== AUTO_TRANSLATED) return false;
  const shown = container.story?.translation?.message;
  const plain = sections.message?.story;
  const own = plain?.message;
  if (!shown || typeof shown.text !== 'string' || !own || typeof own.text !== 'string') return false;
  if (!plain.id || plain.id !== container.story.id || shown.text === own.text) return false;
  putBack(shown, own);
  return true;
}

// Every auto-translated post in an answer, as written. How many changed.
export function untranslatePosts(data) {
  let posts = 0;
  walk(data, (value) => {
    if (!Array.isArray(value) && value.message_container && restorePost(value)) posts++;
  });
  return posts;
}

export default {
  id: 'noAutoTranslate',
  section: 'comments',
  android: 'Turn off auto-translation',
  title: 'Show comments as written',
  description: "Comments and posts in other languages show the words people wrote instead of Facebook's automatic translation. See translation under a comment still works when you want it.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let shown = 0;
    const seen = new CommentBook();
    net.transformResponses({
      id: 'noAutoTranslate',
      enabled,
      markers: MARKERS,
      // Facebook parses every answer and the page's inline data with JSON.parse.
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        const { comments, copies } = untranslate(data, seen);
        if (comments) {
          shown += comments;
          diagnostics?.changed();
        }
        return comments + copies > 0;
      },
    });
    // Only while a comment the reader translated waits for See original. "ORIGINAL" is in most
    // comment answers, so this isn't run on them the rest of the time.
    net.transformResponses({
      id: 'noAutoTranslate-original',
      enabled: () => enabled() && seen.asked > 0,
      markers: ORIGINAL_MARKERS,
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        forgetAsked(data, seen);
        return false;
      },
    });
    let posts = 0;
    net.transformResponses({
      id: 'noAutoTranslate-posts',
      enabled,
      markers: POST_MARKERS,
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        const changed = untranslatePosts(data);
        if (changed) {
          posts += changed;
          diagnostics?.changed();
        }
        return changed > 0;
      },
    });
    diagnostics?.add('Comments shown as written', () => String(shown));
    diagnostics?.add('Posts shown as written', () => String(posts));
  },
};
