// One <style> element holds the CSS of every feature that's on. It's rebuilt whenever a
// setting changes, so CSS features switch on and off without a reload.

import { whenRootReady } from './env.js';

export function renderFeatureCss(features, settings, log) {
  const parts = [];
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

export function mountFeatureStyles({ features, settings, log, doc = document }) {
  const style = doc.createElement('style');
  style.dataset.hushfacebookWeb = 'features';
  const render = () => {
    style.textContent = renderFeatureCss(features, settings, log);
  };
  render();
  whenRootReady(() => (doc.head ?? doc.documentElement).append(style), doc);
  settings.subscribe(render);
  return style;
}
