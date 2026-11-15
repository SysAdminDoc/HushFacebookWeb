// Buttons a feature puts on its own card in the settings panel ("Show seen posts"). label is
// a string, or a function when the wording follows the feature's state. A function that returns
// '' leaves its button off the card for now. Each button keeps its place number either way.
//
// A feature can also show a list of links on its card (Remember what you watch): get returns
// [{ label, detail, href, action }] each time the card is drawn, and empty is shown when there
// are none. An item without href is a plain line, and action ({ label, run }) puts a button beside
// it (Hide parts of the page's Show again).

export function createActions() {
  const byFeature = new Map();
  const linkLists = new Map();
  return {
    // The handle a feature gets as ctx.actions.
    for(featureId) {
      return {
        add(label, run) {
          const list = byFeature.get(featureId) ?? [];
          list.push({ label, run });
          byFeature.set(featureId, list);
        },
        links(get, empty) {
          linkLists.set(featureId, { get, empty });
        },
      };
    },
    links(featureId) {
      const found = linkLists.get(featureId);
      return found ? { items: found.get(), empty: found.empty } : null;
    },
    list(featureId) {
      return (byFeature.get(featureId) ?? [])
        .map(({ label, run }, index) => ({ label: typeof label === 'function' ? label() : label, run, index }))
        .filter(({ label }) => label);
    },
  };
}
