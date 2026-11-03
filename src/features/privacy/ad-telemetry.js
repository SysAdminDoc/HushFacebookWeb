// Block ad telemetry, like Hushfacebook's Android patch of that name. Facebook's site reports ads
// as Falco log events over its realtime socket (realtime.js). Live 2026-11-03 on Home, two of them
// are about ads:
//   comet_ads_product_logging           an ad coming into view ("event": "impression"): its ad id,
//                                       the ad request it came in, its tracking token, its place
//                                       in the feed and the feed's session
//   brand_safety_opportunity_loss_rate  a feed slot for an ad: whether one went in, its client
//                                       token and what the posts on either side were
// No other request carried an ad's id or token (beacons, XHR and fetch were all checked). With
// this on, those events come out of the batch before it goes. The batch itself still goes, empty
// if they were all it held, so every frame the server acknowledges is still sent.
// comet_metrics_viewable_impression stays: it covers every post on screen, ads or not.

export const AD_EVENTS = new Set(['comet_ads_product_logging', 'brand_safety_opportunity_loss_rate']);

export default {
  id: 'blockAdTelemetry',
  section: 'privacy',
  android: 'Block ad telemetry',
  title: 'Block ad telemetry',
  description: "Facebook's site reports every ad you scroll past and each spot in your feed where it put one. With this on, those reports don't leave your browser. The ads themselves stay unless Hide sponsored posts is on.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    const held = new Map([...AD_EVENTS].map((name) => [name, 0]));
    if (net) {
      net.editLogBatches({
        id: 'blockAdTelemetry',
        startupPrivacy: true,
        enabled,
        edit(batch) {
          const kept = batch.events.filter((event) => !AD_EVENTS.has(event?.name));
          if (kept.length === batch.events.length) return false;
          for (const event of batch.events) if (AD_EVENTS.has(event?.name)) held.set(event.name, held.get(event.name) + 1);
          batch.events = kept;
          diagnostics?.changed();
          return true;
        },
      });
    }
    diagnostics?.add('Ad reports held back', () => {
      if (!net) return "Off: the script can't reach the page's log socket";
      const views = held.get('comet_ads_product_logging');
      const slots = held.get('brand_safety_opportunity_loss_rate');
      return `${views} ${views === 1 ? 'ad view' : 'ad views'}, ${slots} ${slots === 1 ? 'ad slot' : 'ad slots'}`;
    });
  },
};
