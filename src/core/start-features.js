// Runs every feature's setup and records the ones that can't run in unavailable (a Map of
// feature id to reason): 'page' needs the page and the manager runs the script as a content
// script, 'api' is missing something only the browser or manager can give, and 'failed'
// threw during setup or stopped working later. A feature that failed partway keeps whatever
// it did start, and that part still checks ctx.enabled(), so switching it off stops it.
export function startFeatures({ features, net, settings, log, unavailable, context, changed, networkUnavailable = 'page' }) {
  for (const feature of features) {
    if (feature.needsPage && !net) {
      unavailable.set(feature.id, networkUnavailable);
      continue;
    }
    if (!feature.setup) continue;
    try {
      feature.setup({
        ...context(feature),
        net,
        settings,
        // A feature that stops working after setup says so, the same as one that couldn't start.
        markUnavailable: (reason = 'failed') => {
          unavailable.set(feature.id, reason);
          changed?.();
        },
        enabled: () => settings.enabled(feature.id),
        option: (key) => settings.get(`${feature.id}.${key}`),
      });
    } catch (error) {
      unavailable.set(feature.id, 'failed');
      log.error(`${feature.title} couldn't start`, error);
    }
  }
}
