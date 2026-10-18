// The extension's manifest, for Chrome and for Firefox. The version comes from package.json at
// build time, and the pages it runs on are the userscript's @match list (meta.mjs).

import { metadata } from './meta.mjs';

const value = (key) => metadata.find(([name]) => name === key)[1];
const matches = metadata.filter(([key]) => key === 'match').map(([, pattern]) => pattern);
const FACEBOOK = matches.filter((pattern) => pattern.includes('facebook.com'));
const GAMES = matches.filter((pattern) => pattern.includes('apps.fbsbx.com'));
const ICONS = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));

// Both halves at document_start, the isolated one first. The page half has to run in Facebook's
// own window, before Facebook's scripts, so its hooks see their requests. Games run in frames.
const scripts = (pages, frames) => [
  { matches: pages, js: ['isolated.js'], run_at: 'document_start', all_frames: frames },
  { matches: pages, js: ['main.js'], run_at: 'document_start', all_frames: frames, world: 'MAIN' },
];

// The add-on id Firefox keeps the extension's storage under. It must never change.
export const GECKO_ID = 'hushfacebook-web@sysadmindoc.github.io';

// The oldest browsers the build supports. esbuild writes the bundles for these, and the
// manifests refuse anything older, so the two can't drift apart. MAIN-world content scripts
// alone would allow Chrome 111, but esbuild leaves anything Chrome 120 can run as written, and
// nothing older than 120 has been checked.
export const BROWSER_FLOORS = { chrome: 120, firefox: 128, safari: 17 };
export const BUNDLE_TARGET = Object.entries(BROWSER_FLOORS).map(([browser, version]) => `${browser}${version}`);

export function extensionManifest(pkg, { browser = 'chrome' } = {}) {
  const firefox = browser === 'firefox';
  return {
    manifest_version: 3,
    name: value('name'),
    version: pkg.version,
    description: value('description'),
    homepage_url: value('homepageURL'),
    ...(firefox
      ? { browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: `${BROWSER_FLOORS.firefox}.0`, data_collection_permissions: { required: ['none'] } } } }
      : { minimum_chrome_version: String(BROWSER_FLOORS.chrome) }),
    icons: ICONS,
    action: { default_title: 'HushFacebook Web settings', default_icon: ICONS },
    // Firefox runs the same classic script as an event page, since it has no extension workers.
    background: firefox ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    // activeTab: the toolbar button sees which tab it was clicked on, and nothing more.
    // alarms: the daily release check.
    permissions: ['storage', 'downloads', 'activeTab', 'alarms'],
    content_scripts: [...scripts(FACEBOOK, false), ...scripts(GAMES, true)],
  };
}
