// Tag suggestions only after @, as Hushfacebook does on Android. Typing a friend's first name
// into a comment box, with no @, makes Facebook offer to tag them (live 2026-10-11, captures/
// 2026-10-11-run31: 4 suggestions under "Thanks <name>", and no query sent for them). Those come
// from two lists the box loads when it opens, one answer each:
//   useFeedComposerCometMentionsBootloadDataSourceQuery
//     data.comet_composer_typeahead_bootload                 (9 people)
//   useFeedComposerCometMentionsBootloadDataSourceWithTaggingTransparencyQuery
//     data.xfb_tag_suggestion_search.suggestions             (58 people)
// After an @ Facebook searches instead, with
// useFeedComposerCometMentionsNetworkDataSourceWithTaggingTransparencyQuery, plus a Nullstate
// list for a bare @ (10 suggestions either way). The script empties only the two lists the box
// loads up front, so a name typed without @ matches no one, and @ still finds everyone. Needs the
// script running in the page.

export const BOOTLOAD = /^useFeedComposerCometMentionsBootloadDataSource(?:WithTaggingTransparency)?Query$/;
export const MARKERS = ['"comet_composer_typeahead_bootload"', '"xfb_tag_suggestion_search"'];

// Both lists in an answer emptied in place. How many people were taken out.
export function emptyTagLists(doc) {
  const data = doc?.data;
  if (!data || typeof data !== 'object') return 0;
  let removed = 0;
  if (Array.isArray(data.comet_composer_typeahead_bootload)) {
    removed += data.comet_composer_typeahead_bootload.length;
    data.comet_composer_typeahead_bootload = [];
  }
  const search = data.xfb_tag_suggestion_search;
  if (search && typeof search === 'object' && Array.isArray(search.suggestions)) {
    removed += search.suggestions.length;
    search.suggestions = [];
  }
  return removed;
}

export default {
  id: 'tagsAfterAt',
  section: 'comments',
  android: 'Tag suggestions only after @',
  title: 'Tag suggestions only after @',
  description: "Typing a friend's name in a comment or post no longer offers to tag them. Type @ first when you do want to tag someone.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    net.transformResponses({
      id: 'tagsAfterAt',
      enabled,
      markers: MARKERS,
      // By name, so the Nullstate and search answers an @ asks for are never touched.
      match: (ctx) => ctx.transport !== 'json-parse' && BOOTLOAD.test(ctx.friendlyName),
      transform(doc) {
        const removed = emptyTagLists(doc);
        if (removed) {
          held += 1;
          diagnostics?.changed();
        }
        return removed > 0;
      },
    });
    diagnostics?.add('Tag lists held back', () => String(held));
  },
};
