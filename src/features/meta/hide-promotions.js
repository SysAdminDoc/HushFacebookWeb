// Hide the Get Messenger card, as Hushfacebook does on Android, and the rest of Facebook's own
// cards and tips. Facebook calls them quick promotions, and its answers carry them as
// eligible_promotions.nodes or jewel_qp.nodes (captured 2026-10-10 and 2026-10-11):
//   MWQuickPromotionThreadlistBannerQuery            the banner over your chat list
//   CometMessagingJewelDropdownEBUpsellContainerQuery the Messenger menu in the top bar
//   StoriesSuspenseContentPaneRootWithEntryPointQuery qp_viewer, a tip in the story viewer
//                                                    (trigger fb_stories_www_tofu_nux)
// The script empties those lists before Facebook reads them, so there's nothing to draw. Each
// node is one promotion with its surface and trigger, and an empty list is what Facebook sends
// when it has none for you. Needs the script running in the page.

export const MARKERS = ['"eligible_promotions"', '"jewel_qp"'];
const LISTS = ['eligible_promotions', 'jewel_qp'];

// Every promotion list in an answer emptied in place. The number of promotions taken out.
export function emptyPromotions(data) {
  let removed = 0;
  (function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 60) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const key of LISTS) {
      const nodes = value[key]?.nodes;
      if (Array.isArray(nodes) && nodes.length) {
        removed += nodes.length;
        value[key].nodes = [];
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  })(data, 0);
  return removed;
}

export default {
  id: 'hidePromotions',
  section: 'meta',
  android: 'Hide the Get Messenger card',
  title: "Hide Facebook's own cards and tips",
  description: 'Cards like Get the Messenger app over your chats or in the Messenger menu, and the tips Facebook shows in stories, never show up.',
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let removed = 0;
    net.transformResponses({
      id: 'hidePromotions',
      enabled,
      markers: MARKERS,
      // Facebook parses every answer with JSON.parse, so one place covers them all.
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        const count = emptyPromotions(data);
        if (count) {
          removed += count;
          diagnostics?.changed();
        }
        return count > 0;
      },
    });
    diagnostics?.add('Cards and tips held back', () => String(removed));
  },
};
