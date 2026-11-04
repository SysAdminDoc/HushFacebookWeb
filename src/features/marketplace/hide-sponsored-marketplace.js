// Ads Facebook drew on the server (in the inline answer of a category or a listing's own page,
// live 2026-11-03) keep their data, since React hydrates their cards from it and throws #418 when
// one is missing. listing-cards.js hides those cards on the page. Every other ad leaves the data
// before it's drawn.

import { adRule } from '../feed/ad-markers.js';
import { AD_CSS, watchAdCards } from './listing-cards.js';

export default {
  id: 'hideSponsoredMarketplace',
  section: 'marketplace',
  android: 'Hide sponsored Marketplace listings',
  title: 'Hide sponsored Marketplace listings',
  description: 'Takes ad cards out of Marketplace before Facebook draws them. The listings around them stay where they are.',
  default: true,
  needsPage: true,

  css: AD_CSS,

  setup({ doc, net, router, settings, enabled, diagnostics }) {
    let drawn = false;
    let cards = null;
    if (doc && router) {
      const counted = new WeakSet();
      cards = watchAdCards({
        doc,
        route: () => router.current(),
        active: () => enabled() && drawn,
        onHidden: (card) => {
          if (counted.has(card)) return;
          counted.add(card);
          diagnostics?.decide({ post: null, rule: 'Sponsored listing', signal: 'MarketplaceFeedAdStory', layer: 'page' });
        },
      });
      settings?.subscribe?.(() => cards.check());
      router.subscribe?.(() => cards.check());
    }
    net.transformResponses(adRule('hideSponsoredMarketplace', enabled, undefined, {
      diagnostics,
      reason: 'Sponsored listing',
      onDrawn: cards ? () => {
        drawn = true;
        cards.check();
      } : undefined,
    }));
  },
};
