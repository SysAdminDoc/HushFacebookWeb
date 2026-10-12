// The Chrome extension's manifest. The version comes from package.json at build time, and the
// pages it runs on are the userscript's @match list (meta.mjs).

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

export function extensionManifest(pkg) {
  return {
    manifest_version: 3,
    name: value('name'),
    version: pkg.version,
    description: value('description'),
    homepage_url: value('homepageURL'),
    // MAIN-world content scripts.
    minimum_chrome_version: '111',
    icons: ICONS,
    action: { default_title: 'HushFacebook Web settings', default_icon: ICONS },
    background: { service_worker: 'background.js' },
    // activeTab: the toolbar button sees which tab it was clicked on, and nothing more.
    // alarms: the daily release check.
    permissions: ['storage', 'downloads', 'activeTab', 'alarms'],
    content_scripts: [...scripts(FACEBOOK, false), ...scripts(GAMES, true)],
  };
}
