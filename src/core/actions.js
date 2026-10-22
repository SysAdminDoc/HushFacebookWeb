// Buttons a feature puts on its own card in the settings panel ("Show seen posts"). label is
// a string, or a function when the wording follows the feature's state. A function that returns
// '' leaves its button off the card for now. Each button keeps its place number either way.

export function createActions() {
  const byFeature = new Map();
  return {
    // The handle a feature gets as ctx.actions.
    for(featureId) {
      return {
        add(label, run) {
          const list = byFeature.get(featureId) ?? [];
          list.push({ label, run });
          byFeature.set(featureId, list);
        },
      };
    },
    list(featureId) {
      return (byFeature.get(featureId) ?? [])
        .map(({ label, run }, index) => ({ label: typeof label === 'function' ? label() : label, run, index }))
        .filter(({ label }) => label);
    },
  };
}
