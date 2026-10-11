// One <style> element holds the CSS of every feature that's on. It's rebuilt whenever a
// setting changes, so CSS features switch on and off without a reload.

import { whenRootReady } from './env.js';

// base: [{ id, css(get) }] for styles the core always needs while the script isn't paused,
// such as the rules that hide posts.
export function renderFeatureCss(features, settings, log, base = []) {
  const parts = [];
  if (settings.get('paused') !== true) {
    for (const part of base) {
      try {
        parts.push(`/* ${part.id} */\n${part.css(settings.get)}`);
      } catch (error) {
        log?.error(`The ${part.id} styles couldn't be built`, error);
      }
    }
  }
  for (const feature of features) {
    if (!feature.css || !settings.enabled(feature.id)) continue;
    try {
      parts.push(`/* ${feature.id} */\n${typeof feature.css === 'function' ? feature.css(settings.get) : feature.css}`);
    } catch (error) {
      log?.error(`${feature.title}: its styles couldn't be built`, error);
    }
  }
  return parts.join('\n');
}

export function mountFeatureStyles({ features, settings, log, doc = document, base = [] }) {
  const style = doc.createElement('style');
  style.dataset.hushfacebookWeb = 'features';
  const render = () => {
    style.textContent = renderFeatureCss(features, settings, log, base);
  };
  render();
  whenRootReady(() => (doc.head ?? doc.documentElement).append(style), doc);
  settings.subscribe(render);
  return style;
}
